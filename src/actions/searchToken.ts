/**
 * Search Token Action — Find tokens by name/symbol on BSC via DexScreener.
 *
 * Enables the LLM to resolve token names (e.g. "币安人生") to contract
 * addresses without requiring the user to provide them manually.
 */

import type { IAction, ActionPayload, ToolResult } from "./interface.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const DEXSCREENER_SEARCH = "https://api.dexscreener.com/latest/dex/search";

export function createSearchTokenAction(): IAction {
    return {
        name: "search_token",
        description: "Search for tokens by name or symbol on BSC. Returns matching tokens with contract addresses, prices, and liquidity. Use this when the user mentions a token by name and you don't have the contract address.",
        readonly: true,

        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Token name or symbol to search for (e.g. 'Binance Life', 'PEPE', '币安人生')",
                },
            },
            required: ["query"],
        },

        async execute(params: Record<string, unknown>): Promise<ToolResult> {
            const query = params.query as string;
            if (!query || query.trim().length === 0) {
                return { success: false, data: null, error: "Search query is required" };
            }

            try {
                const encoded = encodeURIComponent(query.trim());
                const resp = await fetch(`${DEXSCREENER_SEARCH}?q=${encoded}`, {
                    signal: AbortSignal.timeout(10_000),
                });

                if (!resp.ok) {
                    return { success: false, data: null, error: `DexScreener search error: ${resp.status}` };
                }

                const raw = await resp.json() as {
                    pairs?: Array<{
                        chainId: string;
                        dexId: string;
                        baseToken: { address: string; name: string; symbol: string };
                        quoteToken: { address: string; name: string; symbol: string };
                        priceUsd: string;
                        volume: { h24: number };
                        liquidity: { usd: number };
                        fdv: number;
                    }>;
                };

                // Filter to BSC pairs only and deduplicate by base token address
                const bscPairs = (raw.pairs ?? []).filter(p => p.chainId === "bsc");
                const seen = new Set<string>();
                const unique = bscPairs.filter(p => {
                    const addr = p.baseToken.address.toLowerCase();
                    if (seen.has(addr)) return false;
                    seen.add(addr);
                    return true;
                });

                if (unique.length === 0) {
                    return {
                        success: true,
                        data: {
                            message: "No BSC tokens found matching this query. Ask the user for the contract address.",
                            results: [],
                        },
                    };
                }

                // Return top 5 unique tokens sorted by liquidity
                const top = unique
                    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
                    .slice(0, 5)
                    .map(p => ({
                        tokenAddress: p.baseToken.address,
                        name: p.baseToken.name,
                        symbol: p.baseToken.symbol,
                        priceUsd: p.priceUsd,
                        liquidityUsd: p.liquidity?.usd ?? 0,
                        volume24h: p.volume?.h24 ?? 0,
                        fdv: p.fdv,
                        dex: p.dexId,
                        quotedAgainst: p.quoteToken.symbol,
                    }));

                return {
                    success: true,
                    data: {
                        query,
                        resultsFound: top.length,
                        results: top,
                        hint: "Pick the token with highest liquidity. Use get_market_data with the tokenAddress for detailed price data.",
                    },
                };
            } catch (err) {
                return {
                    success: false,
                    data: null,
                    error: err instanceof Error ? err.message : "Unknown error searching tokens",
                };
            }
        },

        encode(_params: Record<string, unknown>): ActionPayload {
            return { target: ZERO_ADDRESS, value: 0n, data: "0x" };
        },
    };
}
