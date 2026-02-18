/**
 * IAction — Composable action module for Agent.
 *
 * Each action encapsulates a single capability (swap, approve, wrap, etc).
 * Actions can be:
 *   - On-chain: produce an ActionPayload for blockchain execution
 *   - Read-only: analytics/portfolio queries that don't produce transactions
 */

import type { Address, Hex } from "viem";

// ═══════════════════════════════════════════════════════
//                    Action Payload
// ═══════════════════════════════════════════════════════

/** On-chain transaction payload (target + value + calldata) */
export interface ActionPayload {
    target: Address;
    value: bigint;
    data: Hex;
}

// ═══════════════════════════════════════════════════════
//                    IAction Interface
// ═══════════════════════════════════════════════════════

export interface IAction {
    /** Unique action name: "swap", "approve", "wrap", "analytics", etc. */
    name: string;

    /** Human-readable description (also used in LLM system prompt) */
    description: string;

    /**
     * Whether this action is read-only (no on-chain tx).
     * Read-only actions (analytics, portfolio) return data but produce
     * no ActionPayload for chain execution.
     */
    readonly: boolean;

    /**
     * Encode decision params into an on-chain ActionPayload.
     * For readonly actions, this returns a "no-op" payload.
     *
     * @param params Decision parameters from Brain
     * @returns ActionPayload ready for chain submission
     */
    encode(params: Record<string, unknown>): ActionPayload;
}
