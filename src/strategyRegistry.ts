import type { Address } from "viem";
import type {
    ActionPayload,
    MarketSignalRecord,
    Observation,
    StrategyConfigRecord,
    StrategyType,
} from "./types.js";

interface StrategyResolution {
    action?: ActionPayload;
    reason: string;
}

type StrategyHandler = (
    strategy: StrategyConfigRecord,
    obs: Observation,
    context: StrategyRuntimeContext
) => StrategyResolution;

const WRAP_NATIVE_SELECTOR = "0xd0e30db0";
const DEFAULT_SIGNAL_MAX_AGE_MS = 5 * 60_000;

export interface StrategyRuntimeContext {
    nowMs: number;
    marketSignals: Map<string, MarketSignalRecord>;
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
    fixed_action: (strategy) => {
        return {
            reason: "fixed_action ready",
            action: {
                target: strategy.target as Address,
                value: BigInt(strategy.value),
                data: strategy.data,
            },
        };
    },
    wrap_native: (strategy) => {
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
    hotpump_watchlist: (strategy, _obs, context) => {
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
};

export function listSupportedStrategies(): StrategyType[] {
    return Object.keys(handlers) as StrategyType[];
}

export function resolveStrategyAction(
    strategy: StrategyConfigRecord,
    obs: Observation,
    context?: Partial<StrategyRuntimeContext>
): StrategyResolution {
    const handler = handlers[strategy.strategyType];
    if (!handler) {
        return {
            reason: `Unsupported strategy type: ${strategy.strategyType}`,
        };
    }
    return handler(strategy, obs, {
        nowMs: context?.nowMs ?? Date.now(),
        marketSignals: context?.marketSignals ?? new Map<string, MarketSignalRecord>(),
    });
}
