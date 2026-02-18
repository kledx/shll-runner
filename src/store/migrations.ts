/**
 * V3.0 Database Migrations
 *
 * Adds three new tables for the Agent Runtime:
 *   1. user_safety_configs — per-agent safety policy configuration
 *   2. agent_memory — Agent cognitive loop history
 *   3. agent_blueprints — No-code agent composition templates
 *
 * Also adds agent_type column to existing token_strategies table.
 *
 * Migration style: idempotent (IF NOT EXISTS / IF NOT EXISTS)
 * to match existing store.ts pattern.
 */

import type { Pool } from "pg";

export async function runV30Migrations(pool: Pool): Promise<void> {
    // ── 1. User Safety Configs ─────────────────────────
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_safety_configs (
            token_id     TEXT NOT NULL,
            chain_id     INTEGER NOT NULL,
            allowed_tokens   JSONB DEFAULT '[]',
            blocked_tokens   JSONB DEFAULT '[]',
            max_trade_amount TEXT DEFAULT '0',
            max_daily_amount TEXT DEFAULT '0',
            max_slippage_bps INTEGER DEFAULT 0,
            cooldown_seconds INTEGER DEFAULT 0,
            max_runs_per_day INTEGER DEFAULT 0,
            allowed_dexes    JSONB DEFAULT '[]',
            created_at   TIMESTAMPTZ DEFAULT NOW(),
            updated_at   TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (token_id, chain_id)
        )
    `);

    // ── 2. Agent Memory ────────────────────────────────
    await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_memory (
            id           SERIAL PRIMARY KEY,
            token_id     TEXT NOT NULL,
            type         VARCHAR(32) NOT NULL,
            action       VARCHAR(64),
            params       JSONB,
            result       JSONB,
            reasoning    TEXT,
            timestamp    TIMESTAMPTZ NOT NULL,
            created_at   TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_agent_memory_token
        ON agent_memory(token_id, timestamp DESC)
    `);

    // ── 3. Agent Blueprints ────────────────────────────
    await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_blueprints (
            agent_type   VARCHAR(64) PRIMARY KEY,
            brain_type   VARCHAR(32) NOT NULL,
            actions      JSONB NOT NULL,
            perception   VARCHAR(32) DEFAULT 'defi',
            llm_config   JSONB,
            created_by   TEXT,
            created_at   TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    // ── 4. Extend token_strategies ─────────────────────
    await pool.query(`
        ALTER TABLE token_strategies
        ADD COLUMN IF NOT EXISTS agent_type VARCHAR(32)
    `);

    // Backfill agent_type from strategy_type for existing records
    await pool.query(`
        UPDATE token_strategies
        SET agent_type = strategy_type
        WHERE agent_type IS NULL
    `);

    // ── 5. Seed built-in blueprints ────────────────────
    const builtinBlueprints = [
        {
            agent_type: "dca",
            brain_type: "rule:dca",
            actions: ["swap", "approve"],
            perception: "defi",
        },
        {
            agent_type: "hot_token",
            brain_type: "rule:hotToken",
            actions: ["swap", "approve", "analytics"],
            perception: "defi",
        },
        {
            agent_type: "llm_trader",
            brain_type: "llm",
            actions: ["swap", "approve", "analytics", "portfolio"],
            perception: "defi",
            llm_config: {
                systemPrompt: "You are a DeFi trading agent. Analyze market data and vault positions to make profitable trades. Be conservative and prioritize capital preservation.",
                provider: "openai",
                model: "gpt-4o-mini",
                maxStepsPerRun: 3,
            },
        },
        {
            agent_type: "llm_defi",
            brain_type: "llm",
            actions: ["swap", "approve", "analytics", "portfolio"],
            perception: "defi",
            llm_config: {
                systemPrompt: "You are an advanced DeFi agent capable of multi-step strategies. Analyze positions, market trends, and optimize yield across protocols.",
                provider: "deepseek",
                model: "deepseek-chat",
                maxStepsPerRun: 5,
            },
        },
    ];

    for (const bp of builtinBlueprints) {
        await pool.query(
            `INSERT INTO agent_blueprints (agent_type, brain_type, actions, perception, llm_config, created_by)
             VALUES ($1, $2, $3, $4, $5, NULL)
             ON CONFLICT (agent_type) DO NOTHING`,
            [
                bp.agent_type,
                bp.brain_type,
                JSON.stringify(bp.actions),
                bp.perception,
                bp.llm_config ? JSON.stringify(bp.llm_config) : null,
            ],
        );
    }
}
