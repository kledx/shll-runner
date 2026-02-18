/**
 * Analytics Action — Read-only market data analysis.
 *
 * Queries market signals and provides analytical data to the Brain.
 * No on-chain transaction is produced.
 */

import type { IAction, ActionPayload } from "./interface.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export function createAnalyticsAction(): IAction {
    return {
        name: "analytics",
        description: "Analyze market data and signals (read-only, no transaction). Params: pair, metric",
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
