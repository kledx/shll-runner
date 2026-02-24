/**
 * Soft Policy Engine — Runner-side safety checks.
 *
 * Reads user_safety_configs from DB and validates actions
 * BEFORE submitting to chain. This is a pre-flight filter to
 * save gas — the on-chain PolicyGuardV4 is always the final authority.
 *
 * Checks:
 *   - Allowed/blocked tokens
 *   - Per-trade amount limit
 *   - Daily spending limit
 *   - Slippage tolerance
 *   - Cooldown period
 *   - Max runs per day
 *   - Allowed DEXes
 */

import type { Pool } from "pg";
import type { IGuardrails, PolicyCheckResult, PolicyViolation, ExecutionContext } from "./interface.js";
import type { ActionPayload } from "../actions/interface.js";

// ═══════════════════════════════════════════════════════
//                  Safety Config
// ═══════════════════════════════════════════════════════

export interface UserSafetyConfig {
    tokenId: string;
    chainId: number;
    allowedTokens: string[];
    blockedTokens: string[];
    maxTradeAmount: string;   // wei string
    maxDailyAmount: string;   // wei string
    maxSlippageBps: number;
    cooldownSeconds: number;
    maxRunsPerDay: number;
    allowedDexes: string[];
}

// ═══════════════════════════════════════════════════════
//               Soft Policy Engine
// ═══════════════════════════════════════════════════════

function formatBnb(wei: bigint): string {
    const ZERO = 0n;
    const DECIMALS = 10n ** 18n;
    if (wei === ZERO) return "0";
    const ethPart = wei / DECIMALS;
    const remainder = wei % DECIMALS;
    if (remainder === ZERO) return ethPart.toString();
    const fracStr = remainder.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
    return fracStr ? `${ethPart}.${fracStr}` : ethPart.toString();
}

export class SoftPolicyEngine implements IGuardrails {
    constructor(
        private tokenId: bigint,
        private pool: Pool,
        private chainId: number,
    ) { }

    async check(action: ActionPayload, context: ExecutionContext): Promise<PolicyCheckResult> {
        const config = await this.loadConfig();
        if (!config) {
            // No safety config = no soft constraints
            return { ok: true, violations: [] };
        }

        const violations: PolicyViolation[] = [];

        // 1. Allowed DEXes check — only applies to swap actions
        //    (approve target = token contract, not a DEX)
        if (config.allowedDexes.length > 0 && context.actionName === "swap") {
            const target = action.target.toLowerCase();
            const isAllowed = config.allowedDexes.some(
                dex => dex.toLowerCase() === target,
            );
            if (!isAllowed) {
                violations.push({
                    code: "SOFT_ALLOWED_DEX",
                    policy: "allowedDexes",
                    message: `Target ${action.target} not in allowed DEX list`,
                });
            }
        }

        // 2. Per-trade amount limit (uses spendAmount which covers both native + ERC20)
        if (config.maxTradeAmount !== "0") {
            const maxTrade = BigInt(config.maxTradeAmount);
            const tradeAmount = context.spendAmount ?? action.value;
            if (tradeAmount > maxTrade) {
                violations.push({
                    code: "SOFT_MAX_TRADE_AMOUNT",
                    policy: "maxTradeAmount",
                    message: `Trade amount ${formatBnb(tradeAmount)} exceeds per-trade limit ${formatBnb(maxTrade)}`,
                });
            }
        }

        // 3. Cooldown check
        if (config.cooldownSeconds > 0) {
            const lastRun = await this.getLastRunTimestamp();
            if (lastRun) {
                const elapsed = context.timestamp - lastRun;
                if (elapsed < config.cooldownSeconds) {
                    violations.push({
                        code: "SOFT_COOLDOWN",
                        policy: "cooldown",
                        message: `Cooldown: ${config.cooldownSeconds - elapsed}s remaining`,
                    });
                }
            }
        }

        // 4. Max runs per day
        if (config.maxRunsPerDay > 0) {
            const todayRuns = await this.getTodayRunCount();
            if (todayRuns >= config.maxRunsPerDay) {
                violations.push({
                    code: "SOFT_MAX_RUNS_PER_DAY",
                    policy: "maxRunsPerDay",
                    message: `Daily run limit reached: ${todayRuns}/${config.maxRunsPerDay}`,
                });
            }
        }

        // 5. Daily spending limit (uses spendAmount)
        if (config.maxDailyAmount !== "0") {
            const maxDaily = BigInt(config.maxDailyAmount);
            const todaySpent = await this.getTodaySpending();
            const tradeAmount = context.spendAmount ?? action.value;
            if (todaySpent + tradeAmount > maxDaily) {
                violations.push({
                    code: "SOFT_MAX_DAILY_AMOUNT",
                    policy: "maxDailyAmount",
                    message: `Would exceed daily limit: spent=${formatBnb(todaySpent)}, tx=${formatBnb(tradeAmount)}, max=${formatBnb(maxDaily)}`,
                });
            }
        }

        // 6. Allowed tokens check — swap/approve tokens must be in whitelist
        if (config.allowedTokens.length > 0 && context.actionTokens && context.actionTokens.length > 0) {
            const allowed = new Set(config.allowedTokens.map(t => t.toLowerCase()));
            const ZERO = "0x0000000000000000000000000000000000000000";
            for (const token of context.actionTokens) {
                // Skip native BNB (address(0)) — always allowed
                if (token === ZERO) continue;
                if (!allowed.has(token)) {
                    violations.push({
                        code: "SOFT_ALLOWED_TOKENS",
                        policy: "allowedTokens",
                        message: `Token ${token} is not in your allowed tokens list`,
                        metadata: { tokenAddress: token },
                    });
                }
            }
        }

        // 7. Blocked tokens check — reject if any token is blacklisted
        if (config.blockedTokens.length > 0 && context.actionTokens && context.actionTokens.length > 0) {
            const blocked = new Set(config.blockedTokens.map(t => t.toLowerCase()));
            for (const token of context.actionTokens) {
                if (blocked.has(token)) {
                    violations.push({
                        code: "SOFT_BLOCKED_TOKENS",
                        policy: "blockedTokens",
                        message: `Token ${token} is in your blocked tokens list`,
                    });
                }
            }
        }

        // 8. Max slippage check — validates minOut implies acceptable slippage
        //    Slippage = 1 - (minOut / amountIn). If > maxSlippageBps, reject.
        //    NOTE: this is a rough check since tokenIn/tokenOut may have different decimals.
        //    It's mainly useful when both tokens have 18 decimals (e.g. BNB/WBNB swaps).
        if (config.maxSlippageBps > 0 && context.amountIn && context.minOut && context.amountIn > 0n) {
            // Slippage in basis points: (1 - minOut/amountIn) * 10000
            // To avoid float: slippageBps = (amountIn - minOut) * 10000 / amountIn
            const slippageBps = Number((context.amountIn - context.minOut) * 10000n / context.amountIn);
            if (slippageBps > config.maxSlippageBps) {
                violations.push({
                    code: "SOFT_MAX_SLIPPAGE_BPS",
                    policy: "maxSlippageBps",
                    message: `Implied slippage ${slippageBps}bps exceeds max ${config.maxSlippageBps}bps`,
                });
            }
        }

        return {
            ok: violations.length === 0,
            violations,
        };
    }

