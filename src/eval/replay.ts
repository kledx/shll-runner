/**
 * Replay classification for Runner failure baselining.
 *
 * Phase 0 goal:
 * - Convert raw run snapshots into stable failure buckets.
 * - Keep the logic deterministic so regressions are easy to detect.
 */

export type ReplayBucket =
    | "success"
    | "expected_wait"
    | "misjudgment"
    | "overreach"
    | "param_anomaly"
    | "recovery_failure"
    | "unknown";

export type ReplayCategory =
    | "executed_tx"
    | "passive_wait"
    | "unknown_action"
    | "policy_blocked"
    | "onchain_paused"
    | "circuit_breaker"
    | "insufficient_gas"
    | "invalid_params"
    | "execution_reverted"
    | "network_error"
    | "authorization_error"
    | "unknown_failure";

export interface ReplayRunSnapshot {
    simulateOk: boolean;
    txHash?: string;
    error?: string;
    failureCategory?: string;
    errorCode?: string;
    intentType?: string;
    decisionReason?: string;
    decisionMessage?: string;
}

export interface ReplayClassification {
    bucket: ReplayBucket;
    category: ReplayCategory;
    evidence: string[];
}

const NETWORK_PATTERNS = [
    /too many request/i,
    /\b429\b/i,
    /getaddrinfo/i,
    /econnrefused/i,
    /timed?\s*out/i,
    /fetch failed/i,
    /network is busy/i,
    /unable to reach the network/i,
    /service temporarily unavailable/i,
];

const AUTH_PATTERNS = [/unauthorized/i, /re-enable autopilot/i, /authorization issue/i];

const INSUFFICIENT_GAS_PATTERNS = [
    /insufficient.*gas/i,
    /insufficient funds/i,
    /no.*bnb.*gas/i,
    /gas.*0/i,
];

const INVALID_PARAMS_PATTERNS = [
    /invalid/i,
    /malformed/i,
    /decode/i,
    /json/i,
    /schema/i,
    /missing required/i,
];

function pickEvidence(text: string, patterns: RegExp[]): string[] {
    const matches: string[] = [];
    for (const p of patterns) {
        const m = text.match(p);
        if (m?.[0]) {
            matches.push(m[0]);
        }
    }
    return matches;
}

function isWaitIntent(intentType?: string): boolean {
    if (!intentType) return false;
    const x = intentType.toLowerCase();
    return x === "wait" || x === "analytics" || x === "portfolio";
}

export function classifyReplaySnapshot(
    snapshot: ReplayRunSnapshot,
): ReplayClassification {
    if (snapshot.errorCode) {
        const byCode = classifyByStructuredCode(snapshot.errorCode);
        if (byCode) {
            return byCode;
        }
    }

    const text = [
        snapshot.error ?? "",
        snapshot.failureCategory ?? "",
        snapshot.errorCode ?? "",
        snapshot.intentType ?? "",
        snapshot.decisionReason ?? "",
        snapshot.decisionMessage ?? "",
    ]
        .join(" | ")
        .toLowerCase();

    if (!snapshot.error && snapshot.txHash) {
        return {
            bucket: "success",
            category: "executed_tx",
            evidence: ["txHash present"],
        };
    }

    if (!snapshot.error && snapshot.simulateOk && isWaitIntent(snapshot.intentType)) {
        return {
            bucket: "expected_wait",
            category: "passive_wait",
            evidence: [snapshot.intentType ?? "wait-like intent"],
        };
    }

    if (text.includes("unknown action")) {
        return {
            bucket: "misjudgment",
            category: "unknown_action",
            evidence: ["unknown action"],
        };
    }

    if (
        text.includes("action blocked by safety policy") ||
        text.includes("policy violation")
    ) {
        return {
            bucket: "overreach",
            category: "policy_blocked",
            evidence: ["policy blocked"],
        };
    }

    if (text.includes("paused on-chain")) {
        return {
            bucket: "recovery_failure",
            category: "onchain_paused",
            evidence: ["paused on-chain"],
        };
    }

    if (text.includes("circuit breaker")) {
        return {
            bucket: "recovery_failure",
            category: "circuit_breaker",
            evidence: ["circuit breaker"],
        };
    }

    const authEvidence = pickEvidence(text, AUTH_PATTERNS);
    if (authEvidence.length > 0) {
        return {
            bucket: "recovery_failure",
            category: "authorization_error",
            evidence: authEvidence,
        };
    }

    const networkEvidence = pickEvidence(text, NETWORK_PATTERNS);
    if (networkEvidence.length > 0) {
        return {
            bucket: "recovery_failure",
            category: "network_error",
            evidence: networkEvidence,
        };
    }

    const gasEvidence = pickEvidence(text, INSUFFICIENT_GAS_PATTERNS);
    if (gasEvidence.length > 0) {
        return {
            bucket: "param_anomaly",
            category: "insufficient_gas",
            evidence: gasEvidence,
        };
    }

    if (text.includes("execution reverted")) {
        return {
            bucket: "param_anomaly",
            category: "execution_reverted",
            evidence: ["execution reverted"],
        };
    }

    const invalidEvidence = pickEvidence(text, INVALID_PARAMS_PATTERNS);
    if (invalidEvidence.length > 0) {
        return {
            bucket: "param_anomaly",
            category: "invalid_params",
            evidence: invalidEvidence,
        };
    }

    if (!snapshot.simulateOk || Boolean(snapshot.error)) {
        return {
            bucket: "unknown",
            category: "unknown_failure",
            evidence: [snapshot.error ?? "simulateOk=false"],
        };
    }

    return {
        bucket: "expected_wait",
        category: "passive_wait",
        evidence: ["default fallback wait"],
    };
}

