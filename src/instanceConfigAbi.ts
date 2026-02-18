/**
 * instanceConfigAbi.ts — ABI fragments for V1.4 InstanceConfig + PolicyGuardV2.
 *
 * NOTE: These are legacy V1 ABIs retained for chain.ts backward compatibility.
 * In V3.0, PolicyGuardV4 is used instead.
 */

export const InstanceConfigAbi = [
    {
        type: "function",
        name: "configs",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [
            {
                name: "ref",
                type: "tuple",
                components: [
                    { name: "policyId", type: "uint16" },
                    { name: "version", type: "uint8" },
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
            { name: "operator", type: "address" },
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
] as const;
