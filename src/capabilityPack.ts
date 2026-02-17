/**
 * @deprecated V2.1 — Capability Packs are deprecated for the autonomous agent model.
 * New strategies (e.g. DCA) should be configured via /strategy/upsert API directly.
 * This module is retained for backward compatibility with existing packs.
 * Future evolution: V2.3 Agent Templates.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { StrategyType } from "./types.js";

const bigintLike = z.union([z.string(), z.number(), z.bigint()]);
const strategyTypeSchema = z.enum([
    "fixed_action",
    "wrap_native",
    "hotpump_watchlist",
    "composite",
    "llm_trader",
    "manual_swap",
    "dca",
]);
const llmProfileSchema = z
    .object({
        model: z.string().optional(),
        maxTokens: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional(),
        systemPromptOverride: z.string().optional(),
    })
    .optional();

const legacyEntrySchema = z.object({
    tokenId: bigintLike,
    strategyType: strategyTypeSchema.default("fixed_action"),
    target: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    data: z.string().regex(/^0x[0-9a-fA-F]*$/).optional(),
    value: bigintLike.optional(),
    strategyParams: z.record(z.string(), z.unknown()).optional(),
    minIntervalMs: z.number().int().positive().max(86_400_000).optional(),
    requirePositiveBalance: z.boolean().optional(),
    maxFailures: z.number().int().positive().max(1000).optional(),
    enabled: z.boolean().optional(),
});

const legacyPackSchema = z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    strategyId: z.string().optional(),
    llmProfile: llmProfileSchema,
    toolAllowList: z.array(z.string()).optional(),
    strategies: z.array(legacyEntrySchema),
});

const manifestRunnerSchema = z
    .object({
        mode: z.enum(["manual", "managed", "external"]).optional(),
        strategyId: z.string().optional(),
        strategyType: strategyTypeSchema.optional(),
        tickSec: z.number().int().positive().optional(),
        dataSource: z.record(z.string(), z.unknown()).optional(),
        paramsSchema: z.record(z.string(), z.unknown()).optional(),
        defaults: z.record(z.string(), z.unknown()).optional(),
        externalRunner: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough();

const manifestNetworkSchema = z
    .object({
        chainId: z.number().int().positive(),
        name: z.string().optional(),
        contracts: z.record(z.string(), z.string()).optional(),
    })
    .passthrough();

const manifestPackSchema = z
    .object({
        schemaVersion: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        version: z.string().optional(),
        description: z.string().optional(),
        strategyId: z.string().optional(),
        llmProfile: llmProfileSchema,
        toolAllowList: z.array(z.string()).optional(),
        runner: manifestRunnerSchema.optional(),
        networks: z.array(manifestNetworkSchema).optional(),
    })
    .passthrough();

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

export interface LegacyCapabilityPack {
    kind: "strategy_pack";
    name?: string;
    version?: string;
    strategyId?: string;
    llmProfile?: {
        model?: string;
        maxTokens?: number;
        timeoutMs?: number;
        systemPromptOverride?: string;
    };
    toolAllowList?: string[];
    strategies: NormalizedPackStrategy[];
    raw: Record<string, unknown>;
}

export interface ManifestRunnerConfig {
    mode?: "manual" | "managed" | "external";
    strategyId?: string;
    strategyType?: StrategyType;
    tickSec?: number;
    dataSource?: Record<string, unknown>;
    paramsSchema?: Record<string, unknown>;
    defaults?: Record<string, unknown>;
    externalRunner?: Record<string, unknown>;
}

export interface ManifestCapabilityPack {
    kind: "manifest_pack";
    schemaVersion?: string;
    id?: string;
    name?: string;
    version?: string;
    description?: string;
    strategyId?: string;
    llmProfile?: {
        model?: string;
        maxTokens?: number;
        timeoutMs?: number;
        systemPromptOverride?: string;
    };
    toolAllowList?: string[];
    runner?: ManifestRunnerConfig;
    networks?: Array<{
        chainId: number;
        name?: string;
        contracts?: Record<string, string>;
    }>;
    raw: Record<string, unknown>;
}

export type CapabilityPack = LegacyCapabilityPack | ManifestCapabilityPack;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLegacyPack(raw: unknown): LegacyCapabilityPack {
    const parsed = legacyPackSchema.parse(raw);
    const record = raw as Record<string, unknown>;
    return {
        kind: "strategy_pack",
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
        raw: record,
    };
}

function parseManifestPack(raw: unknown): ManifestCapabilityPack {
    const parsed = manifestPackSchema.parse(raw);
    const record = raw as Record<string, unknown>;
    return {
        kind: "manifest_pack",
        schemaVersion: parsed.schemaVersion,
        id: parsed.id,
        name: parsed.name,
        version: parsed.version,
        description: parsed.description,
        strategyId: parsed.strategyId,
        llmProfile: parsed.llmProfile ?? undefined,
        toolAllowList: parsed.toolAllowList,
        runner: parsed.runner
            ? {
                mode: parsed.runner.mode,
                strategyId: parsed.runner.strategyId,
                strategyType: parsed.runner.strategyType,
                tickSec: parsed.runner.tickSec,
                dataSource: parsed.runner.dataSource,
                paramsSchema: parsed.runner.paramsSchema,
                defaults: parsed.runner.defaults,
                externalRunner: parsed.runner.externalRunner,
            }
            : undefined,
        networks: parsed.networks?.map((network) => ({
            chainId: network.chainId,
            name: network.name,
            contracts: network.contracts,
        })),
        raw: record,
    };
}

export function parseCapabilityPack(raw: unknown): CapabilityPack {
    if (!isRecord(raw)) {
        throw new Error("Capability pack must be a JSON object");
    }

    if (Array.isArray(raw.strategies)) {
        return parseLegacyPack(raw);
    }

    const parsedManifest = parseManifestPack(raw);
    if (!parsedManifest.runner && !parsedManifest.schemaVersion) {
        throw new Error(
            "Capability pack format not recognized: expected legacy strategies[] or manifest runner/schemaVersion"
        );
    }
    return parsedManifest;
}

export async function loadCapabilityPackFromFile(filePath: string): Promise<CapabilityPack> {
    const rawText = await readFile(filePath, "utf8");
    const raw = JSON.parse(rawText) as unknown;
    return parseCapabilityPack(raw);
}
