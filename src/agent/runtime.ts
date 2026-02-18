/**
 * Agent Runtime — The cognitive loop.
 *
 * Drives a single execution cycle for an Agent:
 *   1. Perceive  — observe environment
 *   2. Remember  — recall past experiences
 *   3. Think     — brain decides action
 *   4. Encode    — convert decision to on-chain payload
 *   5. Check     — guardrails safety validation
 *   6. Act       — submit transaction (external responsibility)
 *   7. Learn     — store memory entry
 *
 * The runtime does NOT handle scheduling — that's the caller's job.
 * It focuses purely on orchestrating one cycle of the cognitive loop.
 */

import type { Agent } from "./agent.js";
import type { ActionPayload } from "../actions/interface.js";
import type { ExecutionContext } from "../guardrails/interface.js";

// ═══════════════════════════════════════════════════════
//                   Run Result
// ═══════════════════════════════════════════════════════

export interface RunResult {
    /** Whether the agent decided to act (vs wait) */
    acted: boolean;
    /** Action name executed (or "wait") */
    action: string;
    /** Brain reasoning */
    reasoning: string;
    /** Decision params (with injected vault/txValue) */
    params?: Record<string, unknown>;
    /** Encoded payload (undefined if wait or blocked) */
    payload?: ActionPayload;
    /** Whether guardrails blocked the action */
    blocked: boolean;
    /** Block reason if blocked */
    blockReason?: string;
    /** LLM signals task is complete — scheduler should disable autopilot */
    done?: boolean;
    /** LLM-suggested ms until next check */
    nextCheckMs?: number;
}

// ═══════════════════════════════════════════════════════
//                   Cognitive Loop
// ═══════════════════════════════════════════════════════

/**
 * Run one cognitive cycle for an agent.
 *
 * Returns a RunResult indicating what happened. The caller is responsible
 * for actually submitting the transaction if `result.payload` is set.
 *
 * @param agent The agent to run
 * @returns RunResult with decision, payload, and status
 */
export async function runAgentCycle(agent: Agent): Promise<RunResult> {
    // ───── 1. Perceive: observe environment ─────
    const observation = await agent.perception.observe();

    // Check if agent is paused on-chain
    if (observation.paused) {
        await agent.memory.store({
            type: "blocked",
            action: "any",
            result: { success: false, error: "Agent is paused on-chain" },
            timestamp: new Date(),
        });
        return {
            acted: false,
            action: "wait",
            reasoning: "Agent is paused on-chain",
            blocked: true,
            blockReason: "Agent is paused on-chain",
        };
    }

    // ───── 2. Remember: recall recent history ─────
    const memories = await agent.memory.recall(20);

    // ───── 3. Think: brain decision ─────
    const decision = await agent.brain.think(observation, memories, agent.actions);

    // If brain says wait, store memory and return
    if (decision.action === "wait") {
        await agent.memory.store({
            type: "decision",
            action: "wait",
            reasoning: decision.reasoning,
            timestamp: new Date(),
        });
        return {
            acted: false,
            action: "wait",
            reasoning: decision.reasoning,
            blocked: false,
            done: decision.done,
            nextCheckMs: decision.nextCheckMs,
        };
    }

    // ───── 4. Encode: find action and encode to payload ─────
    const actionModule = agent.actions.find(a => a.name === decision.action);
    if (!actionModule) {
        await agent.memory.store({
            type: "blocked",
            action: decision.action,
            result: { success: false, error: `Unknown action: ${decision.action}` },
            timestamp: new Date(),
        });
        return {
            acted: false,
            action: decision.action,
            reasoning: decision.reasoning,
            blocked: true,
            blockReason: `Unknown action: ${decision.action}`,
        };
    }

    // Read-only actions (analytics, portfolio)
    if (actionModule.readonly) {
        await agent.memory.store({
            type: "observation",
            action: decision.action,
            params: decision.params,
            reasoning: decision.reasoning,
            timestamp: new Date(),
        });
        return {
            acted: true,
            action: decision.action,
            reasoning: decision.reasoning,
            blocked: false,
            done: decision.done,
            nextCheckMs: decision.nextCheckMs,
        };
    }

    const payload = actionModule.encode({
        ...decision.params,
        vault: agent.vault, // Inject vault so actions don't need global state
    });

    // ───── 5. Check Safety: guardrails ─────
    const context: ExecutionContext = {
        tokenId: agent.tokenId,
        agentType: agent.agentType,
        vault: agent.vault,
        timestamp: Math.floor(Date.now() / 1000),
    };

    const safetyResult = await agent.guardrails.check(payload, context);

    if (!safetyResult.ok) {
        const firstViolation = safetyResult.violations[0];
        await agent.memory.store({
            type: "blocked",
            action: decision.action,
            params: decision.params,
            result: { success: false, error: firstViolation?.message ?? "Policy violation" },
            reasoning: decision.reasoning,
            timestamp: new Date(),
        });
        return {
            acted: false,
            action: decision.action,
            reasoning: decision.reasoning,
            payload,
            blocked: true,
            blockReason: firstViolation?.message ?? "Policy violation",
            done: decision.done,
            nextCheckMs: decision.nextCheckMs,
        };
    }

    // ───── 6. Return payload for caller to submit ─────
    // (Transaction submission is the caller's responsibility,
    //  so the caller can handle gas, retries, receipts, etc.)

    // Enrich params with txValue for spending tracking in guardrails
    const enrichedParams = {
        ...decision.params,
        vault: agent.vault,
        txValue: payload.value.toString(),
    };

    return {
        acted: true,
        action: decision.action,
        reasoning: decision.reasoning,
        params: enrichedParams,
        payload,
        blocked: false,
        done: decision.done,
        nextCheckMs: decision.nextCheckMs,
    };
}

/**
 * Record the result of a transaction execution in agent memory.
 * Called by the scheduler after submitTransaction().
 */
export async function recordExecution(
    agent: Agent,
    action: string,
    params: Record<string, unknown>,
    reasoning: string,
    result: { success: boolean; txHash?: string; error?: string },
): Promise<void> {
    await agent.memory.store({
        type: "execution",
        action,
        params,
        result,
        reasoning,
        timestamp: new Date(),
    });
}
