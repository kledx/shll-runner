export type RunFailureCategory =
    | "model_output_error"
    | "business_rejected"
    | "infrastructure_error";

export type RunErrorCode =
    | "MODEL_UNKNOWN_ACTION"
    | "MODEL_INVALID_PARAMS"
    | "MODEL_SCHEMA_VALIDATION_FAILED"
    | "MODEL_LOW_CONFIDENCE"
    | "BUSINESS_POLICY_BLOCKED"
    | "BUSINESS_POLICY_ALLOWED_DEX"
    | "BUSINESS_POLICY_MAX_TRADE_AMOUNT"
    | "BUSINESS_POLICY_COOLDOWN"
    | "BUSINESS_POLICY_MAX_RUNS_PER_DAY"
    | "BUSINESS_POLICY_MAX_DAILY_AMOUNT"
    | "BUSINESS_POLICY_ALLOWED_TOKENS"
    | "BUSINESS_POLICY_BLOCKED_TOKENS"
    | "BUSINESS_POLICY_MAX_SLIPPAGE_BPS"
    | "BUSINESS_POLICY_HARD_REJECTED"
    | "BUSINESS_POLICY_HARD_SIMULATION_REVERTED"
    | "BUSINESS_AGENT_PAUSED"
    | "BUSINESS_CIRCUIT_BREAKER"
    | "BUSINESS_AUTHORIZATION_REQUIRED"
    | "BUSINESS_INSUFFICIENT_BALANCE"
    | "BUSINESS_INSUFFICIENT_GAS"
    | "BUSINESS_CHAIN_REVERTED"
    | "BUSINESS_AUTOPAUSE_THRESHOLD"
    | "INFRA_RPC_RATE_LIMIT"
    | "INFRA_NETWORK_UNAVAILABLE"
    | "INFRA_TIMEOUT"
    | "INFRA_RUNTIME_EXCEPTION";

export interface RunFailureInfo {
    failureCategory: RunFailureCategory;
    errorCode: RunErrorCode;
}

const RATE_LIMIT_PATTERNS = [/too many request/i, /\b429\b/i, /rate.?limit/i];
const NETWORK_PATTERNS = [
    /getaddrinfo/i,
    /econnrefused/i,
    /fetch failed/i,
    /unable to reach the network/i,
    /network request failed/i,
];
const TIMEOUT_PATTERNS = [/timed?\s*out/i, /esockettimedout/i, /\btimeout\b/i];

function hasAny(text: string, patterns: RegExp[]): boolean {
    return patterns.some((p) => p.test(text));
}

export function classifyFailureFromPolicyViolation(code?: string): RunFailureInfo {
    switch (code) {
        case "SOFT_ALLOWED_DEX":
            return {
                failureCategory: "business_rejected",
                errorCode: "BUSINESS_POLICY_ALLOWED_DEX",
            };
        case "SOFT_MAX_TRADE_AMOUNT":
            return {
                failureCategory: "business_rejected",
                errorCode: "BUSINESS_POLICY_MAX_TRADE_AMOUNT",
            };
        case "SOFT_COOLDOWN":
            return {
                failureCategory: "business_rejected",
                errorCode: "BUSINESS_POLICY_COOLDOWN",
            };
        case "SOFT_MAX_RUNS_PER_DAY":
            return {
                failureCategory: "business_rejected",
                errorCode: "BUSINESS_POLICY_MAX_RUNS_PER_DAY",
            };
        case "SOFT_MAX_DAILY_AMOUNT":
            return {
                failureCategory: "business_rejected",
                errorCode: "BUSINESS_POLICY_MAX_DAILY_AMOUNT",
            };
        case "SOFT_ALLOWED_TOKENS":
            return {
                failureCategory: "business_rejected",
                errorCode: "BUSINESS_POLICY_ALLOWED_TOKENS",
            };
        case "SOFT_BLOCKED_TOKENS":
            return {
                failureCategory: "business_rejected",
                errorCode: "BUSINESS_POLICY_BLOCKED_TOKENS",
            };
        case "SOFT_MAX_SLIPPAGE_BPS":
            return {
                failureCategory: "business_rejected",
                errorCode: "BUSINESS_POLICY_MAX_SLIPPAGE_BPS",
            };
        case "HARD_POLICY_REJECTED":
            return {
                failureCategory: "business_rejected",
                errorCode: "BUSINESS_POLICY_HARD_REJECTED",
            };
        case "HARD_SIMULATION_REVERTED":
            return {
                failureCategory: "business_rejected",
                errorCode: "BUSINESS_POLICY_HARD_SIMULATION_REVERTED",
            };
        default:
            return {
                failureCategory: "business_rejected",
                errorCode: "BUSINESS_POLICY_BLOCKED",
            };
    }
}

