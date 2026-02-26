/**
 * Trigger Store — Global trigger queries across all agents.
 *
 * Unlike PgMemory (which is scoped to a single tokenId),
 * this module provides cross-agent trigger queries for the
 * scheduler's trigger evaluation phase.
 */

import type { Pool } from "pg";
import type { TriggerGoal } from "./interface.js";

/**
 * Load all active triggers across all agents.
 * Used by the scheduler to batch-evaluate triggers.
 */
export async function loadAllActiveTriggers(pool: Pool): Promise<TriggerGoal[]> {
    const result = await pool.query(
        `SELECT token_id, action AS goal_id, params AS payload,
                reasoning AS message, timestamp AS created_at
         FROM agent_memory
         WHERE type = 'trigger' AND result IS NULL
         ORDER BY timestamp ASC
         LIMIT 100`,
    );

    return result.rows.map(row => {
        const payload = (typeof row.payload === "string"
            ? JSON.parse(row.payload)
            : row.payload) as Record<string, unknown>;
        return {
            goalId: String(row.goal_id),
            condition: payload.condition as TriggerGoal["condition"],
            action: payload.action as TriggerGoal["action"],
            tokenId: BigInt(row.token_id),
            createdAt: new Date(row.created_at as string),
            basePrice: payload.basePrice as number | undefined,
            lastTriggeredAt: payload.lastTriggeredAt
                ? new Date(payload.lastTriggeredAt as string)
                : undefined,
        };
    });
}

/**
 * Mark a trigger as fired (completed).
 */
export async function completeTriggerGlobal(
    pool: Pool,
    tokenId: bigint,
    goalId: string,
    result: string,
): Promise<void> {
    await pool.query(
        `UPDATE agent_memory
         SET result = $3::jsonb
         WHERE token_id = $1 AND type = 'trigger' AND action = $2 AND result IS NULL`,
        [tokenId.toString(), goalId, JSON.stringify({ fired: true, result })],
    );
}
