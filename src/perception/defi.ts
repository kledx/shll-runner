/**
 * DeFi Perception — Concrete IPerception for DeFi agents.
 *
 * Reads on-chain state: vault balances (native + ERC20), block data.
 * Prices and gas are fetched via RPC calls.
 * Dynamic token discovery via agent_memory DB (swap history).
 */

import type { Address, PublicClient } from "viem";
import type { Pool } from "pg";
import type { IPerception, Observation, TokenBalance } from "./interface.js";

// ERC20 ABI fragments
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

// Discovery settings
const DISCOVERY_CACHE_MS = 300_000; // Re-discover every 5 min (DB query is cheap)

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
    /** PostgreSQL pool for querying swap history */
    pool?: Pool;
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

    /**
     * Discover tokens from swap history in agent_memory DB.
     * Extracts unique tokenIn/tokenOut addresses from past swap actions.
     * Then reads symbol + decimals on-chain for any new tokens found.
     */
    private async discoverTokens(): Promise<void> {
        const now = Date.now();
        if (now - this.lastDiscovery < DISCOVERY_CACHE_MS) return;
        this.lastDiscovery = now;

        if (!this.config.pool) return;

        try {
            const { publicClient, pool } = this.config;
            const knownAddrs = new Set(
                this.trackedTokens.map(t => t.address.toLowerCase()),
            );

            // Query unique token addresses from swap params in agent_memory
            const result = await pool!.query(
                `SELECT DISTINCT
                    params->>'tokenIn' AS token_in,
                    params->>'tokenOut' AS token_out
                 FROM agent_memory
                 WHERE token_id = $1 AND action = 'swap' AND params IS NOT NULL
                 ORDER BY token_out`,
                [this.tokenId.toString()],
            );

            // Collect unique addresses not in static list
            const newAddrs = new Set<string>();
            for (const row of result.rows) {
                for (const addr of [row.token_in, row.token_out]) {
                    if (addr && !knownAddrs.has(addr.toLowerCase())) {
                        newAddrs.add(addr);
                    }
                }
            }

            if (newAddrs.size === 0) return;

            // Read symbol + decimals for new tokens
            const discovered: TrackedToken[] = [];
            for (const addr of newAddrs) {
                try {
                    const [symbol, decimals] = await Promise.all([
                        publicClient.readContract({
                            address: addr as Address,
                            abi: ERC20_SYMBOL_ABI,
                            functionName: "symbol",
                        }).catch(() => "???"),
                        publicClient.readContract({
                            address: addr as Address,
                            abi: ERC20_DECIMALS_ABI,
                            functionName: "decimals",
                        }).catch(() => 18),
                    ]);
                    discovered.push({
                        address: addr as Address,
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
                    `[Perception] Discovered ${discovered.length} token(s) from swap history: ${discovered.map(t => t.symbol).join(", ")}`,
                );
            }
        } catch (err) {
            console.warn(`[Perception] Token discovery failed:`, err);
        }
    }

    async observe(): Promise<Observation> {
        const { publicClient, agentNfaAddress, agentNfaAbi } = this.config;

        // Discover tokens from DB (cached, lightweight)
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
            .filter((tb) => tb.balance > 0n);

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
