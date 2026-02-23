/**
 * Agent runtime cognitive loop.
 *
 * Runs one cycle:
 * observe -> propose -> plan -> validate -> simulate -> (ready for execute)
 */

import type { Agent } from "./agent.js";
import type { ActionPayload } from "../actions/interface.js";
import type { ExecutionContext } from "../guardrails/interface.js";
import type { ExecutionTraceEntry, ShadowComparison } from "../types.js";
import type { RunFailureCategory, RunErrorCode } from "../runFailure.js";
import { classifyFailureFromPolicyViolation } from "../runFailure.js";
import { buildExecutionPlan, buildLegacyExecutionPlan } from "./planner.js";

export interface RunResult {
    acted: boolean;
    action: string;
    reasoning: string;
    message?: string;
    params?: Record<string, unknown>;
    payload?: ActionPayload;
    blocked: boolean;
    blockReason?: string;
    done?: boolean;
    nextCheckMs?: number;
    failureCategory?: RunFailureCategory;
    errorCode?: RunErrorCode;
    executionTrace?: ExecutionTraceEntry[];
    shadowComparison?: ShadowComparison;
}

export interface RunCycleOptions {
    shadowCompare?: boolean;
    minActionConfidence?: number;
}

function addTrace(
    entries: ExecutionTraceEntry[],
    stage: ExecutionTraceEntry["stage"],
    status: ExecutionTraceEntry["status"],
    note?: string,
    meta?: Record<string, unknown>,
): void {
    entries.push({
        stage,
        status,
        at: new Date().toISOString(),
        note,
        meta,
    });
}

function classifyTrustedWaitBlock(
    blockReason: string,
): { failureCategory: RunFailureCategory; errorCode: RunErrorCode } {
    const text = blockReason.toLowerCase();
    if (text.includes("gas") || text.includes("bnb") || text.includes("insufficient")) {
        return {
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_INSUFFICIENT_GAS",
        };
    }
    return {
        failureCategory: "business_rejected",
        errorCode: "BUSINESS_INSUFFICIENT_BALANCE",
    };
}

function buildShadowComparison(
    primary: ReturnType<typeof buildExecutionPlan>,
    legacy: ReturnType<typeof buildLegacyExecutionPlan>,
): ShadowComparison {
    const diverged =
        primary.kind !== legacy.kind ||
        primary.actionName !== legacy.actionName ||
        primary.errorCode !== legacy.errorCode;
    let reason: string | undefined;
    if (diverged) {
        const parts: string[] = [];
        if (primary.kind !== legacy.kind) {
            parts.push(`kind ${legacy.kind} -> ${primary.kind}`);
        }
        if (primary.actionName !== legacy.actionName) {
            parts.push(`action ${legacy.actionName} -> ${primary.actionName}`);
        }
        if (primary.errorCode !== legacy.errorCode) {
            parts.push(`error ${legacy.errorCode ?? "none"} -> ${primary.errorCode ?? "none"}`);
        }
        reason = parts.join("; ");
    }
    return {
        primaryKind: primary.kind,
        legacyKind: legacy.kind,
        primaryAction: primary.actionName,
        legacyAction: legacy.actionName,
        primaryErrorCode: primary.errorCode,
        legacyErrorCode: legacy.errorCode,
        diverged,
        reason,
        at: new Date().toISOString(),
    };
}

