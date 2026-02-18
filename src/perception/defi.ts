/**
 * DeFi Perception — Concrete IPerception for DeFi agents.
 *
 * Reads on-chain state: vault balances (native + ERC20), block data.
 * Prices and gas are fetched via RPC calls.
 */

import type { Address, PublicClient } from "viem";
import type { IPerception, Observation, TokenBalance } from "./interface.js";

// ERC20 balanceOf ABI fragment
const ERC20_BALANCE_OF_ABI = [
    {
        inputs: [{ name: "account", type: "address" }],
        name: "balanceOf",
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
] as const;

// ═══════════════════════════════════════════════════════
//            Tracked Token Config
// ═══════════════════════════════════════════════════════

/** Token to track in the vault */
export interface TrackedToken {
    address: Address;
    symbol: string;
    decimals: number;
}

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
    /** ERC20 tokens to track in the vault (auto-reads balanceOf) */
    trackedTokens?: TrackedToken[];
}

export class DefiPerception implements IPerception {
    private trackedTokens: TrackedToken[];

    constructor(
        private vault: Address,
        private tokenId: bigint,
        private config: DefiPerceptionConfig,
    ) {
        this.trackedTokens = config.trackedTokens ?? [];
    }

    async observe(): Promise<Observation> {
        const { publicClient, agentNfaAddress, agentNfaAbi } = this.config;

        // Parallel read: native balance + block + on-chain agent state + ERC20 balances
        const [nativeBalance, block, gasPrice, agentState, ...erc20Balances] = await Promise.all([
            publicClient.getBalance({ address: this.vault }),
            publicClient.getBlock(),
            publicClient.getGasPrice(),
            publicClient.readContract({
                address: agentNfaAddress,
                abi: agentNfaAbi,
                functionName: "getState",
                args: [this.tokenId],
            }).catch(() => null),
            // Read each tracked token's balance in one batch
            ...this.trackedTokens.map((token) =>
                publicClient.readContract({
                    address: token.address,
                    abi: ERC20_BALANCE_OF_ABI,
                    functionName: "balanceOf",
                    args: [this.vault],
                }).catch(() => 0n)
            ),
        ]);

        // DEBUG: trace vault address and balance
        console.log(`[DEBUG] DefiPerception vault=${this.vault} nativeBalance=${nativeBalance.toString()} tokenId=${this.tokenId.toString()}`);

        // Parse paused status from agent state (status === 1 means paused)
        const stateObj = agentState as { status?: number } | null;
        const paused = stateObj?.status === 1;

        // Build vault token balances from tracked tokens
        const vaultBalances: TokenBalance[] = this.trackedTokens
            .map((token, i) => ({
                token: token.address,
                symbol: token.symbol,
                balance: erc20Balances[i] as bigint,
                decimals: token.decimals,
            }))
            .filter((tb) => tb.balance > 0n); // Only include tokens with non-zero balance

        if (vaultBalances.length > 0) {
            console.log(
                `[DEBUG] ERC20 balances:`,
                vaultBalances.map((tb) => `${tb.symbol}=${tb.balance.toString()}`).join(", ")
            );
        }

        return {
            vault: vaultBalances,
            nativeBalance,
            prices: new Map(),
            gasPrice,
            blockNumber: block.number,
            timestamp: Number(block.timestamp),
            paused,
        };
    }
}