    // ─── Internal helpers ──────────────────────────────

    private async loadConfig(): Promise<UserSafetyConfig | null> {
        const result = await this.pool.query(
            `SELECT token_id, chain_id, allowed_tokens, blocked_tokens,
                    max_trade_amount, max_daily_amount, max_slippage_bps,
                    cooldown_seconds, max_runs_per_day, allowed_dexes
             FROM user_safety_configs
             WHERE token_id = $1 AND chain_id = $2`,
            [this.tokenId.toString(), this.chainId],
        );

        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        return {
            tokenId: row.token_id,
            chainId: row.chain_id,
            allowedTokens: row.allowed_tokens ?? [],
            blockedTokens: row.blocked_tokens ?? [],
            maxTradeAmount: row.max_trade_amount ?? "0",
            maxDailyAmount: row.max_daily_amount ?? "0",
            maxSlippageBps: row.max_slippage_bps ?? 0,
            cooldownSeconds: row.cooldown_seconds ?? 0,
            maxRunsPerDay: row.max_runs_per_day ?? 0,
            allowedDexes: row.allowed_dexes ?? [],
        };
    }

    private async getLastRunTimestamp(): Promise<number | null> {
        const result = await this.pool.query(
            `SELECT EXTRACT(EPOCH FROM timestamp)::int AS ts
             FROM agent_memory
             WHERE token_id = $1 AND type = 'execution'
             ORDER BY timestamp DESC LIMIT 1`,
            [this.tokenId.toString()],
        );
        return result.rows.length > 0 ? result.rows[0].ts : null;
    }

    private async getTodayRunCount(): Promise<number> {
        const result = await this.pool.query(
            `SELECT COUNT(*) AS cnt
             FROM agent_memory
             WHERE token_id = $1 AND type = 'execution'
               AND timestamp >= CURRENT_DATE`,
            [this.tokenId.toString()],
        );
        return parseInt(result.rows[0].cnt, 10);
    }

    private async getTodaySpending(): Promise<bigint> {
        // Sum of execution tx values from agent_memory today.
        // Different actions store the amount under different field names:
        //   - runtime injects 'txValue' (ActionPayload.value) into params
        //   - fallback: 'amountIn' (swap), 'value' (legacy)
        const result = await this.pool.query(
            `SELECT COALESCE(SUM(
                COALESCE(
                    (params->>'txValue')::numeric,
                    (params->>'amountIn')::numeric,
                    (params->>'value')::numeric,
                    0
                )
             ), 0) AS total
             FROM agent_memory
             WHERE token_id = $1 AND type = 'execution'
               AND timestamp >= CURRENT_DATE
               AND result->>'success' = 'true'`,
            [this.tokenId.toString()],
        );
        const total = result.rows[0].total;
        return BigInt(Math.floor(Number(total)));
    }
}
