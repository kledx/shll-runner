/**
 * Safety Metrics API — Agent safety SLA indicators.
 *
 * Routes:
 *   GET /v3/safety/:tokenId/metrics    — 5 core SLA indicators
 *   GET /v3/safety/:tokenId/timeline   — Safety trend (day/week/month)
 *   GET /v3/safety/:tokenId/violations — Recent policy violation events
 *
 * @module P-2026-032
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { writeJson } from "../http.js";

export interface SafetyMetricsRouteContext {
    pool: Pool;
    chainId: number;
}

/**
 * Handle safety metrics API requests.
 * @returns true if the route was handled, false otherwise
 */
export async function handleSafetyMetricsRoutes(
    method: string,
    pathname: string,
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: SafetyMetricsRouteContext,
): Promise<boolean> {
    // Only handle GET requests
    if (method !== "GET") return false;

    // Match /v3/safety/:tokenId/metrics
    const metricsMatch = pathname.match(/^\/v3\/safety\/(\d+)\/metrics$/);
    if (metricsMatch) {
        const tokenId = BigInt(metricsMatch[1]);
        const result = await safetyMetricsQuery(ctx.pool, ctx.chainId, tokenId);
        writeJson(res, 200, result);
        return true;
    }

    // Match /v3/safety/:tokenId/timeline
    const timelineMatch = pathname.match(/^\/v3\/safety\/(\d+)\/timeline$/);
    if (timelineMatch) {
        const tokenId = BigInt(timelineMatch[1]);
        const url = new URL(pathname, "http://localhost");
        // Parse period from raw URL query string
        const rawUrl = _req.url ?? pathname;
        const qIdx = rawUrl.indexOf("?");
        const qStr = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "";
        const params = new URLSearchParams(qStr);
        const period = params.get("period") ?? "day";
        if (!["day", "week", "month"].includes(period)) {
            writeJson(res, 400, { error: "period must be day, week, or month" });
            return true;
        }
        const result = await safetyTimelineQuery(
            ctx.pool,
            ctx.chainId,
            tokenId,
            period as "day" | "week" | "month",
        );
        writeJson(res, 200, result);
        return true;
    }

    // Match /v3/safety/:tokenId/violations
    const violationsMatch = pathname.match(/^\/v3\/safety\/(\d+)\/violations$/);
    if (violationsMatch) {
        const tokenId = BigInt(violationsMatch[1]);
        const rawUrl = _req.url ?? pathname;
        const qIdx = rawUrl.indexOf("?");
        const qStr = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "";
        const params = new URLSearchParams(qStr);
        const limit = Math.min(Math.max(1, Number(params.get("limit") ?? 50)), 200);
        const result = await safetyViolationsQuery(ctx.pool, ctx.chainId, tokenId, limit);
        writeJson(res, 200, result);
        return true;
    }

    return false;
}

// ═══════════════════════════════════════════════════════
//           Direct query functions
// ═══════════════════════════════════════════════════════

