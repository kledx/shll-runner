/**
 * Scheduler — Agent cognitive loop orchestrator.
 *
 * Iterates enabled tokens, manages agent instances, runs cognitive cycles,
 * and submits on-chain transactions.
 */

import { keccak256, stringToHex } from "viem";
import type { Logger } from "./logger.js";
import type { RunnerStore } from "./store/index.js";
import type { ChainServices } from "./chain.js";
import type { ExecutionTraceEntry } from "./types.js";
import type { ActionPayload } from "./actions/interface.js";
import { AgentManager } from "./agent/manager.js";
import { getBlueprint } from "./agent/factory.js";
import { runAgentCycle, recordExecution } from "./agent/runtime.js";
import { sanitizeForUser, extractErrorMessage } from "./errors.js";
import { withRetry } from "./errors/RunnerError.js";
import {
    classifyFailureFromBlockedReason,
    classifyFailureFromError,
} from "./runFailure.js";
import {
    metrics,
    METRIC_LOOP_TICKS,
    METRIC_CYCLES_TOTAL,
    METRIC_TX_SUCCESS,
    METRIC_TX_FAILURE,
    METRIC_BLOCKED,
    METRIC_SCHEDULABLE_TOKENS,
} from "./metrics.js";

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
    shadowModeEnabled: boolean;
    shadowModeTokenIds: bigint[];
    shadowExecuteTx: boolean;
    llmMinActionConfidence: number;
}

export interface SchedulerContext {
    store: RunnerStore;
    chain: ChainServices;
    config: SchedulerConfig;
    agentManager: AgentManager;
    log: Logger;
}

// ═══════════════════════════════════════════════════════
//                     Semaphore
// ═══════════════════════════════════════════════════════

/** Lightweight concurrency limiter — no external dependencies */
class Semaphore {
    private running = 0;
    private queue: (() => void)[] = [];

    constructor(private readonly limit: number) { }

    /** Number of tasks waiting for a slot */
    get pendingCount(): number { return this.queue.length; }

    /** Number of tasks currently executing */
    get activeCount(): number { return this.running; }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.running >= this.limit) {
            await new Promise<void>((resolve) => this.queue.push(resolve));
        }
        this.running++;
        try {
            return await fn();
        } finally {
            this.running--;
            this.queue.shift()?.();
        }
    }
}

// ═══════════════════════════════════════════════════════
//                     State
// ═══════════════════════════════════════════════════════

let lastLoopAt = 0;

// Per-token consecutive blocked counter — auto-pause after MAX_BLOCKED_RETRIES
const MAX_BLOCKED_RETRIES = 5;
const MAX_BACKOFF_MS = 10 * 60 * 1000; // 10 minutes
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

async function computeAdaptiveLoopSleepMs(
    store: SchedulerContext["store"],
    defaultPollIntervalMs: number,
): Promise<number> {
    const nextCheckAt = await store.getEarliestNextCheckAt();
    if (!nextCheckAt) return defaultPollIntervalMs;
    const deltaMs = nextCheckAt.getTime() - Date.now();
    // Keep a small floor to avoid a busy loop while still honoring short cadences.
    return Math.min(defaultPollIntervalMs, Math.max(1000, deltaMs));
}

function appendTrace(
    entries: ExecutionTraceEntry[],
    stage: ExecutionTraceEntry["stage"],
    status: ExecutionTraceEntry["status"],
    note?: string,
    meta?: Record<string, unknown>,
): ExecutionTraceEntry[] {
    return [
        ...entries,
        {
            stage,
            status,
            at: new Date().toISOString(),
            note,
            meta,
        },
    ];
}

function isInvalidTokenIdError(rawMessage: string): boolean {
    const text = rawMessage.toLowerCase();
    return text.includes("invalid token id") || text.includes("erc721: invalid token id");
}

