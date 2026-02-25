/**
 * Shadow metrics store operations — dual-run comparison analysis.
 */

import type { Pool } from "pg";
import type { ExecutionTraceEntry, RunMode } from "../types.js";

export async function getShadowMetrics(
    pool: Pool,
    chainId: number,
    options?: {
        tokenId?: bigint;
        sinceHours?: number;
    },
): Promise<{
    sinceHours: number;
    tokenId?: string;
    modes: Record<
        RunMode,
        {
            totalRuns: number;
            successRuns: number;
            blockedRuns: number;
            exceptionRuns: number;
            txRuns: number;
            manualInterventionRuns: number;
            avgLatencyMs: number | null;
            divergenceRuns: number;
            successRate: number;
            rejectRate: number;
            exceptionRate: number;
            interventionRate: number;
            divergenceRate: number;
        }
    >;
    compare: {
        successRateDelta: number;
        rejectRateDelta: number;
        exceptionRateDelta: number;
        interventionRateDelta: number;
    };
}> {
    const sinceHours = Math.max(1, Math.min(24 * 30, Math.floor(options?.sinceHours ?? 72)));
    const where: string[] = ["chain_id = $1", "created_at >= NOW() - ($2::text || ' hours')::interval"];
    const params: unknown[] = [chainId, sinceHours];
    if (options?.tokenId != null) {
        where.push("token_id = $3");
        params.push(options.tokenId.toString());
    }

    const result = await pool.query(
        `
        SELECT run_mode, tx_hash, error, failure_category, error_code, execution_trace, shadow_compare
        FROM runs
        WHERE ${where.join(" AND ")}
        `,
        params,
    );

    const empty = {
        totalRuns: 0,
        successRuns: 0,
        blockedRuns: 0,
        exceptionRuns: 0,
        txRuns: 0,
        manualInterventionRuns: 0,
        divergenceRuns: 0,
        latencyTotalMs: 0,
        latencyCount: 0,
    };
    const modes = {
        primary: { ...empty },
        shadow: { ...empty },
    };

    const interventionCodes = new Set([
        "BUSINESS_AUTHORIZATION_REQUIRED",
        "BUSINESS_AUTOPAUSE_THRESHOLD",
        "BUSINESS_CIRCUIT_BREAKER",
    ]);

    for (const row of result.rows as Array<Record<string, unknown>>) {
        const mode = row.run_mode === "shadow" ? "shadow" : "primary";
        const bucket = modes[mode];
        bucket.totalRuns++;

        if (row.error == null) {
            bucket.successRuns++;
        }
        if (row.tx_hash != null) {
            bucket.txRuns++;
        }

        const category = row.failure_category == null ? "" : String(row.failure_category);
        if (category === "business_rejected") {
            bucket.blockedRuns++;
        } else if (row.error != null) {
            bucket.exceptionRuns++;
        }

        const errorCode = row.error_code == null ? "" : String(row.error_code);
        if (interventionCodes.has(errorCode)) {
            bucket.manualInterventionRuns++;
        }

        let shadowCompare: Record<string, unknown> | null = null;
        if (row.shadow_compare && typeof row.shadow_compare === "object") {
            shadowCompare = row.shadow_compare as Record<string, unknown>;
        } else if (typeof row.shadow_compare === "string") {
            try {
                const parsed = JSON.parse(row.shadow_compare) as unknown;
                if (parsed && typeof parsed === "object") {
                    shadowCompare = parsed as Record<string, unknown>;
                }
            } catch {
                // ignore malformed shadow compare payloads
            }
        }
        if (shadowCompare?.diverged === true) {
            bucket.divergenceRuns++;
        }

        let trace: ExecutionTraceEntry[] | undefined;
        if (Array.isArray(row.execution_trace)) {
            trace = row.execution_trace as ExecutionTraceEntry[];
        } else if (typeof row.execution_trace === "string") {
            try {
                const parsed = JSON.parse(row.execution_trace) as unknown;
                if (Array.isArray(parsed)) {
                    trace = parsed as ExecutionTraceEntry[];
                }
            } catch {
                // ignore malformed trace payloads
            }
        }
        if (trace && trace.length > 0) {
            const observe = trace.find((item) => item.stage === "observe");
            const record = trace.find((item) => item.stage === "record");
            if (observe?.at && record?.at) {
                const start = Date.parse(observe.at);
                const end = Date.parse(record.at);
                if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
                    bucket.latencyTotalMs += end - start;
                    bucket.latencyCount++;
                }
            }
        }
    }

    const withRates = (bucket: typeof empty) => {
        const total = bucket.totalRuns || 1;
        return {
            totalRuns: bucket.totalRuns,
            successRuns: bucket.successRuns,
            blockedRuns: bucket.blockedRuns,
            exceptionRuns: bucket.exceptionRuns,
            txRuns: bucket.txRuns,
            manualInterventionRuns: bucket.manualInterventionRuns,
            avgLatencyMs:
                bucket.latencyCount > 0
                    ? Math.round(bucket.latencyTotalMs / bucket.latencyCount)
                    : null,
            divergenceRuns: bucket.divergenceRuns,
            successRate: bucket.successRuns / total,
            rejectRate: bucket.blockedRuns / total,
            exceptionRate: bucket.exceptionRuns / total,
            interventionRate: bucket.manualInterventionRuns / total,
            divergenceRate: bucket.divergenceRuns / total,
        };
    };

    const primary = withRates(modes.primary);
    const shadow = withRates(modes.shadow);

    return {
        sinceHours,
        tokenId: options?.tokenId?.toString(),
        modes: {
            primary,
            shadow,
        },
        compare: {
            successRateDelta: shadow.successRate - primary.successRate,
            rejectRateDelta: shadow.rejectRate - primary.rejectRate,
            exceptionRateDelta: shadow.exceptionRate - primary.exceptionRate,
            interventionRateDelta: shadow.interventionRate - primary.interventionRate,
        },
    };
}
