/**
 * Hard Policy — Chain-side PolicyGuardV4 simulation.
 *
 * Uses eth_call to simulate PolicyGuardV4.validate() before submitting.
 * If the on-chain check would revert, we catch it here to avoid gas waste.
 *
 * This is a secondary guardrail — SoftPolicyEngine is the primary filter.
 * Both run in the cognitive loop's "Check" step.
 *
 * V3.1: Delegates simulation to @shll/runner-sdk PolicySimulator.
 */

import type { Address, PublicClient } from "viem";
import { PolicySimulator } from "@shll/runner-sdk";
import type { IGuardrails, PolicyCheckResult, ExecutionContext } from "./interface.js";
import type { ActionPayload } from "../actions/interface.js";

// ═══════════════════════════════════════════════════════
//            Hard Policy Implementation
// ═══════════════════════════════════════════════════════

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
    private simulator: PolicySimulator;

    constructor(
        private tokenId: bigint,
        private config: HardPolicyConfig,
    ) {
        this.simulator = new PolicySimulator({
            publicClient: config.publicClient as any,
            policyGuardV4Address: config.policyGuardV4Address,
            operatorAddress: config.operatorAddress,
            agentNfaAddress: config.agentNfaAddress,
        });
    }

    async check(action: ActionPayload, _context: ExecutionContext): Promise<PolicyCheckResult> {
        // Skip if no PolicyGuardV4 configured
        if (this.config.policyGuardV4Address === "0x0000000000000000000000000000000000000000") {
            return { ok: true, violations: [] };
        }

        try {
            const result = await this.simulator.simulateAction(
                this.tokenId,
                this.config.vaultAddress,
                {
                    target: action.target,
                    value: action.value,
                    data: action.data,
                }
            );

            if (!result.ok) {
                const isWhitelistError = (result.reason ?? "").toLowerCase().includes("not in whitelist");
                // Phase 4: Enrich whitelist errors with token address from context
                const metadata: Record<string, string> | undefined =
                    isWhitelistError && _context.actionTokens && _context.actionTokens.length > 0
                        ? { tokenAddress: _context.actionTokens[_context.actionTokens.length - 1] }
                        : undefined;
                return {
                    ok: false,
                    violations: [{
                        code: "HARD_POLICY_REJECTED",
                        policy: "PolicyGuardV4",
                        message: result.reason || "On-chain policy check failed",
                        metadata,
                    }],
                };
            }

            return { ok: true, violations: [] };
        } catch (error) {
            const message = error instanceof Error ? error.message : "PolicyGuardV4 call failed";
            return {
                ok: false,
                violations: [{
                    code: "HARD_SIMULATION_REVERTED",
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
