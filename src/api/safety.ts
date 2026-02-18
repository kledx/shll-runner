/**
 * Safety Config API — CRUD endpoints for user_safety_configs.
 *
 * Routes:
 *   GET    /v3/safety/:tokenId  — Get safety config
 *   PUT    /v3/safety/:tokenId  — Create or update safety config
 *   DELETE /v3/safety/:tokenId  — Delete safety config
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { writeJson, parseBody } from "../http.js";
import { SafetyConfigStore, type SafetyConfigInput } from "../store/safety.js";

export interface SafetyRouteContext {
    pool: Pool;
    chainId: number;
}

/**
 * Handle safety config API requests.
 * @returns true if the route was handled, false otherwise
 */
export async function handleSafetyRoutes(
    method: string,
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
    ctx: SafetyRouteContext,
): Promise<boolean> {
    // Match /v3/safety/:tokenId
    const match = pathname.match(/^\/v3\/safety\/(\d+)$/);
    if (!match) return false;

    const tokenId = match[1];
    const store = new SafetyConfigStore(ctx.pool, ctx.chainId);

    // GET — read current config
    if (method === "GET") {
        const config = await store.get(tokenId);
        if (!config) {
            writeJson(res, 404, { error: `No safety config found for tokenId ${tokenId}` });
            return true;
        }
        writeJson(res, 200, { ok: true, config });
        return true;
    }

    // PUT — create or update
    if (method === "PUT") {
        const body = await parseBody(req) as Record<string, unknown>;

        const input: SafetyConfigInput = {
            tokenId,
            chainId: ctx.chainId,
            allowedTokens: body.allowedTokens as string[] | undefined,
            blockedTokens: body.blockedTokens as string[] | undefined,
            maxTradeAmount: body.maxTradeAmount as string | undefined,
            maxDailyAmount: body.maxDailyAmount as string | undefined,
            maxSlippageBps: body.maxSlippageBps as number | undefined,
            cooldownSeconds: body.cooldownSeconds as number | undefined,
            maxRunsPerDay: body.maxRunsPerDay as number | undefined,
            allowedDexes: body.allowedDexes as string[] | undefined,
        };

        // Try update first, create if doesn't exist
        const existing = await store.get(tokenId);
        const result = existing
            ? await store.update(tokenId, input)
            : await store.create(input);

        writeJson(res, existing ? 200 : 201, { ok: true, config: result });
        return true;
    }

    // DELETE — remove config
    if (method === "DELETE") {
        const deleted = await store.delete(tokenId);
        if (!deleted) {
            writeJson(res, 404, { error: `No safety config found for tokenId ${tokenId}` });
            return true;
        }
        writeJson(res, 200, { ok: true, deleted: true });
        return true;
    }

    return false;
}
