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
const DEFAULT_DEADLINE_OFFSET = 20 * 60; // 20 minutes

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
            const amountIn = BigInt(params.amountIn as string);
            const minOut = params.minOut ? BigInt(params.minOut as string) : 0n;
            const deadline = BigInt(
                (params.deadline as number) ??
                Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_OFFSET,
            );

            // vault is required — injected by runtime from agent.vault
            const vault = params.vault as Address;
            if (!vault || vault === ZERO_ADDRESS) {
                throw new Error("swap action requires params.vault to be set");
            }

            const path: Address[] = [tokenIn as Address, tokenOut as Address];
            const isNativeIn = tokenIn.toLowerCase() === ZERO_ADDRESS;

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
