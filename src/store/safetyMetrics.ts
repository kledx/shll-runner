/**
 * Safety SLA metrics store operations — safety metrics, timeline, violations.
 */

import type { Pool } from "pg";
import { toIso } from "./helpers.js";

export async function getSafetyMetrics(
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

export async function getSafetyTimeline(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
    period: "day" | "week" | "month" = "day",
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

export async function getSafetyViolations(
    pool: Pool,
    chainId: number,
    tokenId: bigint,
    limit = 50,
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
        SELECT id, violation_code, intent_type, error, error_code, failure_category, created_at
        FROM runs
        WHERE chain_id = $1 AND token_id = $2 AND violation_code IS NOT NULL
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
