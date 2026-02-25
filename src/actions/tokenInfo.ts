/**
 * Token Info Action — Read-only ERC20 metadata query.
 *
 * Returns name, symbol, decimals, and totalSupply for any ERC20 token.
 * Helps LLM understand token precision and verify token identity.
 */

import type { Address, PublicClient } from "viem";
import type { IAction, ToolResult, ActionPayload } from "./interface.js";

const ERC20_METADATA_ABI = [
    {
        type: "function" as const,
        name: "name",
        inputs: [],
        outputs: [{ name: "", type: "string" }],
        stateMutability: "view" as const,
    },
    {
        type: "function" as const,
        name: "symbol",
        inputs: [],
        outputs: [{ name: "", type: "string" }],
        stateMutability: "view" as const,
    },
    {
        type: "function" as const,
        name: "decimals",
        inputs: [],
        outputs: [{ name: "", type: "uint8" }],
        stateMutability: "view" as const,
    },
    {
        type: "function" as const,
        name: "totalSupply",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view" as const,
    },
] as const;

export function createTokenInfoAction(publicClient: PublicClient): IAction {
    return {
        name: "get_token_info",
        description:
            "Get ERC20 token metadata: name, symbol, decimals, and total supply. " +
            "Use this to verify a token's identity and understand its precision before trading.",
        readonly: true,

        parameters: {
            type: "object",
            properties: {
                tokenAddress: {
                    type: "string",
                    description: "The ERC20 token contract address (0x...)",
                },
            },
            required: ["tokenAddress"],
        },

        async execute(params: Record<string, unknown>): Promise<ToolResult> {
            const tokenAddress = (params.tokenAddress as string) as Address;

            try {
                const [name, symbol, decimals, totalSupply] = await Promise.all([
                    publicClient.readContract({
                        address: tokenAddress,
                        abi: ERC20_METADATA_ABI,
                        functionName: "name",
                    }).catch(() => "Unknown"),
                    publicClient.readContract({
                        address: tokenAddress,
                        abi: ERC20_METADATA_ABI,
                        functionName: "symbol",
                    }).catch(() => "???"),
                    publicClient.readContract({
                        address: tokenAddress,
                        abi: ERC20_METADATA_ABI,
                        functionName: "decimals",
                    }).catch(() => 18),
                    publicClient.readContract({
                        address: tokenAddress,
                        abi: ERC20_METADATA_ABI,
                        functionName: "totalSupply",
                    }).catch(() => 0n),
                ]);

                const decNum = Number(decimals);
                const supplyNum = Number(totalSupply) / Math.pow(10, decNum);

                return {
                    success: true,
                    data: {
                        address: tokenAddress.toLowerCase(),
                        name,
                        symbol,
                        decimals: decNum,
                        totalSupply: totalSupply.toString(),
                        totalSupplyFormatted: supplyNum.toLocaleString("en-US", {
                            maximumFractionDigits: 2,
                        }),
                    },
                };
            } catch (err) {
                return {
                    success: false,
                    data: {
                        error: "Failed to read token info — address may not be a valid ERC20.",
                        details: err instanceof Error ? err.message : String(err),
                    },
                };
            }
        },

        encode(): ActionPayload {
            throw new Error("get_token_info is read-only and cannot be encoded");
        },
    };
}
