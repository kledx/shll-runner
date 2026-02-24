/**
 * DeFi Perception — Concrete IPerception for DeFi agents.
 *
 * Reads on-chain state: vault balances (native + ERC20), block data.
 * Prices and gas are fetched via RPC calls.
 * Dynamic token discovery via BSCScan tokentx API.
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

// BSCScan API for token discovery
const CHAIN_ID = Number(process.env.CHAIN_ID || "97");
const IS_MAINNET = CHAIN_ID === 56;
const BSCSCAN_API = IS_MAINNET
    ? "https://api.bscscan.com/api"
    : "https://api-testnet.bscscan.com/api";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || "";
const DISCOVERY_CACHE_MS = 60_000; // Re-discover every 60s

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

    /** Discover tokens via BSCScan tokentx API (cached) */
    private async discoverTokens(): Promise<void> {
        const now = Date.now();
        if (now - this.lastDiscovery < DISCOVERY_CACHE_MS) return;
        this.lastDiscovery = now;

        try {
            const knownAddrs = new Set(
                this.trackedTokens.map(t => t.address.toLowerCase()),
            );

            const params = new URLSearchParams({
                module: "account",
                action: "tokentx",
                address: this.vault,
                startblock: "0",
                endblock: "99999999",
                page: "1",
                offset: "100",
                sort: "desc",
            });
            if (BSCSCAN_API_KEY) params.set("apikey", BSCSCAN_API_KEY);

            const resp = await fetch(`${BSCSCAN_API}?${params.toString()}`, {
                signal: AbortSignal.timeout(8_000),
            });
            if (!resp.ok) return;

            const data = (await resp.json()) as {
                status: string;
                result: Array<{
                    contractAddress: string;
                    tokenSymbol: string;
                    tokenDecimal: string;
                }>;
            };
            if (data.status !== "1" || !Array.isArray(data.result)) return;

            const seen = new Set<string>();
            const discovered: TrackedToken[] = [];
            for (const tx of data.result) {
                const addr = tx.contractAddress.toLowerCase();
                if (seen.has(addr) || knownAddrs.has(addr)) continue;
                seen.add(addr);
                discovered.push({
                    address: tx.contractAddress as Address,
                    symbol: tx.tokenSymbol || "???",
                    decimals: Number.parseInt(tx.tokenDecimal, 10) || 18,
                });
            }
            this.discoveredTokens = discovered;
            if (discovered.length > 0) {
                console.log(
                    `[Perception] Discovered ${discovered.length} extra token(s): ${discovered.map(t => t.symbol).join(", ")}`,
                );
            }
        } catch {
            // Silently fail — discovery is optional
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
