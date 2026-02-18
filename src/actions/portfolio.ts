/**
 * Portfolio Action — Read-only vault position and balance tool.
 *
 * Returns a summary of the agent's vault holdings to the Brain.
 * LLM can call this tool to check current positions before trading.
 *
 * Note: This action uses the observation data passed via params
 * (injected by the runtime from the perception layer).
 */

import type { IAction, ActionPayload, ToolResult } from "./interface.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export function createPortfolioAction(): IAction {
    return {
        name: "get_portfolio",
        description: "Get the agent's current vault holdings and token balances. Call this to understand your current positions before trading.",
        readonly: true,

        parameters: {
            type: "object",
            properties: {},
            required: [],
        },

        async execute(params: Record<string, unknown>): Promise<ToolResult> {
            // The runtime injects observation data into params
            const vault = params.__vault as string | undefined;
            const vaultTokens = params.__vaultTokens as Array<{
                symbol: string;
                balance: string | bigint;
                decimals: number;
                token: string; // address
            }> | undefined;
            const nativeBalance = params.__nativeBalance as string | undefined;

            const summary = {
                vaultAddress: vault ?? "unknown",
                nativeBalance: nativeBalance ?? "0",
                tokens: (vaultTokens ?? []).map(t => ({
                    symbol: t.symbol,
                    balance: t.balance.toString(),
                    decimals: t.decimals,
                    address: t.token,
                })),
                totalTokenTypes: (vaultTokens ?? []).length,
            };

            return { success: true, data: summary };
        },

        encode(_params: Record<string, unknown>): ActionPayload {
            // Read-only action — returns a no-op payload
            return { target: ZERO_ADDRESS, value: 0n, data: "0x" };
        },
    };
}
