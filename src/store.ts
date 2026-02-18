import { Pool, type PoolConfig } from "pg";
import type {
    AutopilotRecord,
    MarketSignalRecord,
    RunRecord,
    StrategyConfigRecord,
    StrategyType,
} from "./types.js";
import { runV30Migrations } from "./store/migrations.js";

interface RunnerStoreConfig {
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

interface UpsertEnableInput {
    tokenId: bigint;
    renter: string;
    operator: string;
    permitExpires: bigint;
    permitDeadline: bigint;
    sig: string;
    txHash: string;
}

interface UpsertStrategyInput {
    tokenId: bigint;
    strategyType: StrategyType;
    target: string;
    data: string;
    value: bigint;
    strategyParams: Record<string, unknown>;
    source: string;
    minIntervalMs: number;
    requirePositiveBalance: boolean;
    maxFailures: number;
    enabled: boolean;
}

interface UpsertMarketSignalInput {
    pair: string;
    priceChangeBps: number;
    volume5m: bigint;
    uniqueTraders5m: number;
    sampledAt?: Date;
    source: string;
}

function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapAutopilotRow(row: Record<string, unknown>): AutopilotRecord {
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

function mapRunRow(row: Record<string, unknown>): RunRecord {
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
        brainType: row.brain_type == null ? undefined : String(row.brain_type),
        intentType: row.intent_type == null ? undefined : String(row.intent_type),
        decisionReason: row.decision_reason == null ? undefined : String(row.decision_reason),
        createdAt: toIso(row.created_at as Date | string),
    };
}

function mapStrategyRow(row: Record<string, unknown>): StrategyConfigRecord {
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
        createdAt: toIso(row.created_at as Date | string),
        updatedAt: toIso(row.updated_at as Date | string),
    };
}

