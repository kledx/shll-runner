/**
 * Swap Quote Action — Read-only on-chain price quote via Router.getAmountsOut.
 *
 * Allows LLM to check exact on-chain prices before deciding to swap.
 * Returns the expected output amount for a given input.
 */

import type { Address, PublicClient } from "viem";
import type { IAction, ToolResult, ActionPayload } from "./interface.js";
import { getChainAddressBook, normalizeKnownAddressForChain } from "../chainDefaults.js";

const CHAIN_DEFAULTS = getChainAddressBook();
const WBNB_ADDRESS = process.env.WBNB_ADDRESS || CHAIN_DEFAULTS.wbnb;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const GET_AMOUNTS_OUT_ABI = [
    {
        type: "function" as const,
        name: "getAmountsOut",
        inputs: [
            { name: "amountIn", type: "uint256" },
            { name: "path", type: "address[]" },
        ],
        outputs: [{ name: "amounts", type: "uint256[]" }],
        stateMutability: "view" as const,
    },
] as const;

export function createSwapQuoteAction(publicClient: PublicClient): IAction {
    return {
        name: "get_swap_quote",
        description:
            "Get an on-chain price quote for a swap. Returns the expected output amount " +
            "from the DEX router's getAmountsOut. Use this to check prices before swapping.",
        readonly: true,

        parameters: {
            type: "object",
            properties: {
                router: { type: "string", description: "DEX router address (0x...)" },
                tokenIn: {
                    type: "string",
                    description: "Input token address. Use 0x0000000000000000000000000000000000000000 for native BNB.",
                },
                tokenOut: { type: "string", description: "Output token address (0x...)" },
                amountIn: {
                    type: "string",
                    description: "Amount of input token in wei (e.g. '1000000000000000000' for 1 token with 18 decimals)",
                },
            },
            required: ["router", "tokenIn", "tokenOut", "amountIn"],
        },

        async execute(params: Record<string, unknown>): Promise<ToolResult> {
            const routerAddr = normalizeKnownAddressForChain(params.router as string);
            const tokenInRaw = params.tokenIn as string;
            const tokenOutRaw = params.tokenOut as string;
            const amountIn = BigInt(params.amountIn as string);

            // Normalize addresses
            const tokenIn = tokenInRaw.toLowerCase() === ZERO_ADDRESS
                ? WBNB_ADDRESS
                : normalizeKnownAddressForChain(tokenInRaw);
            const tokenOut = tokenOutRaw.toLowerCase() === ZERO_ADDRESS
                ? WBNB_ADDRESS
                : normalizeKnownAddressForChain(tokenOutRaw);

            // Build path (add WBNB bridge if needed)
            let path: Address[];
            if (
                tokenIn.toLowerCase() !== WBNB_ADDRESS.toLowerCase() &&
                tokenOut.toLowerCase() !== WBNB_ADDRESS.toLowerCase()
            ) {
                path = [tokenIn as Address, WBNB_ADDRESS as Address, tokenOut as Address];
            } else {
                path = [tokenIn as Address, tokenOut as Address];
            }

            try {
                const amounts = await publicClient.readContract({
                    address: routerAddr as Address,
                    abi: GET_AMOUNTS_OUT_ABI,
                    functionName: "getAmountsOut",
                    args: [amountIn, path],
                });

                const expectedOut = amounts[amounts.length - 1];
                return {
                    success: true,
                    data: {
                        amountIn: amountIn.toString(),
                        expectedOutput: expectedOut.toString(),
                        path: path.map(p => p.toLowerCase()),
                        hops: path.length - 1,
                    },
                };
            } catch (err) {
                return {
                    success: false,
                    data: {
                        error: "Quote failed — the token pair may lack liquidity on this router.",
                        details: err instanceof Error ? err.message : String(err),
                    },
                };
            }
        },

        encode(): ActionPayload {
            throw new Error("get_swap_quote is read-only and cannot be encoded");
        },
    };
}
