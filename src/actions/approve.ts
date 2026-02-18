/**
 * Approve Action — ERC20 token approval.
 *
 * Grants unlimited allowance to a spender (usually a DEX router).
 * Migrated from intentEncoder.ts encodeApproveIntent().
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