export async function runAgentCycle(
    agent: Agent,
    options?: RunCycleOptions,
): Promise<RunResult> {
    const executionTrace: ExecutionTraceEntry[] = [];

    const observation = await agent.perception.observe();
    addTrace(executionTrace, "observe", "ok", "Observation collected", {
        paused: observation.paused,
        vaultTokenCount: observation.vault.length,
    });

    if (observation.paused) {
        await agent.memory.store({
            type: "blocked",
            action: "any",
            result: { success: false, error: "Agent is paused on-chain" },
            timestamp: new Date(),
        });
        addTrace(executionTrace, "validate", "blocked", "Agent paused on-chain");
        return {
            acted: false,
            action: "wait",
            reasoning: "Agent is paused on-chain",
            blocked: true,
            blockReason: "Agent is paused on-chain",
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_AGENT_PAUSED",
            executionTrace,
        };
    }

    const memories = await agent.memory.recall(20);
    const decision = await agent.brain.think(observation, memories, agent.actions);
    const decisionParams = decision.params ?? {};
    const confidence = Number.isFinite(decision.confidence)
        ? Math.max(0, Math.min(1, decision.confidence))
        : 0;
    const minActionConfidence = options?.minActionConfidence ?? 0;
    const shadowCompareEnabled = options?.shadowCompare === true;
    let shadowComparison: ShadowComparison | undefined;
    addTrace(executionTrace, "propose", "ok", "Decision proposed", {
        action: decision.action,
        confidence,
        minActionConfidence,
    });

    if (decision.action === "wait") {
        const TRUSTED_BLOCK_PATTERNS = [
            /vault.*no fund|balance.*0|no.*token/i,
            /no.*bnb.*gas|gas.*0|insufficient.*gas/i,
        ];
        const llmBlocked = decision.blocked ?? false;
        const blockReason = decision.blockReason ?? "";
        const isTrustedBlock =
            llmBlocked && TRUSTED_BLOCK_PATTERNS.some((p) => p.test(blockReason));

        if (llmBlocked && !isTrustedBlock) {
            console.warn(
                `[runtime] Demoting LLM blocked to normal wait, untrusted reason: ${blockReason}`,
            );
        }

        await agent.memory.store({
            type: "decision",
            action: "wait",
            params: decisionParams,
            reasoning: decision.reasoning,
            timestamp: new Date(),
        });

        addTrace(
            executionTrace,
            "plan",
            isTrustedBlock ? "blocked" : "skip",
            isTrustedBlock ? "Trusted blocked wait" : "No-op wait",
        );

        const trustedFailure = isTrustedBlock
            ? classifyTrustedWaitBlock(blockReason)
            : undefined;
        if (shadowCompareEnabled) {
            shadowComparison = {
                primaryKind: isTrustedBlock ? "blocked" : "wait",
                legacyKind: isTrustedBlock ? "blocked" : "wait",
                primaryAction: "wait",
                legacyAction: "wait",
                diverged: false,
                at: new Date().toISOString(),
            };
        }

        return {
            acted: false,
            action: "wait",
            reasoning: decision.reasoning,
            message: decision.message,
            blocked: isTrustedBlock,
            blockReason: isTrustedBlock ? blockReason : undefined,
            done: decision.done,
            nextCheckMs: decision.nextCheckMs,
            failureCategory: trustedFailure?.failureCategory,
            errorCode: trustedFailure?.errorCode,
            executionTrace,
            shadowComparison,
        };
    }

    if (confidence < minActionConfidence) {
        const blockReason = `Model confidence ${confidence.toFixed(2)} below runtime threshold ${minActionConfidence.toFixed(2)}`;
        await agent.memory.store({
            type: "blocked",
            action: decision.action,
            params: decisionParams,
            result: { success: false, error: blockReason },
            reasoning: decision.reasoning,
            timestamp: new Date(),
        });
        addTrace(
            executionTrace,
            "validate",
            "blocked",
            "Runtime confidence gate rejected decision",
            { confidence, minActionConfidence },
        );
        return {
            acted: false,
            action: decision.action,
            reasoning: decision.reasoning,
            message: "Action rejected by runtime confidence gate. Waiting for a higher-confidence decision.",
            blocked: true,
            blockReason,
            done: decision.done,
            nextCheckMs: decision.nextCheckMs,
            failureCategory: "model_output_error",
            errorCode: "MODEL_LOW_CONFIDENCE",
            executionTrace,
            shadowComparison,
        };
    }

    // Store the decision so circuit breaker can detect new instructions
    await agent.memory.store({
        type: "decision",
        action: decision.action,
        params: decisionParams,
        reasoning: decision.reasoning,
        timestamp: new Date(),
    });

    // Re-read memories so circuit breaker sees the fresh decision entry
    const freshMemories = await agent.memory.recall(20);

    // Circuit breaker for repeated failing actions
    // Auto-resets when: (a) a successful execution exists, (b) user sent a new instruction
    // (decision entry), or (c) failures are older than 30 minutes.
    const CIRCUIT_BREAKER_WINDOW_MS = 30 * 60 * 1000; // 30 min
    const CIRCUIT_BREAKER_THRESHOLD = 3;
    let consecutiveFailures = 0;
    const windowCutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;
    for (let i = 0; i < freshMemories.length; i++) {
        const m = freshMemories[i];
        // Skip the decision entry we just wrote above (always at index 0)
        if (i === 0 && m.type === "decision" && m.action === decision.action) continue;
        // Reset on any successful execution
        if (m.type === "execution" && m.result?.success) break;
        // Reset when a PREVIOUS user instruction was issued (agent re-planned)
        if (m.type === "decision") break;
        // Reset on observation entries
        if (m.type === "observation") break;
        // Ignore failures older than the time window
        if (m.timestamp && m.timestamp.getTime() < windowCutoff) break;
        if (
            m.action === decision.action &&
            (m.type === "blocked" ||
                (m.type === "execution" && m.result?.success === false))
        ) {
            consecutiveFailures++;
        }
    }

    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        const blockMsg = `Circuit Breaker Triggered: The action '${decision.action}' has failed ${CIRCUIT_BREAKER_THRESHOLD} consecutive times within ${CIRCUIT_BREAKER_WINDOW_MS / 60000} minutes. Agent paused to protect gas. Please send a new instruction to reset, or wait for automatic recovery.`;
        await agent.memory.store({
            type: "blocked",
            action: decision.action,
            params: decisionParams,
            result: { success: false, error: blockMsg },
            reasoning: "Circuit breaker condition met",
            timestamp: new Date(),
        });
        addTrace(executionTrace, "validate", "blocked", "Circuit breaker triggered");
        return {
            acted: false,
            action: "wait",
            reasoning:
                "Circuit breaker triggered due to consecutive failures. Will auto-reset on new instruction or after 30 minutes.",
            message: blockMsg,
            blocked: true,
            blockReason: blockMsg,
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_CIRCUIT_BREAKER",
            executionTrace,
            shadowComparison,
        };
    }

    const plan = buildExecutionPlan(decision, agent.actions);
    if (shadowCompareEnabled) {
        const legacyPlan = buildLegacyExecutionPlan(decision, agent.actions);
        shadowComparison = buildShadowComparison(plan, legacyPlan);
    }
    addTrace(executionTrace, "plan", "ok", "Execution plan built", {
        kind: plan.kind,
        action: plan.actionName,
        shadowDiverged: shadowComparison?.diverged,
    });

    if (plan.kind === "blocked") {
        await agent.memory.store({
            type: "blocked",
            action: plan.actionName,
            params: plan.params,
            result: { success: false, error: plan.reason },
            reasoning: decision.reasoning,
            timestamp: new Date(),
        });
        addTrace(executionTrace, "validate", "blocked", "Planner rejected decision");
        return {
            acted: false,
            action: plan.actionName,
            reasoning: decision.reasoning,
            message: `Action rejected by runtime planner: ${plan.reason}`,
            blocked: true,
            blockReason: plan.reason,
            done: decision.done,
            nextCheckMs: decision.nextCheckMs,
            failureCategory: plan.failureCategory,
            errorCode: plan.errorCode,
            executionTrace,
            shadowComparison,
        };
    }

    if (plan.kind === "readonly") {
        await agent.memory.store({
            type: "observation",
            action: plan.actionName,
            params: plan.params,
            reasoning: decision.reasoning,
            timestamp: new Date(),
        });
        addTrace(executionTrace, "validate", "ok", "Readonly action validated");
        addTrace(executionTrace, "execute", "skip", "Readonly action has no tx");
        return {
            acted: true,
            action: plan.actionName,
            reasoning: decision.reasoning,
            message: decision.message,
            blocked: false,
            done: decision.done,
            nextCheckMs: decision.nextCheckMs,
            executionTrace,
            shadowComparison,
        };
    }

    const actionModule = plan.actionModule;
    if (!actionModule || plan.kind !== "write") {
        await agent.memory.store({
            type: "blocked",
            action: plan.actionName,
            params: plan.params,
            result: { success: false, error: "Planner produced no executable action" },
            reasoning: decision.reasoning,
            timestamp: new Date(),
        });
        addTrace(
            executionTrace,
            "validate",
            "error",
            "Planner produced no executable action",
        );
        return {
            acted: false,
            action: plan.actionName,
            reasoning: decision.reasoning,
            blocked: true,
            blockReason: "Planner produced no executable action",
            done: decision.done,
            nextCheckMs: decision.nextCheckMs,
            failureCategory: "infrastructure_error",
            errorCode: "INFRA_RUNTIME_EXCEPTION",
            executionTrace,
            shadowComparison,
        };
    }

    addTrace(executionTrace, "validate", "ok", "Write action validated");
    const payload = actionModule.encode({
        ...plan.params,
        vault: agent.vault,
    });

    const amountInRaw = plan.params.amountIn as string | undefined;
    const minOutRaw = plan.params.minOut as string | undefined;
    const amountInBig = amountInRaw ? BigInt(amountInRaw) : undefined;
    const minOutBig = minOutRaw ? BigInt(minOutRaw) : undefined;
    const spendAmount = payload.value > 0n ? payload.value : (amountInBig ?? 0n);

    const actionTokens: string[] = [];
    if (plan.params.tokenIn) {
        actionTokens.push((plan.params.tokenIn as string).toLowerCase());
    }
    if (plan.params.tokenOut) {
        actionTokens.push((plan.params.tokenOut as string).toLowerCase());
    }
    if (plan.params.token) {
        actionTokens.push((plan.params.token as string).toLowerCase());
    }

    const context: ExecutionContext = {
        tokenId: agent.tokenId,
        agentType: agent.agentType,
        vault: agent.vault,
        timestamp: Math.floor(Date.now() / 1000),
        actionName: plan.actionName,
        spendAmount,
        actionTokens: actionTokens.length > 0 ? actionTokens : undefined,
        amountIn: amountInBig,
        minOut: minOutBig,
    };

    const safetyResult = await agent.guardrails.check(payload, context);
    if (!safetyResult.ok) {
        const firstViolation = safetyResult.violations[0];
        const blockMsg = firstViolation?.message ?? "Policy violation";
        const policyFailure = classifyFailureFromPolicyViolation(firstViolation?.code);
        const userMessage = `Action blocked by safety policy: ${blockMsg}`;

        await agent.memory.store({
            type: "blocked",
            action: plan.actionName,
            params: plan.params,
            result: { success: false, error: blockMsg },
            reasoning: decision.reasoning,
            timestamp: new Date(),
        });
        addTrace(executionTrace, "simulate", "blocked", "Guardrails rejected payload", {
            policy: firstViolation?.policy,
            violationCode: firstViolation?.code,
        });
        return {
            acted: false,
            action: plan.actionName,
            reasoning: decision.reasoning,
            message: userMessage,
            payload,
            blocked: true,
            blockReason: blockMsg,
            done: decision.done,
            nextCheckMs: decision.nextCheckMs,
            failureCategory: policyFailure.failureCategory,
            errorCode: policyFailure.errorCode,
            executionTrace,
            shadowComparison,
        };
    }

    addTrace(executionTrace, "simulate", "ok", "Guardrails preflight passed");
    addTrace(executionTrace, "execute", "ok", "Payload ready for scheduler");

    const enrichedParams = {
        ...plan.params,
        vault: agent.vault,
        txValue: payload.value.toString(),
    };

    return {
        acted: true,
        action: plan.actionName,
        reasoning: decision.reasoning,
        message: decision.message,
        params: enrichedParams,
        payload,
        blocked: false,
        done: decision.done,
        nextCheckMs: decision.nextCheckMs,
        executionTrace,
        shadowComparison,
    };
}

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
