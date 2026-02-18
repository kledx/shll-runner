/**
 * DCA Rule Brain — Deterministic DCA strategy brain.
 *
 * Implements IBrain for Dollar-Cost Averaging:
 *   - Always decides to swap a fixed amount at each cycle
 *   - Timing control is external (caller's scheduling interval)
 *   - Validates DCA params from strategy config
 *
 * Migrated from strategies/dca.ts, adapted to IBrain interface.
 */

import type { IBrain, Decision } from "../interface.js";
import type { Observation } from "../../perception/interface.js";
import type { MemoryEntry } from "../../memory/interface.js";
import type { IAction } from "../../actions/interface.js";

// ═══════════════════════════════════════════════════════
//                  DCA Configuration
// ═══════════════════════════════════════════════════════

export interface DCABrainConfig {
    /** ERC20 address to accumulate */
    tokenToBuy: string;
    /** ERC20 address to spend (e.g. WBNB) */
    tokenToSpend: string;
    /** Wei string — amount to spend each execution */
    amountPerExecution: string;
    /** Max slippage in bps (default: 100 = 1%) */
    slippageBps?: number;
    /** DEX router address */
    routerAddress: string;
}

const DEFAULT_SLIPPAGE_BPS = 100;

// ═══════════════════════════════════════════════════════
//                     DCA Brain
// ═══════════════════════════════════════════════════════

export class DCABrain implements IBrain {
    private config: DCABrainConfig;

    constructor(config: DCABrainConfig) {
        this.config = config;
    }

    async think(
        obs: Observation,
        _memories: MemoryEntry[],
        actions: IAction[],
    ): Promise<Decision> {
        // Validate DCA config — all required fields must be set
        if (!this.config.routerAddress || !this.config.tokenToBuy || !this.config.tokenToSpend) {
            return {
                action: "wait",
                params: {},
                reasoning: "DCA: strategy not configured (missing router/tokenToBuy/tokenToSpend). Set strategyParams via /strategy/upsert.",
                confidence: 1.0,
            };
        }

        // Validate swap action is available
        const hasSwap = actions.some(a => a.name === "swap");
        if (!hasSwap) {
            return {
                action: "wait",
                params: {},
                reasoning: "DCA: swap action not available",
                confidence: 1.0,
            };
        }

        // Check if vault has enough balance (native or token)
        const amountIn = BigInt(this.config.amountPerExecution);
        if (obs.nativeBalance < amountIn) {
            return {
                action: "wait",
                params: {},
                reasoning: `DCA: insufficient balance. Need ${amountIn}, have ${obs.nativeBalance}`,
                confidence: 1.0,
            };
        }

        // DCA always acts — the scheduling interval provides timing control
        return {
            action: "swap",
            params: {
                router: this.config.routerAddress,
                tokenIn: this.config.tokenToSpend,
                tokenOut: this.config.tokenToBuy,
                amountIn: this.config.amountPerExecution,
                minOut: "0", // Rely on on-chain slippage protection
                slippageBps: this.config.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
            },
            reasoning: `DCA periodic buy: spending ${this.config.amountPerExecution} wei of ${this.config.tokenToSpend.slice(0, 10)} for ${this.config.tokenToBuy.slice(0, 10)}`,
            confidence: 1.0,
        };
    }
}
