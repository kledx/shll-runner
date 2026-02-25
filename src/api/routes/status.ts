/**
 * Status & health routes — /status, /status/all, /health, /autopilots, /shadow/metrics, /metrics,
 *                          /agent/dashboard, /agent/activity
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiServerContext } from "../server.js";
import { writeJson, withCors } from "../../http.js";
import { parseStatusQuery, parseShadowMetricsQuery } from "../../validation.js";
import { getLastLoopAt } from "../../scheduler.js";
import { getSignalSyncState } from "../../market/signalSync.js";
import { metrics } from "../../metrics.js";

export async function handleStatusRoutes(
    method: string,
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
    ctx: ApiServerContext,
    url?: URL,
    requireAuth?: () => boolean,
): Promise<boolean> {
    const { store, chain, config } = ctx;

    if (method !== "GET") return false;

    const parsedUrl = url ?? new URL(req.url ?? "/", "http://localhost");

    // ── Status (single token) ──────────────────────
    if (pathname === "/status") {
        const query = parseStatusQuery({
            tokenId: parsedUrl.searchParams.get("tokenId") ?? undefined,
            runsLimit: parsedUrl.searchParams.get("runsLimit") ?? undefined,
        });
        const tokenId = query.tokenId ?? config.tokenId;
        const runsLimit = query.runsLimit ?? config.statusRunsLimit;

        const onchain = await chain.readStatus(tokenId);
        const autopilot = await store.getAutopilot(tokenId);
        const strategy = await store.getStrategy(tokenId);
        const runs = await store.listRuns(tokenId, runsLimit);

        writeJson(res, 200, {
            ok: true,
            tokenId: tokenId.toString(),
            runnerOperator: chain.account.address,
            onchainOperator: onchain.onchainOperator,
            operatorExpires: onchain.operatorExpires.toString(),
            renter: onchain.renter,
            renterExpires: onchain.renterExpires.toString(),
            operatorNonce: onchain.operatorNonce.toString(),
            autopilot,
            strategy,
            runs,
        });
        return true;
    }

    // ── Status All ─────────────────────────────────
    if (pathname === "/status/all") {
        writeJson(res, 200, {
            ok: true,
            chainId: config.chainId,
            runnerOperator: chain.account.address,
            autopilots: await store.listAutopilots(),
            strategies: await store.listStrategies(),
        });
        return true;
    }

    // ── Autopilots List ────────────────────────────
    if (pathname === "/autopilots") {
        writeJson(res, 200, {
            ok: true,
            items: await store.listAutopilots(),
        });
        return true;
    }

    // ── Shadow Metrics ─────────────────────────────
    if (pathname === "/shadow/metrics") {
        const query = parseShadowMetricsQuery({
            tokenId: parsedUrl.searchParams.get("tokenId") ?? undefined,
            sinceHours: parsedUrl.searchParams.get("sinceHours") ?? undefined,
        });
        const report = await store.getShadowMetrics({
            tokenId: query.tokenId,
            sinceHours: query.sinceHours,
        });
        writeJson(res, 200, {
            ok: true,
            ...report,
        });
        return true;
    }

    // ── Agent Dashboard ────────────────────────────
    if (pathname === "/agent/dashboard") {
        const tokenIdParam = parsedUrl.searchParams.get("tokenId");
        if (!tokenIdParam) {
            writeJson(res, 400, { error: "tokenId is required" });
            return true;
        }
        const tokenId = BigInt(tokenIdParam);
        const dashboard = await store.getDashboard(tokenId);
        writeJson(res, 200, {
            ok: true,
            tokenId: tokenId.toString(),
            ...dashboard,
        });
        return true;
    }

    // ── Agent Activity ─────────────────────────────
    if (pathname === "/agent/activity") {
        const tokenIdParam = parsedUrl.searchParams.get("tokenId");
        if (!tokenIdParam) {
            writeJson(res, 400, { error: "tokenId is required" });
            return true;
        }
        const tokenId = BigInt(tokenIdParam);
        const limitRaw = parsedUrl.searchParams.get("limit");
        const offsetRaw = parsedUrl.searchParams.get("offset");
        const brainType = parsedUrl.searchParams.get("brainType") ?? undefined;
        const result = await store.getActivity(tokenId, {
            limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
            offset: offsetRaw ? Number.parseInt(offsetRaw, 10) : undefined,
            brainType,
        });
        writeJson(res, 200, {
            ok: true,
            tokenId: tokenId.toString(),
            ...result,
        });
        return true;
    }

    // ── Health ─────────────────────────────────────
    if (pathname === "/health") {
        const enabledTokenIds = await store.listEnabledTokenIds();
        const activeLockCount = await store.countActiveAutopilotLocks();
        const syncState = getSignalSyncState();
        writeJson(res, 200, {
            ok: true,
            chainId: config.chainId,
            runnerOperator: chain.account.address,
            enabledCount: enabledTokenIds.length,
            activeLockCount,
            lastLoopAt: getLastLoopAt(),
            pollIntervalMs: config.pollIntervalMs,
            marketSignalSync: {
                enabled: config.marketSignalSyncEnabled,
                sourceConfigured: !!config.marketSignalSourceUrl,
                intervalMs: config.marketSignalSyncIntervalMs,
                lastSyncAt: syncState.lastSyncAt || null,
                lastError: syncState.lastSyncError,
            },
            shadowMode: {
                enabled: config.shadowModeEnabled,
                executeTx: config.shadowExecuteTx,
                tokenIds:
                    config.shadowModeTokenIds.length > 0
                        ? config.shadowModeTokenIds.map((x: bigint) => x.toString())
                        : "all",
                metricsEndpoint: "/shadow/metrics",
            },
        });
        return true;
    }

    // ── Metrics ─────────────────────────────────────
    if (pathname === "/metrics") {
        // Protect metrics with API key when configured
        if (requireAuth && !requireAuth()) {
            writeJson(res, 401, { error: "unauthorized" });
            return true;
        }
        const accept = req.headers.accept ?? "";
        if (accept.includes("text/plain") || accept.includes("text/prometheus")) {
            withCors(res);
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(metrics.toPrometheus());
        } else {
            writeJson(res, 200, metrics.snapshot());
        }
        return true;
    }

    return false;
}
