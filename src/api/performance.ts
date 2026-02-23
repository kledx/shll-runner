/**
 * Performance API — Agent performance metrics endpoints.
 *
 * Routes:
 *   GET /v3/agents/:tokenId/performance — Single agent performance data
 *   GET /v3/performance/templates       — Template-level aggregated performance
 *
 * @module P-2026-027
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { writeJson } from "../http.js";

export interface PerformanceRouteContext {
    pool: Pool;
    chainId: number;
}

/**
 * Handle performance API requests.
 * @returns true if the route was handled, false otherwise
 */
export async function handlePerformanceRoutes(
    method: string,
    pathname: string,
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: PerformanceRouteContext,
): Promise<boolean> {
    // Only handle GET requests
    if (method !== "GET") return false;

    // Match /v3/agents/:tokenId/performance
    const agentMatch = pathname.match(/^\/v3\/agents\/(\d+)\/performance$/);
    if (agentMatch) {
        const tokenId = BigInt(agentMatch[1]);
        const result = await performanceQuery(ctx.pool, ctx.chainId, tokenId);
        writeJson(res, 200, result);
        return true;
    }

    // Match /v3/performance/templates
    if (pathname === "/v3/performance/templates") {
        const result = await templatePerformanceQuery(ctx.pool, ctx.chainId);
        writeJson(res, 200, result);
        return true;
    }

    return false;
}

// Direct query functions to avoid re-initializing RunnerStore
// (we only need the pool, not the full store lifecycle)

function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function performanceQuery(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
): Promise<{
    totalRuns: number;
    successRuns: number;
    failedRuns: number;
    successRate: number;
    totalPnlUsd: string;
    totalGasUsed: string;
    maxDrawdownUsd: string;
    avgDailyRuns: number;
    firstRunAt: string | null;
    lastRunAt: string | null;
    dailyPnl: { date: string; pnl: string; runs: number }[];
}> {
    const [statsResult, dailyResult] = await Promise.all([
        pool.query(
            `
            SELECT
                COUNT(*)::int AS total_runs,
                COUNT(*) FILTER (WHERE error IS NULL)::int AS success_runs,
                COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS failed_runs,
                COALESCE(SUM(pnl_usd::numeric) FILTER (WHERE pnl_usd IS NOT NULL), 0)::text AS total_pnl_usd,
                COALESCE(SUM(gas_used::numeric) FILTER (WHERE gas_used IS NOT NULL), 0)::text AS total_gas_used,
                MIN(created_at) AS first_run_at,
                MAX(created_at) AS last_run_at
            FROM runs
            WHERE chain_id = $1 AND token_id = $2
            `,
            [chainId, tokenId.toString()],
        ),
        pool.query(
            `
            SELECT
                created_at::date::text AS date,
                COALESCE(SUM(pnl_usd::numeric) FILTER (WHERE pnl_usd IS NOT NULL), 0)::text AS pnl,
                COUNT(*)::int AS runs
            FROM runs
            WHERE chain_id = $1 AND token_id = $2
            GROUP BY created_at::date
            ORDER BY created_at::date ASC
            LIMIT 90
            `,
            [chainId, tokenId.toString()],
        ),
    ]);

    const s = statsResult.rows[0] as Record<string, unknown> | undefined;
    const totalRuns = Number(s?.total_runs ?? 0);
    const successRuns = Number(s?.success_runs ?? 0);
    const failedRuns = Number(s?.failed_runs ?? 0);

    const firstRunAt = s?.first_run_at != null ? toIso(s.first_run_at as Date | string) : null;
    const lastRunAt = s?.last_run_at != null ? toIso(s.last_run_at as Date | string) : null;
    let daysActive = 1;
    if (firstRunAt && lastRunAt) {
        daysActive = Math.max(1, Math.ceil(
            (new Date(lastRunAt).getTime() - new Date(firstRunAt).getTime()) / (1000 * 60 * 60 * 24),
        ));
    }

    const dailyPnl = dailyResult.rows.map((row: Record<string, unknown>) => ({
        date: String(row.date),
        pnl: String(row.pnl),
        runs: Number(row.runs),
    }));

    // Compute max drawdown
    let peak = 0;
    let maxDrawdown = 0;
    let cumPnl = 0;
    for (const day of dailyPnl) {
        cumPnl += Number(day.pnl);
        if (cumPnl > peak) peak = cumPnl;
        const drawdown = peak - cumPnl;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return {
        totalRuns,
        successRuns,
        failedRuns,
        successRate: totalRuns > 0 ? Math.round((successRuns / totalRuns) * 10000) / 100 : 0,
        totalPnlUsd: String(s?.total_pnl_usd ?? "0"),
        totalGasUsed: String(s?.total_gas_used ?? "0"),
        maxDrawdownUsd: maxDrawdown.toFixed(2),
        avgDailyRuns: Math.round((totalRuns / daysActive) * 100) / 100,
        firstRunAt,
        lastRunAt,
        dailyPnl,
    };
}

async function templatePerformanceQuery(
    pool: Pool,
    chainId: number,
): Promise<{
    templates: {
        brainType: string;
        totalTokens: number;
        totalRuns: number;
        successRate: number;
        totalPnlUsd: string;
    }[];
}> {
    const result = await pool.query(
        `
        SELECT
            brain_type,
            COUNT(DISTINCT token_id)::int AS total_tokens,
            COUNT(*)::int AS total_runs,
            COUNT(*) FILTER (WHERE error IS NULL)::int AS success_runs,
            COALESCE(SUM(pnl_usd::numeric) FILTER (WHERE pnl_usd IS NOT NULL), 0)::text AS total_pnl_usd
        FROM runs
        WHERE chain_id = $1 AND brain_type IS NOT NULL
        GROUP BY brain_type
        ORDER BY total_runs DESC
        `,
        [chainId],
    );

    return {
        templates: result.rows.map((row: Record<string, unknown>) => ({
            brainType: String(row.brain_type),
            totalTokens: Number(row.total_tokens),
            totalRuns: Number(row.total_runs),
            successRate:
                Number(row.total_runs) > 0
                    ? Math.round((Number(row.success_runs) / Number(row.total_runs)) * 10000) / 100
                    : 0,
            totalPnlUsd: String(row.total_pnl_usd),
        })),
    };
}
