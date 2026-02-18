/**
 * Agent Module Bootstrap — Registers all modules with the Agent Factory.
 *
 * Called once at startup to populate the module registries.
 * This is the single entry point where all concrete implementations
 * are wired to their interface slots.
 */

import type { Address, PublicClient } from "viem";
import type { Pool } from "pg";
import {
    registerPerception,
    registerBrain,
    registerAction,
    registerGuardrails,
    registerMemory,
    type BrainFactoryContext,
} from "./agent/factory.js";
import { DefiPerception, type DefiPerceptionConfig } from "./perception/defi.js";
import { PgMemory } from "./memory/pg.js";
import { DCABrain, type DCABrainConfig } from "./brain/rule/dca.js";
import { HotTokenBrain, type HotTokenBrainConfig } from "./brain/rule/hotToken.js";
import { LLMBrain } from "./brain/llm/agent.js";
import { createLLMProvider } from "./brain/llm/provider.js";
import { createSwapAction } from "./actions/swap.js";
import { createApproveAction } from "./actions/approve.js";
import { createWrapAction } from "./actions/wrap.js";
import { createAnalyticsAction } from "./actions/analytics.js";
import { createPortfolioAction } from "./actions/portfolio.js";
import { SoftPolicyEngine } from "./guardrails/softPolicy.js";
import { HardPolicyGuard, CombinedGuardrails, type HardPolicyConfig } from "./guardrails/hardPolicy.js";

// ═══════════════════════════════════════════════════════
//                  Bootstrap Config
// ═══════════════════════════════════════════════════════

export interface BootstrapConfig {
    pool: Pool;
    publicClient: PublicClient;
    chainId: number;
    agentNfaAddress: Address;
    agentNfaAbi: readonly unknown[];
    policyGuardV4Address: Address;
    operatorAddress: Address;
    wbnbAddress: Address;
}

// ═══════════════════════════════════════════════════════
//                   Bootstrap
// ═══════════════════════════════════════════════════════

export function bootstrapAgentModules(config: BootstrapConfig): void {
    const perceptionConfig: DefiPerceptionConfig = {
        publicClient: config.publicClient,
        agentNfaAddress: config.agentNfaAddress,
        agentNfaAbi: config.agentNfaAbi,
    };

    // ── Perception ─────────────────────────────────────
    registerPerception("defi", (vault, tokenId) =>
        new DefiPerception(vault, tokenId, perceptionConfig),
    );

    // ── Memory ─────────────────────────────────────────
    registerMemory((tokenId) =>
        new PgMemory(tokenId, config.pool),
    );

    // ── Brain: Rule-based ──────────────────────────────
    // Rule brains use per-agent strategyParams from the DB
    // (passed through ChainAgentData.strategyParams → BrainFactoryContext)
    registerBrain("rule:dca", (ctx: BrainFactoryContext) => {
        const sp = ctx.strategyParams ?? {};
        const dcaConfig: DCABrainConfig = {
            tokenToBuy: sp.tokenToBuy as string ?? "",
            tokenToSpend: sp.tokenToSpend as string ?? "",
            amountPerExecution: sp.amountPerExecution as string ?? "0",
            slippageBps: sp.slippageBps as number ?? 100,
            routerAddress: sp.routerAddress as string ?? "",
        };
        return new DCABrain(dcaConfig);
    });

    registerBrain("rule:hotToken", (ctx: BrainFactoryContext) => {
        const sp = ctx.strategyParams ?? {};
        const htConfig: HotTokenBrainConfig = {
            watchlistPairs: (sp.watchlistPairs as string[]) ?? [],
            minPriceChangeBps: (sp.minPriceChangeBps as number) ?? 500,
            minVolume5m: BigInt((sp.minVolume5m as string) ?? "0"),
            routerAddress: (sp.routerAddress as string) ?? "",
            amountPerTrade: (sp.amountPerTrade as string) ?? "0",
            maxSignalAgeMs: (sp.maxSignalAgeMs as number) ?? 300_000,
        };
        return new HotTokenBrain(htConfig);
    });

    // ── Brain: LLM-based ───────────────────────────────
    registerBrain("llm", (ctx: BrainFactoryContext) => {
        const llmConfig = ctx.llmConfig;
        if (!llmConfig) {
            throw new Error("LLM brain requires llmConfig from blueprint");
        }

        // Env vars override blueprint defaults — allows any OpenAI-compatible provider
        const provider = process.env.LLM_PROVIDER || llmConfig.provider;
        const model = process.env.LLM_MODEL || llmConfig.model;
        const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || llmConfig.apiKey || "";
        const endpoint = process.env.LLM_BASE_URL || llmConfig.endpoint; // undefined → use PROVIDER_ENDPOINTS lookup

        // Merge user-defined trading goal from strategyParams into prompt
        let systemPrompt = llmConfig.systemPrompt;
        const sp = ctx.strategyParams ?? {};
        if (typeof sp.tradingGoal === "string" && sp.tradingGoal.trim()) {
            systemPrompt += `\n\n## User Trading Goal\n${sp.tradingGoal.trim()}`;
        }
        if (Array.isArray(sp.watchTokens) && sp.watchTokens.length > 0) {
            systemPrompt += `\n\n## Tokens to Watch\n${(sp.watchTokens as string[]).join(", ")}`;
        }

        const mergedConfig = { ...llmConfig, systemPrompt };
        const llmProvider = createLLMProvider(
            provider,
            apiKey,
            model,
            {
                endpoint,
                maxTokens: Number(process.env.LLM_MAX_TOKENS) || llmConfig.maxStepsPerRun || 2048,
                timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 30_000,
            },
        );
        return new LLMBrain(mergedConfig, llmProvider);
    });

    // ── Actions ────────────────────────────────────────
    registerAction("swap", createSwapAction);
    registerAction("approve", createApproveAction);
    registerAction("wrap", () => createWrapAction(config.wbnbAddress));
    registerAction("analytics", createAnalyticsAction);
    registerAction("portfolio", createPortfolioAction);

    // ── Guardrails (Soft + Hard) ───────────────────────
    const hardPolicyConfig: HardPolicyConfig = {
        publicClient: config.publicClient,
        policyGuardV4Address: config.policyGuardV4Address,
        operatorAddress: config.operatorAddress,
    };

    registerGuardrails((tokenId) => {
        const soft = new SoftPolicyEngine(tokenId, config.pool, config.chainId);
        const hard = new HardPolicyGuard(tokenId, hardPolicyConfig);
        return new CombinedGuardrails(soft, hard);
    });
}
