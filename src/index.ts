/**
 * SHLL Agent Runner
 *
 * Features:
 * 1) Control API: /enable, /disable, /status
 * 2) Observe-reason-act loop for auto execution
 * 3) Local persistence for autopilot status and run history
 */

import "dotenv/config";
import { createServer } from "node:http";
import { formatEther, keccak256, stringToHex, type Address, type Hex } from "viem";
import { ZodError } from "zod";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { createChainServices } from "./chain.js";
import { RunnerStore } from "./store.js";
import { getUrl, parseBody, withCors, writeJson } from "./http.js";
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
} from "./validation.js";
import type {
    MarketSignalUpsertPayload,
    MarketSignalRecord,
} from "./types.js";
import { handleV3Routes } from "./api/router.js";
import { AgentManager } from "./agent/manager.js";
import { runAgentCycle, recordExecution } from "./agent/runtime.js";
import { bootstrapAgentModules } from "./bootstrap.js";
import { AgentNFAAbi } from "./abi.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const log = createLogger(config.logLevel);
const chain = createChainServices({
    rpcUrl: config.rpcUrl,
    rpcTimeoutMs: config.rpcTimeoutMs,
    rpcRetryCount: config.rpcRetryCount,
    operatorPrivateKey: config.operatorPrivateKey,
    agentNfaAddress: config.agentNfaAddress,
    instanceConfigAddress: config.instanceConfigAddress,
    policyGuardV2Address: config.policyGuardV2Address,
});
const store = new RunnerStore({
    chainId: config.chainId,
    maxRunRecords: config.maxRunRecords,
    databaseUrl: config.databaseUrl,
    pgHost: config.pgHost,
    pgPort: config.pgPort,
    pgUser: config.pgUser,
    pgPassword: config.pgPassword,
    pgDatabase: config.pgDatabase,
    pgSsl: config.pgSsl,
    pgPoolMax: config.pgPoolMax,
});
const allowedTokenIdSet = new Set<string>(
    (config.allowedTokenIds.length > 0 ? config.allowedTokenIds : [config.tokenId]).map((v) =>
        v.toString()
    )
);
let lastLoopAt = 0;
let lastMarketSignalSyncAt = 0;
let lastMarketSignalSyncError: string | null = null;

// V3.0 Agent Manager (lifecycle for Agent instances)
const agentManager = new AgentManager();



interface NormalizedMarketSignalInput {
    pair: string;
    priceChangeBps: number;
    volume5m: bigint;
    uniqueTraders5m: number;
    sampledAt?: Date;
    source: string;
}





function isTokenAllowed(tokenId: bigint): boolean {
    return allowedTokenIdSet.has(tokenId.toString());
}

function normalizeMarketSignalInput(
    payload: MarketSignalUpsertPayload,
    defaultSource: string
): NormalizedMarketSignalInput {
    const sampledAt = payload.sampledAt ? new Date(payload.sampledAt) : undefined;
    if (sampledAt && Number.isNaN(sampledAt.getTime())) {
        throw new Error("invalid sampledAt");
    }

    return {
        pair: payload.pair,
        priceChangeBps: payload.priceChangeBps,
        volume5m: BigInt(payload.volume5m ?? 0),
        uniqueTraders5m: payload.uniqueTraders5m ?? 0,
        sampledAt,
        source: payload.source ?? defaultSource,
    };
}

function recordLike(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("source item must be an object");
    }
    return value as Record<string, unknown>;
}

function pickFirstValue(record: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
        const value = record[key];
        if (value != null) return value;
    }
    return undefined;
}

function integerLike(value: unknown, field: string): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Number.parseInt(value.trim(), 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    throw new Error(`invalid ${field}`);
}

function bigintLike(value: unknown, field: string): bigint {
    try {
        if (typeof value === "bigint") return value;
        if (typeof value === "number" && Number.isFinite(value)) {
            return BigInt(Math.trunc(value));
        }
        if (typeof value === "string" && value.trim()) {
            return BigInt(value.trim());
        }
    } catch {
        // fall through
    }
    throw new Error(`invalid ${field}`);
}

