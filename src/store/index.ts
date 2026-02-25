/**
 * RunnerStore — Facade class delegating to domain-specific store modules.
 *
 * Public API is identical to the original monolithic store.ts.
 * All consumers import `RunnerStore` from this file.
 *
 * Internal sub-modules:
 *   - autopilot.ts   — enable/disable/lock/lease
 *   - strategy.ts    — strategy CRUD + budget
 *   - runRecords.ts  — run record read/write + cleanup
 *   - marketSignals.ts — market signal management
 *   - analytics.ts   — dashboard/performance/activity
 *   - shadowMetrics.ts — shadow mode comparison data
 *   - safetyMetrics.ts — safety SLA metrics
 *   - migrations.ts  — schema migrations
 *   - helpers.ts     — shared row mappers
 */

import { Pool, type PoolConfig } from "pg";
import type {
    AutopilotRecord,
    MarketSignalRecord,
    RunRecord,
    RunMode,
    StrategyConfigRecord,
} from "../types.js";
import { runV30Migrations } from "./migrations.js";

// Domain modules
import * as autopilotOps from "./autopilot.js";
import * as strategyOps from "./strategy.js";
import * as runRecordsOps from "./runRecords.js";
import * as marketSignalsOps from "./marketSignals.js";
import * as analyticsOps from "./analytics.js";
import * as shadowMetricsOps from "./shadowMetrics.js";
import * as safetyMetricsOps from "./safetyMetrics.js";

// Re-export input types for consumers
export type { UpsertEnableInput } from "./autopilot.js";
export type { UpsertStrategyInput } from "./strategy.js";
export type { UpsertMarketSignalInput } from "./marketSignals.js";

export interface RunnerStoreConfig {
    chainId: number;
    maxRunRecords: number;
    databaseUrl: string;
    pgHost: string;
    pgPort: number;
    pgUser: string;
    pgPassword: string;
    pgDatabase: string;
    pgSsl: boolean;
    pgPoolMax: number;
}

export class RunnerStore {
    private readonly pool: Pool;
    private readonly chainId: number;
    private readonly maxRunRecords: number;

    constructor(config: RunnerStoreConfig) {
        this.chainId = config.chainId;
        this.maxRunRecords = config.maxRunRecords;

        const poolConfig: PoolConfig = {
            max: config.pgPoolMax,
        };

        if (config.databaseUrl) {
            poolConfig.connectionString = config.databaseUrl;
        } else {
            if (!config.pgHost || !config.pgUser || !config.pgDatabase) {
                throw new Error(
                    "Postgres config missing: set DATABASE_URL or PGHOST/PGUSER/PGDATABASE",
                );
            }
            poolConfig.host = config.pgHost;
            poolConfig.port = config.pgPort;
            poolConfig.user = config.pgUser;
            poolConfig.password = config.pgPassword;
            poolConfig.database = config.pgDatabase;
        }

        if (config.pgSsl) {
            poolConfig.ssl = { rejectUnauthorized: false };
        }

        this.pool = new Pool(poolConfig);
    }

    /** Expose the internal Pool for V3.0 API routes. */
    getPool(): Pool {
        return this.pool;
    }

    async init(): Promise<void> {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS autopilots (
                chain_id INTEGER NOT NULL,
                token_id NUMERIC(78, 0) NOT NULL,
                renter TEXT NOT NULL,
                operator TEXT NOT NULL,
                permit_expires NUMERIC(78, 0) NOT NULL,
                permit_deadline NUMERIC(78, 0) NOT NULL,
                sig TEXT NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                last_reason TEXT NULL,
                last_enable_tx_hash TEXT NULL,
                last_disable_tx_hash TEXT NULL,
                locked_until TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (chain_id, token_id)
            )
        `);

        await this.pool.query(`
            ALTER TABLE autopilots
            ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ NULL
        `);

        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS runs (
                id BIGSERIAL PRIMARY KEY,
                chain_id INTEGER NOT NULL,
                token_id NUMERIC(78, 0) NOT NULL,
                action_type TEXT NOT NULL,
                action_hash TEXT NOT NULL,
                simulate_ok BOOLEAN NOT NULL,
                tx_hash TEXT NULL,
                error TEXT NULL,
                error_code TEXT NULL,
                execution_trace JSONB NULL,
                run_mode TEXT NOT NULL DEFAULT 'primary',
                shadow_compare JSONB NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS token_strategies (
                chain_id INTEGER NOT NULL,
                token_id NUMERIC(78, 0) NOT NULL,
                strategy_type TEXT NOT NULL,
                target TEXT NOT NULL,
                data TEXT NOT NULL,
                value NUMERIC(78, 0) NOT NULL,
                strategy_params JSONB NOT NULL DEFAULT '{}'::jsonb,
                source TEXT NOT NULL DEFAULT 'api',
                min_interval_ms INTEGER NOT NULL,
                require_positive_balance BOOLEAN NOT NULL,
                max_failures INTEGER NOT NULL,
                failure_count INTEGER NOT NULL DEFAULT 0,
                budget_day DATE NULL,
                daily_runs_used INTEGER NOT NULL DEFAULT 0,
                daily_value_used NUMERIC(78, 0) NOT NULL DEFAULT 0,
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                last_run_at TIMESTAMPTZ NULL,
                last_error TEXT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (chain_id, token_id)
            )
        `);

