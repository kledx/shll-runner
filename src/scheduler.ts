/**
 * Scheduler — Agent cognitive loop orchestrator.
 *
 * Iterates enabled tokens, manages agent instances, runs cognitive cycles,
 * and submits on-chain transactions.
 */

import { keccak256, stringToHex } from "viem";
import type { Logger } from "./logger.js";
import type { RunnerStore } from "./store.js";
import type { ChainServices } from "./chain.js";
import { AgentManager } from "./agent/manager.js";
import { getBlueprint } from "./agent/factory.js";
import { runAgentCycle, recordExecution } from "./agent/runtime.js";
import { sanitizeForUser, extractErrorMessage } from "./errors.js";

// ═══════════════════════════════════════════════════════
//                  Config Interface
// ═══════════════════════════════════════════════════════

export interface SchedulerConfig {
    pollIntervalMs: number;
    tokenLockLeaseMs: number;
    maxRetries: number;
    agentNfaAddress: string;
    databaseUrl: string;
    pgHost: string;
    pgPort: number;
    pgDatabase: string;
}

export interface SchedulerContext {
    store: RunnerStore;
    chain: ChainServices;
    config: SchedulerConfig;
    agentManager: AgentManager;
    log: Logger;
}

// ═══════════════════════════════════════════════════════
//                     State
// ═══════════════════════════════════════════════════════

let lastLoopAt = 0;

// Per-token consecutive blocked counter — auto-pause after MAX_BLOCKED_RETRIES
const MAX_BLOCKED_RETRIES = 3;
const blockedCounts = new Map<string, number>();

export function getLastLoopAt(): number {
    return lastLoopAt;
}

/** Clear blocked backoff counter for a token (called when user sends a new instruction) */
export function resetBlockedCount(tokenId: bigint): void {
    blockedCounts.delete(tokenId.toString());
}

// ═══════════════════════════════════════════════════════
//                  Scheduler Loop
// ═══════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single token's agent cycle.
 * Extracted so it can be called from both the scheduler loop and externally
 * (e.g. API trigger for immediate execution).
 *
 * Returns true if the cycle executed, false if skipped.
 */
