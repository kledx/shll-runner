/**
 * PgMemory — PostgreSQL-backed IMemory implementation.
 *
 * Uses the `agent_memory` table for persistent storage of
 * agent execution history, decisions, and observations.
 */

import type { Pool } from "pg";
import type { IMemory, MemoryEntry, MemoryEntryType, GoalEntry } from "./interface.js";

// ═══════════════════════════════════════════════════════
//            PgMemory Implementation
// ═══════════════════════════════════════════════════════

export class PgMemory implements IMemory {
    constructor(
        private tokenId: bigint,
        private pool: Pool,
    ) { }

    async recall(limit = 20): Promise<MemoryEntry[]> {
        const result = await this.pool.query(
            `SELECT type, action, params, result, reasoning, timestamp
             FROM agent_memory
             WHERE token_id = $1 AND type != 'goal'
             ORDER BY timestamp DESC
             LIMIT $2`,
            [this.tokenId.toString(), limit],
        );

        return result.rows.map(mapRowToEntry);
    }

    async store(entry: MemoryEntry): Promise<void> {
        await this.pool.query(
            `INSERT INTO agent_memory (token_id, type, action, params, result, reasoning, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                this.tokenId.toString(),
                entry.type,
                entry.action ?? null,
                entry.params ? JSON.stringify(entry.params) : null,
                entry.result ? JSON.stringify(entry.result) : null,
                entry.reasoning ?? null,
                entry.timestamp.toISOString(),
            ],
        );
    }

    async getSummary(): Promise<string> {
        // Recent history condensed for LLM context
        const entries = await this.recall(10);
        if (entries.length === 0) {
            return "No previous activity.";
        }

        const lines = entries.map(e => {
            const ts = e.timestamp.toISOString().slice(0, 19);
            const action = e.action ?? "N/A";
            const status = e.result?.success === true ? "OK" :
                e.result?.success === false ? "FAIL" : "";
            return `[${ts}] ${e.type}: ${action} ${status} — ${e.reasoning ?? ""}`.trim();
        });

        return lines.join("\n");
    }

    // ── Goal Tracking ──────────────────────────────────

    /**
     * Store or update an active goal.
     * Uses agent_memory with type='goal', action=goalId.
     * Upsert: if goalId exists, update description and metadata.
     */
    async storeGoal(goalId: string, description: string, metadata?: Record<string, unknown>): Promise<void> {
        // Check if goal already exists
        const existing = await this.pool.query(
            `SELECT 1 FROM agent_memory
             WHERE token_id = $1 AND type = 'goal' AND action = $2
             LIMIT 1`,
            [this.tokenId.toString(), goalId],
        );

        if (existing.rows.length > 0) {
            // Update existing goal
            await this.pool.query(
                `UPDATE agent_memory
                 SET reasoning = $3, params = $4, timestamp = NOW()
                 WHERE token_id = $1 AND type = 'goal' AND action = $2`,
                [
                    this.tokenId.toString(),
                    goalId,
                    description,
                    metadata ? JSON.stringify(metadata) : null,
                ],
            );
        } else {
            // Insert new goal
            await this.pool.query(
                `INSERT INTO agent_memory (token_id, type, action, params, result, reasoning, timestamp)
                 VALUES ($1, 'goal', $2, $3, NULL, $4, NOW())`,
                [
                    this.tokenId.toString(),
                    goalId,
                    metadata ? JSON.stringify(metadata) : null,
                    description,
                ],
            );
        }
    }

    /**
     * Get all active (non-completed) goals for this agent.
     * Active = type='goal' AND result IS NULL (completed goals have result set).
     */
    async getActiveGoals(): Promise<GoalEntry[]> {
        const result = await this.pool.query(
            `SELECT action AS goal_id, reasoning AS description, params AS metadata,
                    timestamp AS created_at
             FROM agent_memory
             WHERE token_id = $1 AND type = 'goal' AND result IS NULL
             ORDER BY timestamp ASC
             LIMIT 10`,
            [this.tokenId.toString()],
        );

        return result.rows.map(row => ({
            goalId: String(row.goal_id),
            description: String(row.description ?? ""),
            metadata: row.metadata as Record<string, unknown> | undefined,
            createdAt: new Date(row.created_at as string),
        }));
    }

    /**
     * Mark a goal as completed (sets result to {success: true}).
     */
    async completeGoal(goalId: string): Promise<void> {
        await this.pool.query(
            `UPDATE agent_memory
             SET result = '{"success": true}'::jsonb
             WHERE token_id = $1 AND type = 'goal' AND action = $2 AND result IS NULL`,
            [this.tokenId.toString(), goalId],
        );
    }
}

// ═══════════════════════════════════════════════════════
//                    Row Mapper
// ═══════════════════════════════════════════════════════

function mapRowToEntry(row: Record<string, unknown>): MemoryEntry {
    return {
        type: row.type as MemoryEntryType,
        action: row.action as string | undefined,
        params: row.params as Record<string, unknown> | undefined,
        result: row.result as MemoryEntry["result"],
        reasoning: row.reasoning as string | undefined,
        timestamp: new Date(row.timestamp as string),
    };
}
