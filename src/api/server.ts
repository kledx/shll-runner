/**
 * API Server — HTTP control plane for the SHLL Agent Runner.
 *
 * Provides REST endpoints for:
 * - Agent lifecycle (enable/disable)
 * - Strategy management (upsert/query)
 * - Market signal ingestion
 * - Agent dashboard and activity
 * - Health check
 * - V3 modular routes (safety, admin)
 */

import { createServer } from "node:http";
import type { Hex } from "viem";
import { ZodError } from "zod";
import type { Logger } from "../logger.js";
import type { RunnerStore } from "../store.js";
import type { ChainServices } from "../chain.js";
import type { AgentManager } from "../agent/manager.js";
import { getUrl, parseBody, withCors, writeJson } from "../http.js";
import {
    normalizePermit,
    parseDisablePayload,
    parseEnablePayload,
    parseMarketSignalBatchUpsertPayload,
    parseMarketSignalSyncRequestPayload,
    parseMarketSignalUpsertPayload,
    parseStrategyQuery,
    parseStrategyUpsertPayload,
    parseStatusQuery,
} from "../validation.js";
import { handleV3Routes } from "./router.js";
import { normalizeMarketSignalInput } from "../market/helpers.js";
import {
    syncMarketSignalsFromSourceOnce,
    getSignalSyncState,
    type SignalSyncConfig,
} from "../market/signalSync.js";
import { getLastLoopAt } from "../scheduler.js";

// ═══════════════════════════════════════════════════════
//                  Server Config
// ═══════════════════════════════════════════════════════

export interface ApiServerConfig {
    apiPort: number;
    apiHost: string;
    apiKey: string;
    chainId: number;
    agentNfaAddress: string;
    tokenId: bigint;
    statusRunsLimit: number;
    pollIntervalMs: number;
    // Market signal sync config
    marketSignalSyncEnabled: boolean;
    marketSignalSourceUrl: string;
    marketSignalSourceApiKey: string;
    marketSignalSourceAuthHeader: string;
    marketSignalSourceName: string;
    marketSignalSyncIntervalMs: number;
    marketSignalSourceTimeoutMs: number;
}

export interface ApiServerContext {
    store: RunnerStore;
    chain: ChainServices;
    config: ApiServerConfig;
    // allowedTokenIdSet removed — V3 uses permit signatures for auth
    agentManager: AgentManager;
    log: Logger;
}

// ═══════════════════════════════════════════════════════
//                  Helpers
// ═══════════════════════════════════════════════════════



function requireApiKey(
    req: import("node:http").IncomingMessage,
    apiKey: string,
): boolean {
    if (!apiKey) return true;
    const provided = req.headers["x-api-key"];
    return provided === apiKey;
}

// ═══════════════════════════════════════════════════════
//                  Server
// ═══════════════════════════════════════════════════════

