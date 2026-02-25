/**
 * API Server — HTTP control plane for the SHLL Agent Runner.
 *
 * Thin dispatcher: delegates to domain-specific route handlers.
 * All route logic lives in api/routes/ modules.
 *
 * Route domains:
 *   - lifecycle.ts  → /enable, /disable
 *   - strategy.ts   → /strategy/*, /strategy/clear-goal
 *   - market.ts     → /market/signal, /market/signal/batch, /market/signal/sync
 *   - status.ts     → /status, /health, /metrics, /agent/*, /shadow/*, /autopilots
 *   - router.ts     → /v3/* (safety, admin, performance, safety-metrics)
 */

import { createServer } from "node:http";
import { ZodError } from "zod";
import type { Logger } from "../logger.js";
import type { RunnerStore } from "../store/index.js";
import type { ChainServices } from "../chain.js";
import type { AgentManager } from "../agent/manager.js";
import { getUrl, withCors, writeJson } from "../http.js";
import { handleV3Routes } from "./router.js";
import { handleLifecycleRoutes } from "./routes/lifecycle.js";
import { handleStrategyRoutes } from "./routes/strategy.js";
import { handleMarketRoutes } from "./routes/market.js";
import { handleStatusRoutes } from "./routes/status.js";
import type { SchedulerContext } from "../scheduler.js";

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
    shadowModeEnabled: boolean;
    shadowModeTokenIds: bigint[];
    shadowExecuteTx: boolean;
}

export interface ApiServerContext {
    store: RunnerStore;
    chain: ChainServices;
    config: ApiServerConfig;
    agentManager: AgentManager;
    log: Logger;
    /** Optional: scheduler context for immediate agent trigger after upsert */
    schedulerCtx?: SchedulerContext;
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

/** Mutating endpoints that require API key auth */
const AUTH_REQUIRED_PATHS = new Set([
    "/enable",
    "/disable",
    "/strategy/upsert",
    "/strategy/clear-goal",
    "/market/signal",
    "/market/signal/batch",
    "/market/signal/sync",
]);

// ═══════════════════════════════════════════════════════
//                  Unified Error Response
// ═══════════════════════════════════════════════════════

interface ErrorResponse {
    error: string;
    code?: string;
    details?: unknown;
}

function writeError(
    res: import("node:http").ServerResponse,
    statusCode: number,
    error: string,
    opts?: { code?: string; details?: unknown },
): void {
    const body: ErrorResponse = { error };
    if (opts?.code) body.code = opts.code;
    if (opts?.details) body.details = opts.details;
    writeJson(res, statusCode, body);
}

// ═══════════════════════════════════════════════════════
//                  Server
// ═══════════════════════════════════════════════════════

export function startApiServer(ctx: ApiServerContext): void {
    const { config, log } = ctx;

    const server = createServer(async (req, res) => {
        try {
            if (!req.url || !req.method) {
                writeError(res, 400, "invalid request");
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
            if (req.method === "POST" && AUTH_REQUIRED_PATHS.has(url.pathname)) {
                if (!requireApiKey(req, config.apiKey)) {
                    writeError(res, 401, "unauthorized", { code: "AUTH_REQUIRED" });
                    return;
                }
            }

            // ── Route dispatch ──────────────────────────────
            // Each handler returns true if it handled the request

            if (await handleLifecycleRoutes(req.method, url.pathname, req, res, ctx)) return;
            if (await handleStrategyRoutes(req.method, url.pathname, req, res, ctx)) return;
            if (await handleMarketRoutes(req.method, url.pathname, req, res, ctx)) return;
            if (await handleStatusRoutes(req.method, url.pathname, req, res, ctx)) return;

            // V3 modular routes (/v3/*)
            const v3Handled = await handleV3Routes(
                req.method,
                url.pathname,
                req,
                res,
                {
                    pool: ctx.store.getPool(),
                    chainId: config.chainId,
                    requireAuth: (r) => requireApiKey(r, config.apiKey),
                },
            );
            if (v3Handled) return;

            writeError(res, 404, "not found");
        } catch (err) {
            if (err instanceof ZodError) {
                writeError(res, 400, "invalid request payload", {
                    code: "VALIDATION_ERROR",
                    details: err.issues,
                });
                return;
            }
            if (err instanceof SyntaxError) {
                writeError(res, 400, "invalid JSON body", {
                    code: "JSON_PARSE_ERROR",
                    details: err.message,
                });
                return;
            }
            const message =
                err instanceof Error ? err.message : String(err);
            log.error("API error:", message);
            writeError(res, 500, "internal server error", {
                code: "INTERNAL_ERROR",
            });
        }
    });

    server.listen(config.apiPort, config.apiHost, () => {
        log.info(
            `Control API listening on http://${config.apiHost}:${config.apiPort}`,
        );
    });
}
