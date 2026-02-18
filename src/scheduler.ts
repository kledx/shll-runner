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
                const autopilot = await store.getAutopilot(tokenId);
                let acquiredDbLock = false;

                if (autopilot?.enabled) {
                    acquiredDbLock = await store.tryAcquireAutopilotLock(
                        tokenId,
                        config.tokenLockLeaseMs,
                    );
                    if (!acquiredDbLock) continue;
                }

                try {
                    // Ensure agent is started in the manager
                    if (!agentManager.isActive(tokenId)) {
                        const obs = await chain.observe(tokenId);
                        // V3: read agentType from chain (bytes32 → string)
                        const agentType = await chain.readAgentType(tokenId) || "dca";
                        const strategy = await store.getStrategy(tokenId);
                        agentManager.startAgent({
                            tokenId,
                            agentType,
                            owner: obs.agentState.owner,
                            renter: obs.renter,
                            vault: obs.agentAccount,
                            strategyParams: strategy?.strategyParams,
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
                        });
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