        // Column additions — idempotent
        await this.pool.query(`ALTER TABLE token_strategies ADD COLUMN IF NOT EXISTS strategy_params JSONB NOT NULL DEFAULT '{}'::jsonb`);
        await this.pool.query(`ALTER TABLE token_strategies ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'api'`);
        await this.pool.query(`ALTER TABLE token_strategies ADD COLUMN IF NOT EXISTS budget_day DATE NULL`);
        await this.pool.query(`ALTER TABLE token_strategies ADD COLUMN IF NOT EXISTS daily_runs_used INTEGER NOT NULL DEFAULT 0`);
        await this.pool.query(`ALTER TABLE token_strategies ADD COLUMN IF NOT EXISTS daily_value_used NUMERIC(78, 0) NOT NULL DEFAULT 0`);

        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS market_signals (
                chain_id INTEGER NOT NULL,
                pair TEXT NOT NULL,
                price_change_bps INTEGER NOT NULL,
                volume_5m NUMERIC(78, 0) NOT NULL DEFAULT 0,
                unique_traders_5m INTEGER NOT NULL DEFAULT 0,
                sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                source TEXT NOT NULL DEFAULT 'manual',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (chain_id, pair)
            )
        `);

        // Indexes
        await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_runs_chain_token_created ON runs (chain_id, token_id, created_at DESC)`);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_autopilots_chain_enabled ON autopilots (chain_id, enabled)`);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_token_strategies_chain_enabled ON token_strategies (chain_id, enabled)`);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_market_signals_chain_sampled ON market_signals (chain_id, sampled_at DESC)`);

        // Runs table column additions
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS params_hash TEXT NULL`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS strategy_explain TEXT NULL`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS failure_category TEXT NULL`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS error_code TEXT NULL`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS execution_trace JSONB NULL`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS run_mode TEXT NOT NULL DEFAULT 'primary'`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS shadow_compare JSONB NULL`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS brain_type TEXT NULL`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS intent_type TEXT NULL`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS decision_reason TEXT NULL`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS decision_message TEXT NULL`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS gas_used TEXT NULL`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS pnl_usd TEXT NULL`);
        await this.pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS violation_code TEXT NULL`);

        // V3.0: agent_memory, user_safety_configs, agent_blueprints
        await runV30Migrations(this.pool);

        // V3.1: adaptive scheduler
        await this.pool.query(`ALTER TABLE token_strategies ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ NULL`);
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    // ── Autopilot ──────────────────────────────────────────
    async upsertEnabled(input: autopilotOps.UpsertEnableInput): Promise<AutopilotRecord> {
        return autopilotOps.upsertEnabled(this.pool, this.chainId, input);
    }

    async disable(tokenId: bigint, reason: string, txHash?: string): Promise<AutopilotRecord> {
        return autopilotOps.disable(this.pool, this.chainId, tokenId, reason, txHash);
    }

    async getAutopilot(tokenId: bigint): Promise<AutopilotRecord | null> {
        return autopilotOps.getAutopilot(this.pool, this.chainId, tokenId);
    }

    async listEnabledTokenIds(): Promise<bigint[]> {
        return autopilotOps.listEnabledTokenIds(this.pool, this.chainId);
    }

    async listSchedulableTokenIds(): Promise<bigint[]> {
        return autopilotOps.listSchedulableTokenIds(this.pool, this.chainId);
    }

    async getEarliestNextCheckAt(): Promise<Date | null> {
        return autopilotOps.getEarliestNextCheckAt(this.pool, this.chainId);
    }

    async listAutopilots(): Promise<AutopilotRecord[]> {
        return autopilotOps.listAutopilots(this.pool, this.chainId);
    }

    async tryAcquireAutopilotLock(tokenId: bigint, leaseMs: number): Promise<boolean> {
        return autopilotOps.tryAcquireAutopilotLock(this.pool, this.chainId, tokenId, leaseMs);
    }

    async releaseAutopilotLock(tokenId: bigint): Promise<void> {
        return autopilotOps.releaseAutopilotLock(this.pool, this.chainId, tokenId);
    }

    async countActiveAutopilotLocks(): Promise<number> {
        return autopilotOps.countActiveAutopilotLocks(this.pool, this.chainId);
    }

    // ── Strategy ───────────────────────────────────────────
    async refreshStrategyDailyBudget(tokenId: bigint): Promise<void> {
        return strategyOps.refreshDailyBudget(this.pool, this.chainId, tokenId);
    }

    async checkStrategyBudget(input: {
        tokenId: bigint;
        nextValue: bigint;
        maxRunsPerDay: number;
        maxValuePerDay: bigint;
    }): Promise<{ ok: true } | { ok: false; reason: string }> {
        return strategyOps.checkBudget(this.pool, this.chainId, input);
    }

    async consumeStrategyBudget(tokenId: bigint, value: bigint): Promise<void> {
        return strategyOps.consumeBudget(this.pool, this.chainId, tokenId, value);
    }

    async upsertStrategy(input: strategyOps.UpsertStrategyInput): Promise<StrategyConfigRecord> {
        return strategyOps.upsertStrategy(this.pool, this.chainId, input);
    }

    async getStrategy(tokenId: bigint): Promise<StrategyConfigRecord | null> {
        return strategyOps.getStrategy(this.pool, this.chainId, tokenId);
    }

    async clearTradingGoal(tokenId: bigint): Promise<void> {
        return strategyOps.clearTradingGoal(this.pool, this.chainId, tokenId);
    }

    async listStrategies(): Promise<StrategyConfigRecord[]> {
        return strategyOps.listStrategies(this.pool, this.chainId);
    }

    async updateNextCheckAt(tokenId: bigint, nextCheckAt: Date): Promise<void> {
        return strategyOps.updateNextCheckAt(this.pool, this.chainId, tokenId, nextCheckAt);
    }

    async getNextCheckAt(tokenId: bigint): Promise<Date | null> {
        return strategyOps.getNextCheckAt(this.pool, this.chainId, tokenId);
    }

    async recordStrategySuccess(tokenId: bigint): Promise<void> {
        return strategyOps.recordSuccess(this.pool, this.chainId, tokenId);
    }

    async recordStrategyFailure(tokenId: bigint, error: string): Promise<StrategyConfigRecord | null> {
        return strategyOps.recordFailure(this.pool, this.chainId, tokenId, error);
    }

    // ── Run Records ────────────────────────────────────────
    async recordRun(input: Omit<RunRecord, "id" | "createdAt">): Promise<RunRecord> {
        return runRecordsOps.recordRun(this.pool, this.chainId, this.maxRunRecords, input);
    }

    async listRuns(tokenId: bigint, limit: number): Promise<RunRecord[]> {
        return runRecordsOps.listRuns(this.pool, this.chainId, tokenId, limit);
    }

    // ── Market Signals ─────────────────────────────────────
    async upsertMarketSignal(input: marketSignalsOps.UpsertMarketSignalInput): Promise<MarketSignalRecord> {
        return marketSignalsOps.upsertMarketSignal(this.pool, this.chainId, input);
    }

    async upsertMarketSignals(inputs: marketSignalsOps.UpsertMarketSignalInput[]): Promise<number> {
        return marketSignalsOps.upsertMarketSignals(this.pool, this.chainId, inputs);
    }

    async listMarketSignals(pairs?: string[], limit = 200): Promise<MarketSignalRecord[]> {
        return marketSignalsOps.listMarketSignals(this.pool, this.chainId, pairs, limit);
    }

    // ── Analytics ──────────────────────────────────────────
    async getDashboard(tokenId: bigint) {
        return analyticsOps.getDashboard(this.pool, this.chainId, tokenId);
    }

    async getPerformance(tokenId: bigint) {
        return analyticsOps.getPerformance(this.pool, this.chainId, tokenId);
    }

    async getTemplatePerformance() {
        return analyticsOps.getTemplatePerformance(this.pool, this.chainId);
    }

    async getActivity(
        tokenId: bigint,
        options?: { limit?: number; offset?: number; brainType?: string },
    ) {
        return analyticsOps.getActivity(this.pool, this.chainId, tokenId, options);
    }

    // ── Shadow Metrics ─────────────────────────────────────
    async getShadowMetrics(options?: { tokenId?: bigint; sinceHours?: number }) {
        return shadowMetricsOps.getShadowMetrics(this.pool, this.chainId, options);
    }

    // ── Safety Metrics ─────────────────────────────────────
    async getSafetyMetrics(tokenId: bigint) {
        return safetyMetricsOps.getSafetyMetrics(this.pool, this.chainId, tokenId);
    }

    async getSafetyTimeline(tokenId: bigint, period: "day" | "week" | "month" = "day") {
        return safetyMetricsOps.getSafetyTimeline(this.pool, this.chainId, tokenId, period);
    }

    async getSafetyViolations(tokenId: bigint, limit = 50) {
        return safetyMetricsOps.getSafetyViolations(this.pool, this.chainId, tokenId, limit);
    }
}
