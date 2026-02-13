/**
 * index.ts — SHLL Agent Runner
 *
 * A minimal observe-reason-act loop that:
 * 1. Observe: read agent state from chain (balance, status, operator validity)
 * 2. Reason: decide if any action is needed (placeholder for AI/strategy logic)
 * 3. Act: execute the action via AgentNFA.execute() as authorized operator
 *
 * Designed for Docker deployment via Dokploy.
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    formatEther,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { config } from "./config.js";
import { AgentNFAAbi } from "./abi.js";

// ─── Setup ───

const account = privateKeyToAccount(config.operatorPrivateKey);

const publicClient = createPublicClient({
    chain: bscTestnet,
    transport: http(config.rpcUrl),
});

const walletClient = createWalletClient({
    chain: bscTestnet,
    transport: http(config.rpcUrl),
    account,
});

const log = {
    info: (...args: unknown[]) => {
        if (config.logLevel !== "silent") console.log(`[${new Date().toISOString()}] [INFO]`, ...args);
    },
    warn: (...args: unknown[]) => {
        console.warn(`[${new Date().toISOString()}] [WARN]`, ...args);
    },
    error: (...args: unknown[]) => {
        console.error(`[${new Date().toISOString()}] [ERROR]`, ...args);
    },
};

// ─── Types ───

interface AgentState {
    balance: bigint;
    status: number; // 0=Active, 1=Paused, 2=Terminated
    owner: Address;
    logicAddress: Address;
    lastActionTimestamp: bigint;
}

interface Observation {
    agentState: AgentState;
    agentAccount: Address;
    renter: Address;
    operator: Address;
    blockNumber: bigint;
    timestamp: number;
}

// ─── Observe ───

async function observe(): Promise<Observation> {
    const [agentState, agentAccount, renter, operator, blockNumber] = await Promise.all([
        publicClient.readContract({
            address: config.agentNfaAddress,
            abi: AgentNFAAbi,
            functionName: "getState",
            args: [config.tokenId],
        }),
        publicClient.readContract({
            address: config.agentNfaAddress,
            abi: AgentNFAAbi,
            functionName: "accountOf",
            args: [config.tokenId],
        }),
        publicClient.readContract({
            address: config.agentNfaAddress,
            abi: AgentNFAAbi,
            functionName: "userOf",
            args: [config.tokenId],
        }),
        publicClient.readContract({
            address: config.agentNfaAddress,
            abi: AgentNFAAbi,
            functionName: "operatorOf",
            args: [config.tokenId],
        }),
        publicClient.getBlockNumber(),
    ]);

    return {
        agentState: agentState as unknown as AgentState,
        agentAccount: agentAccount as Address,
        renter: renter as Address,
        operator: operator as Address,
        blockNumber,
        timestamp: Date.now(),
    };
}

// ─── Reason ───

interface Decision {
    shouldAct: boolean;
    reason: string;
    action?: {
        target: Address;
        value: bigint;
        data: `0x${string}`;
    };
}

function reason(obs: Observation): Decision {
    const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;

    // Guard: agent is not active
    if (obs.agentState.status !== 0) {
        return { shouldAct: false, reason: `Agent status is ${obs.agentState.status} (not Active)` };
    }

    // Guard: no renter
    if (obs.renter === ZERO_ADDR) {
        return { shouldAct: false, reason: "No active renter" };
    }

    // Guard: we are not the authorized operator
    if (obs.operator.toLowerCase() !== account.address.toLowerCase()) {
        return { shouldAct: false, reason: `Not authorized operator (current: ${obs.operator})` };
    }

    // Guard: vault balance too low to do anything meaningful
    if (obs.agentState.balance === 0n) {
        return { shouldAct: false, reason: "Agent account balance is zero" };
    }

    // ─── Placeholder: Strategy Logic ───
    // In a real implementation, this would:
    // 1. Check market conditions via oracle/DEX quotes
    // 2. Evaluate position health (DeFi lending)
    // 3. Calculate optimal trade parameters
    // 4. Build the Action struct
    //
    // For MVP, we just log the observation and skip.
    return {
        shouldAct: false,
        reason: `Idle — balance: ${formatEther(obs.agentState.balance)} BNB, block: ${obs.blockNumber}`,
    };
}

// ─── Act ───

async function act(decision: Decision): Promise<void> {
    if (!decision.shouldAct || !decision.action) return;

    log.info(`Executing action → target: ${decision.action.target}`);

    try {
        const hash = await walletClient.writeContract({
            address: config.agentNfaAddress,
            abi: AgentNFAAbi,
            functionName: "execute",
            args: [
                config.tokenId,
                {
                    target: decision.action.target,
                    value: decision.action.value,
                    data: decision.action.data,
                },
            ],
        });

        log.info(`TX sent: ${hash}`);

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        log.info(`TX confirmed in block ${receipt.blockNumber}, status: ${receipt.status}`);
    } catch (err) {
        log.error("Execution failed:", err instanceof Error ? err.message : err);
    }
}

// ─── Main Loop ───

async function runLoop(): Promise<void> {
    log.info("=== SHLL Agent Runner ===");
    log.info(`Operator: ${account.address}`);
    log.info(`Agent NFA: ${config.agentNfaAddress}`);
    log.info(`Token ID: ${config.tokenId.toString()}`);
    log.info(`Poll interval: ${config.pollIntervalMs}ms`);
    log.info("");

    let consecutiveErrors = 0;

    while (true) {
        try {
            // 1. Observe
            const obs = await observe();

            // 2. Reason
            const decision = reason(obs);
            log.info(`[Tick] ${decision.reason}`);

            // 3. Act
            if (decision.shouldAct) {
                await act(decision);
            }

            consecutiveErrors = 0;
        } catch (err) {
            consecutiveErrors++;
            log.error(`Loop error (${consecutiveErrors}/${config.maxRetries}):`, err instanceof Error ? err.message : err);

            if (consecutiveErrors >= config.maxRetries) {
                log.error("Max retries reached, backing off for 60s...");
                await sleep(60_000);
                consecutiveErrors = 0;
            }
        }

        await sleep(config.pollIntervalMs);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Start
runLoop().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
