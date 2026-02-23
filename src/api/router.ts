/**
 * V3.0 API Router — Dispatches new V3.0 endpoints to their handlers.
 *
 * This module adds V3.0 routes alongside the existing monolithic API.
 * All V3.0 routes are prefixed with /v3/ to avoid conflicts.
 *
 * Integration:
 *   Call handleV3Routes() from the existing HTTP request handler
 *   in index.ts. If it returns true, the request was handled.
 *
 * Routes:
 *   /v3/safety/:tokenId            — Safety config CRUD
 *   /v3/admin/blueprints[/:type]   — Blueprint management
 *   /v3/agents                     — List active agents (future)
 *   /v3/agents/:tokenId/run        — Trigger agent cycle (future)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { handleSafetyRoutes } from "./safety.js";
import { handleAdminRoutes } from "./admin.js";
import { handlePerformanceRoutes } from "./performance.js";

export interface V3RouterContext {
    pool: Pool;
    chainId: number;
    requireAuth: (req: IncomingMessage) => boolean;
}

/**
 * Try to handle a V3.0 API request.
 *
 * @returns true if the request was handled, false if not a V3 route
 */
export async function handleV3Routes(
    method: string,
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
    ctx: V3RouterContext,
): Promise<boolean> {
    // Only handle /v3/* routes
    if (!pathname.startsWith("/v3/")) return false;

    // All mutating V3 routes require auth
    if (method !== "GET" && !ctx.requireAuth(req)) {
        const { writeJson } = await import("../http.js");
        writeJson(res, 401, { error: "unauthorized" });
        return true;
    }

    // Safety config routes
    const safetyHandled = await handleSafetyRoutes(method, pathname, req, res, {
        pool: ctx.pool,
        chainId: ctx.chainId,
    });
    if (safetyHandled) return true;

    // Admin blueprint routes (all require auth, including GET)
    if (pathname.startsWith("/v3/admin/")) {
        if (!ctx.requireAuth(req)) {
            const { writeJson } = await import("../http.js");
            writeJson(res, 401, { error: "unauthorized" });
            return true;
        }

        const adminHandled = await handleAdminRoutes(method, pathname, req, res, {
            pool: ctx.pool,
        });
        if (adminHandled) return true;
    }

    // P-2026-027: Performance dashboard routes (read-only, no auth required)
    const perfHandled = await handlePerformanceRoutes(method, pathname, req, res, {
        pool: ctx.pool,
        chainId: ctx.chainId,
    });
    if (perfHandled) return true;

    return false;
}
