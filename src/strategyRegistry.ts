import type { Address, Hex } from "viem";
import type {
    ActionPayload,
    CompositeChildStrategy,
    MarketSignalRecord,
    Observation,
    StrategyConfigRecord,
    StrategyType,
} from "./types.js";
import { resolveLlmTrader, type LLMTraderConfig } from "./strategies/llmTrader.js";
import { resolveDCA } from "./strategies/dca.js";

export interface StrategyResolution {
    action?: ActionPayload;
    reason: string;
    /** V1.4: LLM explanation text */
    explain?: string;
}

type StrategyHandler = (
    strategy: StrategyConfigRecord,
    obs: Observation,
    context: StrategyRuntimeContext
) => Promise<StrategyResolution>;

const WRAP_NATIVE_SELECTOR = "0xd0e30db0";
const DEFAULT_SIGNAL_MAX_AGE_MS = 5 * 60_000;

export interface StrategyRuntimeContext {
    nowMs: number;
    marketSignals: Map<string, MarketSignalRecord>;
    /** V1.4: LLM configuration (injected from config) */
    llmConfig?: LLMTraderConfig;
    chainId?: number;
}

function parseWatchlistPairs(strategy: StrategyConfigRecord): string[] {
    const raw = strategy.strategyParams.watchlistPairs;
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(
            (v): v is string =>
                typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v.trim())
        )
        .map((v) => v.toLowerCase());
}