function timestampToIso(value: unknown): string | undefined {
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

function coerceSourceSignalItem(
    raw: unknown,
    fallbackSource: string
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



function requireApiKey(req: { headers: Record<string, string | string[] | undefined> }): boolean {
    if (!config.apiKey) return true;
    const incoming = req.headers["x-api-key"];
    const key = Array.isArray(incoming) ? incoming[0] : incoming;
    return key === config.apiKey;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncMarketSignalsFromSourceOnce(options?: {
    dryRun?: boolean;
}): Promise<{
    dryRun: boolean;
    total: number;
    accepted: number;
    skipped: number;
    upserted: number;
}> {
    if (!config.marketSignalSourceUrl) {
        throw new Error("MARKET_SIGNAL_SOURCE_URL is empty");
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(
        () => controller.abort(),
        Math.max(1000, config.marketSignalSourceTimeoutMs)
    );

    try {
        const headers: Record<string, string> = {
            accept: "application/json",
        };
        if (config.marketSignalSourceApiKey) {
            headers[config.marketSignalSourceAuthHeader] = config.marketSignalSourceApiKey;
        }

        const response = await fetch(config.marketSignalSourceUrl, {
            method: "GET",
            headers,
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(
                `market signal source request failed (${response.status} ${response.statusText})`
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
                "market signal source response must be an array or { items: [] } or { data: [] }"
            );
        }

        const inputs: NormalizedMarketSignalInput[] = [];
        let skipped = 0;

        for (const item of rawItems) {
            try {
                const parsed = coerceSourceSignalItem(item, config.marketSignalSourceName);
                const normalized = normalizeMarketSignalInput(parsed, config.marketSignalSourceName);
                inputs.push(normalized);
            } catch {
                skipped++;
            }
        }

        const dryRun = options?.dryRun ?? false;
        const upserted = dryRun ? 0 : await store.upsertMarketSignals(inputs);
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

async function runMarketSignalSyncLoop(): Promise<void> {
    log.info(
        `[SignalSync] enabled, source=${config.marketSignalSourceUrl}, interval=${config.marketSignalSyncIntervalMs}ms`
    );
    while (true) {
        try {
            const result = await syncMarketSignalsFromSourceOnce();
            lastMarketSignalSyncAt = Date.now();
            lastMarketSignalSyncError = null;
            log.info(
                `[SignalSync] pulled total=${result.total}, accepted=${result.accepted}, skipped=${result.skipped}, upserted=${result.upserted}`
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            lastMarketSignalSyncError = message;
            log.error(`[SignalSync] failed: ${message}`);
        }
        await sleep(Math.max(1000, config.marketSignalSyncIntervalMs));
    }
}

function startApiServer(): void {
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

            if (
                req.method === "POST" &&
                (url.pathname === "/enable" ||
                    url.pathname === "/disable" ||
                    url.pathname === "/strategy/upsert" ||

                    url.pathname === "/market/signal" ||
                    url.pathname === "/market/signal/batch" ||
                    url.pathname === "/market/signal/sync")
            ) {
                if (!requireApiKey(req)) {
                    writeJson(res, 401, { error: "unauthorized" });
                    return;
                }
            }

            if (req.method === "POST" && url.pathname === "/enable") {
                const body = await parseBody(req);
                const payload = parseEnablePayload(body);
                const permit = normalizePermit(payload.permit);

                if (payload.chainId != null && payload.chainId !== config.chainId) {
                    writeJson(res, 400, {
                        error: `chainId mismatch: expected ${config.chainId}`,
                    });
                    return;
                }

                if (
                    payload.nfaAddress != null &&
                    payload.nfaAddress.toLowerCase() !== config.agentNfaAddress.toLowerCase()
                ) {
                    writeJson(res, 400, {
                        error: `nfaAddress mismatch: expected ${config.agentNfaAddress}`,
                    });
                    return;
                }

                if (!isTokenAllowed(permit.tokenId)) {
                    writeJson(res, 400, {
                        error: `tokenId not allowed by runner: ${permit.tokenId.toString()}`,
                        allowedTokenIds: [...allowedTokenIdSet],
                    });
                    return;
                }

                if (permit.operator.toLowerCase() !== chain.account.address.toLowerCase()) {
                    writeJson(res, 400, {
                        error: "permit.operator must equal runner operator address",
                        expectedOperator: chain.account.address,
                    });
                    return;
                }

                const nowSec = BigInt(Math.floor(Date.now() / 1000));
                if (permit.deadline < nowSec) {
                    writeJson(res, 400, { error: "permit.deadline has expired" });
                    return;
                }

                const result = await chain.enableOperatorWithPermit(
                    permit,
                    payload.sig as Hex,
                    payload.waitForReceipt ?? true
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
                    `Permit applied: tokenId=${permit.tokenId.toString()} hash=${result.hash}`
                );
                writeJson(res, 200, {
                    ok: true,
                    txHash: result.hash,
                    receiptStatus: result.receiptStatus,
                    receiptBlock: result.receiptBlock,
                });
                return;
            }

            // /strategy/upsert — configure agent execution params (V3: type from template)
            if (req.method === "POST" && url.pathname === "/strategy/upsert") {
                const body = await parseBody(req);
                const payload = parseStrategyUpsertPayload(body);
                if (!payload.strategyType) {
                    writeJson(res, 400, { error: "strategyType is required" });
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
                    requirePositiveBalance: payload.requirePositiveBalance ?? true,
                    maxFailures: payload.maxFailures ?? 5,
                    enabled: payload.enabled ?? true,
                });
                log.info(`Strategy upserted: tokenId=${payload.tokenId} type=${payload.strategyType}`);
                writeJson(res, 200, { ok: true, strategy: record });
                return;
            }

            if (req.method === "POST" && url.pathname === "/market/signal") {
                const body = await parseBody(req);
                const payload = parseMarketSignalUpsertPayload(body);
                const normalized = normalizeMarketSignalInput(payload, "manual");

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

            if (req.method === "POST" && url.pathname === "/market/signal/batch") {
                const body = await parseBody(req);
                const payload = parseMarketSignalBatchUpsertPayload(body);
                const defaultSource = payload.source ?? "manual-batch";
                const inputs = payload.items.map((item) =>
                    normalizeMarketSignalInput(item, defaultSource)
                );
                const upserted = await store.upsertMarketSignals(inputs);
                writeJson(res, 200, {
                    ok: true,
                    requestedCount: payload.items.length,
                    upsertedCount: upserted,
                });
                return;
            }

            if (req.method === "POST" && url.pathname === "/market/signal/sync") {
                const body = await parseBody(req);
                const payload = parseMarketSignalSyncRequestPayload(body);
                const startedAt = Date.now();
                const result = await syncMarketSignalsFromSourceOnce({
                    dryRun: payload.dryRun ?? false,
                });
                if (!result.dryRun) {
                    lastMarketSignalSyncAt = Date.now();
                    lastMarketSignalSyncError = null;
                }
                writeJson(res, 200, {
                    ok: true,
                    ...result,
                    elapsedMs: Date.now() - startedAt,
                });
                return;
            }

            if (req.method === "GET" && url.pathname === "/market/signal") {
                const pair = url.searchParams.get("pair") ?? undefined;
                const limitRaw = url.searchParams.get("limit") ?? undefined;
                if (pair && !/^0x[a-fA-F0-9]{40}$/.test(pair)) {
                    writeJson(res, 400, { error: "pair must be a 0x-prefixed 20-byte address" });
                    return;
                }

                let limit = 100;
                if (limitRaw != null) {
                    const parsed = Number.parseInt(limitRaw, 10);
                    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1000) {
                        writeJson(res, 400, { error: "limit must be an integer between 1 and 1000" });
                        return;
                    }
                    limit = parsed;
                }

                const items = await store.listMarketSignals(pair ? [pair] : undefined, limit);
                writeJson(res, 200, { ok: true, count: items.length, items });
                return;
            }

            if (req.method === "POST" && url.pathname === "/disable") {
                const body = await parseBody(req);
                const payload = parseDisablePayload(body);
                const tokenId = payload.tokenId != null ? BigInt(payload.tokenId) : config.tokenId;
                const mode = payload.mode ?? "local";
                const reason = payload.reason ?? "disabled by API";

                let txHash: string | undefined;
                if (mode === "onchain") {
                    const result = await chain.clearOperator(
                        tokenId,
                        payload.waitForReceipt ?? true
                    );
                    txHash = result.hash;
                }

                const record = await store.disable(tokenId, reason, txHash);
                writeJson(res, 200, { ok: true, tokenId: record.tokenId, mode, txHash });
                return;
            }

            if (req.method === "GET" && url.pathname === "/status") {
                const query = parseStatusQuery({
                    tokenId: url.searchParams.get("tokenId") ?? undefined,
                    runsLimit: url.searchParams.get("runsLimit") ?? undefined,
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
                    autoActionEnabled: config.autoActionEnabled,
                    autoActionTarget: config.autoActionTarget,
                    minActionIntervalMs: config.minActionIntervalMs,
                });
                return;
            }

            if (req.method === "GET" && url.pathname === "/strategy") {
                const query = parseStrategyQuery({
                    tokenId: url.searchParams.get("tokenId") ?? undefined,
                });
                if (query.tokenId != null) {
                    const tokenId = BigInt(query.tokenId);
                    const strategy = await store.getStrategy(tokenId);
                    writeJson(res, 200, { ok: true, tokenId: tokenId.toString(), strategy });
                    return;
                }
                writeJson(res, 200, { ok: true, items: await store.listStrategies() });
                return;
            }

            // V3.0: /strategy/supported + /strategy/evaluate removed
            //       (Use V3 Agent Blueprints + /v3/admin/* routes instead)


            // ── V2.1: Agent Dashboard + Activity ───────────────────

            if (req.method === "GET" && url.pathname === "/agent/dashboard") {
                const tokenIdParam = url.searchParams.get("tokenId");
                if (!tokenIdParam) {
                    writeJson(res, 400, { error: "tokenId is required" });
                    return;
                }
                const tokenId = BigInt(tokenIdParam);
                if (!isTokenAllowed(tokenId)) {
                    writeJson(res, 403, { error: "tokenId not allowed" });
                    return;
                }
                const dashboard = await store.getDashboard(tokenId);
                writeJson(res, 200, {
                    ok: true,
                    tokenId: tokenId.toString(),
                    ...dashboard,
                });
                return;
            }

            if (req.method === "GET" && url.pathname === "/agent/activity") {
                const tokenIdParam = url.searchParams.get("tokenId");
                if (!tokenIdParam) {
                    writeJson(res, 400, { error: "tokenId is required" });
                    return;
                }
                const tokenId = BigInt(tokenIdParam);
                if (!isTokenAllowed(tokenId)) {
                    writeJson(res, 403, { error: "tokenId not allowed" });
                    return;
                }
                const limitRaw = url.searchParams.get("limit");
                const offsetRaw = url.searchParams.get("offset");
                const brainType = url.searchParams.get("brainType") ?? undefined;
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
                return;
            }

            if (req.method === "GET" && url.pathname === "/autopilots") {
                writeJson(res, 200, { ok: true, items: await store.listAutopilots() });
                return;
            }

            if (req.method === "GET" && url.pathname === "/status/all") {
                writeJson(res, 200, {
                    ok: true,
                    chainId: config.chainId,
                    runnerOperator: chain.account.address,
                    allowedTokenIds: [...allowedTokenIdSet],
                    autopilots: await store.listAutopilots(),
                    strategies: await store.listStrategies(),
                });
                return;
            }

            if (req.method === "GET" && url.pathname === "/health") {
                const enabledTokenIds = await store.listEnabledTokenIds();
                const activeLockCount = await store.countActiveAutopilotLocks();
                writeJson(res, 200, {
                    ok: true,
                    chainId: config.chainId,
                    runnerOperator: chain.account.address,
                    enabledCount: enabledTokenIds.length,
                    activeLockCount,
                    lastLoopAt,
                    pollIntervalMs: config.pollIntervalMs,
                    marketSignalSync: {
                        enabled: config.marketSignalSyncEnabled,
                        sourceConfigured: !!config.marketSignalSourceUrl,
                        intervalMs: config.marketSignalSyncIntervalMs,
                        lastSyncAt: lastMarketSignalSyncAt || null,
                        lastError: lastMarketSignalSyncError,
                    },
                });
                return;
            }

            // V3.0: /byor/schema + /byor/submit removed (BYOR deprecated)

            // ─── V3.0 Modular Routes ───
            const v3Handled = await handleV3Routes(req.method!, url.pathname, req, res, {
                pool: store.getPool(),
                chainId: config.chainId,
                requireAuth: (r) => requireApiKey(r),
            });
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
            const message = err instanceof Error ? err.message : String(err);
            log.error("API error:", message);
            writeJson(res, 500, { error: message });
        }
    });

    server.listen(config.apiPort, config.apiHost, () => {
        log.info(`Control API listening on http://${config.apiHost}:${config.apiPort}`);
    });
}

// ═══════════════════════════════════════════════════════
//   V3 Agent Runtime Loop (replaces V1 runLoop)
// ═══════════════════════════════════════════════════════

async function runLoop(): Promise<void> {
    log.info("=== SHLL Agent Runner (V3.0) ===");
    log.info(`Operator: ${chain.account.address}`);
    log.info(`Agent NFA: ${config.agentNfaAddress}`);
    log.info(`Allowed token IDs: ${[...allowedTokenIdSet].join(", ")}`);
    log.info(`Poll interval: ${config.pollIntervalMs}ms`);
    log.info(
        `Store backend: postgres (${config.databaseUrl ? "DATABASE_URL" : `${config.pgHost}:${config.pgPort}/${config.pgDatabase}`})`
    );
    log.info("");

    let consecutiveErrors = 0;

    while (true) {
        try {
            lastLoopAt = Date.now();

            // Collect enabled token IDs from DB
            const tokenSet = new Set<string>();
            for (const tokenId of await store.listEnabledTokenIds()) {
                tokenSet.add(tokenId.toString());
            }
            if (config.autoActionEnabled) {
                tokenSet.add(config.tokenId.toString());
            }

            if (tokenSet.size === 0) {
                log.info("[Tick] idle — no enabled autopilot token");
            }

            for (const tokenIdRaw of tokenSet) {
                const tokenId = BigInt(tokenIdRaw);
                const autopilot = await store.getAutopilot(tokenId);
                let acquiredDbLock = false;

                if (autopilot?.enabled) {
                    acquiredDbLock = await store.tryAcquireAutopilotLock(
                        tokenId,
                        config.tokenLockLeaseMs
                    );
                    if (!acquiredDbLock) continue;
                }

                try {
                    // Ensure agent is started in the manager
                    if (!agentManager.isActive(tokenId)) {
                        // Read on-chain data to create agent
                        const obs = await chain.observe(tokenId);
                        // TODO: read agentType from chain once Observation type includes it
                        // For now, use "dca" — the BLUEPRINT key, not the brain type "rule:dca"
                        const agentType = "dca";
                        agentManager.startAgent({
                            tokenId,
                            agentType,
                            owner: obs.agentState.owner,
                            renter: obs.renter,
                            vault: obs.agentAccount,
                            strategyParams: (await store.getStrategy(tokenId))?.strategyParams,
                        });
                        log.info(`[V3] Agent ${tokenId.toString()} started (type=${agentType})`);
                    }

                    const agent = agentManager.getAgent(tokenId);
                    if (!agent) continue;

                    // Run one cognitive cycle
                    const result = await runAgentCycle(agent);
                    log.info(
                        `[V3][${tokenId.toString()}] ${result.action}: ${result.reasoning}${result.blocked ? ` [BLOCKED: ${result.blockReason}]` : ""}`
                    );

                    // If the runtime produced a payload, submit it on-chain
                    if (result.acted && result.payload && !result.blocked) {
                        const txResult = await chain.executeAction(tokenId, result.payload);
                        log.info(
                            `[V3][${tokenId.toString()}] TX confirmed block=${txResult.receiptBlock} status=${txResult.receiptStatus}`
                        );

                        // Record execution in agent memory
                        await recordExecution(
                            agent,
                            result.action,
                            result.params ?? {},
                            result.reasoning,
                            { success: true, txHash: txResult.hash },
                        );

                        // Record in legacy run history for dashboard
                        const hash = keccak256(
                            stringToHex(
                                `${result.payload.target.toLowerCase()}:${result.payload.value.toString()}:${result.payload.data.toLowerCase()}`
                            )
                        );
                        await store.recordRun({
                            tokenId: tokenId.toString(),
                            actionType: "auto",
                            actionHash: hash,
                            simulateOk: true,
                            txHash: txResult.hash,
                        });
                    }
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    log.error(`[V3][${tokenId.toString()}] error:`, message);

                    // Record failure in agent memory if agent exists
                    const agent = agentManager.getAgent(tokenId);
                    if (agent) {
                        await recordExecution(
                            agent,
                            "unknown",
                            {},
                            "cycle error",
                            { success: false, error: message },
                        );
                    }

                    await store.recordRun({
                        tokenId: tokenId.toString(),
                        actionType: "auto",
                        actionHash: "0x00",
                        simulateOk: false,
                        error: message,
                    });
                } finally {
                    if (acquiredDbLock) {
                        await store.releaseAutopilotLock(tokenId);
                    }
                }
            }

            consecutiveErrors = 0;
        } catch (err) {
            consecutiveErrors++;
            log.error(
                `Loop error (${consecutiveErrors}/${config.maxRetries}):`,
                err instanceof Error ? err.message : err
            );

            if (consecutiveErrors >= config.maxRetries) {
                log.error("Max retries reached, backing off for 60s...");
                await sleep(60_000);
                consecutiveErrors = 0;
            }
        }

        await sleep(config.pollIntervalMs);
    }
}

// ═══════════════════════════════════════════════════════
//                   Main
// ═══════════════════════════════════════════════════════

async function main(): Promise<void> {
    await store.init();

    // Bootstrap V3 Agent Runtime modules
    bootstrapAgentModules({
        pool: store.getPool(),
        publicClient: chain.publicClient,
        chainId: config.chainId,
        agentNfaAddress: config.agentNfaAddress as `0x${string}`,
        agentNfaAbi: AgentNFAAbi,
        policyGuardV4Address: (config as any).policyGuardV4Address ?? ZERO_ADDR as `0x${string}`,
        operatorAddress: chain.account.address,
        wbnbAddress: (config as any).wbnbAddress ?? ZERO_ADDR as `0x${string}`,
    });
    log.info("[V3] Agent modules bootstrapped");

    const shutdown = async () => {
        log.info("Shutting down runner...");
        agentManager.stopAll();
        await store.close();
        process.exit(0);
    };
    process.on("SIGINT", () => { void shutdown(); });
    process.on("SIGTERM", () => { void shutdown(); });

    startApiServer();

    if (config.marketSignalSyncEnabled) {
        if (!config.marketSignalSourceUrl) {
            log.error(
                "MARKET_SIGNAL_SYNC_ENABLED=true but MARKET_SIGNAL_SOURCE_URL is empty, sync loop is disabled"
            );
        } else {
            void runMarketSignalSyncLoop();
        }
    }

    await runLoop();
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});

