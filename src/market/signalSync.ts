/**
 * Market Signal Sync — Periodic polling of external market signal sources.
 *
 * Extracted from index.ts. Runs as a background loop.
 */

import type { RunnerStore } from "../store.js";
import type { createLogger } from "../logger.js";
import {
    normalizeMarketSignalInput,
    coerceSourceSignalItem,
    type NormalizedMarketSignalInput,
} from "./helpers.js";

// ═══════════════════════════════════════════════════════
//                  Config Interface
// ═══════════════════════════════════════════════════════

export interface SignalSyncConfig {
    marketSignalSourceUrl: string;
    marketSignalSourceApiKey: string;
    marketSignalSourceAuthHeader: string;
    marketSignalSourceName: string;
    marketSignalSyncIntervalMs: number;
    marketSignalSourceTimeoutMs: number;
}

export interface SignalSyncContext {
    store: RunnerStore;
    config: SignalSyncConfig;
    log: ReturnType<typeof createLogger>;
}

// ═══════════════════════════════════════════════════════
//                     State
// ═══════════════════════════════════════════════════════

let lastSyncAt = 0;
let lastSyncError: string | null = null;

export function getSignalSyncState() {
    return { lastSyncAt, lastSyncError };
}

// ═══════════════════════════════════════════════════════
//                  Single Sync
// ═══════════════════════════════════════════════════════

export async function syncMarketSignalsFromSourceOnce(
    ctx: SignalSyncContext,
    options?: { dryRun?: boolean },
): Promise<{
    dryRun: boolean;
    total: number;
    accepted: number;
    skipped: number;
    upserted: number;
}> {
    if (!ctx.config.marketSignalSourceUrl) {
        throw new Error("MARKET_SIGNAL_SOURCE_URL is empty");
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(
        () => controller.abort(),
        Math.max(1000, ctx.config.marketSignalSourceTimeoutMs),
    );

    try {
        const headers: Record<string, string> = {
            accept: "application/json",
        };
        if (ctx.config.marketSignalSourceApiKey) {
            headers[ctx.config.marketSignalSourceAuthHeader] =
                ctx.config.marketSignalSourceApiKey;
        }

        const response = await fetch(ctx.config.marketSignalSourceUrl, {
            method: "GET",
            headers,
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(
                `market signal source request failed (${response.status} ${response.statusText})`,
            );
        }

        const body = (await response.json()) as unknown;
        const rawItems = Array.isArray(body)
            ? body
            : typeof body === "object" &&
                body != null &&
                Array.isArray((body as { items?: unknown[] }).items)
                ? ((body as { items: unknown[] }).items as unknown[])
                : typeof body === "object" &&
                    body != null &&
                    Array.isArray((body as { data?: unknown[] }).data)
                    ? ((body as { data: unknown[] }).data as unknown[])
                    : null;
        if (!rawItems) {
            throw new Error(
                "market signal source response must be an array or { items: [] } or { data: [] }",
            );
        }

        const inputs: NormalizedMarketSignalInput[] = [];
        let skipped = 0;

        for (const item of rawItems) {
            try {
                const parsed = coerceSourceSignalItem(item, ctx.config.marketSignalSourceName);
                const normalized = normalizeMarketSignalInput(
                    parsed,
                    ctx.config.marketSignalSourceName,
                );
                inputs.push(normalized);
            } catch {
                skipped++;
            }
        }

        const dryRun = options?.dryRun ?? false;
        const upserted = dryRun ? 0 : await ctx.store.upsertMarketSignals(inputs);
        return {
            dryRun,
            total: rawItems.length,
            accepted: inputs.length,
            skipped,
            upserted,
        };
    } finally {
        clearTimeout(timeoutHandle);
    }
}

// ═══════════════════════════════════════════════════════
//                  Sync Loop
// ═══════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runMarketSignalSyncLoop(ctx: SignalSyncContext): Promise<void> {
    ctx.log.info(
        `[SignalSync] enabled, source=${ctx.config.marketSignalSourceUrl}, interval=${ctx.config.marketSignalSyncIntervalMs}ms`,
    );
    while (true) {
        try {
            const result = await syncMarketSignalsFromSourceOnce(ctx);
            lastSyncAt = Date.now();
            lastSyncError = null;
            ctx.log.info(
                `[SignalSync] pulled total=${result.total}, accepted=${result.accepted}, skipped=${result.skipped}, upserted=${result.upserted}`,
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            lastSyncError = message;
            ctx.log.error(`[SignalSync] failed: ${message}`);
        }
        await sleep(Math.max(1000, ctx.config.marketSignalSyncIntervalMs));
    }
}
