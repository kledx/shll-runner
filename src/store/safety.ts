/**
 * Safety Config Store — CRUD for user_safety_configs table.
 *
 * Provides API-layer access to user safety configurations.
 * Used by:
 *   - SoftPolicyEngine (guardrails/softPolicy.ts) for reads
 *   - API routes (api/routes/safety.ts) for CRUD
 */

import type { Pool } from "pg";
import type { UserSafetyConfig } from "../guardrails/softPolicy.js";

// ═══════════════════════════════════════════════════════
//              Safety Config Input Types
// ═══════════════════════════════════════════════════════

export interface SafetyConfigInput {
    tokenId: string;
    chainId: number;
    allowedTokens?: string[];
    blockedTokens?: string[];
    maxTradeAmount?: string;
    maxDailyAmount?: string;
    maxSlippageBps?: number;
    cooldownSeconds?: number;
    maxRunsPerDay?: number;
    allowedDexes?: string[];
}

// ═══════════════════════════════════════════════════════
//                Safety Config Store
// ═══════════════════════════════════════════════════════

export class SafetyConfigStore {
    constructor(
        private pool: Pool,
        private chainId: number,
    ) { }

    /** Get safety config for a specific agent */
    async get(tokenId: string): Promise<UserSafetyConfig | null> {
        const result = await this.pool.query(
            `SELECT * FROM user_safety_configs WHERE token_id = $1 AND chain_id = $2`,
            [tokenId, this.chainId],
        );
        if (result.rows.length === 0) return null;
        return mapRow(result.rows[0]);
    }

    /** Create a new safety config */
    async create(input: SafetyConfigInput): Promise<UserSafetyConfig> {
        const result = await this.pool.query(
            `INSERT INTO user_safety_configs (
                token_id, chain_id, allowed_tokens, blocked_tokens,
                max_trade_amount, max_daily_amount, max_slippage_bps,
                cooldown_seconds, max_runs_per_day, allowed_dexes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *`,
            [
                input.tokenId,
                input.chainId,
                JSON.stringify(input.allowedTokens ?? []),
                JSON.stringify(input.blockedTokens ?? []),
                input.maxTradeAmount ?? "0",
                input.maxDailyAmount ?? "0",
                input.maxSlippageBps ?? 0,
                input.cooldownSeconds ?? 0,
                input.maxRunsPerDay ?? 0,
                JSON.stringify(input.allowedDexes ?? []),
            ],
        );
        return mapRow(result.rows[0]);
    }

    /** Update existing safety config (partial update) */
    async update(tokenId: string, updates: Partial<SafetyConfigInput>): Promise<UserSafetyConfig | null> {
        const setClauses: string[] = [];
        const params: unknown[] = [tokenId, this.chainId];
        let idx = 3;

        if (updates.allowedTokens !== undefined) {
            setClauses.push(`allowed_tokens = $${idx++}`);
            params.push(JSON.stringify(updates.allowedTokens));
        }
        if (updates.blockedTokens !== undefined) {
            setClauses.push(`blocked_tokens = $${idx++}`);
            params.push(JSON.stringify(updates.blockedTokens));
        }
        if (updates.maxTradeAmount !== undefined) {
            setClauses.push(`max_trade_amount = $${idx++}`);
            params.push(updates.maxTradeAmount);
        }
        if (updates.maxDailyAmount !== undefined) {
            setClauses.push(`max_daily_amount = $${idx++}`);
            params.push(updates.maxDailyAmount);
        }
        if (updates.maxSlippageBps !== undefined) {
            setClauses.push(`max_slippage_bps = $${idx++}`);
            params.push(updates.maxSlippageBps);
        }
        if (updates.cooldownSeconds !== undefined) {
            setClauses.push(`cooldown_seconds = $${idx++}`);
            params.push(updates.cooldownSeconds);
        }
        if (updates.maxRunsPerDay !== undefined) {
            setClauses.push(`max_runs_per_day = $${idx++}`);
            params.push(updates.maxRunsPerDay);
        }
        if (updates.allowedDexes !== undefined) {
            setClauses.push(`allowed_dexes = $${idx++}`);
            params.push(JSON.stringify(updates.allowedDexes));
        }

        if (setClauses.length === 0) {
            return this.get(tokenId);
        }

        setClauses.push("updated_at = NOW()");

        const result = await this.pool.query(
            `UPDATE user_safety_configs
             SET ${setClauses.join(", ")}
             WHERE token_id = $1 AND chain_id = $2
             RETURNING *`,
            params,
        );

        if (result.rows.length === 0) return null;
        return mapRow(result.rows[0]);
    }

    /** Delete (reset) safety config */
    async delete(tokenId: string): Promise<boolean> {
        const result = await this.pool.query(
            `DELETE FROM user_safety_configs WHERE token_id = $1 AND chain_id = $2`,
            [tokenId, this.chainId],
        );
        return (result.rowCount ?? 0) > 0;
    }
}

// ── Row mapper ─────────────────────────────────────────

function mapRow(row: Record<string, unknown>): UserSafetyConfig {
    return {
        tokenId: String(row.token_id),
        chainId: Number(row.chain_id),
        allowedTokens: (row.allowed_tokens ?? []) as string[],
        blockedTokens: (row.blocked_tokens ?? []) as string[],
        maxTradeAmount: String(row.max_trade_amount ?? "0"),
        maxDailyAmount: String(row.max_daily_amount ?? "0"),
        maxSlippageBps: Number(row.max_slippage_bps ?? 0),
        cooldownSeconds: Number(row.cooldown_seconds ?? 0),
        maxRunsPerDay: Number(row.max_runs_per_day ?? 0),
        allowedDexes: (row.allowed_dexes ?? []) as string[],
    };
}
