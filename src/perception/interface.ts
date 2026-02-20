/**
 * IPerception — Sensory module for Agent cognitive loop.
 *
 * Gathers environmental state: vault balances, token prices, gas, etc.
 * Pure observation — no side effects.
 */

import type { Address } from "viem";

// ═══════════════════════════════════════════════════════
//                    Observation Data
// ═══════════════════════════════════════════════════════

/** Token balance in the vault */
export interface TokenBalance {
    token: Address;
    symbol: string;
    balance: bigint;
    decimals: number;
}

/** Snapshot of the agent's environment at a point in time */
export interface Observation {
    /** The agent's vault address */
    vaultAddress: Address;
    /** Vault token balances */
    vault: TokenBalance[];
    /** Native balance (BNB) */
    nativeBalance: bigint;
    /** Token prices (address → USD price) */
    prices: Map<Address, number>;
    /** Current gas price in wei */
    gasPrice: bigint;
    /** Current block number */
    blockNumber: bigint;
    /** Block timestamp */
    timestamp: number;
    /** Whether the agent is paused on-chain */
    paused: boolean;
}

// ═══════════════════════════════════════════════════════
//                    IPerception Interface
// ═══════════════════════════════════════════════════════

export interface IPerception {
    /** Observe the current environment and return a snapshot */
    observe(): Promise<Observation>;
}
