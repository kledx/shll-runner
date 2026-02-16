/**
 * ABI fragments for V1.4 on-chain config contracts:
 * - InstanceConfig: stores per-instance parameters
 * - PolicyGuardV2: validates actions against policy rules
 */

export const InstanceConfigAbi = [
    {
        type: "function",
        name: "getInstanceParams",
        inputs: [{ name: "instanceId", type: "uint256" }],
        outputs: [
            {
                name: "ref",
                type: "tuple",
                components: [
                    { name: "policyId", type: "uint32" },
                    { name: "version", type: "uint16" },
                ],
            },
            { name: "params", type: "bytes" },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "configs",
        inputs: [{ name: "instanceId", type: "uint256" }],
        outputs: [
            {
                name: "ref",
                type: "tuple",
                components: [
                    { name: "policyId", type: "uint32" },
                    { name: "version", type: "uint16" },
                ],
            },
            { name: "paramsPacked", type: "bytes" },
            { name: "paramsHash", type: "bytes32" },
        ],
        stateMutability: "view",
    },
] as const;

export const PolicyGuardV2Abi = [
    {
        type: "function",
        name: "validate",
        inputs: [
            { name: "nfa", type: "address" },
            { name: "tokenId", type: "uint256" },
            { name: "agentAccount", type: "address" },
            { name: "caller", type: "address" },
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
        outputs: [
            { name: "ok", type: "bool" },
            { name: "reason", type: "string" },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "commit",
        inputs: [
            { name: "nfa", type: "address" },
            { name: "tokenId", type: "uint256" },
            { name: "agentAccount", type: "address" },
            { name: "caller", type: "address" },
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
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;
