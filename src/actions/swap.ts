/**
 * Swap Action — DEX token swap (PancakeSwap V2 compatible).
 *
 * Supports:
 *   - swapExactETHForTokens (native → ERC20)
 *   - swapExactTokensForTokens (ERC20 → ERC20)
 *
 * Migrated from intentEncoder.ts encodeSwapIntent().
 *
 * NOTE: vault address MUST be passed via params.vault by the runtime.
 * There is no global mutable state — each action call is self-contained.
 */

import { encodeFunctionData, type Address, type Hex } from "viem";
import type { IAction, ActionPayload } from "./interface.js";
import { getChainAddressBook, normalizeKnownAddressForChain } from "../chainDefaults.js";

// ── ERC20 Approve ABI (for auto-approve in batch) ──────
const ERC20_APPROVE_ABI = [
    {
        type: "function" as const,
        name: "approve",
        inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "nonpayable" as const,
    },
] as const;

const MAX_UINT256 = BigInt(
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
);

// ── ABI fragments ──────────────────────────────────────

const SWAP_EXACT_TOKENS_ABI = [
    {
        type: "function" as const,
        name: "swapExactTokensForTokens",
        inputs: [
            { name: "amountIn", type: "uint256" },
            { name: "amountOutMin", type: "uint256" },
            { name: "path", type: "address[]" },
            { name: "to", type: "address" },
            { name: "deadline", type: "uint256" },
        ],
        outputs: [{ name: "amounts", type: "uint256[]" }],
        stateMutability: "nonpayable" as const,
    },
] as const;