function mapMarketSignalRow(row: Record<string, unknown>): MarketSignalRecord {
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
                    "Postgres config missing: set DATABASE_URL or PGHOST/PGUSER/PGDATABASE"
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

        await this.pool.query(`
            ALTER TABLE token_strategies
            ADD COLUMN IF NOT EXISTS strategy_params JSONB NOT NULL DEFAULT '{}'::jsonb
        `);

        await this.pool.query(`
            ALTER TABLE token_strategies
            ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'api'
        `);

        await this.pool.query(`
            ALTER TABLE token_strategies
            ADD COLUMN IF NOT EXISTS budget_day DATE NULL
        `);

        await this.pool.query(`
            ALTER TABLE token_strategies
            ADD COLUMN IF NOT EXISTS daily_runs_used INTEGER NOT NULL DEFAULT 0
        `);

        await this.pool.query(`
            ALTER TABLE token_strategies
            ADD COLUMN IF NOT EXISTS daily_value_used NUMERIC(78, 0) NOT NULL DEFAULT 0
        `);

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

        await this.pool.query(`
            CREATE INDEX IF NOT EXISTS idx_runs_chain_token_created
            ON runs (chain_id, token_id, created_at DESC)
        `);

        await this.pool.query(`
            CREATE INDEX IF NOT EXISTS idx_autopilots_chain_enabled
            ON autopilots (chain_id, enabled)
        `);

        await this.pool.query(`
            CREATE INDEX IF NOT EXISTS idx_token_strategies_chain_enabled
            ON token_strategies (chain_id, enabled)
        `);

        await this.pool.query(`
            CREATE INDEX IF NOT EXISTS idx_market_signals_chain_sampled
            ON market_signals (chain_id, sampled_at DESC)
        `);

        // V1.4: add new columns to runs table
        await this.pool.query(`
            ALTER TABLE runs
            ADD COLUMN IF NOT EXISTS params_hash TEXT NULL
        `);
        await this.pool.query(`
            ALTER TABLE runs
            ADD COLUMN IF NOT EXISTS strategy_explain TEXT NULL
        `);
        await this.pool.query(`
            ALTER TABLE runs
            ADD COLUMN IF NOT EXISTS failure_category TEXT NULL
        `);

        // V2.1: add brain/intent/reason columns to runs table
        await this.pool.query(`
            ALTER TABLE runs
            ADD COLUMN IF NOT EXISTS brain_type TEXT NULL
        `);
        await this.pool.query(`
            ALTER TABLE runs
            ADD COLUMN IF NOT EXISTS intent_type TEXT NULL
        `);
        await this.pool.query(`
            ALTER TABLE runs
            ADD COLUMN IF NOT EXISTS decision_reason TEXT NULL
        `);

        // V3.0: create agent_memory, user_safety_configs, agent_blueprints tables
        await runV30Migrations(this.pool);
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    async upsertEnabled(input: UpsertEnableInput): Promise<AutopilotRecord> {
        const result = await this.pool.query(
            `
            INSERT INTO autopilots (
                chain_id,
                token_id,
                renter,
                operator,
                permit_expires,
                permit_deadline,
                sig,
                enabled,
                last_reason,
                last_enable_tx_hash,
                locked_until,
                updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NULL,$8,NULL,NOW())
            ON CONFLICT (chain_id, token_id)
            DO UPDATE SET
                renter = EXCLUDED.renter,
                operator = EXCLUDED.operator,
                permit_expires = EXCLUDED.permit_expires,
                permit_deadline = EXCLUDED.permit_deadline,
                sig = EXCLUDED.sig,
                enabled = TRUE,
                last_reason = NULL,
                last_enable_tx_hash = EXCLUDED.last_enable_tx_hash,
                locked_until = NULL,
                updated_at = NOW()
            RETURNING *
            `,
            [
                this.chainId,
                input.tokenId.toString(),
                input.renter,
                input.operator,
                input.permitExpires.toString(),
                input.permitDeadline.toString(),
                input.sig,
                input.txHash,
            ]
        );
        return mapAutopilotRow(result.rows[0] as Record<string, unknown>);
    }

    async disable(tokenId: bigint, reason: string, txHash?: string): Promise<AutopilotRecord> {
        const result = await this.pool.query(
            `
            INSERT INTO autopilots (
                chain_id,
                token_id,
                renter,
                operator,
                permit_expires,
                permit_deadline,
                sig,
                enabled,
                last_reason,
                last_disable_tx_hash,
                locked_until,
                updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8,$9,NULL,NOW())
            ON CONFLICT (chain_id, token_id)
            DO UPDATE SET
                enabled = FALSE,
                last_reason = EXCLUDED.last_reason,
                last_disable_tx_hash = COALESCE(EXCLUDED.last_disable_tx_hash, autopilots.last_disable_tx_hash),
                locked_until = NULL,
                updated_at = NOW()
            RETURNING *
            `,
            [
                this.chainId,
                tokenId.toString(),
                "0x0000000000000000000000000000000000000000",
                "0x0000000000000000000000000000000000000000",
                "0",
                "0",
                "0x",
                reason,
                txHash ?? null,
            ]
        );
        return mapAutopilotRow(result.rows[0] as Record<string, unknown>);
    }

    async getAutopilot(tokenId: bigint): Promise<AutopilotRecord | null> {
        const result = await this.pool.query(
            `
            SELECT *
            FROM autopilots
            WHERE chain_id = $1 AND token_id = $2
            LIMIT 1
            `,
            [this.chainId, tokenId.toString()]
        );
        if (result.rows.length === 0) return null;
        return mapAutopilotRow(result.rows[0] as Record<string, unknown>);
    }

    async listEnabledTokenIds(): Promise<bigint[]> {
        const result = await this.pool.query(
            `
            SELECT token_id
            FROM autopilots
            WHERE chain_id = $1 AND enabled = TRUE
            ORDER BY token_id ASC
            `,
            [this.chainId]
        );
        return result.rows.map((row) => BigInt(String(row.token_id)));
    }

    async listAutopilots(): Promise<AutopilotRecord[]> {
        const result = await this.pool.query(
            `
            SELECT *
            FROM autopilots
            WHERE chain_id = $1
            ORDER BY token_id ASC
            `,
            [this.chainId]
        );
        return result.rows.map((row) => mapAutopilotRow(row as Record<string, unknown>));
    }

    async tryAcquireAutopilotLock(tokenId: bigint, leaseMs: number): Promise<boolean> {
        const result = await this.pool.query(
            `
            UPDATE autopilots
            SET
                locked_until = NOW() + ($3::text || ' milliseconds')::interval,
                updated_at = NOW()
            WHERE
                chain_id = $1
                AND token_id = $2
                AND enabled = TRUE
                AND (locked_until IS NULL OR locked_until <= NOW())
            RETURNING token_id
            `,
            [this.chainId, tokenId.toString(), Math.max(1, leaseMs)]
        );
        return result.rows.length > 0;
    }

    async releaseAutopilotLock(tokenId: bigint): Promise<void> {
        await this.pool.query(
            `
            UPDATE autopilots
            SET
                locked_until = NULL,
                updated_at = NOW()
            WHERE chain_id = $1 AND token_id = $2
            `,
            [this.chainId, tokenId.toString()]
        );
    }

    async countActiveAutopilotLocks(): Promise<number> {
        const result = await this.pool.query(
            `
            SELECT COUNT(*)::int AS count
            FROM autopilots
            WHERE chain_id = $1 AND enabled = TRUE AND locked_until > NOW()
            `,
            [this.chainId]
        );
        return Number(result.rows[0]?.count ?? 0);
    }

    async refreshStrategyDailyBudget(tokenId: bigint): Promise<void> {
        await this.pool.query(
            `
            UPDATE token_strategies
            SET
                budget_day = CURRENT_DATE,
                daily_runs_used = CASE
                    WHEN budget_day IS NULL OR budget_day < CURRENT_DATE THEN 0
                    ELSE daily_runs_used
                END,
                daily_value_used = CASE
                    WHEN budget_day IS NULL OR budget_day < CURRENT_DATE THEN 0
                    ELSE daily_value_used
                END,
                updated_at = NOW()
            WHERE chain_id = $1 AND token_id = $2
            `,
            [this.chainId, tokenId.toString()]
        );
    }

    async checkStrategyBudget(input: {
        tokenId: bigint;
        nextValue: bigint;
        maxRunsPerDay: number;
        maxValuePerDay: bigint;
    }): Promise<{ ok: true } | { ok: false; reason: string }> {
        await this.refreshStrategyDailyBudget(input.tokenId);
        const strategy = await this.getStrategy(input.tokenId);
        if (!strategy) return { ok: false, reason: "strategy not found" };

        if (
            input.maxRunsPerDay > 0 &&
            strategy.dailyRunsUsed + 1 > input.maxRunsPerDay
        ) {
            return {
                ok: false,
                reason: `Daily run budget exceeded (${strategy.dailyRunsUsed}/${input.maxRunsPerDay})`,
            };
        }

        if (input.maxValuePerDay > 0n) {
            const used = BigInt(strategy.dailyValueUsed);
            if (used + input.nextValue > input.maxValuePerDay) {
                return {
                    ok: false,
                    reason: `Daily value budget exceeded (${used.toString()}/${input.maxValuePerDay.toString()})`,
                };
            }
        }

        return { ok: true };
    }

    async consumeStrategyBudget(tokenId: bigint, value: bigint): Promise<void> {
        await this.refreshStrategyDailyBudget(tokenId);
        await this.pool.query(
            `
            UPDATE token_strategies
            SET
                daily_runs_used = daily_runs_used + 1,
                daily_value_used = daily_value_used + $3,
                updated_at = NOW()
            WHERE chain_id = $1 AND token_id = $2
            `,
            [this.chainId, tokenId.toString(), value.toString()]
        );
    }

    async upsertStrategy(input: UpsertStrategyInput): Promise<StrategyConfigRecord> {
        const result = await this.pool.query(
            `
            INSERT INTO token_strategies (
                chain_id,
                token_id,
                strategy_type,
                target,
                data,
                value,
                strategy_params,
                source,
                min_interval_ms,
                require_positive_balance,
                max_failures,
                failure_count,
                budget_day,
                daily_runs_used,
                daily_value_used,
                enabled,
                last_error,
                updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,0,CURRENT_DATE,0,0,$12,NULL,NOW())
            ON CONFLICT (chain_id, token_id)
            DO UPDATE SET
                strategy_type = EXCLUDED.strategy_type,
                target = EXCLUDED.target,
                data = EXCLUDED.data,
                value = EXCLUDED.value,
                strategy_params = EXCLUDED.strategy_params,
                source = EXCLUDED.source,
                min_interval_ms = EXCLUDED.min_interval_ms,
                require_positive_balance = EXCLUDED.require_positive_balance,
                max_failures = EXCLUDED.max_failures,
                enabled = EXCLUDED.enabled,
                failure_count = CASE WHEN EXCLUDED.enabled THEN 0 ELSE token_strategies.failure_count END,
                last_error = CASE WHEN EXCLUDED.enabled THEN NULL ELSE token_strategies.last_error END,
                updated_at = NOW()
            RETURNING *
            `,
            [
                this.chainId,
                input.tokenId.toString(),
                input.strategyType,
                input.target,
                input.data,
                input.value.toString(),
                JSON.stringify(input.strategyParams ?? {}),
                input.source,
                input.minIntervalMs,
                input.requirePositiveBalance,
                input.maxFailures,
                input.enabled,
            ]
        );
        return mapStrategyRow(result.rows[0] as Record<string, unknown>);
    }

    async getStrategy(tokenId: bigint): Promise<StrategyConfigRecord | null> {
        const result = await this.pool.query(
            `
            SELECT *
            FROM token_strategies
            WHERE chain_id = $1 AND token_id = $2
            LIMIT 1
            `,
            [this.chainId, tokenId.toString()]
        );
        if (result.rows.length === 0) return null;
        return mapStrategyRow(result.rows[0] as Record<string, unknown>);
    }

    async listStrategies(): Promise<StrategyConfigRecord[]> {
        const result = await this.pool.query(
            `
            SELECT *
            FROM token_strategies
            WHERE chain_id = $1
            ORDER BY token_id ASC
            `,
            [this.chainId]
        );
        return result.rows.map((row) => mapStrategyRow(row as Record<string, unknown>));
    }

    async upsertMarketSignal(input: UpsertMarketSignalInput): Promise<MarketSignalRecord> {
        const normalizedPair = input.pair.toLowerCase();
        const sampledAt = input.sampledAt ?? new Date();
        const result = await this.pool.query(
            `
            INSERT INTO market_signals (
                chain_id,
                pair,
                price_change_bps,
                volume_5m,
                unique_traders_5m,
                sampled_at,
                source,
                updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
            ON CONFLICT (chain_id, pair)
            DO UPDATE SET
                price_change_bps = EXCLUDED.price_change_bps,
                volume_5m = EXCLUDED.volume_5m,
                unique_traders_5m = EXCLUDED.unique_traders_5m,
                sampled_at = EXCLUDED.sampled_at,
                source = EXCLUDED.source,
                updated_at = NOW()
            RETURNING *
            `,
            [
                this.chainId,
                normalizedPair,
                input.priceChangeBps,
                input.volume5m.toString(),
                input.uniqueTraders5m,
                sampledAt.toISOString(),
                input.source,
            ]
        );
        return mapMarketSignalRow(result.rows[0] as Record<string, unknown>);
    }

    async upsertMarketSignals(inputs: UpsertMarketSignalInput[]): Promise<number> {
        if (inputs.length === 0) return 0;
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            let count = 0;
            for (const input of inputs) {
                const normalizedPair = input.pair.toLowerCase();
                const sampledAt = input.sampledAt ?? new Date();
                await client.query(
                    `
                    INSERT INTO market_signals (
                        chain_id,
                        pair,
                        price_change_bps,
                        volume_5m,
                        unique_traders_5m,
                        sampled_at,
                        source,
                        updated_at
                    )
                    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
                    ON CONFLICT (chain_id, pair)
                    DO UPDATE SET
                        price_change_bps = EXCLUDED.price_change_bps,
                        volume_5m = EXCLUDED.volume_5m,
                        unique_traders_5m = EXCLUDED.unique_traders_5m,
                        sampled_at = EXCLUDED.sampled_at,
                        source = EXCLUDED.source,
                        updated_at = NOW()
                    `,
                    [
                        this.chainId,
                        normalizedPair,
                        input.priceChangeBps,
                        input.volume5m.toString(),
                        input.uniqueTraders5m,
                        sampledAt.toISOString(),
                        input.source,
                    ]
                );
                count++;
            }
            await client.query("COMMIT");
            return count;
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    }

    async listMarketSignals(pairs?: string[], limit = 200): Promise<MarketSignalRecord[]> {
        if (pairs && pairs.length > 0) {
            const normalizedPairs = pairs.map((pair) => pair.toLowerCase());
            const result = await this.pool.query(
                `
                SELECT *
                FROM market_signals
                WHERE chain_id = $1 AND pair = ANY($2::text[])
                ORDER BY sampled_at DESC
                `,
                [this.chainId, normalizedPairs]
            );
            return result.rows.map((row) => mapMarketSignalRow(row as Record<string, unknown>));
        }

        const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
        const result = await this.pool.query(
            `
            SELECT *
            FROM market_signals
            WHERE chain_id = $1
            ORDER BY sampled_at DESC
            LIMIT $2
            `,
            [this.chainId, boundedLimit]
        );
        return result.rows.map((row) => mapMarketSignalRow(row as Record<string, unknown>));
    }

    async recordStrategySuccess(tokenId: bigint): Promise<void> {
        await this.pool.query(
            `
            UPDATE token_strategies
            SET
                last_run_at = NOW(),
                failure_count = 0,
                last_error = NULL,
                updated_at = NOW()
            WHERE chain_id = $1 AND token_id = $2
            `,
            [this.chainId, tokenId.toString()]
        );
    }

    async recordStrategyFailure(tokenId: bigint, error: string): Promise<StrategyConfigRecord | null> {
        const updated = await this.pool.query(
            `
            UPDATE token_strategies
            SET
                failure_count = failure_count + 1,
                last_error = $3,
                updated_at = NOW()
            WHERE chain_id = $1 AND token_id = $2
            RETURNING *
            `,
            [this.chainId, tokenId.toString(), error.slice(0, 500)]
        );
        if (updated.rows.length === 0) return null;
        const strategy = mapStrategyRow(updated.rows[0] as Record<string, unknown>);
        if (strategy.failureCount >= strategy.maxFailures && strategy.enabled) {
            const disabled = await this.pool.query(
                `
                UPDATE token_strategies
                SET
                    enabled = FALSE,
                    updated_at = NOW()
                WHERE chain_id = $1 AND token_id = $2
                RETURNING *
                `,
                [this.chainId, tokenId.toString()]
            );
            return mapStrategyRow(disabled.rows[0] as Record<string, unknown>);
        }
        return strategy;
    }

    async recordRun(input: Omit<RunRecord, "id" | "createdAt">): Promise<RunRecord> {
        const inserted = await this.pool.query(
            `
            INSERT INTO runs (
                chain_id,
                token_id,
                action_type,
                action_hash,
                simulate_ok,
                tx_hash,
                error,
                params_hash,
                strategy_explain,
                failure_category,
                brain_type,
                intent_type,
                decision_reason
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            RETURNING *
            `,
            [
                this.chainId,
                input.tokenId,
                input.actionType,
                input.actionHash,
                input.simulateOk,
                input.txHash ?? null,
                input.error ?? null,
                input.paramsHash ?? null,
                input.strategyExplain ?? null,
                input.failureCategory ?? null,
                input.brainType ?? null,
                input.intentType ?? null,
                input.decisionReason ?? null,
            ]
        );

        await this.pool.query(
            `
            DELETE FROM runs
            WHERE id IN (
                SELECT id
                FROM runs
                WHERE chain_id = $1
                ORDER BY created_at DESC
                OFFSET $2
            )
            `,
            [this.chainId, this.maxRunRecords]
        );

        return mapRunRow(inserted.rows[0] as Record<string, unknown>);
    }

    async listRuns(tokenId: bigint, limit: number): Promise<RunRecord[]> {
        const result = await this.pool.query(
            `
            SELECT *
            FROM runs
            WHERE chain_id = $1 AND token_id = $2
            ORDER BY created_at DESC
            LIMIT $3
            `,
            [this.chainId, tokenId.toString(), limit]
        );
        return result.rows.map((row) => mapRunRow(row as Record<string, unknown>));
    }

    // ── V2.1: Dashboard + Activity ─────────────────────────────────

    /**
     * Aggregated dashboard data for a single agent token.
     */
    async getDashboard(tokenId: bigint): Promise<{
        autopilot: AutopilotRecord | null;
        strategy: StrategyConfigRecord | null;
        stats: {
            totalRuns: number;
            successRuns: number;
            failedRuns: number;
            latestRunAt: string | null;
        };
        recentRuns: RunRecord[];
    }> {
        const [autopilot, strategy, statsResult, recentRuns] = await Promise.all([
            this.getAutopilot(tokenId),
            this.getStrategy(tokenId),
            this.pool.query(
                `
                SELECT
                    COUNT(*)::int AS total_runs,
                    COUNT(*) FILTER (WHERE tx_hash IS NOT NULL AND error IS NULL)::int AS success_runs,
                    COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS failed_runs,
                    MAX(created_at) AS latest_run_at
                FROM runs
                WHERE chain_id = $1 AND token_id = $2
                `,
                [this.chainId, tokenId.toString()]
            ),
            this.listRuns(tokenId, 10),
        ]);

        const statsRow = statsResult.rows[0] as Record<string, unknown> | undefined;

        return {
            autopilot,
            strategy,
            stats: {
                totalRuns: Number(statsRow?.total_runs ?? 0),
                successRuns: Number(statsRow?.success_runs ?? 0),
                failedRuns: Number(statsRow?.failed_runs ?? 0),
                latestRunAt:
                    statsRow?.latest_run_at != null
                        ? toIso(statsRow.latest_run_at as Date | string)
                        : null,
            },
            recentRuns,
        };
    }

    /**
     * Paginated activity log with optional brain/intent type filtering.
     */
    async getActivity(
        tokenId: bigint,
        options?: { limit?: number; offset?: number; brainType?: string }
    ): Promise<{ total: number; items: RunRecord[] }> {
        const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
        const offset = Math.max(0, options?.offset ?? 0);

        const whereParts = ["chain_id = $1", "token_id = $2"];
        const params: unknown[] = [this.chainId, tokenId.toString()];
        let paramIdx = 3;

        if (options?.brainType) {
            whereParts.push(`brain_type = $${paramIdx}`);
            params.push(options.brainType);
            paramIdx++;
        }

        const whereClause = whereParts.join(" AND ");

        const [countResult, itemsResult] = await Promise.all([
            this.pool.query(
                `SELECT COUNT(*)::int AS total FROM runs WHERE ${whereClause}`,
                params
            ),
            this.pool.query(
                `
                SELECT * FROM runs
                WHERE ${whereClause}
                ORDER BY created_at DESC
                LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
                `,
                [...params, limit, offset]
            ),
        ]);

        return {
            total: Number((countResult.rows[0] as Record<string, unknown>)?.total ?? 0),
            items: itemsResult.rows.map((row) => mapRunRow(row as Record<string, unknown>)),
        };
    }
}