export async function runSingleToken(
    tokenId: bigint,
    ctx: SchedulerContext,
    opts?: { skipCadenceCheck?: boolean },
): Promise<boolean> {
    const { store, chain, config, agentManager, log } = ctx;

    // B2: Per-token adaptive cadence — skip if not time yet
    if (!opts?.skipCadenceCheck) {
        const nextCheck = await store.getNextCheckAt(tokenId);
        if (nextCheck && Date.now() < nextCheck.getTime()) {
            return false;
        }
    }

    const autopilot = await store.getAutopilot(tokenId);

    // Skip if autopilot was disabled
    if (!autopilot?.enabled) return false;

    const acquiredDbLock = await store.tryAcquireAutopilotLock(
        tokenId,
        config.tokenLockLeaseMs,
    );
    if (!acquiredDbLock) return false;

    try {
        // P-2026-018: Skip LLM agents with no tradingGoal (standby mode)
        const strategyPre = await store.getStrategy(tokenId);
        const isLlmAgent = strategyPre?.strategyType?.startsWith("llm_");
        if (isLlmAgent && !strategyPre?.strategyParams?.tradingGoal) {
            return false; // Standby — no instruction to process
        }

        // Ensure agent is started in the manager
        if (!agentManager.isActive(tokenId)) {
            const obs = await chain.observe(tokenId);
            // V3: read agentType from chain, fall back to strategy DB
            const chainType = await chain.readAgentType(tokenId);
            const agentType = (chainType && chainType !== "unknown")
                ? chainType
                : (strategyPre?.strategyType || "llm_trader");

            // Skip tokens with unsupported agentType (e.g. removed blueprints)
            if (!getBlueprint(agentType)) {
                log.warn(
                    `[V3] Skipping token ${tokenId.toString()} — no blueprint for agentType: ${agentType}`,
                );
                return false;
            }

            agentManager.startAgent({
                tokenId,
                agentType,
                owner: obs.agentState.owner,
                renter: obs.renter,
                vault: obs.agentAccount,
                strategyParams: strategyPre?.strategyParams,
            });
            log.info(
                `[V3] Agent ${tokenId.toString()} started (type=${agentType})`,
            );
        }

        const agent = agentManager.getAgent(tokenId);
        if (!agent) return false;

        // Run one cognitive cycle
        const result = await runAgentCycle(agent);
        log.info(
            `[V3][${tokenId.toString()}] ${result.action}: ${result.reasoning}${result.blocked ? ` [BLOCKED: ${result.blockReason}]` : ""}`,
        );

        // Record non-TX decisions (wait / blocked / read-only) to runs
        if (!result.acted || result.blocked || !result.payload) {
            await store.recordRun({
                tokenId: tokenId.toString(),
                actionType: "auto",
                actionHash: "0x00",
                simulateOk: !result.blocked,
                brainType: agent.agentType,
                intentType: result.action,
                decisionReason: result.reasoning,
                decisionMessage: result.message,
                error: result.blocked
                    ? result.blockReason
                    : undefined,
            });

            // P-2026-018: Done signal — clear goal, enter standby (keep autopilot active)
            if (result.done) {
                await store.clearTradingGoal(tokenId);
                agentManager.stopAgent(tokenId);
                log.info(
                    `[V3][${tokenId.toString()}] Done — tradingGoal cleared, agent standby`,
                );
                return true;
            }
        }

        // Blocked backoff: if agent is blocked (prerequisites not met), back off 5 min
        const BLOCKED_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
        if (result.blocked) {
            const key = tokenId.toString();
            const count = (blockedCounts.get(key) ?? 0) + 1;
            blockedCounts.set(key, count);

            // Auto-pause after MAX_BLOCKED_RETRIES consecutive blocked results
            if (count >= MAX_BLOCKED_RETRIES) {
                await store.recordRun({
                    tokenId: key,
                    actionType: "auto",
                    actionHash: "0x00",
                    simulateOk: false,
                    brainType: agent.agentType,
                    intentType: "paused",
                    decisionReason: `Auto-paused after ${count} consecutive blocked checks: ${result.blockReason ?? "unknown"}`,
                    error: result.blockReason,
                });
                await store.clearTradingGoal(tokenId);
                agentManager.stopAgent(tokenId);
                blockedCounts.delete(key);
                log.warn(
                    `[V3][${key}] Auto-paused — blocked ${count}× consecutively: ${result.blockReason ?? "unknown"}`,
                );
                return true;
            }

            const nextCheckAt = new Date(Date.now() + BLOCKED_BACKOFF_MS);
            await store.updateNextCheckAt(tokenId, nextCheckAt);
            log.info(
                `[V3][${tokenId.toString()}] Blocked (${count}/${MAX_BLOCKED_RETRIES}) — backoff ${BLOCKED_BACKOFF_MS / 1000}s: ${result.blockReason ?? "unknown"}`,
            );
            return true;
        }

        // Non-blocked result: reset consecutive blocked counter
        blockedCounts.delete(tokenId.toString());

        // B4: Persist next check time based on LLM suggestion (all paths)
        const strategy = await store.getStrategy(tokenId);
        const minInterval = strategy?.minIntervalMs ?? config.pollIntervalMs;

        // If the agent successfully acted AND requests a fast follow-up (e.g. approve → swap),
        // allow bypassing minInterval for multi-step workflows
        const FAST_FOLLOWUP_MIN = 10_000; // 10 seconds minimum for chained actions
        const nextMs = (result.acted && result.nextCheckMs && result.nextCheckMs < minInterval)
            ? Math.max(result.nextCheckMs, FAST_FOLLOWUP_MIN)
            : Math.max(result.nextCheckMs ?? minInterval, minInterval);

        const nextCheckAt = new Date(Date.now() + nextMs);
        await store.updateNextCheckAt(tokenId, nextCheckAt);

        // Skip TX submission for non-acting decisions
        if (!result.acted || result.blocked || !result.payload) {
            return true;
        }

        // If the runtime produced a payload, submit it on-chain
        if (result.acted && result.payload && !result.blocked) {
            const txResult = await chain.executeAction(
                tokenId,
                result.payload,
            );
            log.info(
                `[V3][${tokenId.toString()}] TX confirmed block=${txResult.receiptBlock} status=${txResult.receiptStatus}`,
            );

            // Record execution in agent memory
            await recordExecution(
                agent,
                result.action,
                result.params ?? {},
                result.reasoning,
                { success: true, txHash: txResult.hash },
            );

            // Record in run history for dashboard
            const hash = keccak256(
                stringToHex(
                    `${result.payload.target.toLowerCase()}:${result.payload.value.toString()}:${result.payload.data.toLowerCase()}`,
                ),
            );
            await store.recordRun({
                tokenId: tokenId.toString(),
                actionType: "auto",
                actionHash: hash,
                simulateOk: true,
                txHash: txResult.hash,
                brainType: agent.agentType,
                intentType: result.action,
                decisionReason: result.reasoning,
                decisionMessage: result.message,
            });
        }

        // P-2026-018: Done signal — clear goal, enter standby (keep autopilot active)
        // Force done for one-shot TX actions even if LLM forgot to set done: true
        // (Removed "approve" so multi-step approve->swap workflows can continue)
        const ONE_SHOT_ACTIONS = ["swap", "wrap"];
        const isOneShot = ONE_SHOT_ACTIONS.includes(result.action);
        const shouldDone = result.done || (result.acted && isOneShot);

        if (shouldDone) {
            await store.clearTradingGoal(tokenId);
            agentManager.stopAgent(tokenId);
            log.info(
                `[V3][${tokenId.toString()}] Done — tradingGoal cleared, agent standby${isOneShot && !result.done ? " (auto-done: one-shot action)" : ""}`,
            );
        }

        return true;
    } catch (err) {
        const rawMessage = extractErrorMessage(err);
        const userMessage = sanitizeForUser(rawMessage);
        log.error(
            `[V3][${tokenId.toString()}] error:`,
            rawMessage,
        );

        // Record failure in agent memory if agent exists
        const agent = agentManager.getAgent(tokenId);
        if (agent) {
            await recordExecution(
                agent,
                "unknown",
                {},
                "cycle error",
                { success: false, error: rawMessage },
            );
        }

        await store.recordRun({
            tokenId: tokenId.toString(),
            actionType: "auto",
            actionHash: "0x00",
            simulateOk: false,
            error: rawMessage,
            brainType: agent?.agentType,
            intentType: "error",
            decisionReason: userMessage,
            decisionMessage: userMessage,
        });

        return false;
    } finally {
        if (acquiredDbLock) {
            await store.releaseAutopilotLock(tokenId);
        }
    }
}

