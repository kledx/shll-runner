/**
 * Autopilot store operations — enable/disable/lock/lease management.
 */

import type { Pool } from "pg";
import type { AutopilotRecord } from "../types.js";
import { mapAutopilotRow } from "./helpers.js";

export interface UpsertEnableInput {
    tokenId: bigint;
    renter: string;
    operator: string;
    permitExpires: bigint;
    permitDeadline: bigint;
    sig: string;
    txHash: string;
}

export async function upsertEnabled(
    pool: Pool,
    chainId: number,
    input: UpsertEnableInput,
): Promise<AutopilotRecord> {
    const result = await pool.query(
        `
        INSERT INTO autopilots (
            chain_id, token_id, renter, operator,
            permit_expires, permit_deadline, sig,
            enabled, last_reason, last_enable_tx_hash,
            locked_until, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NULL,$8,NULL,NOW())
        ON CONFLICT (chain_id, token_id)
        DO UPDATE SET
            renter = EXCLUDED.renter,
            operator = EXCLUDED.operator,
            permit_expires = EXCLUDED.permit_expires,
            permit_deadline = EXCLUDED.permit_deadline,
            sig = EXCLUDED.sig,
            enabled = TRUE,
            last_reason = NULL,
            last_enable_tx_hash = EXCLUDED.last_enable_tx_hash,
            locked_until = NULL,
            updated_at = NOW()
        RETURNING *
        `,
        [
            chainId,
            input.tokenId.toString(),
            input.renter,
            input.operator,
            input.permitExpires.toString(),
            input.permitDeadline.toString(),
            input.sig,
            input.txHash,
        ],
    );
    return mapAutopilotRow(result.rows[0] as Record<string, unknown>);
}

export async function disable(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
    reason: string,
    txHash?: string,
): Promise<AutopilotRecord> {
    const result = await pool.query(
        `
        INSERT INTO autopilots (
            chain_id, token_id, renter, operator,
            permit_expires, permit_deadline, sig,
            enabled, last_reason, last_disable_tx_hash,
            locked_until, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8,$9,NULL,NOW())
        ON CONFLICT (chain_id, token_id)
        DO UPDATE SET
            enabled = FALSE,
            last_reason = EXCLUDED.last_reason,
            last_disable_tx_hash = COALESCE(EXCLUDED.last_disable_tx_hash, autopilots.last_disable_tx_hash),
            locked_until = NULL,
            updated_at = NOW()
        RETURNING *
        `,
        [
            chainId,
            tokenId.toString(),
            "0x0000000000000000000000000000000000000000",
            "0x0000000000000000000000000000000000000000",
            "0",
            "0",
            "0x",
            reason,
            txHash ?? null,
        ],
    );
    return mapAutopilotRow(result.rows[0] as Record<string, unknown>);
}

export async function getAutopilot(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
): Promise<AutopilotRecord | null> {
    const result = await pool.query(
        `SELECT * FROM autopilots WHERE chain_id = $1 AND token_id = $2 LIMIT 1`,
        [chainId, tokenId.toString()],
    );
    if (result.rows.length === 0) return null;
    return mapAutopilotRow(result.rows[0] as Record<string, unknown>);
}

export async function listEnabledTokenIds(
    pool: Pool,
    chainId: number,
): Promise<bigint[]> {
    const result = await pool.query(
        `SELECT token_id FROM autopilots WHERE chain_id = $1 AND enabled = TRUE ORDER BY token_id ASC`,
        [chainId],
    );
    return result.rows.map((row) => BigInt(String(row.token_id)));
}

export async function listSchedulableTokenIds(
    pool: Pool,
    chainId: number,
): Promise<bigint[]> {
    const result = await pool.query(
        `
        SELECT DISTINCT ts.token_id
        FROM token_strategies ts
        JOIN autopilots ap ON ts.chain_id = ap.chain_id AND ts.token_id = ap.token_id
        WHERE ts.chain_id = $1 AND ts.enabled = TRUE AND ap.enabled = TRUE
        ORDER BY COALESCE(ts.next_check_at, '1970-01-01'::timestamptz) ASC
        `,
        [chainId],
    );
    return result.rows.map((row) => BigInt(String(row.token_id)));
}

export async function getEarliestNextCheckAt(
    pool: Pool,
    chainId: number,
): Promise<Date | null> {
    const result = await pool.query(
        `
        SELECT MIN(COALESCE(ts.next_check_at, NOW())) AS next_check_at
        FROM token_strategies ts
        JOIN autopilots ap ON ts.chain_id = ap.chain_id AND ts.token_id = ap.token_id
        WHERE ts.chain_id = $1 AND ts.enabled = TRUE AND ap.enabled = TRUE
        `,
        [chainId],
    );
    const raw = result.rows[0]?.next_check_at as string | Date | null | undefined;
    if (!raw) return null;
    return new Date(raw);
}

export async function listAutopilots(
    pool: Pool,
    chainId: number,
): Promise<AutopilotRecord[]> {
    const result = await pool.query(
        `SELECT * FROM autopilots WHERE chain_id = $1 ORDER BY token_id ASC`,
        [chainId],
    );
    return result.rows.map((row) => mapAutopilotRow(row as Record<string, unknown>));
}

export async function tryAcquireAutopilotLock(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
    leaseMs: number,
): Promise<boolean> {
    const result = await pool.query(
        `
        UPDATE autopilots
        SET locked_until = NOW() + ($3::text || ' milliseconds')::interval, updated_at = NOW()
        WHERE chain_id = $1 AND token_id = $2
            AND enabled = TRUE
            AND (locked_until IS NULL OR locked_until <= NOW())
        RETURNING token_id
        `,
        [chainId, tokenId.toString(), Math.max(1, leaseMs)],
    );
    return result.rows.length > 0;
}

export async function releaseAutopilotLock(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
): Promise<void> {
    await pool.query(
        `UPDATE autopilots SET locked_until = NULL, updated_at = NOW() WHERE chain_id = $1 AND token_id = $2`,
        [chainId, tokenId.toString()],
    );
}

export async function countActiveAutopilotLocks(
    pool: Pool,
    chainId: number,
): Promise<number> {
    const result = await pool.query(
        `SELECT COUNT(*)::int AS count FROM autopilots WHERE chain_id = $1 AND enabled = TRUE AND locked_until > NOW()`,
        [chainId],
    );
    return Number(result.rows[0]?.count ?? 0);
}
