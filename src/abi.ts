/**
 * abi.ts — Minimal ABI fragments used by the agent runner
 */

// AgentNFA: execute(uint256 tokenId, (address target, uint256 value, bytes data) action)
export const AgentNFAAbi = [
    {
        type: "function",
        name: "execute",
        inputs: [
            { name: "tokenId", type: "uint256" },
            {
                name: "action",
                type: "tuple",
                components: [
                    { name: "target", type: "address" },
                    { name: "value", type: "uint256" },
                    { name: "data", type: "bytes" },
                ],
            },
        ],
        outputs: [{ name: "result", type: "bytes" }],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "operatorOf",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "address" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "userOf",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "address" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getState",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [
            {
                name: "",
                type: "tuple",
                components: [
                    { name: "balance", type: "uint256" },
                    { name: "status", type: "uint8" },
                    { name: "owner", type: "address" },
                    { name: "logicAddress", type: "address" },
                    { name: "lastActionTimestamp", type: "uint256" },
                ],
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "accountOf",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "address" }],
        stateMutability: "view",
    },
] as const;
