/**
 * Trigger Evaluator — Programmatic condition checker.
 *
 * Runs in the scheduler loop at high frequency (every 3-5s).
 * Fetches token prices from DexScreener API in batch,
 * evaluates all active triggers, returns fired ones.
 *
 * Does NOT call the LLM — pure programmatic evaluation.
 */

import type { TriggerGoal, TriggerFired } from "./interface.js";

const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens";

/** Price cache entry */
interface PriceEntry {
    priceUsd: number;
    fetchedAt: number;
}

// Cache prices for 3 seconds to avoid redundant API calls
const priceCache = new Map<string, PriceEntry>();
const CACHE_TTL_MS = 3_000;

/**
 * Batch-fetch USD prices for a set of token addresses from DexScreener.
 * DexScreener supports comma-separated addresses in a single request.
 */
async function fetchPrices(tokens: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    if (tokens.length === 0) return prices;

    // Use cached prices where fresh enough
    const now = Date.now();
    const staleTokens: string[] = [];
    for (const t of tokens) {
        const cached = priceCache.get(t.toLowerCase());
        if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
            prices.set(t.toLowerCase(), cached.priceUsd);
        } else {
            staleTokens.push(t);
        }
    }

    if (staleTokens.length === 0) return prices;

    try {
        // DexScreener allows comma-separated token addresses (up to ~30)
        const batchSize = 30;
        for (let i = 0; i < staleTokens.length; i += batchSize) {
            const batch = staleTokens.slice(i, i + batchSize);
            const joined = batch.join(",");
            const resp = await fetch(`${DEXSCREENER_API}/${joined}`, {
                signal: AbortSignal.timeout(8_000),
            });

            if (!resp.ok) continue;

            const raw = await resp.json() as {
                pairs?: Array<{
                    chainId: string;
                    baseToken: { address: string };
                    priceUsd: string;
                    liquidity?: { usd: number };
                }>;
            };

            // For each token, pick the BSC pair with highest liquidity
            const bscPairs = (raw.pairs ?? []).filter(p => p.chainId === "bsc");
            const tokenBestPrice = new Map<string, { price: number; liquidity: number }>();

            for (const pair of bscPairs) {
                const addr = pair.baseToken.address.toLowerCase();
                const price = parseFloat(pair.priceUsd);
                if (isNaN(price) || price <= 0) continue;

                const liq = pair.liquidity?.usd ?? 0;
                const existing = tokenBestPrice.get(addr);
                if (!existing || liq > existing.liquidity) {
                    tokenBestPrice.set(addr, { price, liquidity: liq });
                }
            }

            for (const [addr, { price }] of tokenBestPrice) {
                prices.set(addr, price);
                priceCache.set(addr, { priceUsd: price, fetchedAt: now });
            }
        }
    } catch {
        // Silently fail — we'll retry next cycle
    }

    return prices;
}

/**
 * Evaluate all active triggers against current market prices.
 * Returns an array of triggers that have fired.
 */
export async function evaluateTriggers(
    triggers: TriggerGoal[],
): Promise<TriggerFired[]> {
    if (triggers.length === 0) return [];

    // Collect unique token addresses to fetch
    const tokenAddresses = [...new Set(
        triggers
            .map(t => t.condition.token.toLowerCase())
            .filter(Boolean),
    )];

    const prices = await fetchPrices(tokenAddresses);
    const fired: TriggerFired[] = [];
    const now = new Date();

    for (const trigger of triggers) {
        const { condition } = trigger;

        switch (condition.type) {
            case "price_below": {
                const price = prices.get(condition.token.toLowerCase());
                if (price == null || condition.threshold == null) break;
                if (price <= condition.threshold) {
                    fired.push({ trigger, currentPrice: price, firedAt: now });
                }
                break;
            }

            case "price_above": {
                const price = prices.get(condition.token.toLowerCase());
                if (price == null || condition.threshold == null) break;
                if (price >= condition.threshold) {
                    fired.push({ trigger, currentPrice: price, firedAt: now });
                }
                break;
            }

            case "price_change_pct": {
                const price = prices.get(condition.token.toLowerCase());
                if (price == null || condition.changePercent == null || !trigger.basePrice) break;
                const pctChange = ((price - trigger.basePrice) / trigger.basePrice) * 100;
                const direction = condition.direction ?? "down";
                if (direction === "down" && pctChange <= -Math.abs(condition.changePercent)) {
                    fired.push({ trigger, currentPrice: price, firedAt: now });
                } else if (direction === "up" && pctChange >= Math.abs(condition.changePercent)) {
                    fired.push({ trigger, currentPrice: price, firedAt: now });
                }
                break;
            }

            case "time_interval": {
                if (!condition.intervalMs) break;
                const lastFired = trigger.lastTriggeredAt?.getTime() ?? trigger.createdAt.getTime();
                if (Date.now() - lastFired >= condition.intervalMs) {
                    const price = prices.get(condition.token.toLowerCase());
                    fired.push({ trigger, currentPrice: price ?? 0, firedAt: now });
                }
                break;
            }
        }
    }

    return fired;
}
