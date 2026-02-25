/**
 * Strategy store operations — CRUD, budget, and scheduling.
 */

import type { Pool } from "pg";
import type { StrategyConfigRecord, StrategyType } from "../types.js";
import { mapStrategyRow } from "./helpers.js";

export interface UpsertStrategyInput {
    tokenId: bigint;
    strategyType: StrategyType;
    target: string;
    data: string;
    value: bigint;
    strategyParams: Record<string, unknown>;
    source: string;
    minIntervalMs: number;
    requirePositiveBalance: boolean;
    maxFailures: number;
    enabled: boolean;
}

export async function refreshDailyBudget(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
): Promise<void> {
    await pool.query(
        `
        UPDATE token_strategies
        SET
            budget_day = CURRENT_DATE,
            daily_runs_used = CASE
                WHEN budget_day IS NULL OR budget_day < CURRENT_DATE THEN 0
                ELSE daily_runs_used
            END,
            daily_value_used = CASE
                WHEN budget_day IS NULL OR budget_day < CURRENT_DATE THEN 0
                ELSE daily_value_used
            END,
            updated_at = NOW()
        WHERE chain_id = $1 AND token_id = $2
        `,
        [chainId, tokenId.toString()],
    );
}

export async function checkBudget(
    pool: Pool,
    chainId: number,
    input: {
        tokenId: bigint;
        nextValue: bigint;
        maxRunsPerDay: number;
        maxValuePerDay: bigint;
    },
): Promise<{ ok: true } | { ok: false; reason: string }> {
    await refreshDailyBudget(pool, chainId, input.tokenId);
    const strategy = await getStrategy(pool, chainId, input.tokenId);
    if (!strategy) return { ok: false, reason: "strategy not found" };

    if (
        input.maxRunsPerDay > 0 &&
        strategy.dailyRunsUsed + 1 > input.maxRunsPerDay
    ) {
        return {
            ok: false,
            reason: `Daily run budget exceeded (${strategy.dailyRunsUsed}/${input.maxRunsPerDay})`,
        };
    }

    if (input.maxValuePerDay > 0n) {
        const used = BigInt(strategy.dailyValueUsed);
        if (used + input.nextValue > input.maxValuePerDay) {
            return {
                ok: false,
                reason: `Daily value budget exceeded (${used.toString()}/${input.maxValuePerDay.toString()})`,
            };
        }
    }

    return { ok: true };
}

export async function consumeBudget(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
    value: bigint,
): Promise<void> {
    await refreshDailyBudget(pool, chainId, tokenId);
    await pool.query(
        `
        UPDATE token_strategies
        SET daily_runs_used = daily_runs_used + 1, daily_value_used = daily_value_used + $3, updated_at = NOW()
        WHERE chain_id = $1 AND token_id = $2
        `,
        [chainId, tokenId.toString(), value.toString()],
    );
}

export async function upsertStrategy(
    pool: Pool,
    chainId: number,
    input: UpsertStrategyInput,
): Promise<StrategyConfigRecord> {
    const result = await pool.query(
        `
        INSERT INTO token_strategies (
            chain_id, token_id, strategy_type, target, data, value,
            strategy_params, source, min_interval_ms, require_positive_balance,
            max_failures, failure_count, budget_day, daily_runs_used,
            daily_value_used, enabled, last_error, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,0,CURRENT_DATE,0,0,$12,NULL,NOW())
        ON CONFLICT (chain_id, token_id)
        DO UPDATE SET
            strategy_type = EXCLUDED.strategy_type,
            target = EXCLUDED.target,
            data = EXCLUDED.data,
            value = EXCLUDED.value,
            strategy_params = EXCLUDED.strategy_params,
            source = EXCLUDED.source,
            min_interval_ms = EXCLUDED.min_interval_ms,
            require_positive_balance = EXCLUDED.require_positive_balance,
            max_failures = EXCLUDED.max_failures,
            enabled = EXCLUDED.enabled,
            failure_count = CASE WHEN EXCLUDED.enabled THEN 0 ELSE token_strategies.failure_count END,
            last_error = CASE WHEN EXCLUDED.enabled THEN NULL ELSE token_strategies.last_error END,
            updated_at = NOW()
        RETURNING *
        `,
        [
            chainId,
            input.tokenId.toString(),
            input.strategyType,
            input.target,
            input.data,
            input.value.toString(),
            JSON.stringify(input.strategyParams ?? {}),
            input.source,
            input.minIntervalMs,
            input.requirePositiveBalance,
            input.maxFailures,
            input.enabled,
        ],
    );
    return mapStrategyRow(result.rows[0] as Record<string, unknown>);
}

