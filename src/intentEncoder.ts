/**
 * ActionIntent → ActionPayload encoder (V1.4.1 §4.4)
 *
 * LLM strategies output structured ActionIntents, this module encodes them
 * into on-chain calldata. Supported actions: swap, approve.
 */

import { encodeFunctionData, type Address, type Hex } from "viem";
import type { ActionPayload } from "./types.js";

// ── ActionIntent Schema ────────────────────────────────────────────

export interface ActionIntent {
    type: "swap" | "approve";
    router: string;        // DEX router address (0x...)
    tokenIn: string;       // ERC20 token address (0x...)
    tokenOut: string;      // ERC20 token address (0x...)
    amountIn: string;      // wei string
    minOut?: string;        // minimum output in wei (slippage protection)
    deadline?: number;      // unix timestamp deadline
    reason?: string[];      // LLM explanation chain
    confidence?: number;    // 0.0-1.0 confidence score
}

// ── ABI fragments for encoding ─────────────────────────────────────

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

// PancakeSwap V2 / Uniswap V2 compatible router ABI
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

// WBNB / WETH address (zero means native token)
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
const DEFAULT_DEADLINE_OFFSET = 20 * 60; // 20 minutes

// ── Encoder Functions ──────────────────────────────────────────────

/**
 * Encode an ERC20 approve intent.
 * Target = tokenIn address, spender = router address.
 */
export function encodeApproveIntent(intent: ActionIntent): ActionPayload {
    const data = encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [intent.router as Address, MAX_UINT256],
    });
    return {
        target: intent.tokenIn as Address,
        value: 0n,
        data: data as Hex,
    };
}

/**
 * Encode a swap intent.
 * If tokenIn is zero address (native token), uses swapExactETHForTokens.
 * Otherwise, uses swapExactTokensForTokens.
 */
export function encodeSwapIntent(
    intent: ActionIntent,
    vaultAddress: Address
): ActionPayload {
    const amountIn = BigInt(intent.amountIn);
    const minOut = intent.minOut ? BigInt(intent.minOut) : 0n;
    const deadline = BigInt(intent.deadline ?? Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_OFFSET);
    const path: Address[] = [intent.tokenIn as Address, intent.tokenOut as Address];

    const isNativeIn = intent.tokenIn.toLowerCase() === ZERO_ADDRESS;

    if (isNativeIn) {
        // swapExactETHForTokens: value = amountIn, path starts from WBNB
        const data = encodeFunctionData({
            abi: SWAP_EXACT_ETH_ABI,
            functionName: "swapExactETHForTokens",
            args: [minOut, path, vaultAddress, deadline],
        });
        return {
            target: intent.router as Address,
            value: amountIn,
            data: data as Hex,
        };
    }

    // swapExactTokensForTokens: value = 0
    const data = encodeFunctionData({
        abi: SWAP_EXACT_TOKENS_ABI,
        functionName: "swapExactTokensForTokens",
        args: [amountIn, minOut, path, vaultAddress, deadline],
    });
    return {
        target: intent.router as Address,
        value: 0n,
        data: data as Hex,
    };
}

/**
 * Encode any ActionIntent into an ActionPayload.
 * Dispatches to the correct encoder based on intent.type.
 */
export function encodeActionIntent(
    intent: ActionIntent,
    vaultAddress: Address
): ActionPayload {
    switch (intent.type) {
        case "approve":
            return encodeApproveIntent(intent);
        case "swap":
            return encodeSwapIntent(intent, vaultAddress);
        default:
            throw new Error(`Unsupported intent type: ${(intent as ActionIntent).type}`);
    }
}

/**
 * Validate an ActionIntent structure before encoding.
 * Returns null if valid, or an error message string.
 */
export function validateActionIntent(intent: unknown): string | null {
    if (!intent || typeof intent !== "object") return "intent must be an object";
    const i = intent as Record<string, unknown>;

    if (!["swap", "approve"].includes(i.type as string)) {
        return `invalid intent.type: ${String(i.type)}`;
    }
    if (typeof i.router !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(i.router)) {
        return `invalid intent.router: ${String(i.router)}`;
    }
    if (typeof i.tokenIn !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(i.tokenIn)) {
        return `invalid intent.tokenIn: ${String(i.tokenIn)}`;
    }
    if (typeof i.tokenOut !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(i.tokenOut)) {
        return `invalid intent.tokenOut: ${String(i.tokenOut)}`;
    }
    if (typeof i.amountIn !== "string" || !i.amountIn) {
        return `invalid intent.amountIn: ${String(i.amountIn)}`;
    }
    try {
        BigInt(i.amountIn as string);
    } catch {
        return `intent.amountIn is not a valid bigint: ${String(i.amountIn)}`;
    }
    if (i.confidence != null) {
        const c = Number(i.confidence);
        if (!Number.isFinite(c) || c < 0 || c > 1) {
            return `intent.confidence must be 0.0-1.0, got: ${String(i.confidence)}`;
        }
    }
    return null;
}
