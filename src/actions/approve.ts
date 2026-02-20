/**
 * Approve Action — ERC20 token approval.
 *
 * Grants unlimited allowance to a spender (usually a DEX router).
 * Migrated from intentEncoder.ts encodeApproveIntent().
 *
 * SECURITY: spender is validated against ALLOWED_SPENDERS whitelist.
 * This prevents prompt-injection attacks where the LLM could approve
 * arbitrary addresses to drain vault tokens.
 */

import { encodeFunctionData, type Address, type Hex } from "viem";
import type { IAction, ActionPayload } from "./interface.js";

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

// SECURITY: only platform-known addresses are allowed as spenders.
// Includes all legitimate DEX routers + WBNB.
// This is a safety net — user SoftPolicy further restricts within this set.
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB_ADDRESS = process.env.WBNB_ADDRESS || "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

const PLATFORM_KNOWN_SPENDERS = [
    ROUTER_ADDRESS,
    WBNB_ADDRESS,
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
    // WBNB testnet
    "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
];

const ALLOWED_SPENDERS: Set<string> = new Set(
    [...PLATFORM_KNOWN_SPENDERS, ...(process.env.EXTRA_ALLOWED_SPENDERS?.split(",") || [])]
        .map(a => a.trim().toLowerCase())
        .filter(Boolean),
);

export function createApproveAction(): IAction {
    return {
        name: "approve",
        description: "Approve a spender (DEX router) to spend an ERC20 token. Defaults to max approval if amount is omitted.",
        readonly: false,

        parameters: {
            type: "object",
            properties: {
                token: { type: "string", description: "ERC20 token contract address to approve (0x...)" },
                spender: { type: "string", description: "Spender address to grant allowance to (usually the DEX router)" },
                amount: { type: "string", description: "Approval amount in wei. Omit for unlimited (max uint256)." },
            },
            required: ["token", "spender"],
        },

        encode(params: Record<string, unknown>): ActionPayload {
            const token = params.token as string;
            const spender = params.spender as string;
            const amount = params.amount
                ? BigInt(params.amount as string)
                : MAX_UINT256;

            // SECURITY: validate spender against whitelist
            if (!ALLOWED_SPENDERS.has(spender.toLowerCase())) {
                throw new Error(
                    `approve BLOCKED: spender ${spender} is not in the allowed spender whitelist. ` +
                    `Only known DEX routers are permitted. Allowed: ${[...ALLOWED_SPENDERS].join(", ")}`,
                );
            }

            const data = encodeFunctionData({
                abi: ERC20_APPROVE_ABI,
                functionName: "approve",
                args: [spender as Address, amount],
            });

            return {
                target: token as Address,
                value: 0n,
                data: data as Hex,
            };
        },
    };
}

