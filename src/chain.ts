import {
    createPublicClient,
    createWalletClient,
    http,
    decodeAbiParameters,
    keccak256,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AgentNFAAbi } from "./abi.js";
import { InstanceConfigAbi, PolicyGuardV2Abi } from "./instanceConfigAbi.js";
import type {
    ActionPayload,
    ActionResult,
    EnableResult,
    InstanceConfigData,
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
    /** V1.4: Read on-chain instance config (returns undefined if contract unconfigured) */
    readInstanceConfig: (tokenId: bigint) => Promise<InstanceConfigData | undefined>;
    /** V1.4: Pre-validate action against PolicyGuardV2 */
    preValidate: (
        tokenId: bigint,
        agentAccount: Address,
        action: ActionPayload
    ) => Promise<{ ok: boolean; reason: string }>;
    enableOperatorWithPermit: (
        permit: NormalizedPermit,
        sig: Hex,
        waitForReceipt: boolean
    ) => Promise<EnableResult>;
    clearOperator: (tokenId: bigint, waitForReceipt: boolean) => Promise<EnableResult>;
    executeAction: (tokenId: bigint, action: ActionPayload) => Promise<ActionResult>;
}

interface ChainConfig {
    rpcUrl: string;
    rpcTimeoutMs: number;
    rpcRetryCount: number;
    operatorPrivateKey: `0x${string}`;
    agentNfaAddress: `0x${string}`;
    instanceConfigAddress: `0x${string}`;
    policyGuardV2Address: `0x${string}`;
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
        const [agentState, agentAccount, renter, renterExpires, operator, operatorExpires, block] =
            await Promise.all([
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
        const [onchainOperator, operatorExpires, renter, renterExpires, operatorNonce] =
            await Promise.all([
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
        waitForReceipt: boolean
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

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        return {
            hash,
            receiptStatus: receipt.status,
            receiptBlock: receipt.blockNumber.toString(),
        };
    }

    async function clearOperator(
        tokenId: bigint,
        waitForReceipt: boolean
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

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        return {
            hash,
            receiptStatus: receipt.status,
            receiptBlock: receipt.blockNumber.toString(),
        };
    }

    async function executeAction(
        tokenId: bigint,
        action: ActionPayload
    ): Promise<ActionResult> {
        const simulation = await publicClient.simulateContract({
            address: config.agentNfaAddress,
            abi: AgentNFAAbi,
            functionName: "execute",
            args: [tokenId, action],
            account,
        });

        const hash = await walletClient.writeContract(simulation.request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        return {
            hash,
            receiptStatus: receipt.status,
            receiptBlock: receipt.blockNumber.toString(),
        };
    }

    // ── V1.4: Read InstanceConfig ─────────────────────────────────
    const ZERO = "0x0000000000000000000000000000000000000000" as Address;
    const instanceConfigEnabled =
        config.instanceConfigAddress && config.instanceConfigAddress !== ZERO;
    const policyGuardV2Enabled =
        config.policyGuardV2Address && config.policyGuardV2Address !== ZERO;

    // Decode InstanceParams from ABI-encoded bytes
    // Solidity struct: (uint16 slippageBps, uint256 tradeLimit, uint256 dailyLimit,
    //                   uint8 tokenGroupId, uint8 dexGroupId, uint8 riskTier)
    function decodeInstanceParams(paramsPacked: Hex): Omit<InstanceConfigData, "policyId" | "version" | "paramsPacked" | "paramsHash"> {
        const decoded = decodeAbiParameters(
            [
                { name: "slippageBps", type: "uint16" },
                { name: "tradeLimit", type: "uint256" },
                { name: "dailyLimit", type: "uint256" },
                { name: "tokenGroupId", type: "uint8" },
                { name: "dexGroupId", type: "uint8" },
                { name: "riskTier", type: "uint8" },
            ],
            paramsPacked
        );
        return {
            slippageBps: Number(decoded[0]),
            tradeLimit: decoded[1] as bigint,
            dailyLimit: decoded[2] as bigint,
            tokenGroupId: Number(decoded[3]),
            dexGroupId: Number(decoded[4]),
            riskTier: Number(decoded[5]),
        };
    }

    async function readInstanceConfig(tokenId: bigint): Promise<InstanceConfigData | undefined> {
        if (!instanceConfigEnabled) return undefined;
        try {
            const result = await publicClient.readContract({
                address: config.instanceConfigAddress,
                abi: InstanceConfigAbi,
                functionName: "configs",
                args: [tokenId],
            });
            // result = [ref: {policyId, version}, paramsPacked, paramsHash]
            const ref = result[0] as { policyId: number; version: number };
            const paramsPacked = result[1] as Hex;
            const paramsHash = result[2] as Hex;

            // If paramsHash is zero, instance has no config bound
            if (paramsHash === "0x0000000000000000000000000000000000000000000000000000000000000000") {
                return undefined;
            }

            const decoded = decodeInstanceParams(paramsPacked);
            return {
                policyId: Number(ref.policyId),
                version: Number(ref.version),
                ...decoded,
                paramsPacked: paramsPacked,
                paramsHash: paramsHash,
            };
        } catch {
            // Contract call failed (e.g. not deployed yet) — graceful degrade
            return undefined;
        }
    }

    async function preValidate(
        tokenId: bigint,
        agentAccount: Address,
        action: ActionPayload
    ): Promise<{ ok: boolean; reason: string }> {
        if (!policyGuardV2Enabled) {
            return { ok: true, reason: "PolicyGuardV2 not configured" };
        }
        try {
            const result = await publicClient.readContract({
                address: config.policyGuardV2Address,
                abi: PolicyGuardV2Abi,
                functionName: "validate",
                args: [
                    config.agentNfaAddress,
                    tokenId,
                    agentAccount,
                    account.address,
                    { target: action.target, value: action.value, data: action.data },
                ],
            });
            return {
                ok: result[0] as boolean,
                reason: (result[1] as string) || "ok",
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, reason: `preValidate call failed: ${message}` };
        }
    }

    return {
        publicClient,
        account,
        observe,
        readStatus,
        readInstanceConfig,
        preValidate,
        enableOperatorWithPermit,
        clearOperator,
        executeAction,
    };
}
