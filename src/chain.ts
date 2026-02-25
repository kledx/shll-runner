/**
 * Chain Services — On-chain read/write operations for SHLL Agent Runner.
 *
 * V3: Simplified to only include AgentNFA operations.
 * PolicyGuardV4 validation is handled by the Guardrails module.
 * V3.1: Delegates core reads/writes to @shll/runner-sdk
 */

import type { Address, Hex } from "viem";
import { createPublicClient, http, encodeFunctionData } from "viem";
import { bscTestnet } from "viem/chains";
import { ChainReader, TransactionBuilder, MinimalAgentNFAAbi } from "@shll/runner-sdk";
import { SubscriptionManagerAbi, AgentNFAAbi, CooldownPolicyAbi } from "./abi.js";
import { erc20Abi } from "viem";
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
    executeBatchAction: (
        tokenId: bigint,
        actions: ActionPayload[],
    ) => Promise<ActionResult>;
    readAllowance: (
        token: string,
        owner: string,
        spender: string,
    ) => Promise<bigint>;
    readAgentType: (tokenId: bigint) => Promise<string>;
    readSubscriptionStatus: (tokenId: bigint) => Promise<
        "None" | "Active" | "GracePeriod" | "Expired" | "Canceled"
    >;
    readCooldownSeconds: (instanceId: bigint) => Promise<number>;
    getAmountsOut: (router: string, amountIn: bigint, path: string[]) => Promise<bigint[]>;
}

interface ChainConfig {
    rpcUrl: string;
    rpcTimeoutMs: number;
    rpcRetryCount: number;
    operatorPrivateKey: `0x${string}`;
    agentNfaAddress: `0x${string}`;
    subscriptionManagerAddress?: `0x${string}`;
    cooldownPolicyAddress?: `0x${string}`;
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
        // GAS-FIX: bypass SDK's simulateContract → writeContract (no gas buffer).
        // SHLL's deeply nested call chain (Operator → NFA → PolicyGuard.validate →
        // AgentAccount.executeCall → DEX router → PolicyGuard.commit) frequently
        // exhausts viem's default gas estimate. We estimate manually and apply 1.5x buffer.
        const walletClient = builder.walletClient;
        const account = walletClient.account!;

        // Step 1: estimate gas for the execute call
        const gasEstimate = await reader.publicClient.estimateContractGas({
            address: config.agentNfaAddress as Address,
            abi: MinimalAgentNFAAbi,
            functionName: "execute",
            args: [tokenId, action],
            account: account,
        });

        // Step 2: apply 50% buffer (nested calls need headroom)
        const gasLimit = gasEstimate * 3n / 2n;

        // Step 3: encode and submit with explicit gas
        const data = encodeFunctionData({
            abi: MinimalAgentNFAAbi,
            functionName: "execute",
            args: [tokenId, action],
        });

        const hash = await walletClient.sendTransaction({
            to: config.agentNfaAddress as Address,
            data: data as Hex,
            gas: gasLimit,
            account,
            chain: null,
        } as any);

        const receipt = await reader.publicClient.waitForTransactionReceipt({
            hash,
        });

        return {
            hash,
            receiptStatus: receipt.status,
            receiptBlock: receipt.blockNumber.toString(),
        };
    }

    async function executeBatchAction(
        tokenId: bigint,
        actions: ActionPayload[],
    ): Promise<ActionResult> {
        // Same gas strategy as executeAction but for batched calls
        const walletClient = builder.walletClient;
        const account = walletClient.account!;

        const gasEstimate = await reader.publicClient.estimateContractGas({
            address: config.agentNfaAddress as Address,
            abi: AgentNFAAbi,
            functionName: "executeBatch",
            args: [tokenId, actions],
            account: account,
        });

        const gasLimit = gasEstimate * 3n / 2n;

        const data = encodeFunctionData({
            abi: AgentNFAAbi,
            functionName: "executeBatch",
            args: [tokenId, actions],
        });

        const hash = await walletClient.sendTransaction({
            to: config.agentNfaAddress as Address,
            data: data as Hex,
            gas: gasLimit,
            account,
            chain: null,
        } as any);

        const receipt = await reader.publicClient.waitForTransactionReceipt({
            hash,
        });

        return {
            hash,
            receiptStatus: receipt.status,
            receiptBlock: receipt.blockNumber.toString(),
        };
    }

    async function readAllowance(
        token: string,
        owner: string,
        spender: string,
    ): Promise<bigint> {
        const allowance = await reader.publicClient.readContract({
            address: token as Address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [owner as Address, spender as Address],
        });
        return allowance as bigint;
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

    // Read on-chain cooldown configuration for dynamic backoff
    async function readCooldownSeconds(instanceId: bigint): Promise<number> {
        const cooldownAddr = config.cooldownPolicyAddress;
        if (!cooldownAddr) return 0;
        try {
            const result = await reader.publicClient.readContract({
                address: cooldownAddr as Address,
                abi: CooldownPolicyAbi,
                functionName: "cooldownSeconds",
                args: [instanceId],
            });
            return Number(result);
        } catch {
            return 0;
        }
    }

    const GET_AMOUNTS_OUT_ABI = [
        {
            type: "function" as const,
            name: "getAmountsOut",
            inputs: [
                { name: "amountIn", type: "uint256" },
                { name: "path", type: "address[]" },
            ],
            outputs: [{ name: "amounts", type: "uint256[]" }],
            stateMutability: "view" as const,
        },
    ] as const;

    async function getAmountsOut(routerAddr: string, amountIn: bigint, path: string[]): Promise<bigint[]> {
        try {
            const result = await reader.publicClient.readContract({
                address: routerAddr as Address,
                abi: GET_AMOUNTS_OUT_ABI,
                functionName: "getAmountsOut",
                args: [amountIn, path as Address[]],
            });
            return [...result];
        } catch {
            return [];
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
        executeBatchAction,
        readAllowance,
        readAgentType,
        readSubscriptionStatus,
        readCooldownSeconds,
        getAmountsOut,
    };
}
