/**
 * PgMemory — PostgreSQL-backed IMemory implementation.
 *
 * Uses the `agent_memory` table for persistent storage of
 * agent execution history, decisions, and observations.
 */

import type { Pool } from "pg";
import type { IMemory, MemoryEntry, MemoryEntryType } from "./interface.js";

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
             WHERE token_id = $1
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
