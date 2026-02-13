/**
 * config.ts — Environment-driven configuration for the agent runner
 */

function required(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
}

function optional(key: string, fallback: string): string {
    return process.env[key] || fallback;
}

export const config = {
    // Chain
    rpcUrl: required("RPC_URL"),
    chainId: parseInt(optional("CHAIN_ID", "97"), 10),

    // Operator wallet
    operatorPrivateKey: required("OPERATOR_PK") as `0x${string}`,

    // Contract addresses
    agentNfaAddress: required("AGENT_NFA_ADDRESS") as `0x${string}`,
    policyGuardAddress: required("POLICY_GUARD_ADDRESS") as `0x${string}`,

    // Agent to operate
    tokenId: BigInt(required("TOKEN_ID")),

    // Runtime
    pollIntervalMs: parseInt(optional("POLL_INTERVAL_MS", "30000"), 10),
    maxRetries: parseInt(optional("MAX_RETRIES", "3"), 10),
    logLevel: optional("LOG_LEVEL", "info"),
} as const;
