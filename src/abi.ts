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
        name: "executeBatch",
        inputs: [
            { name: "tokenId", type: "uint256" },
            {
                name: "actions",
                type: "tuple[]",
                components: [
                    { name: "target", type: "address" },
                    { name: "value", type: "uint256" },
                    { name: "data", type: "bytes" },
                ],
            },
        ],
        outputs: [{ name: "results", type: "bytes[]" }],
        stateMutability: "nonpayable",
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

// SubscriptionManager: subscription lifecycle reads
export const SubscriptionManagerAbi = [
    {
        type: "function",
        name: "getEffectiveStatus",
        inputs: [{ name: "instanceId", type: "uint256" }],
        outputs: [{ name: "", type: "uint8" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "canExecute",
        inputs: [{ name: "instanceId", type: "uint256" }],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getSubscription",
        inputs: [{ name: "instanceId", type: "uint256" }],
        outputs: [
            {
                name: "",
                type: "tuple",
                components: [
                    { name: "subscriber", type: "address" },
                    { name: "listingId", type: "bytes32" },
                    { name: "currentPeriodEnd", type: "uint64" },
                    { name: "gracePeriodEnd", type: "uint64" },
                    { name: "pricePerPeriod", type: "uint96" },
                    { name: "periodDays", type: "uint32" },
                    { name: "gracePeriodDays", type: "uint32" },
                    { name: "status", type: "uint8" },
                ],
            },
        ],
        stateMutability: "view",
    },
] as const;

// CooldownPolicy: read cooldown configuration for dynamic backoff
export const CooldownPolicyAbi = [
    {
        type: "function",
        name: "cooldownSeconds",
        inputs: [{ name: "instanceId", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
] as const;
