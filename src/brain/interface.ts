/**
 * IBrain — Decision-making module for Agent cognitive loop.
 *
 * Takes observation + memories + available actions → produces a Decision.
 * Two implementation families:
 *   - RuleBrain: deterministic logic (DCA, hot token tracking)
 *   - LLMBrain: AI reasoning via LLM (ReAct loop)
 */

import type { Observation } from "../perception/interface.js";
import type { MemoryEntry } from "../memory/interface.js";
import type { IAction } from "../actions/interface.js";

// ═══════════════════════════════════════════════════════
//                    Decision Output
// ═══════════════════════════════════════════════════════

export interface Decision {
    /** Action name to execute, or "wait" to skip this cycle */
    action: string;
    /** Parameters for the chosen action */
    params: Record<string, unknown>;
    /** Internal reasoning for why this decision was made (for logs/debugging) */
    reasoning: string;
    /** User-facing message — what the agent says to the user */
    message?: string;
    /** Confidence score 0-1 (1 = certain, used by guardrails for threshold) */
    confidence: number;
    /** If true, task is fully complete — scheduler should disable autopilot */
    done?: boolean;
    /** Suggested ms until next check (scheduler enforces minIntervalMs floor) */
    nextCheckMs?: number;
    /** If true, agent cannot proceed due to missing prerequisites (e.g. no funds) */
    blocked?: boolean;
    /** Reason why the agent is blocked (user-facing) */
    blockReason?: string;
}

// ═══════════════════════════════════════════════════════
//                    IBrain Interface
// ═══════════════════════════════════════════════════════

export interface IBrain {
    /**
     * Analyze the current observation, past memories, and available actions
     * to produce a Decision.
     *
     * @param obs      Current environment snapshot
     * @param memories Recent history entries
     * @param actions  Available actions for the agent
     * @returns        Decision with action name, params, reasoning, confidence
     */
    think(
        obs: Observation,
        memories: MemoryEntry[],
        actions: IAction[],
    ): Promise<Decision>;
}