function isShadowModeForToken(tokenId: bigint, config: SchedulerConfig): boolean {
    if (!config.shadowModeEnabled) return false;
    if (config.shadowModeTokenIds.length === 0) return true;
    return config.shadowModeTokenIds.some((id) => id === tokenId);
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
    let cycleTrace: ExecutionTraceEntry[] = [];
    const shadowMode = isShadowModeForToken(tokenId, config);

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
        // V4: Subscription status check — skip non-active subscriptions
        const subStatus = await chain.readSubscriptionStatus(tokenId);
        if (
            subStatus === "GracePeriod" ||
            subStatus === "Expired" ||
            subStatus === "Canceled"
        ) {
            if (agentManager.isActive(tokenId)) {
                agentManager.stopAgent(tokenId);
            }
            log.info(
                `[V4][${tokenId.toString()}] Subscription ${subStatus} — agent paused`,
            );
            return false;
        }

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
        metrics.inc(METRIC_CYCLES_TOTAL);
        const result = await runAgentCycle(agent, {
            shadowCompare: shadowMode,
            minActionConfidence: config.llmMinActionConfidence,
            readAllowance: chain.readAllowance,
            getAmountsOut: chain.getAmountsOut,
        });
        cycleTrace = [...(result.executionTrace ?? [])];
        log.info(
            `[V3][${tokenId.toString()}] ${result.action}: ${result.reasoning}${result.blocked ? ` [BLOCKED: ${result.blockReason}]` : ""}`,
        );

        // Record non-TX decisions (wait / blocked / read-only) to runs
        if (!result.acted || result.blocked || !result.payload) {
            const fallbackBlocked = result.blocked
                ? classifyFailureFromBlockedReason(result.blockReason ?? "blocked")
                : null;
            const blockedFailure = result.blocked
                ? {
                    failureCategory:
                        result.failureCategory ?? fallbackBlocked!.failureCategory,
                    errorCode:
                        result.errorCode ?? fallbackBlocked!.errorCode,
                }
                : {};

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
                executionTrace: appendTrace(
                    cycleTrace,
                    "record",
                    result.blocked ? "blocked" : "ok",
                    "Non-TX decision recorded",
                    { action: result.action },
                ),
                runMode: shadowMode ? "shadow" : "primary",
                shadowCompare: result.shadowComparison,
                violationCode: result.errorCode?.startsWith("SOFT_") || result.errorCode?.startsWith("HARD_")
                    ? result.errorCode : undefined,
                ...blockedFailure,
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

        // Blocked backoff: if agent is blocked (prerequisites not met), back off
        // Exponential backoff: base * 2^(count-1), capped at MAX_BACKOFF_MS
        const BASE_BACKOFF_MS = parseInt(process.env.BLOCKED_BACKOFF_MS ?? "65000", 10);
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
                    failureCategory: "business_rejected",
                    errorCode: "BUSINESS_AUTOPAUSE_THRESHOLD",
                    executionTrace: appendTrace(
                        cycleTrace,
                        "record",
                        "blocked",
                        "Auto-paused after consecutive blocked checks",
                        { blockedCount: count },
                    ),
                    runMode: shadowMode ? "shadow" : "primary",
                    shadowCompare: result.shadowComparison,
                });
                await store.clearTradingGoal(tokenId);
                agentManager.stopAgent(tokenId);
                blockedCounts.delete(key);
                log.warn(
                    `[V3][${key}] Auto-paused — blocked ${count}× consecutively: ${result.blockReason ?? "unknown"}`,
                );
                return true;
            }

            // Exponential backoff: 65s, 130s, 260s, 520s... capped at MAX_BACKOFF_MS
            let backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, count - 1), MAX_BACKOFF_MS);
            const isCooldownBlock =
                result.errorCode === "BUSINESS_POLICY_COOLDOWN" ||
                (result.blockReason?.toLowerCase().includes("cooldown") ?? false);

            // t6: Dynamic backoff for cooldown blocks — read actual cooldownSeconds from chain
            if (isCooldownBlock) {
                try {
                    const chainCd = await chain.readCooldownSeconds(tokenId);
                    if (chainCd > 0) {
                        // Add 5s buffer above on-chain cooldown to avoid race
                        backoffMs = chainCd * 1000 + 5_000;
                        log.info(
                            `[t6][${tokenId.toString()}] Dynamic cooldown backoff: ${chainCd}s (on-chain) + 5s buffer = ${backoffMs / 1000}s`,
                        );
                    }
                } catch {
                    // Chain read failed — fall back to exponential default
                }
            }

            const nextCheckAt = new Date(Date.now() + backoffMs);
            await store.updateNextCheckAt(tokenId, nextCheckAt);
            log.info(
                `[V3][${tokenId.toString()}] Blocked (${count}/${MAX_BLOCKED_RETRIES}) — backoff ${Math.round(backoffMs / 1000)}s (exponential): ${result.blockReason ?? "unknown"}`,
            );
            return true;
        }

        // Non-blocked result: reset consecutive blocked counter
        blockedCounts.delete(tokenId.toString());

        // B4: Persist next check time based on LLM suggestion (all paths)
        const strategy = await store.getStrategy(tokenId);
        const minInterval = strategy?.minIntervalMs ?? config.pollIntervalMs;

        // If the agent successfully acted AND requests a fast follow-up (e.g. approve → swap),
        // allow bypassing minInterval for multi-step workflows.
        // Also allow short wait cadence for recurring conversational tasks.
        const FAST_FOLLOWUP_MIN = 10_000; // 10 seconds minimum for chained actions
        const WAIT_CADENCE_MIN = 5_000; // 5 seconds minimum for recurring wait tasks
        const hasNextCheck = typeof result.nextCheckMs === "number" && result.nextCheckMs >= 0;
        const allowWaitCadenceBypass =
            result.action === "wait" &&
            result.done === false &&
            hasNextCheck;
        const allowTxFollowupBypass =
            result.acted &&
            hasNextCheck &&
            result.nextCheckMs! < minInterval;

        const nextMs = allowWaitCadenceBypass
            ? Math.max(result.nextCheckMs!, WAIT_CADENCE_MIN)
            : allowTxFollowupBypass
                ? Math.max(result.nextCheckMs!, FAST_FOLLOWUP_MIN)
                : Math.max(result.nextCheckMs ?? minInterval, minInterval);

        const nextCheckAt = new Date(Date.now() + nextMs);
        await store.updateNextCheckAt(tokenId, nextCheckAt);

        // Skip TX submission for non-acting decisions
        if (!result.acted || result.blocked || !result.payload) {
            return true;
        }

        if (shadowMode && !config.shadowExecuteTx) {
            const primaryPayload = Array.isArray(result.payload)
                ? result.payload[result.payload.length - 1]
                : result.payload;
            const hash = keccak256(
                stringToHex(
                    `${primaryPayload.target.toLowerCase()}:${primaryPayload.value.toString()}:${primaryPayload.data.toLowerCase()}`,
                ),
            );
            await store.recordRun({
                tokenId: tokenId.toString(),
                actionType: "auto",
                actionHash: hash,
                simulateOk: true,
                brainType: agent.agentType,
                intentType: result.action,
                decisionReason: result.reasoning,
                decisionMessage: result.message,
                executionTrace: appendTrace(
                    appendTrace(
                        cycleTrace,
                        "execute",
                        "skip",
                        "Shadow mode dry-run, tx submission skipped",
                        { action: result.action },
                    ),
                    "record",
                    "ok",
                    "Shadow dry-run recorded",
                    { actionHash: hash },
                ),
                runMode: "shadow",
                shadowCompare: result.shadowComparison,
            });
            return true;
        }

        // If the runtime produced a payload, submit it on-chain
        if (result.acted && result.payload && !result.blocked) {
            let txTrace = appendTrace(
                cycleTrace,
                "execute",
                "ok",
                Array.isArray(result.payload)
                    ? `Submitting batch (${result.payload.length} actions) on-chain`
                    : "Submitting transaction on-chain",
                { action: result.action },
            );

            // Dispatch: batch payloads → executeBatchAction, single → executeAction
            // Wrapped with withRetry for transient RPC/network failures
            const txResult = Array.isArray(result.payload)
                ? await withRetry(
                    () => chain.executeBatchAction(tokenId, result.payload as ActionPayload[]),
                    { maxAttempts: 2, baseDelayMs: 2000, label: `executeBatch(${tokenId})`, logger: log },
                )
                : await withRetry(
                    () => chain.executeAction(tokenId, result.payload as ActionPayload),
                    { maxAttempts: 2, baseDelayMs: 2000, label: `execute(${tokenId})`, logger: log },
                );

            txTrace = appendTrace(
                txTrace,
                "verify",
                "ok",
                "Transaction confirmed",
                {
                    txHash: txResult.hash,
                    receiptStatus: txResult.receiptStatus,
                    isBatch: Array.isArray(result.payload),
                },
            );
            log.info(
                `[V3][${tokenId.toString()}] TX confirmed block=${txResult.receiptBlock} status=${txResult.receiptStatus}${Array.isArray(result.payload) ? ` (batch=${result.payload.length})` : ""}`,
            );
            metrics.inc(METRIC_TX_SUCCESS);

            // Record execution in agent memory
            await recordExecution(
                agent,
                result.action,
                result.params ?? {},
                result.reasoning,
                { success: true, txHash: txResult.hash },
            );

            // Record in run history for dashboard
            const primaryPayload = Array.isArray(result.payload)
                ? result.payload[result.payload.length - 1]
                : result.payload;
            const hash = keccak256(
                stringToHex(
                    `${primaryPayload.target.toLowerCase()}:${primaryPayload.value.toString()}:${primaryPayload.data.toLowerCase()}`,
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
                executionTrace: appendTrace(
                    txTrace,
                    "record",
                    "ok",
                    "Successful TX run recorded",
                    { actionHash: hash },
                ),
                runMode: shadowMode ? "shadow" : "primary",
                shadowCompare: result.shadowComparison,
            });
        }

        // P-2026-018: Done signal — clear goal, enter standby (keep autopilot active)
        // Force done for one-shot TX actions even if LLM forgot to set done: true
        // (Removed "approve" so multi-step approve->swap workflows can continue)
        const ONE_SHOT_ACTIONS = ["swap", "wrap"];
        const isOneShot = ONE_SHOT_ACTIONS.includes(result.action);
        // Force done for one-shot TX actions ONLY IF LLM did not explicitly return done: false
        const shouldDone = result.done !== false && (result.done === true || (result.acted && isOneShot));

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
        const failure = classifyFailureFromError(rawMessage);
        log.error(
            `[V3][${tokenId.toString()}] error:`,
            rawMessage,
        );
        metrics.inc(METRIC_TX_FAILURE);

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
            failureCategory: failure.failureCategory,
            errorCode: failure.errorCode,
            brainType: agent?.agentType,
            intentType: "error",
            decisionReason: userMessage,
            decisionMessage: userMessage,
            executionTrace: appendTrace(
                cycleTrace,
                "record",
                "error",
                "Scheduler exception recorded",
                { error: rawMessage.slice(0, 240) },
            ),
            runMode: shadowMode ? "shadow" : "primary",
        });

        // Token no longer exists on-chain (stale DB/autopilot record): disable permanently.
        if (isInvalidTokenIdError(rawMessage)) {
            const reason =
                "On-chain token does not exist (ERC721: invalid token ID). Autopilot disabled by runner.";
            await store.disable(tokenId, reason);
            await store.clearTradingGoal(tokenId);
            agentManager.stopAgent(tokenId);
            blockedCounts.delete(tokenId.toString());
            log.warn(`[V3][${tokenId.toString()}] Disabled autopilot: ${reason}`);
            return true;
        }

        if (failure.failureCategory === "business_rejected") {
            const key = tokenId.toString();
            const count = (blockedCounts.get(key) ?? 0) + 1;
            blockedCounts.set(key, count);

            const BASE_BACKOFF_MS = parseInt(process.env.BLOCKED_BACKOFF_MS ?? "65000", 10);
            if (count >= MAX_BLOCKED_RETRIES) {
                await store.clearTradingGoal(tokenId);
                agentManager.stopAgent(tokenId);
                blockedCounts.delete(key);
                log.warn(
                    `[V3][${key}] Auto-paused after ${count} consecutive business failures: ${userMessage}`,
                );
                return true;
            }

            // Exponential backoff for business failures too
            const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, count - 1), MAX_BACKOFF_MS);
            const nextCheckAt = new Date(Date.now() + backoffMs);
            await store.updateNextCheckAt(tokenId, nextCheckAt);
            log.info(
                `[V3][${key}] Business failure (${count}/${MAX_BLOCKED_RETRIES}), backoff ${Math.round(backoffMs / 1000)}s (exponential)`,
            );
            return true;
        }

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
    log.info(`LLM min action confidence: ${config.llmMinActionConfidence}`);
    log.info(
        `Shadow mode: ${config.shadowModeEnabled ? "enabled" : "disabled"}${config.shadowModeEnabled ? ` (dryRunTx=${!config.shadowExecuteTx})` : ""}`,
    );
    log.info(
        `Store backend: postgres (${config.databaseUrl ? "DATABASE_URL" : `${config.pgHost}:${config.pgPort}/${config.pgDatabase}`})`,
    );
    log.info("");

    let consecutiveErrors = 0;

    const concurrency = parseInt(process.env.SCHEDULER_CONCURRENCY ?? "3", 10);
    const semaphore = new Semaphore(concurrency);
    log.info(`Scheduler concurrency: ${concurrency}`);

    while (true) {
        let loopSleepMs = config.pollIntervalMs;
        try {
            lastLoopAt = Date.now();
            metrics.inc(METRIC_LOOP_TICKS);

            // V3: token discovery from token_strategies JOIN autopilots
            // Ordered by next_check_at ASC — most urgent tokens dispatched first
            const schedulableTokenIds = await store.listSchedulableTokenIds();
            metrics.set(METRIC_SCHEDULABLE_TOKENS, schedulableTokenIds.length);

            if (schedulableTokenIds.length === 0) {
                log.info("[Tick] idle — no schedulable tokens");
            }

            // Dispatch tokens in parallel, limited by semaphore
            const tasks = schedulableTokenIds.map((tokenId) =>
                semaphore.run(() => runSingleToken(tokenId, ctx)),
            );
            await Promise.allSettled(tasks);

            consecutiveErrors = 0;
            loopSleepMs = await computeAdaptiveLoopSleepMs(store, config.pollIntervalMs);
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

        await sleep(loopSleepMs);
    }
}
