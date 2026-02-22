/**
 * Allowance Action — Read-only ERC20 allowance check tool.
 *
 * Returns the current spending allowance for a token/spender pair.
 * LLM uses this to check if approve is needed before swapping.
 */

import { createPublicClient, http, erc20Abi } from "viem";
import { bsc, bscTestnet } from "viem/chains";
import type { IAction, ActionPayload, ToolResult } from "./interface.js";
import { getChainIdFromEnv } from "../chainDefaults.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export function createAllowanceAction(): IAction {
    return {
        name: "get_allowance",
        description: "Check the ERC20 token allowance for a spender. Call this BEFORE approving to see if approval is already granted. Returns the current allowance in wei.",
        readonly: true,

        parameters: {
            type: "object",
            properties: {
                token: { type: "string", description: "ERC20 token contract address" },
                owner: { type: "string", description: "Token owner address (the agent vault)" },
                spender: { type: "string", description: "Spender address (e.g. PancakeSwap router)" },
            },
            required: ["token", "owner", "spender"],
        },

        async execute(params: Record<string, unknown>): Promise<ToolResult> {
            try {
                const token = params.token as string;
                const owner = params.owner as string;
                const spender = params.spender as string;

                const chainId = getChainIdFromEnv();
                const chain = chainId === 56 ? bsc : bscTestnet;
                const defaultRpc = chainId === 56
                    ? "https://bsc-dataseed1.binance.org"
                    : "https://data-seed-prebsc-1-s1.binance.org:8545";
                const rpcUrl = process.env.RPC_URL || defaultRpc;

                const client = createPublicClient({
                    chain,
                    transport: http(rpcUrl),
                });

                const allowance = await client.readContract({
                    address: token as `0x${string}`,
                    abi: erc20Abi,
                    functionName: "allowance",
                    args: [owner as `0x${string}`, spender as `0x${string}`],
                });

                return {
                    success: true,
                    data: {
                        token,
                        owner,
                        spender,
                        allowance: allowance.toString(),
                        hasAllowance: allowance > 0n,
                    },
                };
            } catch (error) {
                return {
                    success: false,
                    data: undefined,
                    error: `Failed to check allowance: ${error instanceof Error ? error.message : "unknown"}`,
                };
            }
        },

        encode(_params: Record<string, unknown>): ActionPayload {
            // Read-only action — returns a no-op payload
            return { target: ZERO_ADDRESS, value: 0n, data: "0x" };
        },
    };
}
