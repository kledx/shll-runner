/**
 * In-memory metrics counters for the SHLL Agent Runner.
 *
 * Lightweight Prometheus-style counters/gauges — no external dependencies.
 * Exposed via the /metrics API endpoint as JSON (and optionally Prometheus text format).
 */

export interface MetricsSnapshot {
    /** Unix timestamp when snapshot was taken */
    snapshotAt: number;
    /** Uptime in seconds */
    uptimeSeconds: number;
    counters: Record<string, number>;
    gauges: Record<string, number>;
}

class MetricsRegistry {
    private startedAt = Date.now();
    private counters = new Map<string, number>();
    private gauges = new Map<string, number>();

    /** Increment a counter by delta (default 1) */
    inc(name: string, delta = 1): void {
        this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
    }

    /** Set a gauge to an exact value */
    set(name: string, value: number): void {
        this.gauges.set(name, value);
    }

    /** Get current value of a counter */
    counter(name: string): number {
        return this.counters.get(name) ?? 0;
    }

    /** Get current value of a gauge */
    gauge(name: string): number {
        return this.gauges.get(name) ?? 0;
    }

    /** Snapshot all metrics */
    snapshot(): MetricsSnapshot {
        const now = Date.now();
        return {
            snapshotAt: now,
            uptimeSeconds: Math.round((now - this.startedAt) / 1000),
            counters: Object.fromEntries(this.counters),
            gauges: Object.fromEntries(this.gauges),
        };
    }

    /** Format as Prometheus text exposition */
    toPrometheus(prefix = "shll_runner"): string {
        const lines: string[] = [];
        for (const [key, value] of this.counters) {
            const name = `${prefix}_${key}_total`;
            lines.push(`# TYPE ${name} counter`);
            lines.push(`${name} ${value}`);
        }
        for (const [key, value] of this.gauges) {
            const name = `${prefix}_${key}`;
            lines.push(`# TYPE ${name} gauge`);
            lines.push(`${name} ${value}`);
        }
        lines.push(`# TYPE ${prefix}_uptime_seconds gauge`);
        lines.push(`${prefix}_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`);
        return lines.join("\n") + "\n";
    }
}

// Singleton instance
export const metrics = new MetricsRegistry();

// ═══════════════════════════════════════════════════════
//                  Well-known metric names
// ═══════════════════════════════════════════════════════

/** Counter: total scheduler loop iterations */
export const METRIC_LOOP_TICKS = "scheduler_loop_ticks";
/** Counter: total agent cycles executed */
export const METRIC_CYCLES_TOTAL = "scheduler_cycles_total";
/** Counter: successful TX submissions */
export const METRIC_TX_SUCCESS = "scheduler_tx_success";
/** Counter: TX submission failures */
export const METRIC_TX_FAILURE = "scheduler_tx_failure";
/** Counter: blocked decisions */
export const METRIC_BLOCKED = "scheduler_blocked";
/** Counter: LLM calls made */
export const METRIC_LLM_CALLS = "llm_calls_total";
/** Counter: LLM fallback activations */
export const METRIC_LLM_FALLBACKS = "llm_fallbacks_total";
/** Counter: retry attempts (withRetry) */
export const METRIC_RETRIES = "retry_attempts_total";
/** Gauge: active agent count */
export const METRIC_ACTIVE_AGENTS = "active_agents";
/** Gauge: schedulable token count */
export const METRIC_SCHEDULABLE_TOKENS = "schedulable_tokens";
