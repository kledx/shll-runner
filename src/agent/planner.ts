import type { Decision } from "../brain/interface.js";
import type { IAction } from "../actions/interface.js";
import { validateActionParams } from "../actions/paramsValidator.js";
import type { RunFailureCategory, RunErrorCode } from "../runFailure.js";

export type PlanKind = "wait" | "readonly" | "write" | "blocked";

export interface ExecutionPlan {
    kind: PlanKind;
    actionName: string;
    params: Record<string, unknown>;
    reason: string;
    actionModule?: IAction;
    failureCategory?: RunFailureCategory;
    errorCode?: RunErrorCode;
}

/**
 * Deterministic planner:
 * converts a model decision into a runtime execution plan.
 */
export function buildExecutionPlan(
    decision: Decision,
    actions: IAction[],
): ExecutionPlan {
    const params = decision.params ?? {};

    if (decision.action === "wait") {
        return {
            kind: "wait",
            actionName: "wait",
            params,
            reason: decision.reasoning,
        };
    }

    const actionModule = actions.find((a) => a.name === decision.action);
    if (!actionModule) {
        return {
            kind: "blocked",
            actionName: decision.action,
            params,
            reason: `Unknown action: ${decision.action}`,
            failureCategory: "model_output_error",
            errorCode: "MODEL_UNKNOWN_ACTION",
        };
    }

    const validation = validateActionParams(actionModule, params);
    if (!validation.ok) {
        return {
            kind: "blocked",
            actionName: decision.action,
            params,
            reason: `Invalid action params: ${validation.errors.join("; ")}`,
            failureCategory: "model_output_error",
            errorCode: "MODEL_SCHEMA_VALIDATION_FAILED",
        };
    }

    if (actionModule.readonly) {
        return {
            kind: "readonly",
            actionName: decision.action,
            params,
            reason: decision.reasoning,
            actionModule,
        };
    }

    return {
        kind: "write",
        actionName: decision.action,
        params,
        reason: decision.reasoning,
        actionModule,
    };
}

/**
 * Legacy planner behavior used for shadow comparison.
 * Differences from current planner:
 * - Does not perform strict schema validation.
 */
export function buildLegacyExecutionPlan(
    decision: Decision,
    actions: IAction[],
): ExecutionPlan {
    const params = decision.params ?? {};

    if (decision.action === "wait") {
        return {
            kind: "wait",
            actionName: "wait",
            params,
            reason: decision.reasoning,
        };
    }

    const actionModule = actions.find((a) => a.name === decision.action);
    if (!actionModule) {
        return {
            kind: "blocked",
            actionName: decision.action,
            params,
            reason: `Unknown action: ${decision.action}`,
            failureCategory: "model_output_error",
            errorCode: "MODEL_UNKNOWN_ACTION",
        };
    }

    if (actionModule.readonly) {
        return {
            kind: "readonly",
            actionName: decision.action,
            params,
            reason: decision.reasoning,
            actionModule,
        };
    }

    return {
        kind: "write",
        actionName: decision.action,
        params,
        reason: decision.reasoning,
        actionModule,
    };
}
