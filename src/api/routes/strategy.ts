/**
 * Strategy routes — /strategy/upsert, /strategy/clear-goal, /strategy (GET)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiServerContext } from "../server.js";
import { parseBody, writeJson } from "../../http.js";
import { parseStrategyUpsertPayload, parseStrategyQuery } from "../../validation.js";
import { runSingleToken, resetBlockedCount } from "../../scheduler.js";

export async function handleStrategyRoutes(
    method: string,
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
    ctx: ApiServerContext,
): Promise<boolean> {
    const { store, agentManager, log } = ctx;

    // ── Strategy Upsert ────────────────────────────
    if (method === "POST" && pathname === "/strategy/upsert") {
        const body = await parseBody(req);
        const payload = parseStrategyUpsertPayload(body);
        if (!payload.strategyType) {
            writeJson(res, 400, {
                error: "strategyType is required",
            });
            return true;
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

        // Extract tradingGoal for immediate trigger check below
        const goal = (payload.strategyParams as Record<string, unknown> | undefined)?.tradingGoal;

        writeJson(res, 200, { ok: true, strategy: record });

        // Trigger immediate agent cycle if tradingGoal was set, and always invalidate cache
        if (ctx.schedulerCtx) {
            const tid = BigInt(payload.tokenId);

            // Stop old cached agent so runtime rebuilds with new strategy parameters
            ctx.schedulerCtx.agentManager.stopAgent(tid);

            if (goal) {
                // Reset blocked backoff state so the new instruction gets a fresh start
                resetBlockedCount(tid);

                log.info(`[API] Triggering immediate cycle for token ${tid.toString()} (blocked counter reset)`);
                void runSingleToken(tid, ctx.schedulerCtx, { skipCadenceCheck: true }).catch(
                    (err) => log.error(`[API] Immediate trigger error for ${tid.toString()}:`, err instanceof Error ? err.message : err),
                );
            }
        }
        return true;
    }

    // ── Strategy Clear Goal ──────────────────────
    if (method === "POST" && pathname === "/strategy/clear-goal") {
        const body = await parseBody(req);
        const tokenId = BigInt((body as Record<string, string>).tokenId ?? "0");
        if (!tokenId) {
            writeJson(res, 400, { error: "tokenId is required" });
            return true;
        }
        await store.clearTradingGoal(tokenId);
        agentManager.stopAgent(tokenId);
        log.info(`[API] Cleared tradingGoal for token ${tokenId.toString()}`);
        writeJson(res, 200, { ok: true, tokenId: tokenId.toString() });
        return true;
    }

    // ── Strategy Query ─────────────────────────────
    if (method === "GET" && pathname === "/strategy") {
        const url = new URL(req.url ?? "/", "http://localhost");
        const query = parseStrategyQuery({
            tokenId: url.searchParams.get("tokenId") ?? undefined,
        });
        if (query.tokenId != null) {
            const tokenId = BigInt(query.tokenId);
            const strategy = await store.getStrategy(tokenId);
            writeJson(res, 200, {
                ok: true,
                tokenId: tokenId.toString(),
                strategy,
            });
            return true;
        }
        writeJson(res, 200, {
            ok: true,
            items: await store.listStrategies(),
        });
        return true;
    }

    return false;
}
