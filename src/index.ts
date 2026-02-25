/**
 * SHLL Agent Runner — V3.0 Entry Point
 *
 * Thin entry point that wires together:
 * 1. Store (PostgreSQL)
 * 2. Chain services (BSC RPC)
 * 3. V3 Agent modules (bootstrap)
 * 4. API server (HTTP control plane)
 * 5. Market signal sync (optional background loop)
 * 6. Scheduler (agent cognitive loop)
 */

import "dotenv/config";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { createChainServices } from "./chain.js";
import { RunnerStore } from "./store/index.js";
import { bootstrapAgentModules } from "./bootstrap.js";
import { AgentManager } from "./agent/manager.js";
import { AgentNFAAbi } from "./abi.js";
import { startApiServer } from "./api/server.js";
import { startScheduler } from "./scheduler.js";
import { runMarketSignalSyncLoop } from "./market/signalSync.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;
const log = createLogger(config.logLevel);

async function main(): Promise<void> {
    const store = new RunnerStore(config);
    await store.init();

    const chain = createChainServices({
        rpcUrl: config.rpcUrl,
        rpcTimeoutMs: config.rpcTimeoutMs,
        rpcRetryCount: config.rpcRetryCount,
        operatorPrivateKey: config.operatorPrivateKey,
        agentNfaAddress: config.agentNfaAddress,
        subscriptionManagerAddress: config.subscriptionManagerAddress,
        cooldownPolicyAddress: config.cooldownPolicyAddress,
    });

    bootstrapAgentModules({
        pool: store.getPool(),
        publicClient: chain.publicClient,
        chainId: config.chainId,
        agentNfaAddress: config.agentNfaAddress,
        agentNfaAbi: AgentNFAAbi,
        policyGuardV4Address: config.policyGuardV4Address ?? (ZERO_ADDR as `0x${string}`),
        operatorAddress: chain.account.address,
        wbnbAddress: config.wbnbAddress ?? (ZERO_ADDR as `0x${string}`),
    });
    log.info("[V3] Agent modules bootstrapped");

    const agentManager = new AgentManager();


    const shutdown = async () => {
        log.info("Shutting down runner...");
        agentManager.stopAll();
        await store.close();
        process.exit(0);
    };
    process.on("SIGINT", () => { void shutdown(); });
    process.on("SIGTERM", () => { void shutdown(); });

    // Shared context for scheduler + API trigger
    const schedulerCtx = { store, chain, config, agentManager, log };

    startApiServer({ store, chain, config, agentManager, log, schedulerCtx });

    if (config.marketSignalSyncEnabled && config.marketSignalSourceUrl) {
        void runMarketSignalSyncLoop({ store, config, log });
    }

    await startScheduler(schedulerCtx);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
