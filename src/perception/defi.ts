/**
 * DeFi Perception — Concrete IPerception for DeFi agents.
 *
 * Reads on-chain state: vault balances (native + ERC20), block data.
 * Prices and gas are fetched via RPC calls.
 * Dynamic token discovery via ERC20 Transfer event logs (no external API needed).
 */

import type { Address, PublicClient } from "viem";
import type { IPerception, Observation, TokenBalance } from "./interface.js";
import { parseAbiItem } from "viem";

// ERC20 balanceOf + symbol + decimals ABI fragments
const ERC20_BALANCE_OF_ABI = [
    {
        inputs: [{ name: "account", type: "address" }],
        name: "balanceOf",
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
] as const;

const ERC20_SYMBOL_ABI = [
    {
        inputs: [],
        name: "symbol",
        outputs: [{ name: "", type: "string" }],
        stateMutability: "view",
        type: "function",
    },
] as const;

const ERC20_DECIMALS_ABI = [
    {
        inputs: [],
        name: "decimals",
        outputs: [{ name: "", type: "uint8" }],
        stateMutability: "view",
        type: "function",
    },
] as const;

// ERC20 Transfer event signature for getLogs
const TRANSFER_EVENT = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 value)"
);

// Discovery settings
const DISCOVERY_CACHE_MS = 120_000; // Re-discover every 120s
const DISCOVERY_BLOCK_RANGE = 200_000n; // ~7 days of BSC blocks

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
    private discoveredTokens: TrackedToken[] = [];
    private lastDiscovery = 0;

    constructor(
        private vault: Address,
        private tokenId: bigint,
        private config: DefiPerceptionConfig,
    ) {
        this.trackedTokens = config.trackedTokens ?? [];
    }

    /** Discover tokens via ERC20 Transfer event logs (RPC-based, cached) */
    private async discoverTokens(): Promise<void> {
        const now = Date.now();
        if (now - this.lastDiscovery < DISCOVERY_CACHE_MS) return;
        this.lastDiscovery = now;

        try {
            const { publicClient } = this.config;
            const knownAddrs = new Set(
                this.trackedTokens.map(t => t.address.toLowerCase()),
            );

            // Scan Transfer events TO the vault address in recent blocks
            const latestBlock = await publicClient.getBlockNumber();
            const fromBlock = latestBlock > DISCOVERY_BLOCK_RANGE
                ? latestBlock - DISCOVERY_BLOCK_RANGE
                : 0n;

            const logs = await publicClient.getLogs({
                event: TRANSFER_EVENT,
                args: { to: this.vault },
                fromBlock,
                toBlock: latestBlock,
            });

            // Extract unique token contract addresses
            const seen = new Set<string>();
            const newTokenAddrs: Address[] = [];
            for (const log of logs) {
                const addr = log.address.toLowerCase();
                if (seen.has(addr) || knownAddrs.has(addr)) continue;
                seen.add(addr);
                newTokenAddrs.push(log.address as Address);
            }

            if (newTokenAddrs.length === 0) return;

            // Read symbol + decimals for each discovered token
            const discovered: TrackedToken[] = [];
            for (const addr of newTokenAddrs) {
                try {
                    const [symbol, decimals] = await Promise.all([
                        publicClient.readContract({
                            address: addr,
                            abi: ERC20_SYMBOL_ABI,
                            functionName: "symbol",
                        }).catch(() => "???"),
                        publicClient.readContract({
                            address: addr,
                            abi: ERC20_DECIMALS_ABI,
                            functionName: "decimals",
                        }).catch(() => 18),
                    ]);
                    discovered.push({
                        address: addr,
                        symbol: symbol as string,
                        decimals: Number(decimals),
                    });
                } catch {
                    // Skip tokens we can't read metadata for
                }
            }

            this.discoveredTokens = discovered;
            if (discovered.length > 0) {
                console.log(
                    `[Perception] Discovered ${discovered.length} extra token(s): ${discovered.map(t => t.symbol).join(", ")}`,
                );
            }
        } catch (err) {
            // Silently fail — discovery is optional
            console.warn(`[Perception] Token discovery failed:`, err);
        }
    }

    async observe(): Promise<Observation> {
        const { publicClient, agentNfaAddress, agentNfaAbi } = this.config;

        // Discover tokens dynamically (cached, non-blocking on failure)
        await this.discoverTokens();

        // Merge static + discovered tokens
        const allTokens = [...this.trackedTokens, ...this.discoveredTokens];

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
            // Read each token's balance
            ...allTokens.map((token) =>
                publicClient.readContract({
                    address: token.address,
                    abi: ERC20_BALANCE_OF_ABI,
                    functionName: "balanceOf",
                    args: [this.vault],
                }).catch(() => 0n)
            ),
        ]);

        // Parse paused status from agent state (status === 1 means paused)
        const stateObj = agentState as { status?: number } | null;
        const paused = stateObj?.status === 1;

        // Build vault token balances from all tokens
        const vaultBalances: TokenBalance[] = allTokens
            .map((token, i) => ({
                token: token.address,
                symbol: token.symbol,
                balance: erc20Balances[i] as bigint,
                decimals: token.decimals,
            }))
            .filter((tb) => tb.balance > 0n); // Only include tokens with non-zero balance

        if (vaultBalances.length > 0) {
            console.log(
                `[Perception] Vault balances:`,
                vaultBalances.map((tb) => `${tb.symbol}=${tb.balance.toString()}`).join(", ")
            );
        }

        return {
            vaultAddress: this.vault,
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