function parseIntParam(
    params: Record<string, unknown>,
    key: string,
    fallback: number
): number {
    const raw = params[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
    if (typeof raw === "string" && raw.trim()) {
        const parsed = Number.parseInt(raw.trim(), 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function parseBigIntParam(
    params: Record<string, unknown>,
    key: string,
    fallback: bigint
): bigint {
    const raw = params[key];
    try {
        if (typeof raw === "bigint") return raw;
        if (typeof raw === "number" && Number.isFinite(raw)) return BigInt(Math.floor(raw));
        if (typeof raw === "string" && raw.trim()) return BigInt(raw.trim());
    } catch {
        // fall through
    }
    return fallback;
}

const handlers: Record<StrategyType, StrategyHandler> = {
    fixed_action: async (strategy) => {
        return {
            reason: "fixed_action ready",
            action: {
                target: strategy.target as Address,
                value: BigInt(strategy.value),
                data: strategy.data,
            },
        };
    },
    wrap_native: async (strategy) => {
        const value = BigInt(strategy.value);
        if (value <= 0n) {
            return {
                reason: "wrap_native requires value > 0",
            };
        }
        return {
            reason: "wrap_native ready",
            action: {
                target: strategy.target as Address,
                value,
                data: WRAP_NATIVE_SELECTOR,
            },
        };
    },
    hotpump_watchlist: async (strategy, _obs, context) => {
        const watchlistPairs = parseWatchlistPairs(strategy);
        if (watchlistPairs.length === 0) {
            return { reason: "hotpump_watchlist requires strategyParams.watchlistPairs" };
        }

        const params = strategy.strategyParams ?? {};
        const pumpThresholdBps = parseIntParam(params, "pumpThresholdBps", 0);
        const uniqueTradersMin = parseIntParam(params, "uniqueTradersMin", 0);
        const minVolume5m = parseBigIntParam(params, "minVolume5m", 0n);
        const signalMaxAgeMs = parseIntParam(
            params,
            "signalMaxAgeMs",
            DEFAULT_SIGNAL_MAX_AGE_MS
        );
        const nowMs = context.nowMs;

        let matched: MarketSignalRecord | null = null;
        for (const pair of watchlistPairs) {
            const signal = context.marketSignals.get(pair);
            if (!signal) continue;

            const signalAgeMs = nowMs - new Date(signal.sampledAt).getTime();
            if (signalAgeMs > signalMaxAgeMs) continue;
            if (signal.priceChangeBps < pumpThresholdBps) continue;
            if (signal.uniqueTraders5m < uniqueTradersMin) continue;
            if (BigInt(signal.volume5m) < minVolume5m) continue;

            if (!matched || signal.priceChangeBps > matched.priceChangeBps) {
                matched = signal;
            }
        }

        if (!matched) {
            return {
                reason: `hotpump_watchlist no signal matched (${watchlistPairs.length} pairs)`,
            };
        }

        return {
            reason: `hotpump_watchlist matched ${matched.pair} (pump=${matched.priceChangeBps}bps, traders=${matched.uniqueTraders5m})`,
            action: {
                target: strategy.target as Address,
                value: BigInt(strategy.value),
                data: strategy.data,
            },
        };
    },
    composite: async (strategy, obs, context) => {
        const params = strategy.strategyParams ?? {};
        const mode: string = (params.mode as string) ?? "first_match";
        const children = params.children;
        if (!Array.isArray(children) || children.length === 0) {
            return { reason: "composite requires strategyParams.children array" };
        }

        const MAX_CHILDREN = 10;
        const safeChildren = children.slice(0, MAX_CHILDREN) as CompositeChildStrategy[];
        const results: { index: number; resolution: StrategyResolution }[] = [];

        for (let i = 0; i < safeChildren.length; i++) {
            const child = safeChildren[i];
            if (!child.strategyType || child.strategyType === "composite" as StrategyType) {
                continue; // prevent nesting composite inside composite
            }
            const childHandler = handlers[child.strategyType];
            if (!childHandler) continue;

            // Build a synthetic StrategyConfigRecord from the child definition
            const childRecord: StrategyConfigRecord = {
                ...strategy,
                strategyType: child.strategyType,
                target: child.target || strategy.target,
                data: (child.data || strategy.data) as Hex,
                value: child.value ?? strategy.value,
                strategyParams: child.strategyParams ?? {},
            };

            const resolution = await childHandler(childRecord, obs, context);
            if (resolution.action) {
                if (mode === "first_match") {
                    return {
                        reason: `composite[${i}/${child.strategyType}]: ${resolution.reason}`,
                        action: resolution.action,
                    };
                }
                results.push({ index: i, resolution });
            }
        }

        // priority mode: return highest-priority (lowest index) match
        if (mode === "priority" && results.length > 0) {
            const best = results[0];
            const child = safeChildren[best.index];
            return {
                reason: `composite[${best.index}/${child.strategyType}] (priority): ${best.resolution.reason}`,
                action: best.resolution.action,
            };
        }

        return {
            reason: `composite: no child matched (${safeChildren.length} children, mode=${mode})`,
        };
    },
    // V1.4: LLM-driven trading strategy
    llm_trader: async (strategy, obs, context) => {
        if (!context.llmConfig || !context.llmConfig.apiKey) {
            return { reason: "llm_trader: LLM not configured (missing LLM_API_KEY)" };
        }
        const result = await resolveLlmTrader(
            strategy,
            obs,
            context.marketSignals,
            context.llmConfig,
            context.chainId ?? 0
        );
        return {
            action: result.action,
            reason: result.reason,
            explain: result.explain,
        };
    },
    // V1.4: Manual swap — passive strategy, only acts via BYOR / API submission
    manual_swap: async () => {
        return {
            reason: "manual_swap idle (awaiting BYOR submission)",
        };
    },
    // V2.1: DCA (Dollar-Cost Averaging) — periodic buy of target token
    dca: async (strategy, obs, context) => {
        return resolveDCA(strategy, obs, context);
    },
};

export function listSupportedStrategies(): StrategyType[] {
    return Object.keys(handlers) as StrategyType[];
}

export async function resolveStrategyAction(
    strategy: StrategyConfigRecord,
    obs: Observation,
    context?: Partial<StrategyRuntimeContext>
): Promise<StrategyResolution> {
    const handler = handlers[strategy.strategyType];
    if (!handler) {
        return {
            reason: `Unsupported strategy type: ${strategy.strategyType}`,
        };
    }
    return handler(strategy, obs, {
        nowMs: context?.nowMs ?? Date.now(),
        marketSignals: context?.marketSignals ?? new Map<string, MarketSignalRecord>(),
        llmConfig: context?.llmConfig,
        chainId: context?.chainId,
    });
}
