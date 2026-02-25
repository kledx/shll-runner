/**
 * Run records store operations — recording, listing, cleanup.
 */

import type { Pool } from "pg";
import type { RunRecord } from "../types.js";
import { mapRunRow } from "./helpers.js";

export async function recordRun(
    pool: Pool,
    chainId: number,
    maxRunRecords: number,
    input: Omit<RunRecord, "id" | "createdAt">,
): Promise<RunRecord> {
    const inserted = await pool.query(
        `
        INSERT INTO runs (
            chain_id, token_id, action_type, action_hash, simulate_ok,
            tx_hash, error, params_hash, strategy_explain, failure_category,
            error_code, execution_trace, run_mode, shadow_compare,
            brain_type, intent_type, decision_reason, decision_message,
            gas_used, pnl_usd, violation_code
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21)
        RETURNING *
        `,
        [
            chainId,
            input.tokenId,
            input.actionType,
            input.actionHash,
            input.simulateOk,
            input.txHash ?? null,
            input.error ?? null,
            input.paramsHash ?? null,
            input.strategyExplain ?? null,
            input.failureCategory ?? null,
            input.errorCode ?? null,
            input.executionTrace ? JSON.stringify(input.executionTrace) : null,
            input.runMode ?? "primary",
            input.shadowCompare ? JSON.stringify(input.shadowCompare) : null,
            input.brainType ?? null,
            input.intentType ?? null,
            input.decisionReason ?? null,
            input.decisionMessage ?? null,
            input.gasUsed ?? null,
            input.pnlUsd ?? null,
            input.violationCode ?? null,
        ],
    );

    // Trim old records
    await pool.query(
        `
        DELETE FROM runs
        WHERE id IN (
            SELECT id FROM runs WHERE chain_id = $1
            ORDER BY created_at DESC OFFSET $2
        )
        `,
        [chainId, maxRunRecords],
    );

    return mapRunRow(inserted.rows[0] as Record<string, unknown>);
}

export async function listRuns(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
    limit: number,
): Promise<RunRecord[]> {
    const result = await pool.query(
        `SELECT * FROM runs WHERE chain_id = $1 AND token_id = $2 ORDER BY created_at DESC LIMIT $3`,
        [chainId, tokenId.toString(), limit],
    );
    return result.rows.map((row) => mapRunRow(row as Record<string, unknown>));
}