export async function startScheduler(ctx: SchedulerContext): Promise<void> {
    const { store, chain, config, agentManager, log } = ctx;

    log.info("=== SHLL Agent Runner (V3.0) ===");
    log.info(`Operator: ${chain.account.address}`);
    log.info(`Agent NFA: ${config.agentNfaAddress}`);
    log.info(`Poll interval: ${config.pollIntervalMs}ms`);
    log.info(
        `Store backend: postgres (${config.databaseUrl ? "DATABASE_URL" : `${config.pgHost}:${config.pgPort}/${config.pgDatabase}`})`,
    );
    log.info("");

    let consecutiveErrors = 0;

    while (true) {
        try {
            lastLoopAt = Date.now();

            // V3: token discovery from token_strategies JOIN autopilots
            const schedulableTokenIds = await store.listSchedulableTokenIds();

            if (schedulableTokenIds.length === 0) {
                log.info("[Tick] idle — no schedulable tokens");
            }

            for (const tokenId of schedulableTokenIds) {
                await runSingleToken(tokenId, ctx);
            }

            consecutiveErrors = 0;
        } catch (err) {
            consecutiveErrors++;
            log.error(
                `Loop error (${consecutiveErrors}/${config.maxRetries}):`,
                err instanceof Error ? err.message : err,
            );

            if (consecutiveErrors >= config.maxRetries) {
                log.error("Max retries reached, backing off for 60s...");
                await sleep(60_000);
                consecutiveErrors = 0;
            }
        }

        await sleep(config.pollIntervalMs);
    }
}
