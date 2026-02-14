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
    parseStrategyLoadPackPayload,
    parseStrategyQuery,
    parseStrategyUpsertPayload,
    parseStatusQuery,
} from "./validation.js";
import type {
    ActionPayload,
    Decision,
    MarketSignalUpsertPayload,
    MarketSignalRecord,
    Observation,
    StrategyConfigRecord,
    StrategyType,
} from "./types.js";
import { listSupportedStrategies, resolveStrategyAction } from "./strategyRegistry.js";
import { loadCapabilityPackFromFile, parseCapabilityPack } from "./capabilityPack.js";
import { sha256Hex, verifyPackSignature } from "./packSecurity.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const log = createLogger(config.logLevel);
const chain = createChainServices({
    rpcUrl: config.rpcUrl,
    rpcTimeoutMs: config.rpcTimeoutMs,
    rpcRetryCount: config.rpcRetryCount,
    operatorPrivateKey: config.operatorPrivateKey,
    agentNfaAddress: config.agentNfaAddress,
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

interface ExecutionProfile {
    source: "strategy" | "global" | "none";
    action?: ActionPayload;
    minIntervalMs: number;
    requirePositiveBalance: boolean;
    strategyReason?: string;
}

interface StrategyInputNormalized {
    tokenId: bigint;
    strategyType: StrategyType;
    target: string;
    data: `0x${string}`;
    value: bigint;
    strategyParams: Record<string, unknown>;
    minIntervalMs: number;
    requirePositiveBalance: boolean;
    maxFailures: number;
    enabled: boolean;
    source: string;
}

interface StrategyRiskLimits {
    allowedTargets: string[];
    allowedSelectors: string[];
    maxValuePerRun: bigint;
    maxRunsPerDay: number;
    maxValuePerDay: bigint;
}

interface NormalizedMarketSignalInput {
    pair: string;
    priceChangeBps: number;
    volume5m: bigint;
    uniqueTraders5m: number;
    sampledAt?: Date;
    source: string;
}

function parseBigintUnknown(value: unknown, fallback: bigint): bigint {
    try {
        if (typeof value === "bigint") return value;
        if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
        if (typeof value === "string" && value.trim()) return BigInt(value.trim());
    } catch {
        // fall through
    }
    return fallback;
}

function parseIntUnknown(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
    if (typeof value === "string" && value.trim()) {
        const parsed = Number.parseInt(value.trim(), 10);
        if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    return fallback;
}

function parseRiskLimits(strategy: StrategyConfigRecord): StrategyRiskLimits {
    const params = strategy.strategyParams ?? {};
    const allowedTargetsRaw = Array.isArray(params.allowedTargets)
        ? (params.allowedTargets as unknown[])
        : [];
    const allowedSelectorsRaw = Array.isArray(params.allowedSelectors)
        ? (params.allowedSelectors as unknown[])
        : [];

    const allowedTargets = allowedTargetsRaw
        .filter((v): v is string => typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v))
        .map((v) => v.toLowerCase());
    const allowedSelectors = allowedSelectorsRaw
        .filter((v): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{8}$/.test(v))
        .map((v) => v.toLowerCase());

    return {
        allowedTargets,
        allowedSelectors,
        maxValuePerRun: parseBigintUnknown(params.maxValuePerRun, 0n),
        maxRunsPerDay: parseIntUnknown(params.maxRunsPerDay, config.defaultMaxRunsPerDay),
        maxValuePerDay: parseBigintUnknown(params.maxValuePerDay, config.defaultMaxValuePerDay),
    };
}

function actionSelector(data: string): string {
    if (!data || data === "0x" || data.length < 10) return "0x";
    return data.slice(0, 10).toLowerCase();
}

function enforceStrategySandbox(
    strategy: StrategyConfigRecord,
    action: ActionPayload
): { ok: boolean; reason?: string; limits: StrategyRiskLimits } {
    const limits = parseRiskLimits(strategy);

    if (limits.allowedTargets.length > 0) {
        const target = action.target.toLowerCase();
        if (!limits.allowedTargets.includes(target)) {
            return {
                ok: false,
                reason: `Target blocked by sandbox: ${action.target}`,
                limits,
            };
        }
    }

    if (limits.allowedSelectors.length > 0) {
        const selector = actionSelector(action.data);
        if (!limits.allowedSelectors.includes(selector)) {
            return {
                ok: false,
                reason: `Selector blocked by sandbox: ${selector}`,
                limits,
            };
        }
    }

    if (limits.maxValuePerRun > 0n && action.value > limits.maxValuePerRun) {
        return {
            ok: false,
            reason: `Value exceeds maxValuePerRun (${action.value.toString()} > ${limits.maxValuePerRun.toString()})`,
            limits,
        };
    }

    return { ok: true, limits };
}

function normalizeStrategyInput(
    input: {
        tokenId: string | number | bigint;
        strategyType?: StrategyType;
        target: string;
        data?: string;
        value?: string | number | bigint;
        strategyParams?: Record<string, unknown>;
        minIntervalMs?: number;
        requirePositiveBalance?: boolean;
        maxFailures?: number;
        enabled?: boolean;
    },
    source: string
): StrategyInputNormalized {
    return {
        tokenId: BigInt(input.tokenId),
        strategyType: input.strategyType ?? "fixed_action",
        target: input.target,
        data: (input.data ?? "0x") as `0x${string}`,
        value: BigInt(input.value ?? 0),
        strategyParams: input.strategyParams ?? {},
        minIntervalMs: input.minIntervalMs ?? config.minActionIntervalMs,
        requirePositiveBalance: input.requirePositiveBalance ?? config.requirePositiveBalance,
        maxFailures: input.maxFailures ?? Math.max(1, config.strategyMaxFailuresDefault),
        enabled: input.enabled ?? true,
        source,
    };
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

async function buildStrategyRuntimeContext(
    strategy: StrategyConfigRecord
): Promise<{ nowMs: number; marketSignals: Map<string, MarketSignalRecord> }> {
    const nowMs = Date.now();
    if (strategy.strategyType !== "hotpump_watchlist") {
        return { nowMs, marketSignals: new Map() };
    }

    const pairs = parseWatchlistPairs(strategy);
    if (pairs.length === 0) {
        return { nowMs, marketSignals: new Map() };
    }

    const signals = await store.listMarketSignals(pairs);
    const signalMap = new Map<string, MarketSignalRecord>();
    for (const signal of signals) {
        signalMap.set(signal.pair.toLowerCase(), signal);
    }

    return { nowMs, marketSignals: signalMap };
}

function makeSyntheticObservation(tokenId: bigint): Observation {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    return {
        tokenId,
        agentState: {
            balance: 1n,
            status: 0,
            owner: ZERO_ADDR as Address,
            logicAddress: ZERO_ADDR as Address,
            lastActionTimestamp: 0n,
        },
        agentAccount: ZERO_ADDR as Address,
        renter: ZERO_ADDR as Address,
        renterExpires: 0n,
        operator: ZERO_ADDR as Address,
        operatorExpires: 0n,
        blockNumber: 0n,
        blockTimestamp: nowSec,
        timestamp: Date.now(),
    };
}

async function resolveExecutionProfile(
    tokenId: bigint,
    strategy: StrategyConfigRecord | null,
    obs?: Observation
): Promise<ExecutionProfile> {
    if (strategy) {
        if (!strategy.enabled) {
            return {
                source: "none",
                minIntervalMs: strategy.minIntervalMs,
                requirePositiveBalance: strategy.requirePositiveBalance,
                strategyReason: "strategy disabled",
            };
        }
        if (obs) {
            const context = await buildStrategyRuntimeContext(strategy);
            const resolved = resolveStrategyAction(strategy, obs, context);
            return {
                source: "strategy",
                action: resolved.action,
                minIntervalMs: strategy.minIntervalMs,
                requirePositiveBalance: strategy.requirePositiveBalance,
                strategyReason: resolved.reason,
            };
        }
        return {
            source: "strategy",
            minIntervalMs: strategy.minIntervalMs,
            requirePositiveBalance: strategy.requirePositiveBalance,
            strategyReason: "strategy loaded",
        };
    }

    if (config.autoActionEnabled && tokenId === config.tokenId) {
        return {
            source: "global",
            action: {
                target: config.autoActionTarget,
                value: config.autoActionValue,
                data: config.autoActionData,
            },
            minIntervalMs: config.minActionIntervalMs,
            requirePositiveBalance: config.requirePositiveBalance,
        };
    }

    return {
        source: "none",
        minIntervalMs: config.minActionIntervalMs,
        requirePositiveBalance: config.requirePositiveBalance,
        strategyReason: "no strategy",
    };
}

function reason(
    obs: Observation,
    profile: ExecutionProfile,
    strategy: StrategyConfigRecord | null
): Decision {
    if (obs.agentState.status !== 0) {
        return {
            shouldAct: false,
            reason: `Agent status is ${obs.agentState.status} (not Active)`,
        };
    }

    if (obs.renter.toLowerCase() === ZERO_ADDR) {
        return { shouldAct: false, reason: "No active renter" };
    }

    if (obs.operator.toLowerCase() !== chain.account.address.toLowerCase()) {
        return {
            shouldAct: false,
            reason: `Not authorized operator (current: ${obs.operator})`,
        };
    }

    if (obs.operatorExpires < obs.blockTimestamp) {
        return { shouldAct: false, reason: "Operator expired" };
    }

    if (profile.requirePositiveBalance && obs.agentState.balance === 0n) {
        return { shouldAct: false, reason: "Agent account balance is zero" };
    }

    if (profile.source === "none" || !profile.action) {
        if (strategy && !strategy.enabled) {
            return {
                shouldAct: false,
                reason: `Strategy disabled after failures (${strategy.failureCount}/${strategy.maxFailures})`,
            };
        }
        return {
            shouldAct: false,
            reason: `Idle - ${profile.strategyReason ?? "no execution profile"}, balance: ${formatEther(obs.agentState.balance)} BNB`,
        };
    }

    if (profile.action.target.toLowerCase() === ZERO_ADDR) {
        return { shouldAct: false, reason: "Idle - target is not configured" };
    }

    const nowMs = Number(obs.blockTimestamp) * 1000;
    const strategyLastRunMs =
        strategy?.lastRunAt != null ? new Date(strategy.lastRunAt).getTime() : null;
    if (strategyLastRunMs != null && Number.isFinite(strategyLastRunMs)) {
        const elapsedMs = nowMs - strategyLastRunMs;
        if (elapsedMs < profile.minIntervalMs) {
            const waitMs = profile.minIntervalMs - elapsedMs;
            return {
                shouldAct: false,
                reason: `Cooldown active (${Math.ceil(waitMs / 1000)}s remaining)`,
            };
        }
    } else {
        const lastActionMs = Number(obs.agentState.lastActionTimestamp) * 1000;
        if (
            obs.agentState.lastActionTimestamp > 0n &&
            nowMs - lastActionMs < profile.minIntervalMs
        ) {
            const waitMs = profile.minIntervalMs - (nowMs - lastActionMs);
            return {
                shouldAct: false,
                reason: `Cooldown active (${Math.ceil(waitMs / 1000)}s remaining)`,
            };
        }
    }

    return {
        shouldAct: true,
        reason: `Action ready - tokenId: ${obs.tokenId.toString()}, balance: ${formatEther(obs.agentState.balance)} BNB, block: ${obs.blockNumber.toString()}`,
        action: profile.action,
    };
}

function isStateInvalidForAutopilot(reasonText: string): boolean {
    return (
        reasonText === "No active renter" ||
        reasonText.startsWith("Not authorized operator") ||
        reasonText === "Operator expired"
    );
}

function actionHash(target: string, value: bigint, data: string): string {
    return keccak256(stringToHex(`${target.toLowerCase()}:${value.toString()}:${data.toLowerCase()}`));
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
                    url.pathname === "/strategy/load-pack" ||
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

            if (req.method === "POST" && url.pathname === "/strategy/upsert") {
                const body = await parseBody(req);
                const payload = parseStrategyUpsertPayload(body);
                const normalized = normalizeStrategyInput(payload, "api");
                const tokenId = normalized.tokenId;

                if (!isTokenAllowed(tokenId)) {
                    writeJson(res, 400, {
                        error: `tokenId not allowed by runner: ${tokenId.toString()}`,
                        allowedTokenIds: [...allowedTokenIdSet],
                    });
                    return;
                }

                const strategy = await store.upsertStrategy({
                    tokenId,
                    strategyType: normalized.strategyType,
                    target: normalized.target,
                    data: normalized.data,
                    value: normalized.value,
                    strategyParams: normalized.strategyParams,
                    source: normalized.source,
                    minIntervalMs: normalized.minIntervalMs,
                    requirePositiveBalance: normalized.requirePositiveBalance,
                    maxFailures: normalized.maxFailures,
                    enabled: normalized.enabled,
                });

                writeJson(res, 200, { ok: true, strategy });
                return;
            }

            if (req.method === "POST" && url.pathname === "/strategy/load-pack") {
                const body = await parseBody(req);
                const payload = parseStrategyLoadPackPayload(body);
                const filePath = payload.filePath ?? config.capabilityPackPath;
                if (!payload.pack && !filePath) {
                    writeJson(res, 400, {
                        error: "Either pack or filePath is required (or set CAPABILITY_PACK_PATH)",
                    });
                    return;
                }

                const pack = payload.pack
                    ? parseCapabilityPack(payload.pack)
                    : await loadCapabilityPackFromFile(filePath as string);
                const packSourceLabel = payload.pack
                    ? "pack:inline"
                    : `pack:${filePath as string}`;
                const computedHash = sha256Hex(pack);
                if (payload.hash) {
                    const expectedHash = payload.hash.toLowerCase().replace(/^0x/, "");
                    if (computedHash !== expectedHash) {
                        writeJson(res, 400, {
                            error: "Capability pack hash mismatch",
                            expectedHash,
                            computedHash,
                        });
                        return;
                    }
                }

                const signatureRequired =
                    config.capabilityPackRequireSignature || !!payload.signature;
                const signature = payload.signature;
                const publicKey = payload.publicKey ?? config.capabilityPackPublicKey;
                if (signatureRequired) {
                    if (!signature) {
                        writeJson(res, 400, {
                            error: "Capability pack signature is required",
                        });
                        return;
                    }
                    if (!publicKey) {
                        writeJson(res, 400, {
                            error: "Capability pack public key is required",
                        });
                        return;
                    }
                    const verified = verifyPackSignature({
                        pack,
                        signature,
                        publicKeyPem: publicKey,
                    });
                    if (!verified) {
                        writeJson(res, 400, {
                            error: "Capability pack signature verification failed",
                        });
                        return;
                    }
                }

                const dryRun = payload.dryRun ?? false;
                const applied: string[] = [];
                const skipped: Array<{ tokenId: string; reason: string }> = [];

                for (const item of pack.strategies) {
                    if (!isTokenAllowed(item.tokenId)) {
                        skipped.push({
                            tokenId: item.tokenId.toString(),
                            reason: "token not in allowlist",
                        });
                        continue;
                    }
                    const normalized = normalizeStrategyInput(item, packSourceLabel);
                    if (!dryRun) {
                        await store.upsertStrategy({
                            tokenId: normalized.tokenId,
                            strategyType: normalized.strategyType,
                            target: normalized.target,
                            data: normalized.data,
                            value: normalized.value,
                            strategyParams: normalized.strategyParams,
                            source: normalized.source,
                            minIntervalMs: normalized.minIntervalMs,
                            requirePositiveBalance: normalized.requirePositiveBalance,
                            maxFailures: normalized.maxFailures,
                            enabled: normalized.enabled,
                        });
                    }
                    applied.push(item.tokenId.toString());
                }

                writeJson(res, 200, {
                    ok: true,
                    dryRun,
                    filePath,
                    packName: pack.name,
                    packVersion: pack.version,
                    packHash: computedHash,
                    appliedCount: applied.length,
                    skippedCount: skipped.length,
                    appliedTokenIds: applied,
                    skipped,
                });
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

            if (req.method === "GET" && url.pathname === "/strategy/supported") {
                writeJson(res, 200, { ok: true, items: listSupportedStrategies() });
                return;
            }

            if (req.method === "GET" && url.pathname === "/strategy/evaluate") {
                const query = parseStrategyQuery({
                    tokenId: url.searchParams.get("tokenId") ?? undefined,
                });
                if (query.tokenId == null) {
                    writeJson(res, 400, { error: "tokenId is required" });
                    return;
                }
                const tokenId = BigInt(query.tokenId);
                const strategy = await store.getStrategy(tokenId);
                if (!strategy) {
                    writeJson(res, 404, {
                        error: `strategy not found for tokenId ${tokenId.toString()}`,
                    });
                    return;
                }

                const context = await buildStrategyRuntimeContext(strategy);
                const syntheticObs = makeSyntheticObservation(tokenId);
                const resolved = resolveStrategyAction(strategy, syntheticObs, context);

                writeJson(res, 200, {
                    ok: true,
                    tokenId: tokenId.toString(),
                    strategyType: strategy.strategyType,
                    enabled: strategy.enabled,
                    marketSignalCount: context.marketSignals.size,
                    matched: !!resolved.action,
                    reason: resolved.reason,
                    action: resolved.action ?? null,
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

            writeJson(res, 404, { error: "not found" });
        } catch (err) {
            if (err instanceof ZodError) {
                writeJson(res, 400, {
                    error: "invalid request payload",
                    details: err.issues,
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

async function runLoop(): Promise<void> {
    log.info("=== SHLL Agent Runner ===");
    log.info(`Operator: ${chain.account.address}`);
    log.info(`Agent NFA: ${config.agentNfaAddress}`);
    log.info(`Default token ID: ${config.tokenId.toString()}`);
    log.info(`Allowed token IDs: ${[...allowedTokenIdSet].join(", ")}`);
    log.info(`Poll interval: ${config.pollIntervalMs}ms`);
    log.info(`Auto action: ${config.autoActionEnabled ? "enabled" : "disabled"}`);
    log.info(
        `Market signal sync: ${config.marketSignalSyncEnabled ? "enabled" : "disabled"}`
    );
    log.info(
        `Store backend: postgres (${config.databaseUrl ? "DATABASE_URL" : `${config.pgHost}:${config.pgPort}/${config.pgDatabase}`})`
    );
    log.info("");

    let consecutiveErrors = 0;

    while (true) {
        try {
            lastLoopAt = Date.now();
            const tokenSet = new Set<string>();
            for (const tokenId of await store.listEnabledTokenIds()) {
                tokenSet.add(tokenId.toString());
            }
            if (config.autoActionEnabled) {
                tokenSet.add(config.tokenId.toString());
            }

            if (tokenSet.size === 0) {
                log.info("[Tick] idle - no enabled autopilot token");
            }

            for (const tokenIdRaw of tokenSet) {
                const tokenId = BigInt(tokenIdRaw);
                const autopilot = await store.getAutopilot(tokenId);
                const strategy = await store.getStrategy(tokenId);
                let acquiredDbLock = false;

                if (autopilot?.enabled) {
                    acquiredDbLock = await store.tryAcquireAutopilotLock(
                        tokenId,
                        config.tokenLockLeaseMs
                    );
                    if (!acquiredDbLock) {
                        continue;
                    }
                }

                try {
                    const obs = await chain.observe(tokenId);
                    const profile = await resolveExecutionProfile(tokenId, strategy, obs);
                    const decision = reason(obs, profile, strategy);
                    log.info(`[Tick][${tokenId.toString()}] ${decision.reason}`);

                    if (!decision.shouldAct) {
                        if (autopilot?.enabled && isStateInvalidForAutopilot(decision.reason)) {
                            await store.disable(tokenId, decision.reason);
                        }
                        continue;
                    }

                    if (!decision.action) {
                        continue;
                    }

                    if (strategy) {
                        const sandbox = enforceStrategySandbox(strategy, decision.action);
                        let limits: StrategyRiskLimits;
                        if (!sandbox.ok) {
                            log.error(`[Tick][${tokenId.toString()}] ${sandbox.reason}`);
                            await store.recordRun({
                                tokenId: tokenId.toString(),
                                actionType: "auto",
                                actionHash: actionHash(
                                    decision.action.target,
                                    decision.action.value,
                                    decision.action.data
                                ),
                                simulateOk: false,
                                error: sandbox.reason,
                            });
                            continue;
                        }
                        limits = sandbox.limits;

                        const budgetCheck = await store.checkStrategyBudget({
                            tokenId,
                            nextValue: decision.action.value,
                            maxRunsPerDay: limits.maxRunsPerDay,
                            maxValuePerDay: limits.maxValuePerDay,
                        });
                        if (!budgetCheck.ok) {
                            log.info(
                                `[Tick][${tokenId.toString()}] budget gate: ${budgetCheck.reason}`
                            );
                            continue;
                        }
                    }

                    const hash = actionHash(
                        decision.action.target,
                        decision.action.value,
                        decision.action.data
                    );
                    const result = await chain.executeAction(tokenId, decision.action);
                    await store.recordRun({
                        tokenId: tokenId.toString(),
                        actionType: "auto",
                        actionHash: hash,
                        simulateOk: true,
                        txHash: result.hash,
                    });
                    await store.recordStrategySuccess(tokenId);
                    if (strategy) {
                        await store.consumeStrategyBudget(tokenId, decision.action.value);
                    }
                    log.info(
                        `[Act][${tokenId.toString()}] TX confirmed in block ${result.receiptBlock}, status: ${result.receiptStatus}`
                    );
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    log.error(`[Tick][${tokenId.toString()}] execution failed:`, message);
                    const failTarget = strategy?.target ?? config.autoActionTarget;
                    const failValue = strategy ? BigInt(strategy.value) : config.autoActionValue;
                    const failData = strategy?.data ?? config.autoActionData;
                    await store.recordRun({
                        tokenId: tokenId.toString(),
                        actionType: "auto",
                        actionHash: actionHash(failTarget, failValue, failData),
                        simulateOk: false,
                        error: message,
                    });
                    const updated = await store.recordStrategyFailure(tokenId, message);
                    if (updated && !updated.enabled) {
                        if (autopilot?.enabled) {
                            await store.disable(
                                tokenId,
                                `strategy failure threshold reached (${updated.failureCount}/${updated.maxFailures})`
                            );
                        }
                        log.error(
                            `[Tick][${tokenId.toString()}] strategy disabled after failures (${updated.failureCount}/${updated.maxFailures})`
                        );
                    }
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

async function main(): Promise<void> {
    await store.init();
    const shutdown = async () => {
        log.info("Shutting down runner...");
        await store.close();
        process.exit(0);
    };
    process.on("SIGINT", () => {
        void shutdown();
    });
    process.on("SIGTERM", () => {
        void shutdown();
    });
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
