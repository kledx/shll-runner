/**
 * Analytics Action — Read-only market data tool.
 *
 * Fetches real market data from DEXScreener API and returns it to the Brain.
 * LLM can call this tool to get price, volume, and liquidity data for a token pair.
 */

import type { IAction, ActionPayload, ToolResult } from "./interface.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// DEXScreener API for BSC
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";

export function createAnalyticsAction(): IAction {
    return {
        name: "get_market_data",
        description: "Fetch real-time market data for a token pair on BSC. Returns price, volume, liquidity, and price changes. Use this BEFORE making a trading decision.",
        readonly: true,

        parameters: {
            type: "object",
            properties: {
                tokenAddress: {
                    type: "string",
                    description: "The token contract address to look up (0x...). Will search for pairs containing this token on BSC.",
                },
            },
            required: ["tokenAddress"],
        },

        async execute(params: Record<string, unknown>): Promise<ToolResult> {
            const tokenAddress = params.tokenAddress as string;
            if (!tokenAddress || !/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
                return { success: false, data: null, error: "Invalid token address" };
            }

            try {
                const resp = await fetch(`${DEXSCREENER_API}/tokens/${tokenAddress}`, {
                    signal: AbortSignal.timeout(10_000),
                });

                if (!resp.ok) {
                    return { success: false, data: null, error: `DEXScreener API error: ${resp.status}` };
                }

                const raw = await resp.json() as {
                    pairs?: Array<{
                        chainId: string;
                        dexId: string;
                        pairAddress: string;
                        baseToken: { address: string; name: string; symbol: string };
                        quoteToken: { address: string; name: string; symbol: string };
                        priceNative: string;
                        priceUsd: string;
                        txns: { h24: { buys: number; sells: number } };
                        volume: { h24: number; h6: number; h1: number; m5: number };
                        priceChange: { h24: number; h6: number; h1: number; m5: number };
                        liquidity: { usd: number; base: number; quote: number };
                        fdv: number;
                    }>;
                };

                // Filter to BSC pairs only
                const bscPairs = (raw.pairs ?? []).filter(p => p.chainId === "bsc");

                if (bscPairs.length === 0) {
                    return { success: true, data: { message: "No BSC pairs found for this token", pairs: [] } };
                }

                // Return top 3 pairs by liquidity
                const top = bscPairs.slice(0, 3).map(p => ({
                    pair: `${p.baseToken.symbol}/${p.quoteToken.symbol}`,
                    pairAddress: p.pairAddress,
                    dex: p.dexId,
                    priceUsd: p.priceUsd,
                    priceNative: p.priceNative,
                    volume24h: p.volume.h24,
                    volume1h: p.volume.h1,
                    priceChange24h: `${p.priceChange.h24}%`,
                    priceChange1h: `${p.priceChange.h1}%`,
                    priceChange5m: `${p.priceChange.m5}%`,
                    liquidityUsd: p.liquidity.usd,
                    buys24h: p.txns.h24.buys,
                    sells24h: p.txns.h24.sells,
                    fdv: p.fdv,
                }));

                return { success: true, data: { tokenAddress, pairsFound: top.length, pairs: top } };
            } catch (err) {
                return {
                    success: false,
                    data: null,
                    error: err instanceof Error ? err.message : "Unknown error fetching market data",
                };
            }
        },

        encode(_params: Record<string, unknown>): ActionPayload {
            // Read-only action — returns a no-op payload
            return { target: ZERO_ADDRESS, value: 0n, data: "0x" };
        },
    };
}
