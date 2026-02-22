import assert from "node:assert/strict";
import {
    classifyFailureFromBlockedReason,
    classifyFailureFromError,
    classifyFailureFromPolicyViolation,
} from "./runFailure.js";

function runFailureClassifierTests(): void {
    const blockedPolicy = classifyFailureFromBlockedReason(
        "Action blocked by safety policy: spending limit exceeded",
    );
    assert.equal(blockedPolicy.failureCategory, "business_rejected");
    assert.equal(blockedPolicy.errorCode, "BUSINESS_POLICY_BLOCKED");

    const blockedModel = classifyFailureFromBlockedReason(
        "Invalid action params: Missing required field 'tokenOut'",
    );
    assert.equal(blockedModel.failureCategory, "model_output_error");
    assert.equal(blockedModel.errorCode, "MODEL_SCHEMA_VALIDATION_FAILED");

    const blockedLowConfidence = classifyFailureFromBlockedReason(
        "Action rejected by runtime confidence gate: model confidence 0.12 below runtime threshold 0.45",
    );
    assert.equal(blockedLowConfidence.failureCategory, "model_output_error");
    assert.equal(blockedLowConfidence.errorCode, "MODEL_LOW_CONFIDENCE");

    const blockedBalance = classifyFailureFromBlockedReason(
        "vault balance 0, no token available",
    );
    assert.equal(blockedBalance.failureCategory, "business_rejected");
    assert.equal(blockedBalance.errorCode, "BUSINESS_INSUFFICIENT_BALANCE");

    const errRateLimit = classifyFailureFromError("429 Too many request");
    assert.equal(errRateLimit.failureCategory, "infrastructure_error");
    assert.equal(errRateLimit.errorCode, "INFRA_RPC_RATE_LIMIT");

    const errRevert = classifyFailureFromError("execution reverted: slippage");
    assert.equal(errRevert.failureCategory, "business_rejected");
    assert.equal(errRevert.errorCode, "BUSINESS_CHAIN_REVERTED");

    const errInvalidToken = classifyFailureFromError(
        "The contract function \"getState\" reverted with the following reason: ERC721: invalid token ID",
    );
    assert.equal(errInvalidToken.failureCategory, "business_rejected");
    assert.equal(errInvalidToken.errorCode, "BUSINESS_CHAIN_REVERTED");

    const errUnknownAction = classifyFailureFromError("Unknown action: noop");
    assert.equal(errUnknownAction.failureCategory, "model_output_error");
    assert.equal(errUnknownAction.errorCode, "MODEL_UNKNOWN_ACTION");

    const errLowConfidence = classifyFailureFromError(
        "Model confidence below runtime threshold 0.45",
    );
    assert.equal(errLowConfidence.failureCategory, "model_output_error");
    assert.equal(errLowConfidence.errorCode, "MODEL_LOW_CONFIDENCE");

    const softCooldown = classifyFailureFromPolicyViolation("SOFT_COOLDOWN");
    assert.equal(softCooldown.failureCategory, "business_rejected");
    assert.equal(softCooldown.errorCode, "BUSINESS_POLICY_COOLDOWN");

    const hardReverted = classifyFailureFromPolicyViolation("HARD_SIMULATION_REVERTED");
    assert.equal(hardReverted.failureCategory, "business_rejected");
    assert.equal(hardReverted.errorCode, "BUSINESS_POLICY_HARD_SIMULATION_REVERTED");
}

runFailureClassifierTests();
console.log("Run failure classifier tests passed.");
