/**
 * Wrap Action — WBNB deposit/withdraw.
 *
 * Wraps native BNB into WBNB (deposit) or unwraps WBNB back to BNB (withdraw).
 */

import { encodeFunctionData, type Address, type Hex } from "viem";
import type { IAction, ActionPayload } from "./interface.js";

const WBNB_DEPOSIT_ABI = [
    {
        type: "function" as const,
        name: "deposit",
        inputs: [],
        outputs: [],
        stateMutability: "payable" as const,
    },
] as const;

const WBNB_WITHDRAW_ABI = [
    {
        type: "function" as const,
        name: "withdraw",
        inputs: [{ name: "wad", type: "uint256" }],
        outputs: [],
        stateMutability: "nonpayable" as const,
    },
] as const;

export function createWrapAction(wbnbAddress: Address): IAction {
    return {
        name: "wrap",
        description: "Wrap native BNB into WBNB or unwrap WBNB into BNB.",
        readonly: false,

        parameters: {
            type: "object",
            properties: {
                direction: { type: "string", description: "Direction of wrapping", enum: ["wrap", "unwrap"] },
                amount: { type: "string", description: "Amount in wei to wrap or unwrap" },
            },
            required: ["direction", "amount"],
        },

        encode(params: Record<string, unknown>): ActionPayload {
            const direction = params.direction as string || "wrap";
            const amount = BigInt(params.amount as string);

            if (direction === "unwrap") {
                const data = encodeFunctionData({
                    abi: WBNB_WITHDRAW_ABI,
                    functionName: "withdraw",
                    args: [amount],
                });
                return {
                    target: wbnbAddress,
                    value: 0n,
                    data: data as Hex,
                };
            }

            // Default: wrap (deposit)
            const data = encodeFunctionData({
                abi: WBNB_DEPOSIT_ABI,
                functionName: "deposit",
                args: [],
            });
            return {
                target: wbnbAddress,
                value: amount,
                data: data as Hex,
            };
        },
    };
}