function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function safetyMetricsQuery(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
): Promise<{
    safeExecutionRate: number;
    totalActions: number;
    safeSuccess: number;
    policyRejectionRate: number;
    totalViolations: number;
    violationsByCode: { code: string; count: number }[];
    highRiskFailureRate: number;
    highRiskFailures: number;
    manualInterventionRate: number;
    manualInterventions: number;
    totalRuns: number;
    lastRunAt: string | null;
    uptimeProxy: boolean;
}> {
    const [statsResult, violationsResult] = await Promise.all([
        pool.query(
            `
            SELECT
                COUNT(*) FILTER (
                    WHERE simulate_ok = true AND error IS NULL
                    AND intent_type IS DISTINCT FROM 'wait'
                    AND intent_type IS DISTINCT FROM 'error'
                )::int AS safe_success,
                COUNT(*) FILTER (
                    WHERE intent_type IS DISTINCT FROM 'wait'
                    AND intent_type IS DISTINCT FROM 'error'
                )::int AS total_actions,
                COUNT(*) FILTER (WHERE violation_code IS NOT NULL)::int AS total_violations,
                COUNT(*) FILTER (
                    WHERE violation_code IN ('HARD_POLICY_REJECTED','HARD_SIMULATION_REVERTED')
                )::int AS high_risk_failures,
                COUNT(*) FILTER (
                    WHERE error_code IN (
                        'BUSINESS_CIRCUIT_BREAKER',
                        'MODEL_LOW_CONFIDENCE',
                        'BUSINESS_AGENT_PAUSED',
                        'BUSINESS_AUTOPAUSE_THRESHOLD'
                    )
                )::int AS manual_interventions,
                COUNT(*)::int AS total_runs,
                MAX(created_at) AS last_run_at
            FROM runs
            WHERE chain_id = $1 AND token_id = $2
            `,
            [chainId, tokenId.toString()],
        ),
        pool.query(
            `
            SELECT violation_code AS code, COUNT(*)::int AS count
            FROM runs
            WHERE chain_id = $1 AND token_id = $2 AND violation_code IS NOT NULL
            GROUP BY violation_code
            ORDER BY count DESC
            `,
            [chainId, tokenId.toString()],
        ),
    ]);

    const s = statsResult.rows[0] as Record<string, unknown> | undefined;
    const totalActions = Number(s?.total_actions ?? 0);
    const safeSuccess = Number(s?.safe_success ?? 0);
    const totalViolations = Number(s?.total_violations ?? 0);
    const highRiskFailures = Number(s?.high_risk_failures ?? 0);
    const manualInterventions = Number(s?.manual_interventions ?? 0);
    const totalRuns = Number(s?.total_runs ?? 0);
    const lastRunAt = s?.last_run_at != null ? toIso(s.last_run_at as Date | string) : null;

    const uptimeProxy = lastRunAt != null &&
        Date.now() - new Date(lastRunAt).getTime() < 15 * 60 * 1000;

    const violationsByCode = violationsResult.rows.map((r: Record<string, unknown>) => ({
        code: String(r.code),
        count: Number(r.count),
    }));

    return {
        safeExecutionRate: totalActions > 0
            ? Math.round((safeSuccess / totalActions) * 10000) / 100
            : 100,
        totalActions,
        safeSuccess,
        policyRejectionRate: totalRuns > 0
            ? Math.round((totalViolations / totalRuns) * 10000) / 100
            : 0,
        totalViolations,
        violationsByCode,
        highRiskFailureRate: totalRuns > 0
            ? Math.round((highRiskFailures / totalRuns) * 10000) / 100
            : 0,
        highRiskFailures,
        manualInterventionRate: totalRuns > 0
            ? Math.round((manualInterventions / totalRuns) * 10000) / 100
            : 0,
        manualInterventions,
        totalRuns,
        lastRunAt,
        uptimeProxy,
    };
}

async function safetyTimelineQuery(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
    period: "day" | "week" | "month",
): Promise<{
    period: string;
    items: {
        bucket: string;
        totalRuns: number;
        violations: number;
        safeSuccess: number;
        safeRate: number;
    }[];
}> {
    const trunc = period === "month" ? "month" : period === "week" ? "week" : "day";
    const limit = period === "month" ? 12 : period === "week" ? 26 : 90;

    const result = await pool.query(
        `
        SELECT
            date_trunc($3, created_at)::date::text AS bucket,
            COUNT(*)::int AS total_runs,
            COUNT(*) FILTER (WHERE violation_code IS NOT NULL)::int AS violations,
            COUNT(*) FILTER (
                WHERE simulate_ok = true AND error IS NULL
                AND intent_type IS DISTINCT FROM 'wait'
                AND intent_type IS DISTINCT FROM 'error'
            )::int AS safe_success
        FROM runs
        WHERE chain_id = $1 AND token_id = $2
        GROUP BY date_trunc($3, created_at)
        ORDER BY bucket DESC
        LIMIT $4
        `,
        [chainId, tokenId.toString(), trunc, limit],
    );

    return {
        period,
        items: result.rows.map((r: Record<string, unknown>) => {
            const totalRuns = Number(r.total_runs);
            const safeSuccess = Number(r.safe_success);
            return {
                bucket: String(r.bucket),
                totalRuns,
                violations: Number(r.violations),
                safeSuccess,
                safeRate: totalRuns > 0
                    ? Math.round((safeSuccess / totalRuns) * 10000) / 100
                    : 100,
            };
        }),
    };
}

async function safetyViolationsQuery(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
    limit: number,
): Promise<{
    items: {
        id: string;
        violationCode: string;
        intentType: string;
        error: string;
        errorCode: string | null;
        failureCategory: string | null;
        createdAt: string;
    }[];
    count: number;
}> {
    const result = await pool.query(
        `
        SELECT
            id,
            violation_code,
            intent_type,
            error,
            error_code,
            failure_category,
            created_at
        FROM runs
        WHERE chain_id = $1
            AND token_id = $2
            AND violation_code IS NOT NULL
        ORDER BY created_at DESC
        LIMIT $3
        `,
        [chainId, tokenId.toString(), limit],
    );

    const items = result.rows.map((r: Record<string, unknown>) => ({
        id: String(r.id),
        violationCode: String(r.violation_code),
        intentType: String(r.intent_type ?? "unknown"),
        error: String(r.error ?? ""),
        errorCode: r.error_code == null ? null : String(r.error_code),
        failureCategory: r.failure_category == null ? null : String(r.failure_category),
        createdAt: toIso(r.created_at as Date | string),
    }));

    return { items, count: items.length };
}
