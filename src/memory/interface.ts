/**
 * IMemory — Agent memory module.
 *
 * Stores and retrieves historical entries: executions, decisions,
 * blocks, observations. Used by Brain for context-aware reasoning.
 */

// ═══════════════════════════════════════════════════════
//                    Memory Entry Types
// ═══════════════════════════════════════════════════════

export type MemoryEntryType = "execution" | "decision" | "blocked" | "observation";

export interface MemoryEntry {
    /** Entry type */
    type: MemoryEntryType;
    /** Action name (e.g. "swap", "approve", "wait") */
    action?: string;
    /** Action parameters */
    params?: Record<string, unknown>;
    /** Execution result */
    result?: {
        success: boolean;
        txHash?: string;
        error?: string;
    };
    /** Brain reasoning trace (especially useful for LLM brains) */
    reasoning?: string;
    /** When this event occurred */
    timestamp: Date;
}

// ═══════════════════════════════════════════════════════
//                    IMemory Interface
// ═══════════════════════════════════════════════════════

export interface IMemory {
    /** Retrieve recent memory entries, newest first */
    recall(limit?: number): Promise<MemoryEntry[]>;

    /** Store a new memory entry */
    store(entry: MemoryEntry): Promise<void>;

    /** Get a condensed summary string for LLM context */
    getSummary(): Promise<string>;
}
