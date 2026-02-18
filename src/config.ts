/**
 * Environment-driven configuration for the agent runner.
 */

function requiredAny(keys: string[]): string {
    for (const key of keys) {
        const value = process.env[key];
        if (value) return value;
    }
    throw new Error(`Missing required env var (any of): ${keys.join(", ")}`);
}

function optionalAny(keys: string[], fallback: string): string {
    for (const key of keys) {
        const value = process.env[key];
        if (value) return value;
    }
    return fallback;
}

function optionalBool(key: string, fallback: boolean): boolean {
    const raw = process.env[key];
    if (raw == null) return fallback;
    return raw.toLowerCase() === "true" || raw === "1";
}

function optionalInt(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : fallback;
}

function optionalBigIntList(key: string): bigint[] {
    const raw = process.env[key];
    if (!raw) return [];
    return raw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => BigInt(v));
}

export const config = {
    // Chain
    rpcUrl: requiredAny(["RPC_URL", "RPC_HTTP"]),
    rpcTimeoutMs: optionalInt("RPC_TIMEOUT_MS", 30_000),
    rpcRetryCount: optionalInt("RPC_RETRY_COUNT", 3),
    chainId: parseInt(optionalAny(["CHAIN_ID"], "97"), 10),

    // Operator wallet
    operatorPrivateKey: requiredAny(["OPERATOR_PK", "RUNNER_PRIVATE_KEY"]) as `0x${string}`,

    // Contract addresses
    agentNfaAddress: requiredAny(["AGENT_NFA_ADDRESS", "AGENT_NFA"]) as `0x${string}`,
    // V3.0 contracts
    policyGuardV4Address: optionalAny(
        ["POLICY_GUARD_V4_ADDRESS", "POLICY_GUARD_ADDRESS", "POLICY_GUARD"],
        "0x0000000000000000000000000000000000000000"
    ) as `0x${string}`,
    wbnbAddress: optionalAny(
        ["WBNB_ADDRESS"],
        "0x0000000000000000000000000000000000000000"
    ) as `0x${string}`,

    // LLM configuration (for llm_trader strategy)
    llmApiKey: optionalAny(["LLM_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"], ""),
    llmBaseUrl: optionalAny(["LLM_BASE_URL"], "https://generativelanguage.googleapis.com/v1beta"),
    llmModel: optionalAny(["LLM_MODEL"], "gemini-2.0-flash"),
    llmMaxTokens: optionalInt("LLM_MAX_TOKENS", 2048),
    llmTimeoutMs: optionalInt("LLM_TIMEOUT_MS", 30_000),

    // Default token
    tokenId: BigInt(optionalAny(["TOKEN_ID"], "0")),
    allowedTokenIds: optionalBigIntList("ALLOWED_TOKEN_IDS"),

    // Runtime
    pollIntervalMs: parseInt(optionalAny(["POLL_INTERVAL_MS"], "30000"), 10),
    tokenLockLeaseMs: parseInt(optionalAny(["TOKEN_LOCK_LEASE_MS"], "90000"), 10),
    maxRetries: parseInt(optionalAny(["MAX_RETRIES"], "3"), 10),
    logLevel: optionalAny(["LOG_LEVEL"], "info"),

    // Control API
    apiPort: parseInt(optionalAny(["API_PORT", "PORT"], "8787"), 10),
    apiHost: optionalAny(["API_HOST"], "0.0.0.0"),
    apiKey: optionalAny(["API_KEY"], ""),

    // Auto-action (add default token to polling set)
    autoActionEnabled: optionalBool("AUTO_ACTION_ENABLED", false),
    marketSignalSyncEnabled: optionalBool("MARKET_SIGNAL_SYNC_ENABLED", false),
    marketSignalSourceUrl: optionalAny(["MARKET_SIGNAL_SOURCE_URL"], ""),
    marketSignalSourceApiKey: optionalAny(["MARKET_SIGNAL_SOURCE_API_KEY"], ""),
    marketSignalSourceAuthHeader: optionalAny(
        ["MARKET_SIGNAL_SOURCE_AUTH_HEADER"],
        "x-api-key"
    ),
    marketSignalSourceName: optionalAny(["MARKET_SIGNAL_SOURCE_NAME"], "source-sync"),
    marketSignalSyncIntervalMs: optionalInt("MARKET_SIGNAL_SYNC_INTERVAL_MS", 15_000),
    marketSignalSourceTimeoutMs: optionalInt("MARKET_SIGNAL_SOURCE_TIMEOUT_MS", 8_000),

    // PostgreSQL store
    databaseUrl: optionalAny(["DATABASE_URL"], ""),
    pgHost: optionalAny(["PGHOST"], ""),
    pgPort: parseInt(optionalAny(["PGPORT"], "5432"), 10),
    pgUser: optionalAny(["PGUSER"], ""),
    pgPassword: optionalAny(["PGPASSWORD"], ""),
    pgDatabase: optionalAny(["PGDATABASE"], ""),
    pgSsl: optionalBool("PG_SSL", false),
    pgPoolMax: parseInt(optionalAny(["PG_POOL_MAX"], "10"), 10),

    // Store limits
    maxRunRecords: parseInt(optionalAny(["MAX_RUN_RECORDS"], "1000"), 10),
    statusRunsLimit: parseInt(optionalAny(["STATUS_RUNS_LIMIT"], "20"), 10),
} as const;
