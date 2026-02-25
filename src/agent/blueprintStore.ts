/**
 * BlueprintStore — In-memory cache of agent blueprints loaded from DB.
 *
 * Startup: loadFromDb() hydrates cache from agent_blueprints table.
 * Runtime: Admin API mutations trigger reload() for hot-update.
 * Fallback: hardcoded BUILTIN_BLUEPRINTS if DB entry not found.
 */

import type { Pool } from "pg";
import type { AgentBlueprint, LLMConfig } from "./agent.js";

// ═══════════════════════════════════════════════════════
//                  Built-in Fallbacks
// ═══════════════════════════════════════════════════════

/** Hardcoded blueprints — always available even if DB is empty/down */
const BUILTIN_BLUEPRINTS: Record<string, AgentBlueprint> = {
    hot_token: {
        brain: "rule:hotToken",
        actions: ["swap", "approve", "analytics"],
        perception: "defi",
    },
    llm_trader: {
        brain: "llm",
        actions: ["swap", "approve", "wrap", "analytics", "portfolio", "allowance", "get_swap_quote", "get_token_info", "transfer"],
        perception: "defi",
        llmConfig: {
            systemPrompt: "You are a DeFi trading agent. Analyze market data and vault positions to make profitable trades. Be conservative and prioritize capital preservation.",
            provider: "openai",
            model: "gpt-4o-mini",
            maxStepsPerRun: 5,
        },
    },
    llm_defi: {
        brain: "llm",
        actions: ["swap", "approve", "wrap", "analytics", "portfolio", "allowance", "get_swap_quote", "get_token_info", "transfer"],
        perception: "defi",
        llmConfig: {
            systemPrompt: "You are an advanced DeFi agent capable of multi-step strategies. Analyze positions, market trends, and optimize yield across protocols.",
            provider: "deepseek",
            model: "deepseek-chat",
            maxStepsPerRun: 5,
        },
    },
};

// ═══════════════════════════════════════════════════════
//                  BlueprintStore
// ═══════════════════════════════════════════════════════

export class BlueprintStore {
    private cache = new Map<string, AgentBlueprint>();
    private pool: Pool | null = null;
    private lastLoadAt = 0;

    /** Initialize with DB pool and load blueprints */
    async init(pool: Pool): Promise<void> {
        this.pool = pool;
        await this.reload();
    }

    /** Reload all blueprints from DB into cache */
    async reload(): Promise<number> {
        if (!this.pool) return 0;

        try {
            const result = await this.pool.query(
                `SELECT agent_type, brain_type, actions, perception, llm_config
                 FROM agent_blueprints
                 ORDER BY created_at ASC`,
            );

            this.cache.clear();
            for (const row of result.rows) {
                this.cache.set(
                    String(row.agent_type),
                    mapRowToBlueprint(row),
                );
            }

            this.lastLoadAt = Date.now();
            return this.cache.size;
        } catch (err) {
            // DB error: keep existing cache, log but don't crash
            console.error("[BlueprintStore] Failed to reload from DB:", err instanceof Error ? err.message : err);
            return this.cache.size;
        }
    }

    /**
     * Get a blueprint by agentType.
     * Priority: DB cache → hardcoded fallback → undefined
     */
    get(agentType: string): AgentBlueprint | undefined {
        return this.cache.get(agentType) ?? BUILTIN_BLUEPRINTS[agentType];
    }

    /** List all available agent types (DB + hardcoded, deduplicated) */
    listTypes(): string[] {
        const types = new Set<string>([
            ...this.cache.keys(),
            ...Object.keys(BUILTIN_BLUEPRINTS),
        ]);
        return [...types];
    }

    /** Check if a blueprint exists */
    has(agentType: string): boolean {
        return this.cache.has(agentType) || agentType in BUILTIN_BLUEPRINTS;
    }

    /** Get cache stats for diagnostics */
    stats(): { dbCount: number; builtinCount: number; lastLoadAt: number } {
        return {
            dbCount: this.cache.size,
            builtinCount: Object.keys(BUILTIN_BLUEPRINTS).length,
            lastLoadAt: this.lastLoadAt,
        };
    }
}

// ═══════════════════════════════════════════════════════
//                  Row Mapper
// ═══════════════════════════════════════════════════════

function mapRowToBlueprint(row: Record<string, unknown>): AgentBlueprint {
    const llmConfig = row.llm_config as Record<string, unknown> | null;

    return {
        brain: String(row.brain_type),
        actions: (row.actions ?? []) as string[],
        perception: String(row.perception ?? "defi"),
        llmConfig: llmConfig
            ? {
                systemPrompt: String(llmConfig.systemPrompt ?? ""),
                provider: String(llmConfig.provider ?? "openai"),
                model: String(llmConfig.model ?? "gpt-4o-mini"),
                maxStepsPerRun: Number(llmConfig.maxStepsPerRun ?? 5),
                endpoint: llmConfig.endpoint ? String(llmConfig.endpoint) : undefined,
                fallbackProvider: llmConfig.fallbackProvider ? String(llmConfig.fallbackProvider) : undefined,
                fallbackModel: llmConfig.fallbackModel ? String(llmConfig.fallbackModel) : undefined,
            } as LLMConfig
            : undefined,
    };
}

// Singleton instance
export const blueprintStore = new BlueprintStore();
