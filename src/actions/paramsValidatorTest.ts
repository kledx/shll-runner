import assert from "node:assert/strict";
import type { IAction } from "./interface.js";
import { validateActionParams } from "./paramsValidator.js";

const mockAction: IAction = {
    name: "mock",
    description: "mock action for validation tests",
    readonly: false,
    parameters: {
        type: "object",
        properties: {
            token: { type: "string", description: "token address" },
            amount: { type: "string", description: "amount in wei" },
            mode: { type: "string", description: "mode", enum: ["safe", "fast"] },
            urgent: { type: "boolean", description: "urgent flag" },
        },
        required: ["token", "amount"],
    },
    encode: () => {
        throw new Error("not implemented");
    },
};

function runParamsValidatorTests(): void {
    const valid = validateActionParams(mockAction, {
        token: "0x123",
        amount: "1000",
        mode: "safe",
        urgent: false,
    });
    assert.equal(valid.ok, true, "valid params should pass");

    const missingRequired = validateActionParams(mockAction, {
        token: "0x123",
    });
    assert.equal(missingRequired.ok, false, "missing required should fail");
    assert.ok(
        missingRequired.errors.some((x) => x.includes("Missing required field 'amount'")),
        "missing required error should mention field",
    );

    const unknownField = validateActionParams(mockAction, {
        token: "0x123",
        amount: "1000",
        foo: "bar",
    });
    assert.equal(unknownField.ok, false, "unknown field should fail");
    assert.ok(
        unknownField.errors.some((x) => x.includes("Unknown field 'foo'")),
        "unknown field error should be reported",
    );

    const typeMismatch = validateActionParams(mockAction, {
        token: "0x123",
        amount: 1000,
    });
    assert.equal(typeMismatch.ok, false, "type mismatch should fail");
    assert.ok(
        typeMismatch.errors.some((x) => x.includes("Field 'amount' expected string")),
        "type mismatch error should be reported",
    );

    const enumMismatch = validateActionParams(mockAction, {
        token: "0x123",
        amount: "1000",
        mode: "turbo",
    });
    assert.equal(enumMismatch.ok, false, "enum mismatch should fail");
    assert.ok(
        enumMismatch.errors.some((x) => x.includes("Field 'mode' must be one of")),
        "enum mismatch error should be reported",
    );

    const internalKeyAllowed = validateActionParams(mockAction, {
        token: "0x123",
        amount: "1000",
        __meta: "internal",
    });
    assert.equal(internalKeyAllowed.ok, true, "internal keys should be ignored");
}

runParamsValidatorTests();
console.log("Params validator tests passed.");
