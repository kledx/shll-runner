/**
 * Transfer Action — ERC20 token transfer from agent vault to a recipient.
 *
 * SECURITY: This is a write action and will be subject to PolicyGuardV4
 * validation (ReceiverGuardPolicy, SpendingLimitPolicy, etc.).
 *
 * NOTE: vault address MUST be passed via params.vault by the runtime.
 */

import { encodeFunctionData, type Address, type Hex } from "viem";
import type { IAction, ActionPayload } from "./interface.js";

const ERC20_TRANSFER_ABI = [
    {
        type: "function" as const,
        name: "transfer",
        inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "nonpayable" as const,
    },
] as const;

export function createTransferAction(): IAction {
    return {
        name: "transfer",
        description:
            "Transfer ERC20 tokens from the agent vault to a recipient address. " +
            "Cannot transfer native BNB. Subject to on-chain policy validation (ReceiverGuard, SpendingLimit).",
        readonly: false,

        parameters: {
            type: "object",
            properties: {
                token: {
                    type: "string",
                    description: "ERC20 token contract address to transfer (0x...)",
                },
                to: {
                    type: "string",
                    description: "Recipient address (0x...)",
                },
                amount: {
                    type: "string",
                    description: "Amount to transfer in wei (e.g. '1000000000000000000' for 1 token with 18 decimals)",
                },
            },
            required: ["token", "to", "amount"],
        },

        encode(params: Record<string, unknown>): ActionPayload {
            const token = params.token as string;
            const to = params.to as string;
            const amountRaw = params.amount as string;

            if (!token) throw new Error("transfer: missing required param 'token'");
            if (!to) throw new Error("transfer: missing required param 'to'");
            if (!amountRaw) throw new Error("transfer: missing required param 'amount'");

            const amount = BigInt(amountRaw);
            if (amount <= 0n) {
                throw new Error("transfer: amount must be > 0");
            }

            const data = encodeFunctionData({
                abi: ERC20_TRANSFER_ABI,
                functionName: "transfer",
                args: [to as Address, amount],
            });

            return {
                target: token as Address,
                value: 0n,
                data: data as Hex,
            };
        },
    };
}
