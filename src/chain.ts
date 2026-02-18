/**
 * Chain Services — On-chain read/write operations for SHLL Agent Runner.
 *
 * V3: Simplified to only include AgentNFA operations.
 * PolicyGuardV4 validation is handled by the Guardrails module.
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    toHex,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AgentNFAAbi } from "./abi.js";
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
}

interface ChainConfig {
    rpcUrl: string;
    rpcTimeoutMs: number;
    rpcRetryCount: number;
    operatorPrivateKey: `0x${string}`;
    agentNfaAddress: `0x${string}`;
}

export function createChainServices(config: ChainConfig): ChainServices {
    const account = privateKeyToAccount(config.operatorPrivateKey);
    const transport = http(config.rpcUrl, {
        timeout: config.rpcTimeoutMs,
        retryCount: config.rpcRetryCount,
    });

    const publicClient = createPublicClient({
        transport,
    });

    const walletClient = createWalletClient({
        transport,
        account,
    });

    async function observe(tokenId: bigint): Promise<Observation> {
        const [
            agentState,
            agentAccount,
            renter,
            renterExpires,
            operator,
            operatorExpires,
            block,
        ] = await Promise.all([
            publicClient.readContract({
                address: config.agentNfaAddress,
                abi: AgentNFAAbi,
                functionName: "getState",
                args: [tokenId],
            }),
            publicClient.readContract({
                address: config.agentNfaAddress,
                abi: AgentNFAAbi,
                functionName: "accountOf",
                args: [tokenId],
            }),
            publicClient.readContract({
                address: config.agentNfaAddress,
                abi: AgentNFAAbi,
                functionName: "userOf",
                args: [tokenId],
            }),
            publicClient.readContract({
                address: config.agentNfaAddress,
                abi: AgentNFAAbi,
                functionName: "userExpires",
                args: [tokenId],
            }),
            publicClient.readContract({
                address: config.agentNfaAddress,
                abi: AgentNFAAbi,
                functionName: "operatorOf",
                args: [tokenId],
            }),
            publicClient.readContract({
                address: config.agentNfaAddress,
                abi: AgentNFAAbi,
                functionName: "operatorExpiresOf",
                args: [tokenId],
            }),
            publicClient.getBlock(),
        ]);

        return {
            tokenId,
            agentState: agentState as unknown as Observation["agentState"],
            agentAccount: agentAccount as Address,
            renter: renter as Address,
            renterExpires: renterExpires as bigint,
            operator: operator as Address,
            operatorExpires: operatorExpires as bigint,
            blockNumber: block.number,
            blockTimestamp: block.timestamp,
            timestamp: Date.now(),
        };
    }

    async function readStatus(tokenId: bigint): Promise<{
        onchainOperator: Address;
        operatorExpires: bigint;
        renter: Address;
        renterExpires: bigint;
        operatorNonce: bigint;
    }> {
        const [
            onchainOperator,
            operatorExpires,
            renter,
            renterExpires,
            operatorNonce,
        ] = await Promise.all([
            publicClient.readContract({
                address: config.agentNfaAddress,
                abi: AgentNFAAbi,
                functionName: "operatorOf",
                args: [tokenId],
            }),
            publicClient.readContract({
                address: config.agentNfaAddress,
                abi: AgentNFAAbi,
                functionName: "operatorExpiresOf",
                args: [tokenId],
            }),
            publicClient.readContract({
                address: config.agentNfaAddress,
                abi: AgentNFAAbi,
                functionName: "userOf",
                args: [tokenId],
            }),
            publicClient.readContract({
                address: config.agentNfaAddress,
                abi: AgentNFAAbi,
                functionName: "userExpires",
                args: [tokenId],
            }),
            publicClient.readContract({
                address: config.agentNfaAddress,
                abi: AgentNFAAbi,
                functionName: "operatorNonceOf",
                args: [tokenId],
            }),
        ]);

        return {
            onchainOperator: onchainOperator as Address,
            operatorExpires: operatorExpires as bigint,
            renter: renter as Address,
            renterExpires: renterExpires as bigint,
            operatorNonce: operatorNonce as bigint,
        };
    }

    async function enableOperatorWithPermit(
        permit: NormalizedPermit,
        sig: Hex,
        waitForReceipt: boolean,
    ): Promise<EnableResult> {
        const simulation = await publicClient.simulateContract({
            address: config.agentNfaAddress,
            abi: AgentNFAAbi,
            functionName: "setOperatorWithSig",
            args: [
                {
                    tokenId: permit.tokenId,
                    renter: permit.renter,
                    operator: permit.operator,
                    expires: permit.expires,
                    nonce: permit.nonce,
                    deadline: permit.deadline,
                },
                sig,
            ],
            account,
        });

        const hash = await walletClient.writeContract(simulation.request);
        if (!waitForReceipt) return { hash };

        const receipt = await publicClient.waitForTransactionReceipt({
            hash,
        });
        return {
            hash,
            receiptStatus: receipt.status,
            receiptBlock: receipt.blockNumber.toString(),
        };
    }

    async function clearOperator(
        tokenId: bigint,
        waitForReceipt: boolean,
    ): Promise<EnableResult> {
        const simulation = await publicClient.simulateContract({
            address: config.agentNfaAddress,
            abi: AgentNFAAbi,
            functionName: "clearOperator",
            args: [tokenId],
            account,
        });

        const hash = await walletClient.writeContract(simulation.request);
        if (!waitForReceipt) return { hash };

        const receipt = await publicClient.waitForTransactionReceipt({
            hash,
        });
        return {
            hash,
            receiptStatus: receipt.status,
            receiptBlock: receipt.blockNumber.toString(),
        };
    }

    async function executeAction(
        tokenId: bigint,
        action: ActionPayload,
    ): Promise<ActionResult> {
        const simulation = await publicClient.simulateContract({
            address: config.agentNfaAddress,
            abi: AgentNFAAbi,
            functionName: "execute",
            args: [tokenId, action],
            account,
        });

        const hash = await walletClient.writeContract(simulation.request);
        const receipt = await publicClient.waitForTransactionReceipt({
            hash,
        });

        return {
            hash,
            receiptStatus: receipt.status,
            receiptBlock: receipt.blockNumber.toString(),
        };
    }

    // keccak256 hash → agent type string lookup
    // Must match AgentNFA.sol TYPE_DCA, TYPE_LLM_TRADER, etc.
    const KNOWN_TYPES = ["dca", "llm_trader", "hot_token", "llm_defi"];
    const AGENT_TYPE_MAP: Record<string, string> = Object.fromEntries(
        KNOWN_TYPES.map((t) => [keccak256(toHex(t)), t]),
    );

    async function readAgentType(tokenId: bigint): Promise<string> {
        const raw = await publicClient.readContract({
            address: config.agentNfaAddress,
            abi: AgentNFAAbi,
            functionName: "agentType",
            args: [tokenId],
        });
        const hex = (raw as string).toLowerCase();
        return AGENT_TYPE_MAP[hex] ?? "unknown";
    }

    return {
        publicClient,
        account,
        observe,
        readStatus,
        enableOperatorWithPermit,
        clearOperator,
        executeAction,
        readAgentType,
    };
}
