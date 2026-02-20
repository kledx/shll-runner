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
import { HotTokenBrain, type HotTokenBrainConfig } from "./brain/rule/hotToken.js";
import { LLMBrain } from "./brain/llm/agent.js";
import { createSwapAction } from "./actions/swap.js";
import { createApproveAction } from "./actions/approve.js";
import { createWrapAction } from "./actions/wrap.js";
import { createAnalyticsAction } from "./actions/analytics.js";
import { createPortfolioAction } from "./actions/portfolio.js";
import { createAllowanceAction } from "./actions/allowance.js";
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
    // Determine chain for correct token addresses
    const isMainnet = config.chainId === 56;

    const trackedTokens: DefiPerceptionConfig["trackedTokens"] = [
        {
            address: config.wbnbAddress,
            symbol: "WBNB",
            decimals: 18,
        },
        {
            address: (isMainnet
                ? "0x55d398326f99059fF775485246999027B3197955"
                : "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd") as Address,
            symbol: "USDT",
            decimals: 18,
        },
        {
            address: (isMainnet
                ? "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56"
                : "0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee") as Address,
            symbol: "BUSD",
            decimals: 18,
        },
        {
            address: (isMainnet
                ? "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
                : "0x64544969ed7EBf5f083679233325356EbE738930") as Address,
            symbol: "USDC",
            decimals: 18,
        },
    ];

    // Allow deployer to add extra tracked tokens via env:
    // EXTRA_TRACKED_TOKENS=0xAddr1:SYM1:18,0xAddr2:SYM2:8
    const extra = process.env.EXTRA_TRACKED_TOKENS;
    if (extra) {
        for (const entry of extra.split(",")) {
            const [addr, sym, dec] = entry.trim().split(":");
            if (addr && sym && dec) {
                trackedTokens.push({
                    address: addr as Address,
                    symbol: sym,
                    decimals: Number(dec),
                });
            }
        }
    }

    const perceptionConfig: DefiPerceptionConfig = {
        publicClient: config.publicClient,
        agentNfaAddress: config.agentNfaAddress,
        agentNfaAbi: config.agentNfaAbi,
        trackedTokens,
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

    // ── Brain: LLM-based (Vercel AI SDK) ────────────────
    registerBrain("llm", (ctx: BrainFactoryContext) => {
        const llmConfig = ctx.llmConfig;
        if (!llmConfig) {
            throw new Error("LLM brain requires llmConfig from blueprint");
        }

        // Merge user-defined trading goal from strategyParams into prompt
        let systemPrompt = llmConfig.systemPrompt;
        const sp = ctx.strategyParams ?? {};
        if (typeof sp.tradingGoal === "string" && sp.tradingGoal.trim()) {
            systemPrompt += `\n\n## User Trading Goal\n${sp.tradingGoal.trim()}`;
        }
        if (Array.isArray(sp.watchTokens) && sp.watchTokens.length > 0) {
            systemPrompt += `\n\n## Tokens to Watch\n${(sp.watchTokens as string[]).join(", ")}`;
        }

        // Env vars override blueprint defaults
        const mergedConfig = {
            ...llmConfig,
            systemPrompt,
            tradingGoal: typeof sp.tradingGoal === "string" ? sp.tradingGoal.trim() : undefined,
            provider: process.env.LLM_PROVIDER || llmConfig.provider,
            model: process.env.LLM_MODEL || llmConfig.model,
            apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || llmConfig.apiKey,
            maxStepsPerRun: Number(process.env.LLM_MAX_STEPS) || llmConfig.maxStepsPerRun || 3,
        };

        return new LLMBrain(mergedConfig);
    });

    // ── Actions ────────────────────────────────────────
    registerAction("swap", createSwapAction);
    registerAction("approve", createApproveAction);
    registerAction("wrap", () => createWrapAction(config.wbnbAddress));
    registerAction("analytics", createAnalyticsAction);
    registerAction("portfolio", createPortfolioAction);
    registerAction("allowance", createAllowanceAction);

    // ── Guardrails (Soft + Hard) ───────────────────────
    const hardPolicyConfig: HardPolicyConfig = {
        publicClient: config.publicClient,
        policyGuardV4Address: config.policyGuardV4Address,
        operatorAddress: config.operatorAddress,
        agentNfaAddress: config.agentNfaAddress,
        // vaultAddress is ignored by validate() (param marked /* agentAccount */)
        // ReceiverGuardPolicy reads vault from its own agentNFA.accountOf() storage
        vaultAddress: "0x0000000000000000000000000000000000000000",
    };

    registerGuardrails((tokenId) => {
        const soft = new SoftPolicyEngine(tokenId, config.pool, config.chainId);
        const hard = new HardPolicyGuard(tokenId, hardPolicyConfig);
        return new CombinedGuardrails(soft, hard);
    });
}