const SWAP_EXACT_ETH_ABI = [
    {
        type: "function" as const,
        name: "swapExactETHForTokens",
        inputs: [
            { name: "amountOutMin", type: "uint256" },
            { name: "path", type: "address[]" },
            { name: "to", type: "address" },
            { name: "deadline", type: "uint256" },
        ],
        outputs: [{ name: "amounts", type: "uint256[]" }],
        stateMutability: "payable" as const,
    },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CHAIN_DEFAULTS = getChainAddressBook();
const WBNB_ADDRESS = process.env.WBNB_ADDRESS || CHAIN_DEFAULTS.wbnb;
const DEFAULT_DEADLINE_OFFSET = 20 * 60; // 20 minutes

// SECURITY: platform-known DEX routers.
// Includes all legitimate DEXes that appear in frontend KNOWN_DEXES.
// This is a safety net against completely unknown contracts.
// User SoftPolicy (allowed_dexes in DB) further restricts within this set.
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || CHAIN_DEFAULTS.router;
const PLATFORM_KNOWN_ROUTERS = [
    ROUTER_ADDRESS,
    // PancakeSwap V2 mainnet
    "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    // PancakeSwap V3 mainnet
    "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
    // PancakeSwap V2 testnet
    "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    // PancakeSwap V3 testnet
    "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
    // BiSwap testnet
    "0x3380aE82e39E42Ca34EbEd69aF67fAa0683Bb5c1",
];

const ALLOWED_ROUTERS: Set<string> = new Set(
    [...PLATFORM_KNOWN_ROUTERS, ...(process.env.EXTRA_ALLOWED_ROUTERS?.split(",") || [])]
        .map(a => a.trim().toLowerCase())
        .filter(Boolean),
);

// ── Swap Action ────────────────────────────────────────

export function createSwapAction(): IAction {
    return {
        name: "swap",
        description: "Swap tokens on a DEX (PancakeSwap V2 compatible). The vault address is auto-injected — do NOT include it in params.",
        readonly: false,

        parameters: {
            type: "object",
            properties: {
                router: { type: "string", description: "DEX router contract address (0x...)" },
                tokenIn: { type: "string", description: "Input token address. Use 0x0000000000000000000000000000000000000000 for native BNB." },
                tokenOut: { type: "string", description: "Output token address (0x...)" },
                amountIn: { type: "string", description: "Amount of input token in wei (e.g. '1000000000000000' for 0.001 with 18 decimals)" },
                minOut: { type: "string", description: "Minimum output amount in wei. Set to '0' if price impact is acceptable." },
                deadline: { type: "number", description: "Unix timestamp deadline (seconds). Optional; defaults to now + 20 minutes." },
            },
            required: ["router", "tokenIn", "tokenOut", "amountIn"],
        },

        async encode(params: Record<string, unknown>): Promise<ActionPayload | ActionPayload[]> {
            const routerRaw = params.router as string;
            const tokenInRaw = params.tokenIn as string;
            const tokenOutRaw = params.tokenOut as string;
            const amountInRaw = params.amountIn as string | undefined;

            // Validate required params before BigInt conversion
            if (!routerRaw) throw new Error("swap: missing required param 'router'");
            if (!tokenInRaw) throw new Error("swap: missing required param 'tokenIn'");
            if (!tokenOutRaw) throw new Error("swap: missing required param 'tokenOut'");
            if (!amountInRaw) throw new Error("swap: missing required param 'amountIn'");

            // Canonicalize known BSC addresses to current chain (56/97),
            // so model outputs won't mix mainnet/testnet infra addresses.
            const router = normalizeKnownAddressForChain(routerRaw);
            const tokenIn = tokenInRaw.toLowerCase() === ZERO_ADDRESS
                ? ZERO_ADDRESS
                : normalizeKnownAddressForChain(tokenInRaw);
            const tokenOut = tokenOutRaw.toLowerCase() === ZERO_ADDRESS
                ? ZERO_ADDRESS
                : normalizeKnownAddressForChain(tokenOutRaw);

            // SECURITY (MED-2): validate router against whitelist
            if (!ALLOWED_ROUTERS.has(router.toLowerCase())) {
                throw new Error(
                    `swap BLOCKED: router ${router} is not in the allowed router whitelist. ` +
                    `Allowed: ${[...ALLOWED_ROUTERS].join(", ")}`,
                );
            }

            const amountIn = BigInt(amountInRaw);

            // SECURITY (MED-1): require explicit minOut to prevent 100% slippage
            const minOutRaw = params.minOut as string | undefined;
            if (!minOutRaw || minOutRaw === "0") {
                throw new Error(
                    "swap BLOCKED: minOut must be set to a non-zero value to prevent sandwich attacks. " +
                    "Calculate a reasonable minimum output based on current price and slippage tolerance.",
                );
            }
            const minOut = BigInt(minOutRaw);

            const deadline = BigInt(
                (params.deadline as number) ??
                Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_OFFSET,
            );

            // vault is required — injected by runtime from agent.vault
            const vault = params.vault as Address;
            if (!vault || vault === ZERO_ADDRESS) {
                throw new Error("swap action requires params.vault to be set");
            }

            const isNativeIn = tokenIn.toLowerCase() === ZERO_ADDRESS;
            const isNativeOut = tokenOut.toLowerCase() === ZERO_ADDRESS;

            // PancakeSwap V2: paths must use WBNB, not address(0)
            const pathIn: Address = isNativeIn ? (WBNB_ADDRESS as Address) : (tokenIn as Address);
            // For native BNB output: use WBNB as tokenOut (smart contract vaults cannot
            // receive native BNB via swapExactTokensForETH due to reentrancy guard gas limits)
            const pathOut: Address = isNativeOut ? (WBNB_ADDRESS as Address) : (tokenOut as Address);

            // Build routing path.
            // OPTIMIZATION: If neither token is WBNB, bridge through WBNB to ensure liquidity.
            // Direct ERC20-ERC20 pairs (e.g. USDT-BUSD) often lack liquidity on V2.
            let path: Address[];
            if (pathIn.toLowerCase() !== WBNB_ADDRESS.toLowerCase() && pathOut.toLowerCase() !== WBNB_ADDRESS.toLowerCase()) {
                path = [pathIn, WBNB_ADDRESS as Address, pathOut];
            } else {
                path = [pathIn, pathOut];
            }

            // Build the swap payload
            let swapPayload: ActionPayload;

            if (isNativeIn) {
                // BNB → ERC20: swapExactETHForTokens
                const data = encodeFunctionData({
                    abi: SWAP_EXACT_ETH_ABI,
                    functionName: "swapExactETHForTokens",
                    args: [minOut, path, vault, deadline],
                });
                swapPayload = {
                    target: router as Address,
                    value: amountIn,
                    data: data as Hex,
                };
            } else {
                // ERC20 → ERC20 (or ERC20 → WBNB when user wants BNB)
                // Always use swapExactTokensForTokens — safe for smart contract wallets
                const data = encodeFunctionData({
                    abi: SWAP_EXACT_TOKENS_ABI,
                    functionName: "swapExactTokensForTokens",
                    args: [amountIn, minOut, path, vault, deadline],
                });
                swapPayload = {
                    target: router as Address,
                    value: 0n,
                    data: data as Hex,
                };
            }

            // Auto-approve: check allowance and prepend approve if needed.
            // Uses __readAllowance injected by runtime (async chain read).
            // When approve is needed, returns [approve, swap] for executeBatch.
            if (!isNativeIn && params.__readAllowance) {
                const readAllowance = params.__readAllowance as (
                    token: string, owner: string, spender: string,
                ) => Promise<bigint>;
                try {
                    const currentAllowance = await readAllowance(
                        tokenIn, vault, router,
                    );
                    if (currentAllowance < amountIn) {
                        // Encode approve payload
                        const approveData = encodeFunctionData({
                            abi: ERC20_APPROVE_ABI,
                            functionName: "approve",
                            args: [router as Address, MAX_UINT256],
                        });
                        const approvePayload: ActionPayload = {
                            target: tokenIn as Address,
                            value: 0n,
                            data: approveData as Hex,
                        };
                        // Return batch: [approve, swap]
                        return [approvePayload, swapPayload];
                    }
                } catch {
                    // Allowance check failed — proceed with swap only.
                    // If approve is actually needed, the on-chain tx will revert
                    // and the LLM can handle it in the next cycle.
                }
            }

            return swapPayload;
        },
    };
}
