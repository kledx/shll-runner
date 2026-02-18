/**
 * Market Signal Helpers — Normalization and coercion utilities.
 *
 * Extracted from index.ts. Used by signalSync.ts and api/server.ts.
 */

import type { MarketSignalUpsertPayload } from "../types.js";
import { parseMarketSignalUpsertPayload } from "../validation.js";

// ═══════════════════════════════════════════════════════
//                  Normalized Input
// ═══════════════════════════════════════════════════════

export interface NormalizedMarketSignalInput {
    pair: string;
    priceChangeBps: number;
    volume5m: bigint;
    uniqueTraders5m: number;
    sampledAt?: Date;
    source: string;
}

// ═══════════════════════════════════════════════════════
//                  Normalization
// ═══════════════════════════════════════════════════════

export function normalizeMarketSignalInput(
    payload: MarketSignalUpsertPayload,
    defaultSource: string,
): NormalizedMarketSignalInput {
    return {
        pair: payload.pair.toLowerCase(),
        priceChangeBps: payload.priceChangeBps,
        volume5m: BigInt(payload.volume5m ?? 0),
        uniqueTraders5m: payload.uniqueTraders5m ?? 0,
        sampledAt: payload.sampledAt ? new Date(payload.sampledAt) : undefined,
        source: payload.source ?? defaultSource,
    };
}

// ═══════════════════════════════════════════════════════
//                  Source Signal Coercion
// ═══════════════════════════════════════════════════════

export function recordLike(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value == null || Array.isArray(value)) {
        throw new Error("expected object");
    }
    return value as Record<string, unknown>;
}

export function pickFirstValue(record: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
        if (record[key] !== undefined) return record[key];
    }
    return undefined;
}

export function integerLike(value: unknown, field: string): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.round(value);
    }
    if (typeof value === "string") {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) return Math.round(parsed);
    }
    throw new Error(`invalid ${field}`);
}

export function bigintLike(value: unknown, field: string): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
        return BigInt(Math.round(value));
    }
    if (typeof value === "string") {
        try {
            return BigInt(value);
        } catch {
            // fall through
        }
        try {
            const num = Number.parseFloat(value);
            if (Number.isFinite(num)) return BigInt(Math.round(num));
        } catch {
            // fall through
        }
    }
    throw new Error(`invalid ${field}`);
}

export function timestampToIso(value: unknown): string | undefined {
    if (value == null) return undefined;
    if (typeof value === "string") {
        if (!value.trim()) return undefined;
        const dt = new Date(value);
        if (Number.isNaN(dt.getTime())) return undefined;
        return dt.toISOString();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        const millis = value < 1_000_000_000_000 ? value * 1000 : value;
        const dt = new Date(millis);
        if (Number.isNaN(dt.getTime())) return undefined;
        return dt.toISOString();
    }
    return undefined;
}

export function coerceSourceSignalItem(
    raw: unknown,
    fallbackSource: string,
): MarketSignalUpsertPayload {
    const row = recordLike(raw);
    const pair = pickFirstValue(row, ["pair", "pairAddress", "pair_address"]);
    const priceChangeBpsValue = pickFirstValue(row, [
        "priceChangeBps",
        "price_change_bps",
        "pumpBps",
        "pump_bps",
    ]);

    if (typeof pair !== "string" || !pair.trim()) {
        throw new Error("missing pair");
    }
    if (priceChangeBpsValue == null) {
        throw new Error("missing priceChangeBps");
    }

    const sampledAtRaw = pickFirstValue(row, [
        "sampledAt",
        "sampled_at",
        "timestamp",
        "ts",
    ]);
    const sourceRaw = pickFirstValue(row, ["source", "provider", "origin"]);
    const source =
        typeof sourceRaw === "string" && sourceRaw.trim() ? sourceRaw.trim() : fallbackSource;

    return parseMarketSignalUpsertPayload({
        pair: pair.trim(),
        priceChangeBps: integerLike(priceChangeBpsValue, "priceChangeBps"),
        volume5m: (() => {
            const volumeRaw = pickFirstValue(row, ["volume5m", "volume_5m", "volume"]);
            if (volumeRaw == null) return 0;
            return bigintLike(volumeRaw, "volume5m").toString();
        })(),
        uniqueTraders5m: (() => {
            const tradersRaw = pickFirstValue(row, [
                "uniqueTraders5m",
                "unique_traders_5m",
                "uniqueTraders",
            ]);
            if (tradersRaw == null) return 0;
            return Math.max(0, integerLike(tradersRaw, "uniqueTraders5m"));
        })(),
        sampledAt: timestampToIso(sampledAtRaw),
        source,
    });
}
