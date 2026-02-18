/**
 * IAction — Composable action module for Agent.
 *
 * Each action encapsulates a single capability (swap, approve, wrap, etc).
 * Actions can be:
 *   - On-chain: produce an ActionPayload for blockchain execution
 *   - Read-only: tool calls that return data to the Brain (analytics, portfolio)
 *
 * V3.1: Added `parameters` for LLM tool calling and `execute()` for read-only tools.
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
//               Tool Parameter Schema
// ═══════════════════════════════════════════════════════

/** JSON Schema subset for describing tool parameters (OpenAI format) */
export interface ToolParameters {
    type: "object";
    properties: Record<string, {
        type: string;
        description: string;
        enum?: string[];
    }>;
    required?: string[];
}

/** Result returned by a read-only tool execution */
export interface ToolResult {
    /** Whether the tool executed successfully */
    success: boolean;
    /** Data payload (JSON-serializable, will be sent back to LLM) */
    data: unknown;
    /** Error message if failed */
    error?: string;
}

// ═══════════════════════════════════════════════════════
//                    IAction Interface
// ═══════════════════════════════════════════════════════

export interface IAction {
    /** Unique action name: "swap", "approve", "wrap", "analytics", etc. */
    name: string;

    /** Human-readable description (used in LLM tool definitions) */
    description: string;

    /**
     * Whether this action is read-only (no on-chain tx).
     * Read-only actions (analytics, portfolio) execute locally and return
     * data to the Brain for further reasoning. They do NOT produce
     * an ActionPayload for chain execution.
     */
    readonly: boolean;

    /**
     * JSON Schema describing the parameters this action accepts.
     * Used to generate OpenAI-compatible `tools` definitions for LLM.
     */
    parameters: ToolParameters;

    /**
     * Execute a read-only tool and return data to the Brain.
     * Only called for `readonly: true` actions.
     * Returns a ToolResult with data that gets fed back to LLM.
     *
     * For write actions, this is not called — use encode() instead.
     */
    execute?(params: Record<string, unknown>): Promise<ToolResult>;

    /**
     * Encode decision params into an on-chain ActionPayload.
     * For readonly actions, this returns a "no-op" payload (backward compat).
     *
     * @param params Decision parameters from Brain
     * @returns ActionPayload ready for chain submission
     */
    encode(params: Record<string, unknown>): ActionPayload;
}
