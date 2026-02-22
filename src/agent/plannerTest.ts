import assert from "node:assert/strict";
import type { Decision } from "../brain/interface.js";
import type { IAction } from "../actions/interface.js";
import { buildExecutionPlan, buildLegacyExecutionPlan } from "./planner.js";

function mockAction(name: string, readonly = false): IAction {
    return {
        name,
        description: `${name} action`,
        readonly,
        parameters: {
            type: "object",
            properties: {
                token: { type: "string", description: "token" },
            },
            required: ["token"],
        },
        encode: () => ({ target: "0x0000000000000000000000000000000000000000", value: 0n, data: "0x" }),
    };
}

function mockDecision(action: string, params: Record<string, unknown> = {}): Decision {
    return {
        action,
        params,
        reasoning: "test",
        confidence: 0.9,
    };
}

function runPlannerTests(): void {
    const actions = [mockAction("swap"), mockAction("get_portfolio", true)];

    const waitPlan = buildExecutionPlan(mockDecision("wait"), actions);
    assert.equal(waitPlan.kind, "wait");

    const unknownPlan = buildExecutionPlan(mockDecision("unknown"), actions);
    assert.equal(unknownPlan.kind, "blocked");
    assert.equal(unknownPlan.errorCode, "MODEL_UNKNOWN_ACTION");

    const invalidPlan = buildExecutionPlan(mockDecision("swap", {}), actions);
    assert.equal(invalidPlan.kind, "blocked");
    assert.equal(invalidPlan.errorCode, "MODEL_SCHEMA_VALIDATION_FAILED");

    const legacyInvalidPlan = buildLegacyExecutionPlan(
        mockDecision("swap", {}),
        actions,
    );
    assert.equal(legacyInvalidPlan.kind, "write");

    const readonlyPlan = buildExecutionPlan(
        mockDecision("get_portfolio", { token: "0x1" }),
        actions,
    );
    assert.equal(readonlyPlan.kind, "readonly");

    const writePlan = buildExecutionPlan(
        mockDecision("swap", { token: "0x1" }),
        actions,
    );
    assert.equal(writePlan.kind, "write");

    const legacyWritePlan = buildLegacyExecutionPlan(
        mockDecision("swap", { token: "0x1" }),
        actions,
    );
    assert.equal(legacyWritePlan.kind, "write");
}

runPlannerTests();
console.log("Planner tests passed.");
