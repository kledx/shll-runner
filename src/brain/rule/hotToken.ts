/**
 * Hot Token Rule Brain — Market-signal-driven trading brain.
 *
 * Monitors price/volume signals and triggers swaps on hot tokens
 * that match configured thresholds.
 *
 * Migrated from strategyRegistry.ts hotpump_watchlist handler.
 */

import type { IBrain, Decision } from "../interface.js";
import type { Observation } from "../../perception/interface.js";
import type { MemoryEntry } from "../../memory/interface.js";
import type { IAction } from "../../actions/interface.js";

// ═══════════════════════════════════════════════════════
//              Hot Token Configuration
// ═══════════════════════════════════════════════════════

export interface HotTokenBrainConfig {
    /** Token pairs to watch (e.g. ["WBNB/USDT", "CAKE/WBNB"]) */
    watchlistPairs: string[];
    /** Minimum price change in bps to trigger action */
    minPriceChangeBps: number;
    /** Minimum 5m volume to consider (token units) */
    minVolume5m: bigint;
    /** DEX router address */
    routerAddress: string;
    /** Amount to invest per trigger */
    amountPerTrade: string;
    /** Max signal age in ms before considering stale */
    maxSignalAgeMs: number;
}

const DEFAULT_MIN_PRICE_CHANGE_BPS = 500;  // 5%
const DEFAULT_MAX_SIGNAL_AGE_MS = 5 * 60_000;  // 5 minutes

// ═══════════════════════════════════════════════════════
//                  Hot Token Brain
// ═══════════════════════════════════════════════════════

export class HotTokenBrain implements IBrain {
    private config: HotTokenBrainConfig;

    constructor(config: HotTokenBrainConfig) {
        this.config = config;
    }

    async think(
        obs: Observation,
        memories: MemoryEntry[],
        actions: IAction[],
    ): Promise<Decision> {
        const hasSwap = actions.some(a => a.name === "swap");
        if (!hasSwap) {
            return {
                action: "wait",
                params: {},
                reasoning: "HotToken: swap action not available",
                confidence: 1.0,
            };
        }

        // Check recent memories to avoid re-trading same signal
        const recentSwaps = memories
            .filter(m => m.type === "execution" && m.action === "swap")
            .slice(0, 5);

        // For now, the hot token brain is a skeleton — market signal integration
        // requires the perception module to provide price/volume signals.
        // This will be fully connected when perception.observe() includes
        // market signal data from the DB.

        // Default: wait if no actionable signal detected
        return {
            action: "wait",
            params: {},
            reasoning: "HotToken: no actionable market signal detected in current cycle",
            confidence: 0.5,
        };
    }
}
