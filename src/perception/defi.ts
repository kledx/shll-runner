/**
 * DeFi Perception — Concrete IPerception for DeFi agents.
 *
 * Reads on-chain state: vault balances, native balance, block data.
 * Prices and gas are fetched via RPC calls.
 *
 * Design: starts simple (native balance + block info + pause status).
 * Token balances and prices will be expanded in follow-up iterations.
 */

import type { Address, PublicClient } from "viem";
import type { IPerception, Observation, TokenBalance } from "./interface.js";

// ═══════════════════════════════════════════════════════
//            DeFi Perception Implementation
// ═══════════════════════════════════════════════════════

export interface DefiPerceptionConfig {
    /** Viem public client for RPC calls */
    publicClient: PublicClient;
    /** AgentNFA contract address */
    agentNfaAddress: Address;
    /** AgentNFA ABI (subset needed for observe) */
    agentNfaAbi: readonly unknown[];
}

export class DefiPerception implements IPerception {
    constructor(
        private vault: Address,
        private tokenId: bigint,
        private config: DefiPerceptionConfig,
    ) { }

    async observe(): Promise<Observation> {
        const { publicClient, agentNfaAddress, agentNfaAbi } = this.config;

        // Parallel read: native balance + block + on-chain agent state
        const [nativeBalance, block, gasPrice, agentState] = await Promise.all([
            publicClient.getBalance({ address: this.vault }),
            publicClient.getBlock(),
            publicClient.getGasPrice(),
            publicClient.readContract({
                address: agentNfaAddress,
                abi: agentNfaAbi,
                functionName: "getState",
                args: [this.tokenId],
            }).catch(() => null),
        ]);

        // Parse paused status from agent state (status === 1 means paused)
        const stateObj = agentState as { status?: number } | null;
        const paused = stateObj?.status === 1;

        // TODO(MVP): Read ERC20 token balances from vault.
        // Will need: tracked token list from DB + multicall for balanceOf.
        const vaultBalances: TokenBalance[] = [];

        return {
            vault: vaultBalances,
            nativeBalance,
            prices: new Map(), // TODO(MVP): Integrate price oracle (DEX reserves or off-chain API)
            gasPrice,
            blockNumber: block.number,
            timestamp: Number(block.timestamp),
            paused,
        };
    }
}
