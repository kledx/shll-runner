import type {
    ReplayBucket,
    ReplayCategory,
    ReplayRunSnapshot,
} from "./replay.js";

export interface ReplayFixture {
    id: string;
    title: string;
    snapshot: ReplayRunSnapshot;
    expected: {
        bucket: ReplayBucket;
        category: ReplayCategory;
    };
}

export const replayFixtures: ReplayFixture[] = [
    {
        id: "RPL-001",
        title: "swap transaction success",
        snapshot: {
            simulateOk: true,
            txHash: "0xabc123",
            intentType: "swap",
            decisionReason: "Swap executed",
        },
        expected: { bucket: "success", category: "executed_tx" },
    },
    {
        id: "RPL-002",
        title: "expected wait",
        snapshot: {
            simulateOk: true,
            intentType: "wait",
            decisionReason: "No valid setup yet",
        },
        expected: { bucket: "expected_wait", category: "passive_wait" },
    },
    {
        id: "RPL-003",
        title: "unknown action from brain",
        snapshot: {
            simulateOk: false,
            intentType: "mystery",
            error: "Unknown action: magicSwap",
        },
        expected: { bucket: "misjudgment", category: "unknown_action" },
    },
    {
        id: "RPL-004",
        title: "policy blocked by guardrail",
        snapshot: {
            simulateOk: false,
            intentType: "swap",
            error: "Action blocked by safety policy: daily spending limit exceeded",
        },
        expected: { bucket: "overreach", category: "policy_blocked" },
    },
    {
        id: "RPL-005",
        title: "paused on chain",
        snapshot: {
            simulateOk: false,
            intentType: "wait",
            error: "Agent is paused on-chain",
        },
        expected: { bucket: "recovery_failure", category: "onchain_paused" },
    },
    {
        id: "RPL-006",
        title: "circuit breaker pause",
        snapshot: {
            simulateOk: false,
            intentType: "wait",
            error: "Circuit Breaker Triggered: The action 'swap' has failed 3 consecutive times",
        },
        expected: { bucket: "recovery_failure", category: "circuit_breaker" },
    },
    {
        id: "RPL-007",
        title: "insufficient gas",
        snapshot: {
            simulateOk: false,
            intentType: "swap",
            error: "Insufficient gas funds. Please add BNB to the Agent Account.",
        },
        expected: { bucket: "param_anomaly", category: "insufficient_gas" },
    },
    {
        id: "RPL-008",
        title: "execution reverted",
        snapshot: {
            simulateOk: false,
            intentType: "swap",
            error: "execution reverted: slippage too high",
        },
        expected: { bucket: "param_anomaly", category: "execution_reverted" },
    },
    {
        id: "RPL-009",
        title: "invalid schema output",
        snapshot: {
            simulateOk: false,
            intentType: "swap",
            error: "invalid params: missing required field tokenOut",
        },
        expected: { bucket: "param_anomaly", category: "invalid_params" },
    },
    {
        id: "RPL-010",
        title: "network timeout",
        snapshot: {
            simulateOk: false,
            intentType: "error",
            error: "Request timed out. Will retry.",
        },
        expected: { bucket: "recovery_failure", category: "network_error" },
    },
    {
        id: "RPL-011",
        title: "authorization issue",
        snapshot: {
            simulateOk: false,
            intentType: "error",
            error: "Authorization issue. Please re-enable Autopilot.",
        },
        expected: { bucket: "recovery_failure", category: "authorization_error" },
    },
    {
        id: "RPL-012",
        title: "uncategorized failure fallback",
        snapshot: {
            simulateOk: false,
            intentType: "error",
            error: "unexpected low-level panic",
        },
        expected: { bucket: "unknown", category: "unknown_failure" },
    },
    {
        id: "RPL-013",
        title: "structured error code takes precedence",
        snapshot: {
            simulateOk: false,
            errorCode: "BUSINESS_POLICY_BLOCKED",
            error: "opaque message",
        },
        expected: { bucket: "overreach", category: "policy_blocked" },
    },
];
