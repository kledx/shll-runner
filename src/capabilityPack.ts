import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { StrategyType } from "./types.js";

const bigintLike = z.union([z.string(), z.number(), z.bigint()]);

const entrySchema = z.object({
    tokenId: bigintLike,
    strategyType: z
        .enum(["fixed_action", "wrap_native", "hotpump_watchlist", "composite", "llm_trader", "manual_swap"])
        .default("fixed_action"),
    target: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    data: z.string().regex(/^0x[0-9a-fA-F]*$/).optional(),
    value: bigintLike.optional(),
    strategyParams: z.record(z.string(), z.unknown()).optional(),
    minIntervalMs: z.number().int().positive().max(86_400_000).optional(),
    requirePositiveBalance: z.boolean().optional(),
    maxFailures: z.number().int().positive().max(1000).optional(),
    enabled: z.boolean().optional(),
});

const llmProfileSchema = z.object({
    model: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    systemPromptOverride: z.string().optional(),
}).optional();

const packSchema = z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    // V1.4: optional metadata
    strategyId: z.string().optional(),
    llmProfile: llmProfileSchema,
    toolAllowList: z.array(z.string()).optional(),
    strategies: z.array(entrySchema),
});

export interface NormalizedPackStrategy {
    tokenId: bigint;
    strategyType: StrategyType;
    target: string;
    data: `0x${string}`;
    value: bigint;
    strategyParams: Record<string, unknown>;
    minIntervalMs?: number;
    requirePositiveBalance?: boolean;
    maxFailures?: number;
    enabled?: boolean;
}

export interface CapabilityPack {
    name?: string;
    version?: string;
    /** V1.4: strategy identifier for routing */
    strategyId?: string;
    /** V1.4: LLM configuration overrides */
    llmProfile?: {
        model?: string;
        maxTokens?: number;
        timeoutMs?: number;
        systemPromptOverride?: string;
    };
    /** V1.4: explicit tool allowlist for LLM strategies */
    toolAllowList?: string[];
    strategies: NormalizedPackStrategy[];
}

export function parseCapabilityPack(raw: unknown): CapabilityPack {
    const parsed = packSchema.parse(raw);
    return {
        name: parsed.name,
        version: parsed.version,
        strategyId: parsed.strategyId,
        llmProfile: parsed.llmProfile ?? undefined,
        toolAllowList: parsed.toolAllowList,
        strategies: parsed.strategies.map((entry) => ({
            tokenId: BigInt(entry.tokenId),
            strategyType: entry.strategyType,
            target: entry.target,
            data: (entry.data ?? "0x") as `0x${string}`,
            value: BigInt(entry.value ?? 0),
            strategyParams: entry.strategyParams ?? {},
            minIntervalMs: entry.minIntervalMs,
            requirePositiveBalance: entry.requirePositiveBalance,
            maxFailures: entry.maxFailures,
            enabled: entry.enabled,
        })),
    };
}

export async function loadCapabilityPackFromFile(filePath: string): Promise<CapabilityPack> {
    const rawText = await readFile(filePath, "utf8");
    const raw = JSON.parse(rawText) as unknown;
    return parseCapabilityPack(raw);
}
