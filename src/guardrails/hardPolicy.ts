/**
 * Hard Policy — Chain-side PolicyGuardV4 simulation.
 *
 * Uses eth_call to simulate PolicyGuardV4.validate() before submitting.
 * If the on-chain check would revert, we catch it here to avoid gas waste.
 *
 * This is a secondary guardrail — SoftPolicyEngine is the primary filter.
 * Both run in the cognitive loop's "Check" step.
 */

import type { Address, PublicClient, Hex } from "viem";
import type { IGuardrails, PolicyCheckResult, ExecutionContext } from "./interface.js";
import type { ActionPayload } from "../actions/interface.js";

// ═══════════════════════════════════════════════════════
//            Hard Policy Implementation
// ═══════════════════════════════════════════════════════

/** Minimal ABI for PolicyGuardV4.validate — must match contract signature */
const POLICY_GUARD_V4_VALIDATE_ABI = [
    {
        name: "validate",
        type: "function",
        stateMutability: "view",
        inputs: [
            { name: "nfa", type: "address" },
            { name: "tokenId", type: "uint256" },
            { name: "agentAccount", type: "address" },
            { name: "caller", type: "address" },
            {
                name: "action",
                type: "tuple",
                components: [
                    { name: "target", type: "address" },
                    { name: "value", type: "uint256" },
                    { name: "data", type: "bytes" },
                ],
            },
        ],
        outputs: [
            { name: "ok", type: "bool" },
            { name: "reason", type: "string" },
        ],
    },
] as const;

export interface HardPolicyConfig {
    publicClient: PublicClient;
    policyGuardV4Address: Address;
    /** Address of the operator wallet calling the vault */
    operatorAddress: Address;
    /** Address of the AgentNFA contract */
    agentNfaAddress: Address;
    /** Address of the agent's vault (TBA) */
    vaultAddress: Address;
}

export class HardPolicyGuard implements IGuardrails {
    constructor(
        private tokenId: bigint,
        private config: HardPolicyConfig,
    ) { }

    async check(action: ActionPayload, _context: ExecutionContext): Promise<PolicyCheckResult> {
        // Skip if no PolicyGuardV4 configured
        if (this.config.policyGuardV4Address === "0x0000000000000000000000000000000000000000") {
            return { ok: true, violations: [] };
        }

        try {
            const [ok, reason] = await this.config.publicClient.readContract({
                address: this.config.policyGuardV4Address,
                abi: POLICY_GUARD_V4_VALIDATE_ABI,
                functionName: "validate",
                args: [
                    this.config.agentNfaAddress,
                    this.tokenId,
                    this.config.vaultAddress,
                    this.config.operatorAddress,
                    {
                        target: action.target,
                        value: action.value,
                        data: action.data,  // full calldata with selector
                    },
                ],
            }) as [boolean, string];

            if (!ok) {
                return {
                    ok: false,
                    violations: [{
                        policy: "PolicyGuardV4",
                        message: reason || "On-chain policy check failed",
                    }],
                };
            }

            return { ok: true, violations: [] };
        } catch (error) {
            // If the call reverts, treat it as a policy failure
            const message = error instanceof Error ? error.message : "PolicyGuardV4 call failed";
            return {
                ok: false,
                violations: [{
                    policy: "PolicyGuardV4",
                    message: `Simulation reverted: ${message.slice(0, 200)}`,
                }],
            };
        }
    }
}

// ═══════════════════════════════════════════════════════
//         Combined Guardrails (Soft + Hard)
// ═══════════════════════════════════════════════════════

/**
 * Combines SoftPolicyEngine and HardPolicyGuard into a single IGuardrails.
 * Runs soft check first (fast, local), then hard check (RPC call).
 */
export class CombinedGuardrails implements IGuardrails {
    constructor(
        private softPolicy: IGuardrails,
        private hardPolicy: IGuardrails,
    ) { }

    async check(action: ActionPayload, context: ExecutionContext): Promise<PolicyCheckResult> {
        // 1. Soft policy (local, fast)
        const softResult = await this.softPolicy.check(action, context);
        if (!softResult.ok) {
            return softResult;
        }

        // 2. Hard policy (on-chain simulation, slower)
        const hardResult = await this.hardPolicy.check(action, context);
        if (!hardResult.ok) {
            return hardResult;
        }

        return { ok: true, violations: [] };
    }
}
