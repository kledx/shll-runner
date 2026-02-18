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
        description: "Approve a spender (DEX router) to spend an ERC20 token. Params: token, spender, amount (optional, defaults to max)",
        readonly: false,

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
