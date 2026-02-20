/**
 * Error sanitization — prevent leaking system internals to users.
 *
 * Raw errors (RPC URLs, stack traces, internal codes) are logged server-side
 * but replaced with friendly messages for user-facing output.
 */

/** Known error patterns → user-friendly replacements */
const ERROR_PATTERNS: Array<[RegExp, string]> = [
    // RPC / network errors
    [/Too many request/i, "Network is busy, retrying shortly."],
    [/429/i, "Network is busy, retrying shortly."],
    [/getaddrinfo/i, "Unable to reach the network. Will retry."],
    [/ECONNREFUSED/i, "Service temporarily unavailable. Will retry."],
    [/ETIMEDOUT|ESOCKETTIMEDOUT|timeout/i, "Request timed out. Will retry."],
    [/fetch failed/i, "Network request failed. Will retry."],

    // Chain / contract errors
    [/insufficient funds/i, "Insufficient gas funds. Please add BNB to the Agent Account."],
    [/execution reverted/i, "Transaction was rejected by the contract. Check your parameters."],
    [/nonce too low/i, "Transaction conflict detected. Retrying."],
    [/replacement transaction underpriced/i, "Transaction conflict detected. Retrying."],
    [/Unauthorized/i, "Authorization issue. Please re-enable Autopilot."],

    // LLM errors
    [/rate.?limit/i, "AI service is busy, retrying shortly."],
    [/API key/i, "AI service configuration issue. Contact admin."],
    [/model.*not.*found/i, "AI model unavailable. Contact admin."],
];

/**
 * Sanitize an error for user-facing display.
 * Raw details are stripped; only a friendly message is returned.
 */
export function sanitizeForUser(rawError: string): string {
    for (const [pattern, friendly] of ERROR_PATTERNS) {
        if (pattern.test(rawError)) {
            return friendly;
        }
    }
    // Generic fallback — never expose raw internals
    return "An unexpected error occurred. The system will retry automatically.";
}

/**
 * Extract error message from unknown catch value.
 */
export function extractErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return String(err);
}
