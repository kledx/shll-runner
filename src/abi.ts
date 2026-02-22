/**
 * abi.ts — Minimal ABI fragments used by the agent runner
 */

// AgentNFA: execute(uint256 tokenId, (address target, uint256 value, bytes data) action)
export const AgentNFAAbi = [
    { type: "error", name: "ExecutionFailed", inputs: [] },
    { type: "error", name: "Unauthorized", inputs: [] },
    { type: "error", name: "LeaseExpired", inputs: [] },
    {
        type: "error",
        name: "PolicyViolation",
        inputs: [{ name: "reason", type: "string" }],
    },
    { type: "error", name: "AgentPaused", inputs: [{ name: "tokenId", type: "uint256" }] },
    { type: "error", name: "AgentTerminated", inputs: [{ name: "tokenId", type: "uint256" }] },
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
        name: "operatorExpiresOf",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "operatorNonceOf",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "clearOperator",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [],
        stateMutability: "nonpayable",
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
        name: "userExpires",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "setOperatorWithSig",
        inputs: [
            {
                name: "permit",
                type: "tuple",
                components: [
                    { name: "tokenId", type: "uint256" },
                    { name: "renter", type: "address" },
                    { name: "operator", type: "address" },
                    { name: "expires", type: "uint64" },
                    { name: "nonce", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                ],
            },
            { name: "sig", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
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
    {
        type: "function",
        name: "agentType",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "bytes32" }],
        stateMutability: "view",
    },
] as const;