export async function getStrategy(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
): Promise<StrategyConfigRecord | null> {
    const result = await pool.query(
        `SELECT * FROM token_strategies WHERE chain_id = $1 AND token_id = $2 LIMIT 1`,
        [chainId, tokenId.toString()],
    );
    if (result.rows.length === 0) return null;
    return mapStrategyRow(result.rows[0] as Record<string, unknown>);
}

export async function clearTradingGoal(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
): Promise<void> {
    await pool.query(
        `
        UPDATE token_strategies
        SET strategy_params = (
            CASE
                WHEN strategy_params ? 'tradingGoal' AND strategy_params->>'tradingGoal' != ''
                THEN jsonb_set(
                    strategy_params,
                    '{goalHistory}',
                    COALESCE(strategy_params->'goalHistory', '[]'::jsonb) ||
                        jsonb_build_array(jsonb_build_object(
                            'text', strategy_params->'tradingGoal',
                            'savedAt', COALESCE(strategy_params->'goalSetAt', to_jsonb(updated_at::text))
                        ))
                ) - 'tradingGoal' - 'goalSetAt'
                ELSE strategy_params - 'tradingGoal' - 'goalSetAt'
            END
        ),
            updated_at = NOW()
        WHERE chain_id = $1 AND token_id = $2
        `,
        [chainId, tokenId.toString()],
    );
}

export async function listStrategies(
    pool: Pool,
    chainId: number,
): Promise<StrategyConfigRecord[]> {
    const result = await pool.query(
        `SELECT * FROM token_strategies WHERE chain_id = $1 ORDER BY token_id ASC`,
        [chainId],
    );
    return result.rows.map((row) => mapStrategyRow(row as Record<string, unknown>));
}

export async function updateNextCheckAt(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
    nextCheckAt: Date,
): Promise<void> {
    await pool.query(
        `UPDATE token_strategies SET next_check_at = $3, updated_at = NOW() WHERE chain_id = $1 AND token_id = $2`,
        [chainId, tokenId.toString(), nextCheckAt.toISOString()],
    );
}

export async function getNextCheckAt(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
): Promise<Date | null> {
    const result = await pool.query(
        `SELECT next_check_at FROM token_strategies WHERE chain_id = $1 AND token_id = $2 LIMIT 1`,
        [chainId, tokenId.toString()],
    );
    if (result.rows.length === 0 || result.rows[0].next_check_at == null) return null;
    return new Date(result.rows[0].next_check_at as string);
}

export async function recordSuccess(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
): Promise<void> {
    await pool.query(
        `
        UPDATE token_strategies
        SET last_run_at = NOW(), failure_count = 0, last_error = NULL, updated_at = NOW()
        WHERE chain_id = $1 AND token_id = $2
        `,
        [chainId, tokenId.toString()],
    );
}

export async function recordFailure(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
    error: string,
): Promise<StrategyConfigRecord | null> {
    const updated = await pool.query(
        `
        UPDATE token_strategies
        SET failure_count = failure_count + 1, last_error = $3, updated_at = NOW()
        WHERE chain_id = $1 AND token_id = $2
        RETURNING *
        `,
        [chainId, tokenId.toString(), error.slice(0, 500)],
    );
    if (updated.rows.length === 0) return null;
    const strategy = mapStrategyRow(updated.rows[0] as Record<string, unknown>);
    if (strategy.failureCount >= strategy.maxFailures && strategy.enabled) {
        const disabled = await pool.query(
            `
            UPDATE token_strategies SET enabled = FALSE, updated_at = NOW()
            WHERE chain_id = $1 AND token_id = $2 RETURNING *
            `,
            [chainId, tokenId.toString()],
        );
        return mapStrategyRow(disabled.rows[0] as Record<string, unknown>);
    }
    return strategy;
}
