/**
 * RunnerError — Unified typed error for the SHLL Agent Runner.
 *
 * Extends native Error with structured failure metadata:
 * - category: model_output_error | business_rejected | infrastructure_error
 * - code: specific error code from RunErrorCode union
 * - retryable: whether the caller should auto-retry
 * - userMessage: sanitized string safe for user display
 */

import type { RunFailureCategory, RunErrorCode } from "../runFailure.js";
import { classifyFailureFromError } from "../runFailure.js";
import { sanitizeForUser } from "../errors.js";

export class RunnerError extends Error {
    readonly category: RunFailureCategory;
    readonly code: RunErrorCode;
    readonly retryable: boolean;
    readonly userMessage: string;

    constructor(
        message: string,
        opts?: {
            category?: RunFailureCategory;
            code?: RunErrorCode;
            retryable?: boolean;
            cause?: unknown;
        },
    ) {
        super(message, { cause: opts?.cause });
        this.name = "RunnerError";

        // Auto-classify from message if category/code not provided
        if (opts?.category && opts?.code) {
            this.category = opts.category;
            this.code = opts.code;
        } else {
            const classified = classifyFailureFromError(message);
            this.category = opts?.category ?? classified.failureCategory;
            this.code = opts?.code ?? classified.errorCode;
        }

        // Infrastructure errors are generally retryable unless explicitly overridden
        this.retryable = opts?.retryable ?? (this.category === "infrastructure_error");
        this.userMessage = sanitizeForUser(message);
    }

    /** Wrap any unknown caught value into a RunnerError */
    static from(err: unknown): RunnerError {
        if (err instanceof RunnerError) return err;
        const message = err instanceof Error ? err.message : String(err);
        return new RunnerError(message, { cause: err });
    }

    /** Check if an unknown error is retryable */
    static isRetryable(err: unknown): boolean {
        if (err instanceof RunnerError) return err.retryable;
        // Classify raw errors to determine retryability
        const message = err instanceof Error ? err.message : String(err);
        const classified = classifyFailureFromError(message);
        return classified.failureCategory === "infrastructure_error";
    }
}

// ═══════════════════════════════════════════════════════
//                  Retry Utility
// ═══════════════════════════════════════════════════════

export interface RetryOptions {
    /** Maximum number of attempts (including the first one). Default: 3 */
    maxAttempts?: number;
    /** Base delay in ms between retries. Default: 1000 */
    baseDelayMs?: number;
    /** Whether to use exponential backoff. Default: true */
    exponential?: boolean;
    /** Optional label for logging. */
    label?: string;
    /** Custom predicate to decide if an error is retryable. Default: RunnerError.isRetryable */
    isRetryable?: (err: unknown) => boolean;
}

/**
 * Retry wrapper for transient infrastructure errors.
 * Only retries errors classified as infrastructure_error (rate limits, timeouts, network).
 * Business and model errors are NOT retried.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    opts?: RetryOptions,
): Promise<T> {
    const maxAttempts = opts?.maxAttempts ?? 3;
    const baseDelayMs = opts?.baseDelayMs ?? 1000;
    const exponential = opts?.exponential ?? true;
    const label = opts?.label ?? "operation";
    const isRetryable = opts?.isRetryable ?? RunnerError.isRetryable;

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;

            if (attempt >= maxAttempts || !isRetryable(err)) {
                throw RunnerError.from(err);
            }

            const delay = exponential
                ? baseDelayMs * Math.pow(2, attempt - 1)
                : baseDelayMs;
            console.warn(
                `  [Retry] ${label} attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    // Unreachable, but TypeScript needs it
    throw RunnerError.from(lastError);
}
