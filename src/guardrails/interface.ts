/**
 * IGuardrails — Safety check module for Agent actions.
 *
 * Two layers:
 *   1. Soft Policy (Runner-side): fast local check against user_safety_configs
 *   2. Hard Policy (chain-side):  simulated PolicyGuardV4.validate() via eth_call
 *
 * Both run before submitting a transaction. The chain-side PolicyGuardV4
 * is always the final authority — guardrails here are a pre-flight filter
 * to avoid wasting gas on transactions that would revert.
 */

import type { ActionPayload } from "../actions/interface.js";

// ═══════════════════════════════════════════════════════
//                    Check Result Types
// ═══════════════════════════════════════════════════════

export interface PolicyViolation {
    /** Which policy triggered the violation */
    policy: string;
    /** Human-readable rejection reason */
    message: string;
}

export interface PolicyCheckResult {
    /** True if all policies passed */
    ok: boolean;
    /** List of violations (empty if ok=true) */
    violations: PolicyViolation[];
}

// ═══════════════════════════════════════════════════════
//                    Execution Context
// ═══════════════════════════════════════════════════════

/** Context passed to guardrails for policy evaluation */
export interface ExecutionContext {
    /** Agent token ID */
    tokenId: bigint;
    /** Agent type */
    agentType: string;
    /** Vault address */
    vault: string;
    /** Current block timestamp */
    timestamp: number;
}

// ═══════════════════════════════════════════════════════
//                    IGuardrails Interface
// ═══════════════════════════════════════════════════════

export interface IGuardrails {
    /**
     * Check an action payload against all safety policies.
     *
     * @param action  The encoded transaction to validate
     * @param context Execution context (tokenId, vault, etc.)
     * @returns PolicyCheckResult with ok flag and any violations
     */
    check(
        action: ActionPayload,
        context: ExecutionContext,
    ): Promise<PolicyCheckResult>;
}
