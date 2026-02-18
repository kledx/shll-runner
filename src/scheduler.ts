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
import { runAgentCycle, recordExecution } from "./agent/runtime.js";

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

export function getLastLoopAt(): number {
    return lastLoopAt;
}

// ═══════════════════════════════════════════════════════
//                  Scheduler Loop
// ═══════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
                // B2: Per-token adaptive cadence — skip if not time yet
                const nextCheck = await store.getNextCheckAt(tokenId);
                if (nextCheck && Date.now() < nextCheck.getTime()) {
                    continue;
                }

                const autopilot = await store.getAutopilot(tokenId);
                let acquiredDbLock = false;

                // Skip if autopilot was disabled between snapshot and now
                if (!autopilot?.enabled) continue;

                acquiredDbLock = await store.tryAcquireAutopilotLock(
                    tokenId,
                    config.tokenLockLeaseMs,
                );
                if (!acquiredDbLock) continue;

                try {
                    // P-2026-018: Skip LLM agents with no tradingGoal (standby mode)
                    const strategyPre = await store.getStrategy(tokenId);
                    const isLlmAgent = strategyPre?.strategyType?.startsWith("llm_");
                    if (isLlmAgent && !strategyPre?.strategyParams?.tradingGoal) {
                        continue; // Standby — no instruction to process
                    }

                    // Ensure agent is started in the manager
                    if (!agentManager.isActive(tokenId)) {
                        const obs = await chain.observe(tokenId);
                        // V3: read agentType from chain, fall back to strategy DB
                        const chainType = await chain.readAgentType(tokenId);
                        const agentType = (chainType && chainType !== "unknown")
                            ? chainType
                            : (strategyPre?.strategyType || "dca");
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
                    if (!agent) continue;

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
                            continue;
                        }
                    }

                    // B4: Persist next check time based on LLM suggestion (all paths)
                    const strategy = await store.getStrategy(tokenId);
                    const minInterval = strategy?.minIntervalMs ?? config.pollIntervalMs;
                    const nextMs = Math.max(
                        result.nextCheckMs ?? minInterval,
                        minInterval,
                    );
                    const nextCheckAt = new Date(Date.now() + nextMs);
                    await store.updateNextCheckAt(tokenId, nextCheckAt);

                    // Skip TX submission for non-acting decisions
                    if (!result.acted || result.blocked || !result.payload) {
                        continue;
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
                        });
                    }

                    // P-2026-018: Done signal — clear goal, enter standby (keep autopilot active)
                    if (result.done) {
                        await store.clearTradingGoal(tokenId);
                        agentManager.stopAgent(tokenId);
                        log.info(
                            `[V3][${tokenId.toString()}] Done — tradingGoal cleared, agent standby`,
                        );
                    }
                } catch (err) {
                    const message =
                        err instanceof Error ? err.message : String(err);
                    log.error(
                        `[V3][${tokenId.toString()}] error:`,
                        message,
                    );

                    // Record failure in agent memory if agent exists
                    const agent = agentManager.getAgent(tokenId);
                    if (agent) {
                        await recordExecution(
                            agent,
                            "unknown",
                            {},
                            "cycle error",
                            { success: false, error: message },
                        );
                    }

                    await store.recordRun({
                        tokenId: tokenId.toString(),
                        actionType: "auto",
                        actionHash: "0x00",
                        simulateOk: false,
                        error: message,
                        brainType: agent?.agentType,
                        intentType: "error",
                        decisionReason: message,
                    });
                } finally {
                    if (acquiredDbLock) {
                        await store.releaseAutopilotLock(tokenId);
                    }
                }
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