export function startApiServer(ctx: ApiServerContext): void {
    const { store, chain, config, log } = ctx;

    const server = createServer(async (req, res) => {
        try {
            if (!req.url || !req.method) {
                writeJson(res, 400, { error: "invalid request" });
                return;
            }

            const url = getUrl(req, `${config.apiHost}:${config.apiPort}`);

            if (req.method === "OPTIONS") {
                withCors(res);
                res.statusCode = 204;
                res.end();
                return;
            }

            // Auth check for mutating endpoints
            if (
                req.method === "POST" &&
                (url.pathname === "/enable" ||
                    url.pathname === "/disable" ||
                    url.pathname === "/strategy/upsert" ||
                    url.pathname === "/market/signal" ||
                    url.pathname === "/market/signal/batch" ||
                    url.pathname === "/market/signal/sync")
            ) {
                if (!requireApiKey(req, config.apiKey)) {
                    writeJson(res, 401, { error: "unauthorized" });
                    return;
                }
            }

            // ── Enable ─────────────────────────────────────
            if (req.method === "POST" && url.pathname === "/enable") {
                const body = await parseBody(req);
                const payload = parseEnablePayload(body);
                const permit = normalizePermit(payload.permit);

                if (
                    payload.chainId != null &&
                    payload.chainId !== config.chainId
                ) {
                    writeJson(res, 400, {
                        error: `chainId mismatch: expected ${config.chainId}`,
                    });
                    return;
                }

                if (
                    payload.nfaAddress != null &&
                    payload.nfaAddress.toLowerCase() !==
                    config.agentNfaAddress.toLowerCase()
                ) {
                    writeJson(res, 400, {
                        error: `nfaAddress mismatch: expected ${config.agentNfaAddress}`,
                    });
                    return;
                }



                if (
                    permit.operator.toLowerCase() !==
                    chain.account.address.toLowerCase()
                ) {
                    writeJson(res, 400, {
                        error: "permit.operator must equal runner operator address",
                        expectedOperator: chain.account.address,
                    });
                    return;
                }

                const nowSec = BigInt(Math.floor(Date.now() / 1000));
                if (permit.deadline < nowSec) {
                    writeJson(res, 400, {
                        error: "permit.deadline has expired",
                    });
                    return;
                }

                const result = await chain.enableOperatorWithPermit(
                    permit,
                    payload.sig as Hex,
                    payload.waitForReceipt ?? true,
                );

                await store.upsertEnabled({
                    tokenId: permit.tokenId,
                    renter: permit.renter,
                    operator: permit.operator,
                    permitExpires: permit.expires,
                    permitDeadline: permit.deadline,
                    sig: payload.sig,
                    txHash: result.hash,
                });

                log.info(
                    `Permit applied: tokenId=${permit.tokenId.toString()} hash=${result.hash}`,
                );
                writeJson(res, 200, {
                    ok: true,
                    txHash: result.hash,
                    receiptStatus: result.receiptStatus,
                    receiptBlock: result.receiptBlock,
                });
                return;
            }

            // ── Strategy Upsert ────────────────────────────
            if (req.method === "POST" && url.pathname === "/strategy/upsert") {
                const body = await parseBody(req);
                const payload = parseStrategyUpsertPayload(body);
                if (!payload.strategyType) {
                    writeJson(res, 400, {
                        error: "strategyType is required",
                    });
                    return;
                }
                const record = await store.upsertStrategy({
                    tokenId: BigInt(payload.tokenId),
                    strategyType: payload.strategyType,
                    target: payload.target ?? "",
                    data: payload.data ?? "0x",
                    value: BigInt(payload.value ?? 0),
                    strategyParams: payload.strategyParams ?? {},
                    source: "api",
                    minIntervalMs: payload.minIntervalMs ?? 300_000,
                    requirePositiveBalance:
                        payload.requirePositiveBalance ?? true,
                    maxFailures: payload.maxFailures ?? 5,
                    enabled: payload.enabled ?? true,
                });
                log.info(
                    `Strategy upserted: tokenId=${payload.tokenId} type=${payload.strategyType}`,
                );
                writeJson(res, 200, { ok: true, strategy: record });
                return;
            }

            // ── Market Signal (single) ─────────────────────
            if (req.method === "POST" && url.pathname === "/market/signal") {
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
                return;
            }

            // ── Market Signal (batch) ──────────────────────
            if (
                req.method === "POST" &&
                url.pathname === "/market/signal/batch"
            ) {
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
                return;
            }

            // ── Market Signal (sync trigger) ───────────────
            if (
                req.method === "POST" &&
                url.pathname === "/market/signal/sync"
            ) {
                const body = await parseBody(req);
                const payload =
                    parseMarketSignalSyncRequestPayload(body);
                const startedAt = Date.now();
                const result = await syncMarketSignalsFromSourceOnce(
                    {
                        store,
                        config,
                        log,
                    },
                    { dryRun: payload.dryRun ?? false },
                );
                writeJson(res, 200, {
                    ok: true,
                    ...result,
                    elapsedMs: Date.now() - startedAt,
                });
                return;
            }

            // ── Market Signal (query) ──────────────────────
            if (req.method === "GET" && url.pathname === "/market/signal") {
                const pair =
                    url.searchParams.get("pair") ?? undefined;
                const limitRaw =
                    url.searchParams.get("limit") ?? undefined;
                if (pair && !/^0x[a-fA-F0-9]{40}$/.test(pair)) {
                    writeJson(res, 400, {
                        error: "pair must be a 0x-prefixed 20-byte address",
                    });
                    return;
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
                        return;
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
                return;
            }

            // ── Disable ────────────────────────────────────
            if (req.method === "POST" && url.pathname === "/disable") {
                const body = await parseBody(req);
                const payload = parseDisablePayload(body);
                const tokenId =
                    payload.tokenId != null
                        ? BigInt(payload.tokenId)
                        : config.tokenId;
                const mode = payload.mode ?? "local";
                const reason = payload.reason ?? "disabled by API";

                let txHash: string | undefined;
                if (mode === "onchain") {
                    const result = await chain.clearOperator(
                        tokenId,
                        payload.waitForReceipt ?? true,
                    );
                    txHash = result.hash;
                }

                const record = await store.disable(
                    tokenId,
                    reason,
                    txHash,
                );
                writeJson(res, 200, {
                    ok: true,
                    tokenId: record.tokenId,
                    mode,
                    txHash,
                });
                return;
            }

            // ── Status (single token) ──────────────────────
            if (req.method === "GET" && url.pathname === "/status") {
                const query = parseStatusQuery({
                    tokenId:
                        url.searchParams.get("tokenId") ?? undefined,
                    runsLimit:
                        url.searchParams.get("runsLimit") ?? undefined,
                });
                const tokenId = query.tokenId ?? config.tokenId;
                const runsLimit =
                    query.runsLimit ?? config.statusRunsLimit;

                const onchain = await chain.readStatus(tokenId);
                const autopilot = await store.getAutopilot(tokenId);
                const strategy = await store.getStrategy(tokenId);
                const runs = await store.listRuns(tokenId, runsLimit);

                writeJson(res, 200, {
                    ok: true,
                    tokenId: tokenId.toString(),
                    runnerOperator: chain.account.address,
                    onchainOperator: onchain.onchainOperator,
                    operatorExpires:
                        onchain.operatorExpires.toString(),
                    renter: onchain.renter,
                    renterExpires: onchain.renterExpires.toString(),
                    operatorNonce: onchain.operatorNonce.toString(),
                    autopilot,
                    strategy,
                    runs,
                });
                return;
            }

            // ── Strategy Query ─────────────────────────────
            if (req.method === "GET" && url.pathname === "/strategy") {
                const query = parseStrategyQuery({
                    tokenId:
                        url.searchParams.get("tokenId") ?? undefined,
                });
                if (query.tokenId != null) {
                    const tokenId = BigInt(query.tokenId);
                    const strategy = await store.getStrategy(tokenId);
                    writeJson(res, 200, {
                        ok: true,
                        tokenId: tokenId.toString(),
                        strategy,
                    });
                    return;
                }
                writeJson(res, 200, {
                    ok: true,
                    items: await store.listStrategies(),
                });
                return;
            }

            // ── Agent Dashboard ────────────────────────────
            if (
                req.method === "GET" &&
                url.pathname === "/agent/dashboard"
            ) {
                const tokenIdParam =
                    url.searchParams.get("tokenId");
                if (!tokenIdParam) {
                    writeJson(res, 400, {
                        error: "tokenId is required",
                    });
                    return;
                }
                const tokenId = BigInt(tokenIdParam);
                // Read-only endpoint — no token allowlist check needed
                const dashboard = await store.getDashboard(tokenId);
                writeJson(res, 200, {
                    ok: true,
                    tokenId: tokenId.toString(),
                    ...dashboard,
                });
                return;
            }

            // ── Agent Activity ─────────────────────────────
            if (
                req.method === "GET" &&
                url.pathname === "/agent/activity"
            ) {
                const tokenIdParam =
                    url.searchParams.get("tokenId");
                if (!tokenIdParam) {
                    writeJson(res, 400, {
                        error: "tokenId is required",
                    });
                    return;
                }
                const tokenId = BigInt(tokenIdParam);
                // Read-only endpoint — no token allowlist check needed
                const limitRaw = url.searchParams.get("limit");
                const offsetRaw = url.searchParams.get("offset");
                const brainType =
                    url.searchParams.get("brainType") ?? undefined;
                const result = await store.getActivity(tokenId, {
                    limit: limitRaw
                        ? Number.parseInt(limitRaw, 10)
                        : undefined,
                    offset: offsetRaw
                        ? Number.parseInt(offsetRaw, 10)
                        : undefined,
                    brainType,
                });
                writeJson(res, 200, {
                    ok: true,
                    tokenId: tokenId.toString(),
                    ...result,
                });
                return;
            }

            // ── Autopilots List ────────────────────────────
            if (req.method === "GET" && url.pathname === "/autopilots") {
                writeJson(res, 200, {
                    ok: true,
                    items: await store.listAutopilots(),
                });
                return;
            }

            // ── Status All ─────────────────────────────────
            if (req.method === "GET" && url.pathname === "/status/all") {
                writeJson(res, 200, {
                    ok: true,
                    chainId: config.chainId,
                    runnerOperator: chain.account.address,
                    autopilots: await store.listAutopilots(),
                    strategies: await store.listStrategies(),
                });
                return;
            }

            // ── Health ─────────────────────────────────────
            if (req.method === "GET" && url.pathname === "/health") {
                const enabledTokenIds =
                    await store.listEnabledTokenIds();
                const activeLockCount =
                    await store.countActiveAutopilotLocks();
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
                        sourceConfigured:
                            !!config.marketSignalSourceUrl,
                        intervalMs: config.marketSignalSyncIntervalMs,
                        lastSyncAt: syncState.lastSyncAt || null,
                        lastError: syncState.lastSyncError,
                    },
                });
                return;
            }

            // ── V3 Modular Routes ──────────────────────────
            const v3Handled = await handleV3Routes(
                req.method!,
                url.pathname,
                req,
                res,
                {
                    pool: store.getPool(),
                    chainId: config.chainId,
                    requireAuth: (r) =>
                        requireApiKey(r, config.apiKey),
                },
            );
            if (v3Handled) return;

            writeJson(res, 404, { error: "not found" });
        } catch (err) {
            if (err instanceof ZodError) {
                writeJson(res, 400, {
                    error: "invalid request payload",
                    details: err.issues,
                });
                return;
            }
            if (err instanceof SyntaxError) {
                writeJson(res, 400, {
                    error: "invalid JSON body",
                    detail: err.message,
                });
                return;
            }
            const message =
                err instanceof Error ? err.message : String(err);
            log.error("API error:", message);
            writeJson(res, 500, { error: message });
        }
    });

    server.listen(config.apiPort, config.apiHost, () => {
        log.info(
            `Control API listening on http://${config.apiHost}:${config.apiPort}`,
        );
    });
}
