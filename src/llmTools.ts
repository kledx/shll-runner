/**
 * LLM Tool definitions for the llm_trader strategy (V1.4.1 §5)
 *
 * These tools are exposed to the LLM during its reasoning loop.
 * Each tool has strict input/output schemas and rate limiting.
 * Tools operate with read-only access to market data and on-chain state.
 */

import type { Address } from "viem";
import type { InstanceConfigData, MarketSignalRecord } from "./types.js";

// ── Tool Definitions (for LLM function-calling) ───────────────────

export interface LLMToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface LLMToolResult {
    success: boolean;
    data?: unknown;
    error?: string;
}

export type ToolExecutor = (args: Record<string, unknown>) => Promise<LLMToolResult>;

// ── Tool Context (injected at resolve time) ────────────────────────

export interface LLMToolContext {
    tokenId: bigint;
    agentAccount: Address;
    instanceConfig?: InstanceConfigData;
    marketSignals: Map<string, MarketSignalRecord>;
    chainId: number;
}

// ── Tool Implementations ───────────────────────────────────────────

function buildGetMarketSignal(ctx: LLMToolContext): ToolExecutor {
    return async (args) => {
        const pair = String(args.pair ?? "").toLowerCase();
        if (!pair) return { success: false, error: "pair is required" };

        const signal = ctx.marketSignals.get(pair);
        if (!signal) {
            return {
                success: true,
                data: { found: false, pair },
            };
        }
        return {
            success: true,
            data: {
                found: true,
                pair: signal.pair,
                priceChangeBps: signal.priceChangeBps,
                volume5m: signal.volume5m,
                uniqueTraders5m: signal.uniqueTraders5m,
                sampledAt: signal.sampledAt,
                source: signal.source,
            },
        };
    };
}

function buildListMarketSignals(ctx: LLMToolContext): ToolExecutor {
    return async (_args) => {
        const signals: Array<{
            pair: string;
            priceChangeBps: number;
            volume5m: string;
            uniqueTraders5m: number;
        }> = [];
        for (const [, signal] of ctx.marketSignals) {
            signals.push({
                pair: signal.pair,
                priceChangeBps: signal.priceChangeBps,
                volume5m: signal.volume5m,
                uniqueTraders5m: signal.uniqueTraders5m,
            });
        }
        // Sort by absolute price change descending
        signals.sort((a, b) => Math.abs(b.priceChangeBps) - Math.abs(a.priceChangeBps));
        return {
            success: true,
            data: { count: signals.length, signals: signals.slice(0, 20) },
        };
    };
}

function buildGetInstanceContext(ctx: LLMToolContext): ToolExecutor {
    return async (_args) => {
        if (!ctx.instanceConfig) {
            return {
                success: true,
                data: {
                    configured: false,
                    tokenId: ctx.tokenId.toString(),
                    agentAccount: ctx.agentAccount,
                },
            };
        }
        return {
            success: true,
            data: {
                configured: true,
                tokenId: ctx.tokenId.toString(),
                agentAccount: ctx.agentAccount,
                chainId: ctx.chainId,
                policyId: ctx.instanceConfig.policyId,
                version: ctx.instanceConfig.version,
                slippageBps: ctx.instanceConfig.slippageBps,
                tradeLimit: ctx.instanceConfig.tradeLimit.toString(),
                dailyLimit: ctx.instanceConfig.dailyLimit.toString(),
                tokenGroupId: ctx.instanceConfig.tokenGroupId,
                dexGroupId: ctx.instanceConfig.dexGroupId,
                riskTier: ctx.instanceConfig.riskTier,
            },
        };
    };
}

// ── Tool Registry ──────────────────────────────────────────────────

export const TOOL_DEFINITIONS: LLMToolDefinition[] = [
    {
        name: "getMarketSignal",
        description: "Get the latest market signal for a specific trading pair address. Returns price change, volume, and trader count.",
        parameters: {
            type: "object",
            properties: {
                pair: { type: "string", description: "The token pair address (0x...)" },
            },
            required: ["pair"],
        },
    },
    {
        name: "listMarketSignals",
        description: "List all available market signals, sorted by price change magnitude. Returns up to 20 signals.",
        parameters: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "getInstanceContext",
        description: "Get the on-chain instance configuration for the current agent, including policy parameters, trade limits, and risk tier.",
        parameters: {
            type: "object",
            properties: {},
        },
    },
];

/**
 * Default tool allowlist — strategies can restrict further via strategyParams.toolAllowList
 */
export const DEFAULT_TOOL_ALLOWLIST = ["getMarketSignal", "listMarketSignals", "getInstanceContext"];

/**
 * Build tool executors for a given context.
 */
export function buildToolExecutors(
    ctx: LLMToolContext,
    allowList?: string[]
): Map<string, ToolExecutor> {
    const allowed = new Set(allowList ?? DEFAULT_TOOL_ALLOWLIST);
    const executors = new Map<string, ToolExecutor>();

    if (allowed.has("getMarketSignal")) {
        executors.set("getMarketSignal", buildGetMarketSignal(ctx));
    }
    if (allowed.has("listMarketSignals")) {
        executors.set("listMarketSignals", buildListMarketSignals(ctx));
    }
    if (allowed.has("getInstanceContext")) {
        executors.set("getInstanceContext", buildGetInstanceContext(ctx));
    }

    return executors;
}

/**
 * Convert tool definitions to the format expected by Gemini / OpenAI function calling.
 */
export function getToolDefinitionsForLLM(allowList?: string[]): LLMToolDefinition[] {
    const allowed = new Set(allowList ?? DEFAULT_TOOL_ALLOWLIST);
    return TOOL_DEFINITIONS.filter((t) => allowed.has(t.name));
}