export function classifyFailureFromBlockedReason(reason: string): RunFailureInfo {
    const text = reason.toLowerCase();

    if (text.includes("unknown action")) {
        return {
            failureCategory: "model_output_error",
            errorCode: "MODEL_UNKNOWN_ACTION",
        };
    }

    if (text.includes("invalid action params") || text.includes("schema validation")) {
        return {
            failureCategory: "model_output_error",
            errorCode: "MODEL_SCHEMA_VALIDATION_FAILED",
        };
    }

    if (
        text.includes("confidence gate") ||
        text.includes("low confidence") ||
        text.includes("confidence below runtime threshold")
    ) {
        return {
            failureCategory: "model_output_error",
            errorCode: "MODEL_LOW_CONFIDENCE",
        };
    }

    if (text.includes("paused on-chain")) {
        return {
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_AGENT_PAUSED",
        };
    }

    if (text.includes("circuit breaker")) {
        return {
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_CIRCUIT_BREAKER",
        };
    }

    if (text.includes("safety policy") || text.includes("policy violation")) {
        return {
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_POLICY_BLOCKED",
        };
    }

    if (text.includes("unauthorized") || text.includes("re-enable autopilot")) {
        return {
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_AUTHORIZATION_REQUIRED",
        };
    }

    if (text.includes("insufficient gas") || text.includes("insufficient funds")) {
        return {
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_INSUFFICIENT_GAS",
        };
    }

    if (
        text.includes("vault") ||
        text.includes("balance") ||
        text.includes("no token")
    ) {
        return {
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_INSUFFICIENT_BALANCE",
        };
    }

    if (
        text.includes("execution reverted") ||
        text.includes("executionfailed()") ||
        text.includes("error: executionfailed()")
    ) {
        return {
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_CHAIN_REVERTED",
        };
    }

    return {
        failureCategory: "infrastructure_error",
        errorCode: "INFRA_RUNTIME_EXCEPTION",
    };
}

export function classifyFailureFromError(rawMessage: string): RunFailureInfo {
    const text = rawMessage.toLowerCase();

    if (text.includes("unknown action")) {
        return {
            failureCategory: "model_output_error",
            errorCode: "MODEL_UNKNOWN_ACTION",
        };
    }

    if (
        text.includes("invalid action params") ||
        text.includes("missing required field") ||
        text.includes("field '")
    ) {
        return {
            failureCategory: "model_output_error",
            errorCode: "MODEL_INVALID_PARAMS",
        };
    }

    if (text.includes("low confidence") || text.includes("confidence below runtime threshold")) {
        return {
            failureCategory: "model_output_error",
            errorCode: "MODEL_LOW_CONFIDENCE",
        };
    }

    if (text.includes("execution reverted")) {
        return {
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_CHAIN_REVERTED",
        };
    }

    if (text.includes("unauthorized") || text.includes("authorization issue")) {
        return {
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_AUTHORIZATION_REQUIRED",
        };
    }

    if (text.includes("insufficient gas") || text.includes("insufficient funds")) {
        return {
            failureCategory: "business_rejected",
            errorCode: "BUSINESS_INSUFFICIENT_GAS",
        };
    }

    if (hasAny(text, RATE_LIMIT_PATTERNS)) {
        return {
            failureCategory: "infrastructure_error",
            errorCode: "INFRA_RPC_RATE_LIMIT",
        };
    }

    if (hasAny(text, TIMEOUT_PATTERNS)) {
        return {
            failureCategory: "infrastructure_error",
            errorCode: "INFRA_TIMEOUT",
        };
    }

    if (hasAny(text, NETWORK_PATTERNS)) {
        return {
            failureCategory: "infrastructure_error",
            errorCode: "INFRA_NETWORK_UNAVAILABLE",
        };
    }

    return {
        failureCategory: "infrastructure_error",
        errorCode: "INFRA_RUNTIME_EXCEPTION",
    };
}
