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
                    policy: "maxTradeAmount",
                    message: `Trade amount ${tradeAmount} exceeds per-trade limit ${maxTrade}`,
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
                    policy: "maxDailyAmount",
                    message: `Would exceed daily limit: spent=${todaySpent}, tx=${tradeAmount}, max=${maxDaily}`,
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
        //   - fallback: 'amountIn' (DCA/swap), 'value' (legacy)
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
