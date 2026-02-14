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
    policyGuardAddress: optionalAny(
        ["POLICY_GUARD_ADDRESS", "POLICY_GUARD"],
        "0x0000000000000000000000000000000000000000"
    ) as `0x${string}`,

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

    // Optional auto action
    autoActionEnabled: optionalBool("AUTO_ACTION_ENABLED", false),
    autoActionTarget: optionalAny(
        ["AUTO_ACTION_TARGET"],
        "0x0000000000000000000000000000000000000000"
    ) as `0x${string}`,
    autoActionData: optionalAny(["AUTO_ACTION_DATA"], "0x") as `0x${string}`,
    autoActionValue: BigInt(optionalAny(["AUTO_ACTION_VALUE"], "0")),
    minActionIntervalMs: parseInt(optionalAny(["MIN_ACTION_INTERVAL_MS"], "300000"), 10),
    requirePositiveBalance: optionalBool("REQUIRE_POSITIVE_BALANCE", true),
    strategyMaxFailuresDefault: parseInt(
        optionalAny(["STRATEGY_MAX_FAILURES_DEFAULT"], "5"),
        10
    ),
    capabilityPackPath: optionalAny(["CAPABILITY_PACK_PATH"], ""),
    capabilityPackPublicKey: optionalAny(["CAPABILITY_PACK_PUBLIC_KEY"], ""),
    capabilityPackRequireSignature: optionalBool("CAPABILITY_PACK_REQUIRE_SIGNATURE", false),
    defaultMaxRunsPerDay: optionalInt("DEFAULT_MAX_RUNS_PER_DAY", 0),
    defaultMaxValuePerDay: BigInt(optionalAny(["DEFAULT_MAX_VALUE_PER_DAY"], "0")),
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
