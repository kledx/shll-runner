/**
 * Portfolio Action — Read-only vault position analysis.
 *
 * Provides portfolio data (balances, P&L, allocation) to the Brain.
 * No on-chain transaction is produced.
 */

import type { IAction, ActionPayload } from "./interface.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export function createPortfolioAction(): IAction {
    return {
        name: "portfolio",
        description: "Analyze vault portfolio positions and allocation (read-only, no transaction). Params: none",
        readonly: true,

        encode(_params: Record<string, unknown>): ActionPayload {
            // Read-only action — returns a no-op payload
            return {
                target: ZERO_ADDRESS,
                value: 0n,
                data: "0x",
            };
        },
    };
}
