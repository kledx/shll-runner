/**
 * BYOR (Bring Your Own Runner) — External Runner Interface
 *
 * Allows external runners to:
 * 1. Query the interface schema (GET /byor/schema)
 * 2. Submit action proposals for a token (POST /byor/submit)
 *
 * Submissions are validated against:
 * - Token ownership / renter status
 * - Strategy sandbox (allowed targets, selectors, budgets)
 * - PolicyGuard pre-check (simulated via contract)
 */

import type { Address, Hex } from "viem";
import type { ActionPayload, StrategyConfigRecord } from "./types.js";

// ── Schema Response ─────────────────────────────────────────────

export interface ByorSchemaResponse {
    version: string;
    chainId: number;
    agentNfaAddress: string;
    runnerOperator: string;
    supportedActions: string[];
    submitEndpoint: string;
    submitMethod: string;
    submitBodySchema: Record<string, unknown>;
    requiredHeaders: string[];
}

export function formatByorSchemaResponse(opts: {
    chainId: number;
    agentNfaAddress: string;
    runnerOperator: string;
    apiBaseUrl?: string;
}): ByorSchemaResponse {
    return {
        version: "1.0.0",
        chainId: opts.chainId,
        agentNfaAddress: opts.agentNfaAddress,
        runnerOperator: opts.runnerOperator,
        supportedActions: ["execute"],
        submitEndpoint: `${opts.apiBaseUrl ?? ""}/byor/submit`,
        submitMethod: "POST",
        submitBodySchema: {
            type: "object",
            required: ["tokenId", "action"],
            properties: {
                tokenId: {
                    type: "string",
                    description: "Agent NFT token ID",
                },
                action: {
                    type: "object",
                    required: ["target", "value", "data"],
                    properties: {
                        target: {
                            type: "string",
                            description: "Target contract address (0x...)",
                        },
                        value: {
                            type: "string",
                            description: "Value in wei (as a decimal string)",
                        },
                        data: {
                            type: "string",
                            description: "Calldata (hex encoded, 0x...)",
                        },
                    },
                },
                dryRun: {
                    type: "boolean",
                    description: "If true, validate but do not execute",
                },
            },
        },
        requiredHeaders: ["x-api-key"],
    };
}

// ── Submission Types ────────────────────────────────────────────

export interface ByorSubmission {
    tokenId: string;
    action: {
        target: string;
        value: string;
        data: string;
    };
    dryRun?: boolean;
}

export interface ByorValidationResult {
    valid: boolean;
    reason?: string;
    action?: ActionPayload;
}

// ── Validation ──────────────────────────────────────────────────

export function validateByorSubmission(
    body: unknown
): ByorValidationResult {
    if (!body || typeof body !== "object") {
        return { valid: false, reason: "body must be a JSON object" };
    }

    const submission = body as Record<string, unknown>;

    // tokenId
    const tokenId = submission.tokenId;
    if (tokenId == null || (typeof tokenId !== "string" && typeof tokenId !== "number")) {
        return { valid: false, reason: "tokenId is required (string or number)" };
    }

    // action block
    const actionRaw = submission.action;
    if (!actionRaw || typeof actionRaw !== "object") {
        return { valid: false, reason: "action is required (object with target, value, data)" };
    }

    const action = actionRaw as Record<string, unknown>;
    const target = action.target;
    const value = action.value;
    const data = action.data;

    if (typeof target !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(target)) {
        return { valid: false, reason: "action.target must be a valid 0x address" };
    }

    if (value == null) {
        return { valid: false, reason: "action.value is required" };
    }

    let valueBigInt: bigint;
    try {
        valueBigInt = BigInt(value as string | number);
    } catch {
        return { valid: false, reason: "action.value must be a valid integer (wei)" };
    }

    if (typeof data !== "string" || !data.startsWith("0x")) {
        return { valid: false, reason: "action.data must be a hex string (0x...)" };
    }

    return {
        valid: true,
        action: {
            target: target as Address,
            value: valueBigInt,
            data: data as Hex,
        },
    };
}

/**
 * Check whether a BYOR submission action is permitted by the existing
 * strategy sandbox rules for a given token. Returns ok=true if no
 * strategy exists (no sandbox enforcement).
 */
export function checkByorSandbox(
    strategy: StrategyConfigRecord | null,
    action: ActionPayload
): { ok: boolean; reason?: string } {
    if (!strategy) {
        // No strategy configured — allow (no sandbox to enforce)
        return { ok: true };
    }

    const params = strategy.strategyParams ?? {};

    // Check allowed targets
    const allowedTargetsRaw = Array.isArray(params.allowedTargets)
        ? (params.allowedTargets as unknown[])
        : [];
    const allowedTargets = allowedTargetsRaw
        .filter((v): v is string => typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v))
        .map((v) => v.toLowerCase());
    if (allowedTargets.length > 0 && !allowedTargets.includes(action.target.toLowerCase())) {
        return {
            ok: false,
            reason: `BYOR target not in strategy sandbox allowedTargets: ${action.target}`,
        };
    }

    // Check allowed selectors
    const allowedSelectorsRaw = Array.isArray(params.allowedSelectors)
        ? (params.allowedSelectors as unknown[])
        : [];
    const allowedSelectors = allowedSelectorsRaw
        .filter((v): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{8}$/.test(v))
        .map((v) => v.toLowerCase());
    if (allowedSelectors.length > 0) {
        const selector = action.data.length >= 10 ? action.data.slice(0, 10).toLowerCase() : "0x";
        if (!allowedSelectors.includes(selector)) {
            return {
                ok: false,
                reason: `BYOR selector not in strategy sandbox allowedSelectors: ${selector}`,
            };
        }
    }

    // Check max value per run
    const maxValuePerRun = (() => {
        const raw = params.maxValuePerRun;
        try {
            if (typeof raw === "bigint") return raw;
            if (typeof raw === "number" && Number.isFinite(raw)) return BigInt(Math.floor(raw));
            if (typeof raw === "string" && raw.trim()) return BigInt(raw.trim());
        } catch { /* ignore */ }
        return 0n;
    })();
    if (maxValuePerRun > 0n && action.value > maxValuePerRun) {
        return {
            ok: false,
            reason: `BYOR value exceeds maxValuePerRun (${action.value.toString()} > ${maxValuePerRun.toString()})`,
        };
    }

    return { ok: true };
}
