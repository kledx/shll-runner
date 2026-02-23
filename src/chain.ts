/**
 * Chain Services — On-chain read/write operations for SHLL Agent Runner.
 *
 * V3: Simplified to only include AgentNFA operations.
 * PolicyGuardV4 validation is handled by the Guardrails module.
 * V3.1: Delegates core reads/writes to @shll/runner-sdk
 */

import type { Address, Hex } from "viem";
import { createPublicClient, http } from "viem";
import { bscTestnet } from "viem/chains";
import { ChainReader, TransactionBuilder } from "@shll/runner-sdk";
import { SubscriptionManagerAbi } from "./abi.js";
import type {
    ActionPayload,
    ActionResult,
    EnableResult,
    NormalizedPermit,
    Observation,
} from "./types.js";

export interface ChainServices {
    publicClient: import("viem").PublicClient;
    account: { address: Address };
    observe: (tokenId: bigint) => Promise<Observation>;
    readStatus: (tokenId: bigint) => Promise<{
        onchainOperator: Address;
        operatorExpires: bigint;
        renter: Address;
        renterExpires: bigint;
        operatorNonce: bigint;
    }>;
    enableOperatorWithPermit: (
        permit: NormalizedPermit,
        sig: Hex,
        waitForReceipt: boolean,
    ) => Promise<EnableResult>;
    clearOperator: (
        tokenId: bigint,
        waitForReceipt: boolean,
    ) => Promise<EnableResult>;
    executeAction: (
        tokenId: bigint,
        action: ActionPayload,
    ) => Promise<ActionResult>;
    readAgentType: (tokenId: bigint) => Promise<string>;
    readSubscriptionStatus: (tokenId: bigint) => Promise<
        "None" | "Active" | "GracePeriod" | "Expired" | "Canceled"
    >;
}

interface ChainConfig {
    rpcUrl: string;
    rpcTimeoutMs: number;
    rpcRetryCount: number;
    operatorPrivateKey: `0x${string}`;
    agentNfaAddress: `0x${string}`;
    subscriptionManagerAddress?: `0x${string}`;
}

export function createChainServices(config: ChainConfig): ChainServices {
    const reader = new ChainReader({
        rpcUrl: config.rpcUrl,
        agentNfaAddress: config.agentNfaAddress,
        rpcTimeoutMs: config.rpcTimeoutMs,
        rpcRetryCount: config.rpcRetryCount,
    });

    const builder = new TransactionBuilder({
        rpcUrl: config.rpcUrl,
        operatorPrivateKey: config.operatorPrivateKey,
        agentNfaAddress: config.agentNfaAddress,
    });

    async function observe(tokenId: bigint): Promise<Observation> {
        return reader.observe(tokenId) as Promise<Observation>;
    }

    async function readStatus(tokenId: bigint) {
        return reader.readStatus(tokenId);
    }

    async function enableOperatorWithPermit(
        permit: NormalizedPermit,
        sig: Hex,
        waitForReceipt: boolean,
    ): Promise<EnableResult> {
        const result = await builder.enableOperatorWithPermit(permit, sig);
        if (!waitForReceipt) return result;

        const receipt = await reader.publicClient.waitForTransactionReceipt({
            hash: result.hash,
        });
        return {
            hash: result.hash,
            receiptStatus: receipt.status,
            receiptBlock: receipt.blockNumber.toString(),
        };
    }

    async function clearOperator(
        tokenId: bigint,
        waitForReceipt: boolean,
    ): Promise<EnableResult> {
        const result = await builder.clearOperator(tokenId);
        if (!waitForReceipt) return result;

        const receipt = await reader.publicClient.waitForTransactionReceipt({
            hash: result.hash,
        });
        return {
            hash: result.hash,
            receiptStatus: receipt.status,
            receiptBlock: receipt.blockNumber.toString(),
        };
    }

    async function executeAction(
        tokenId: bigint,
        action: ActionPayload,
    ): Promise<ActionResult> {
        const result = await builder.executeAction(tokenId, action);
        const receipt = await reader.publicClient.waitForTransactionReceipt({
            hash: result.hash,
        });

        return {
            hash: result.hash,
            receiptStatus: receipt.status,
            receiptBlock: receipt.blockNumber.toString(),
        };
    }

    async function readAgentType(tokenId: bigint): Promise<string> {
        return reader.readAgentType(tokenId);
    }

    const STATUS_LABELS = ["None", "Active", "GracePeriod", "Expired", "Canceled"] as const;
    type SubStatus = typeof STATUS_LABELS[number];

    // V4: Read subscription status from SubscriptionManager
    async function readSubscriptionStatus(tokenId: bigint): Promise<SubStatus> {
        const subAddr = config.subscriptionManagerAddress;
        // No SubscriptionManager configured → treat as legacy (None)
        if (!subAddr || subAddr === "0x0000000000000000000000000000000000000000") {
            return "None";
        }
        try {
            const subClient = createPublicClient({
                chain: bscTestnet,
                transport: http(config.rpcUrl),
            });
            const statusIndex = await subClient.readContract({
                address: subAddr,
                abi: SubscriptionManagerAbi,
                functionName: "getEffectiveStatus",
                args: [tokenId],
            }) as number;
            return STATUS_LABELS[statusIndex] ?? "None";
        } catch {
            // Contract call failed (legacy instance, no record) → None
            return "None";
        }
    }

    return {
        publicClient: reader.publicClient as any,
        account: { address: builder.accountAddress },
        observe,
        readStatus,
        enableOperatorWithPermit,
        clearOperator,
        executeAction,
        readAgentType,
        readSubscriptionStatus,
    };
}
