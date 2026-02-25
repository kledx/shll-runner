/**
 * Store helpers — shared row mappers and utility functions.
 */

import type {
    AutopilotRecord,
    ExecutionTraceEntry,
    MarketSignalRecord,
    RunRecord,
    RunMode,
    ShadowComparison,
    StrategyConfigRecord,
    StrategyType,
} from "../types.js";

export function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function mapAutopilotRow(row: Record<string, unknown>): AutopilotRecord {
    return {
        tokenId: String(row.token_id),
        chainId: Number(row.chain_id),
        renter: String(row.renter),
        operator: String(row.operator),
        permitExpires: String(row.permit_expires),
        permitDeadline: String(row.permit_deadline),
        sig: String(row.sig),
        enabled: Boolean(row.enabled),
        lastReason: row.last_reason == null ? undefined : String(row.last_reason),
        lastEnableTxHash:
            row.last_enable_tx_hash == null ? undefined : String(row.last_enable_tx_hash),
        lastDisableTxHash:
            row.last_disable_tx_hash == null ? undefined : String(row.last_disable_tx_hash),
        lockedUntil: row.locked_until == null ? undefined : toIso(row.locked_until as Date | string),
        createdAt: toIso(row.created_at as Date | string),
        updatedAt: toIso(row.updated_at as Date | string),
    };
}

export function mapRunRow(row: Record<string, unknown>): RunRecord {
    let executionTrace: ExecutionTraceEntry[] | undefined;
    let shadowCompare: ShadowComparison | undefined;
    if (Array.isArray(row.execution_trace)) {
        executionTrace = row.execution_trace as ExecutionTraceEntry[];
    } else if (typeof row.execution_trace === "string") {
        try {
            const parsed = JSON.parse(row.execution_trace) as unknown;
            if (Array.isArray(parsed)) {
                executionTrace = parsed as ExecutionTraceEntry[];
            }
        } catch {
            // ignore malformed trace payloads
        }
    }
    if (row.shadow_compare && typeof row.shadow_compare === "object") {
        shadowCompare = row.shadow_compare as ShadowComparison;
    } else if (typeof row.shadow_compare === "string") {
        try {
            const parsed = JSON.parse(row.shadow_compare) as unknown;
            if (parsed && typeof parsed === "object") {
                shadowCompare = parsed as ShadowComparison;
            }
        } catch {
            // ignore malformed shadow compare payloads
        }
    }
    return {
        id: String(row.id),
        tokenId: String(row.token_id),
        actionType: String(row.action_type),
        actionHash: String(row.action_hash),
        simulateOk: Boolean(row.simulate_ok),
        txHash: row.tx_hash == null ? undefined : String(row.tx_hash),
        error: row.error == null ? undefined : String(row.error),
        paramsHash: row.params_hash == null ? undefined : String(row.params_hash),
        strategyExplain: row.strategy_explain == null ? undefined : String(row.strategy_explain),
        failureCategory: row.failure_category == null ? undefined : String(row.failure_category),
        errorCode: row.error_code == null ? undefined : String(row.error_code),
        executionTrace,
        runMode: row.run_mode == null ? "primary" : (String(row.run_mode) as RunMode),
        shadowCompare,
        brainType: row.brain_type == null ? undefined : String(row.brain_type),
        intentType: row.intent_type == null ? undefined : String(row.intent_type),
        decisionReason: row.decision_reason == null ? undefined : String(row.decision_reason),
        decisionMessage: row.decision_message == null ? undefined : String(row.decision_message),
        gasUsed: row.gas_used == null ? undefined : String(row.gas_used),
        pnlUsd: row.pnl_usd == null ? undefined : String(row.pnl_usd),
        violationCode: row.violation_code == null ? undefined : String(row.violation_code),
        createdAt: toIso(row.created_at as Date | string),
    };
}

export function mapStrategyRow(row: Record<string, unknown>): StrategyConfigRecord {
    const paramsRaw = row.strategy_params;
    let strategyParams: Record<string, unknown> = {};
    if (paramsRaw && typeof paramsRaw === "object") {
        strategyParams = paramsRaw as Record<string, unknown>;
    }
    return {
        tokenId: String(row.token_id),
        chainId: Number(row.chain_id),
        strategyType: String(row.strategy_type) as StrategyType,
        target: String(row.target),
        data: String(row.data) as `0x${string}`,
        value: String(row.value),
        strategyParams,
        source: String(row.source ?? "api"),
        minIntervalMs: Number(row.min_interval_ms),
        requirePositiveBalance: Boolean(row.require_positive_balance),
        maxFailures: Number(row.max_failures),
        failureCount: Number(row.failure_count),
        budgetDay: row.budget_day == null ? undefined : String(row.budget_day),
        dailyRunsUsed: Number(row.daily_runs_used ?? 0),
        dailyValueUsed: String(row.daily_value_used ?? "0"),
        enabled: Boolean(row.enabled),
        lastRunAt: row.last_run_at == null ? undefined : toIso(row.last_run_at as Date | string),
        lastError: row.last_error == null ? undefined : String(row.last_error),
        nextCheckAt: row.next_check_at == null ? undefined : toIso(row.next_check_at as Date | string),
        createdAt: toIso(row.created_at as Date | string),
        updatedAt: toIso(row.updated_at as Date | string),
    };
}

export function mapMarketSignalRow(row: Record<string, unknown>): MarketSignalRecord {
    return {
        chainId: Number(row.chain_id),
        pair: String(row.pair),
        priceChangeBps: Number(row.price_change_bps),
        volume5m: String(row.volume_5m ?? "0"),
        uniqueTraders5m: Number(row.unique_traders_5m ?? 0),
        sampledAt: toIso(row.sampled_at as Date | string),
        source: String(row.source ?? "manual"),
        createdAt: toIso(row.created_at as Date | string),
        updatedAt: toIso(row.updated_at as Date | string),
    };
}
