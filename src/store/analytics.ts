/**
 * Analytics store operations — dashboard, performance, activity, template performance.
 */

import type { Pool } from "pg";
import type { AutopilotRecord, RunRecord, StrategyConfigRecord } from "../types.js";
import { toIso, mapRunRow } from "./helpers.js";
import * as autopilotOps from "./autopilot.js";
import * as strategyOps from "./strategy.js";
import { listRuns } from "./runRecords.js";

export async function getDashboard(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
): Promise<{
    autopilot: AutopilotRecord | null;
    strategy: StrategyConfigRecord | null;
    stats: {
        totalRuns: number;
        successRuns: number;
        failedRuns: number;
        latestRunAt: string | null;
        totalPnlUsd: string;
        totalGasUsed: string;
    };
    recentRuns: RunRecord[];
}> {
    const [autopilot, strategy, statsResult, recentRuns] = await Promise.all([
        autopilotOps.getAutopilot(pool, chainId, tokenId),
        strategyOps.getStrategy(pool, chainId, tokenId),
        pool.query(
            `
            SELECT
                COUNT(*)::int AS total_runs,
                COUNT(*) FILTER (WHERE error IS NULL)::int AS success_runs,
                COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS failed_runs,
                MAX(created_at) AS latest_run_at,
                COALESCE(SUM(pnl_usd::numeric) FILTER (WHERE pnl_usd IS NOT NULL), 0)::text AS total_pnl_usd,
                COALESCE(SUM(gas_used::numeric) FILTER (WHERE gas_used IS NOT NULL), 0)::text AS total_gas_used
            FROM runs
            WHERE chain_id = $1 AND token_id = $2
            `,
            [chainId, tokenId.toString()],
        ),
        listRuns(pool, chainId, tokenId, 10),
    ]);

    const statsRow = statsResult.rows[0] as Record<string, unknown> | undefined;

    return {
        autopilot,
        strategy,
        stats: {
            totalRuns: Number(statsRow?.total_runs ?? 0),
            successRuns: Number(statsRow?.success_runs ?? 0),
            failedRuns: Number(statsRow?.failed_runs ?? 0),
            latestRunAt:
                statsRow?.latest_run_at != null
                    ? toIso(statsRow.latest_run_at as Date | string)
                    : null,
            totalPnlUsd: String(statsRow?.total_pnl_usd ?? "0"),
            totalGasUsed: String(statsRow?.total_gas_used ?? "0"),
        },
        recentRuns,
    };
}

export async function getPerformance(
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

export async function getTemplatePerformance(
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

export async function getActivity(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
    options?: { limit?: number; offset?: number; brainType?: string },
): Promise<{ total: number; items: RunRecord[] }> {
    const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
    const offset = Math.max(0, options?.offset ?? 0);

    const whereParts = ["chain_id = $1", "token_id = $2"];
    const params: unknown[] = [chainId, tokenId.toString()];
    let paramIdx = 3;

    if (options?.brainType) {
        whereParts.push(`brain_type = $${paramIdx}`);
        params.push(options.brainType);
        paramIdx++;
    }

    const whereClause = whereParts.join(" AND ");

    const [countResult, itemsResult] = await Promise.all([
        pool.query(
            `SELECT COUNT(*)::int AS total FROM runs WHERE ${whereClause}`,
            params,
        ),
        pool.query(
            `SELECT * FROM runs WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
            [...params, limit, offset],
        ),
    ]);

    return {
        total: Number((countResult.rows[0] as Record<string, unknown>)?.total ?? 0),
        items: itemsResult.rows.map((row) => mapRunRow(row as Record<string, unknown>)),
    };
}