function classifyByStructuredCode(errorCode: string): ReplayClassification | null {
    switch (errorCode) {
        case "MODEL_UNKNOWN_ACTION":
            return {
                bucket: "misjudgment",
                category: "unknown_action",
                evidence: [errorCode],
            };
        case "MODEL_INVALID_PARAMS":
        case "MODEL_SCHEMA_VALIDATION_FAILED":
            return {
                bucket: "param_anomaly",
                category: "invalid_params",
                evidence: [errorCode],
            };
        case "BUSINESS_POLICY_BLOCKED":
        case "BUSINESS_POLICY_ALLOWED_DEX":
        case "BUSINESS_POLICY_MAX_TRADE_AMOUNT":
        case "BUSINESS_POLICY_COOLDOWN":
        case "BUSINESS_POLICY_MAX_RUNS_PER_DAY":
        case "BUSINESS_POLICY_MAX_DAILY_AMOUNT":
        case "BUSINESS_POLICY_ALLOWED_TOKENS":
        case "BUSINESS_POLICY_BLOCKED_TOKENS":
        case "BUSINESS_POLICY_MAX_SLIPPAGE_BPS":
        case "BUSINESS_POLICY_HARD_REJECTED":
        case "BUSINESS_POLICY_HARD_SIMULATION_REVERTED":
            return {
                bucket: "overreach",
                category: "policy_blocked",
                evidence: [errorCode],
            };
        case "BUSINESS_AGENT_PAUSED":
            return {
                bucket: "recovery_failure",
                category: "onchain_paused",
                evidence: [errorCode],
            };
        case "BUSINESS_CIRCUIT_BREAKER":
            return {
                bucket: "recovery_failure",
                category: "circuit_breaker",
                evidence: [errorCode],
            };
        case "BUSINESS_INSUFFICIENT_GAS":
            return {
                bucket: "param_anomaly",
                category: "insufficient_gas",
                evidence: [errorCode],
            };
        case "BUSINESS_INSUFFICIENT_BALANCE":
            return {
                bucket: "param_anomaly",
                category: "invalid_params",
                evidence: [errorCode],
            };
        case "BUSINESS_CHAIN_REVERTED":
            return {
                bucket: "param_anomaly",
                category: "execution_reverted",
                evidence: [errorCode],
            };
        case "BUSINESS_AUTHORIZATION_REQUIRED":
            return {
                bucket: "recovery_failure",
                category: "authorization_error",
                evidence: [errorCode],
            };
        case "INFRA_RPC_RATE_LIMIT":
        case "INFRA_NETWORK_UNAVAILABLE":
        case "INFRA_TIMEOUT":
            return {
                bucket: "recovery_failure",
                category: "network_error",
                evidence: [errorCode],
            };
        case "INFRA_RUNTIME_EXCEPTION":
            return {
                bucket: "unknown",
                category: "unknown_failure",
                evidence: [errorCode],
            };
        default:
            return null;
    }
}
