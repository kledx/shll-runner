/**
 * Market signal routes — /market/signal, /market/signal/batch, /market/signal/sync, /market/signal (GET)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiServerContext } from "../server.js";
import { parseBody, writeJson } from "../../http.js";
import {
    parseMarketSignalUpsertPayload,
    parseMarketSignalBatchUpsertPayload,
    parseMarketSignalSyncRequestPayload,
} from "../../validation.js";
import { normalizeMarketSignalInput } from "../../market/helpers.js";
import { syncMarketSignalsFromSourceOnce } from "../../market/signalSync.js";

export async function handleMarketRoutes(
    method: string,
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
    ctx: ApiServerContext,
    url?: URL,
): Promise<boolean> {
    const { store, config, log } = ctx;
    const parsedUrl = url ?? new URL(req.url ?? "/", "http://localhost");

    // ── Market Signal (single) ─────────────────────
    if (method === "POST" && pathname === "/market/signal") {
        const body = await parseBody(req);
        const payload = parseMarketSignalUpsertPayload(body);
        const normalized = normalizeMarketSignalInput(
            payload,
            "manual",
        );
        const record = await store.upsertMarketSignal({
            pair: normalized.pair,
            priceChangeBps: normalized.priceChangeBps,
            volume5m: normalized.volume5m,
            uniqueTraders5m: normalized.uniqueTraders5m,
            sampledAt: normalized.sampledAt,
            source: normalized.source,
        });
        writeJson(res, 200, { ok: true, signal: record });
        return true;
    }

    // ── Market Signal (batch) ──────────────────────
    if (method === "POST" && pathname === "/market/signal/batch") {
        const body = await parseBody(req);
        const payload = parseMarketSignalBatchUpsertPayload(body);
        const defaultSource = payload.source ?? "manual-batch";
        const inputs = payload.items.map((item) =>
            normalizeMarketSignalInput(item, defaultSource),
        );
        const upserted = await store.upsertMarketSignals(inputs);
        writeJson(res, 200, {
            ok: true,
            requestedCount: payload.items.length,
            upsertedCount: upserted,
        });
        return true;
    }

    // ── Market Signal (sync trigger) ───────────────
    if (method === "POST" && pathname === "/market/signal/sync") {
        const body = await parseBody(req);
        const payload = parseMarketSignalSyncRequestPayload(body);
        const startedAt = Date.now();
        const result = await syncMarketSignalsFromSourceOnce(
            { store, config, log },
            { dryRun: payload.dryRun ?? false },
        );
        writeJson(res, 200, {
            ok: true,
            ...result,
            elapsedMs: Date.now() - startedAt,
        });
        return true;
    }

    // ── Market Signal (query) ──────────────────────
    if (method === "GET" && pathname === "/market/signal") {
        const pair = parsedUrl.searchParams.get("pair") ?? undefined;
        const limitRaw = parsedUrl.searchParams.get("limit") ?? undefined;
        if (pair && !/^0x[a-fA-F0-9]{40}$/.test(pair)) {
            writeJson(res, 400, {
                error: "pair must be a 0x-prefixed 20-byte address",
            });
            return true;
        }

        let limit = 100;
        if (limitRaw != null) {
            const parsed = Number.parseInt(limitRaw, 10);
            if (
                !Number.isFinite(parsed) ||
                parsed <= 0 ||
                parsed > 1000
            ) {
                writeJson(res, 400, {
                    error: "limit must be an integer between 1 and 1000",
                });
                return true;
            }
            limit = parsed;
        }

        const items = await store.listMarketSignals(
            pair ? [pair] : undefined,
            limit,
        );
        writeJson(res, 200, {
            ok: true,
            count: items.length,
            items,
        });
        return true;
    }

    return false;
}
