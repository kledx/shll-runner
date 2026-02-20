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
const WBNB_ADDRESS = process.env.WBNB_ADDRESS || "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const DEFAULT_DEADLINE_OFFSET = 20 * 60; // 20 minutes

// SECURITY: known DEX routers. swap target must be one of these.
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const ALLOWED_ROUTERS: Set<string> = new Set(
    [ROUTER_ADDRESS, ...(process.env.EXTRA_ALLOWED_ROUTERS?.split(",") || [])]
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
            },
            required: ["router", "tokenIn", "tokenOut", "amountIn"],
        },

        encode(params: Record<string, unknown>): ActionPayload {
            const router = params.router as string;
            const tokenIn = params.tokenIn as string;
            const tokenOut = params.tokenOut as string;
            const amountInRaw = params.amountIn as string | undefined;

            // Validate required params before BigInt conversion
            if (!router) throw new Error("swap: missing required param 'router'");
            if (!tokenIn) throw new Error("swap: missing required param 'tokenIn'");
            if (!tokenOut) throw new Error("swap: missing required param 'tokenOut'");
            if (!amountInRaw) throw new Error("swap: missing required param 'amountIn'");

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

            // PancakeSwap V2: swapExactETHForTokens requires path[0] = WBNB, not address(0)
            const pathIn: Address = isNativeIn ? (WBNB_ADDRESS as Address) : (tokenIn as Address);
            const path: Address[] = [pathIn, tokenOut as Address];

            if (isNativeIn) {
                const data = encodeFunctionData({
                    abi: SWAP_EXACT_ETH_ABI,
                    functionName: "swapExactETHForTokens",
                    args: [minOut, path, vault, deadline],
                });
                return {
                    target: router as Address,
                    value: amountIn,
                    data: data as Hex,
                };
            }

            const data = encodeFunctionData({
                abi: SWAP_EXACT_TOKENS_ABI,
                functionName: "swapExactTokensForTokens",
                args: [amountIn, minOut, path, vault, deadline],
            });
            return {
                target: router as Address,
                value: 0n,
                data: data as Hex,
            };
        },
    };
}
