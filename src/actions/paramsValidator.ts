import type { IAction } from "./interface.js";

type SchemaPrimitive = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

export interface ParamsValidationResult {
    ok: boolean;
    errors: string[];
}

function isTypeMatch(value: unknown, expected: SchemaPrimitive): boolean {
    switch (expected) {
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "integer":
            return typeof value === "number" && Number.isInteger(value);
        case "boolean":
            return typeof value === "boolean";
        case "object":
            return typeof value === "object" && value !== null && !Array.isArray(value);
        case "array":
            return Array.isArray(value);
        case "null":
            return value === null;
        default:
            return false;
    }
}

/**
 * Strictly validate decision params against action tool schema.
 * - Required fields must exist.
 * - Unknown fields are rejected.
 * - No implicit type coercion.
 */
export function validateActionParams(
    action: IAction,
    params: Record<string, unknown>,
): ParamsValidationResult {
    const schema = action.parameters;
    const errors: string[] = [];

    if (!schema || schema.type !== "object") {
        return { ok: true, errors: [] };
    }

    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);

    // Reject unknown fields (allow internal meta fields prefixed by "__")
    for (const key of Object.keys(params)) {
        if (key.startsWith("__")) continue;
        if (!(key in properties)) {
            errors.push(`Unknown field '${key}'`);
        }
    }

    // Validate required
    for (const key of required) {
        if (!(key in params)) {
            errors.push(`Missing required field '${key}'`);
            continue;
        }
        const value = params[key];
        if (value === undefined || value === null) {
            errors.push(`Required field '${key}' is empty`);
        }
    }

    // Validate property types and enums
    for (const [key, descriptor] of Object.entries(properties)) {
        if (!(key in params)) continue;
        const value = params[key];
        if (value === undefined) continue;

        const expectedType = descriptor.type as SchemaPrimitive;
        if (!isTypeMatch(value, expectedType)) {
            errors.push(
                `Field '${key}' expected ${expectedType}, got ${Array.isArray(value) ? "array" : typeof value}`,
            );
            continue;
        }

        if (descriptor.enum && descriptor.enum.length > 0) {
            if (typeof value !== "string" || !descriptor.enum.includes(value)) {
                errors.push(
                    `Field '${key}' must be one of [${descriptor.enum.join(", ")}]`,
                );
            }
        }
    }

    return {
        ok: errors.length === 0,
        errors,
    };
}
