import assert from "node:assert/strict";
import { classifyReplaySnapshot } from "./replay.js";
import { replayFixtures } from "./replayFixtures.js";

function runReplayClassifierTests(): void {
    assert.ok(replayFixtures.length >= 10, "fixtures should cover baseline set");

    for (const f of replayFixtures) {
        const actual = classifyReplaySnapshot(f.snapshot);
        assert.equal(
            actual.bucket,
            f.expected.bucket,
            `${f.id} (${f.title}) bucket mismatch`,
        );
        assert.equal(
            actual.category,
            f.expected.category,
            `${f.id} (${f.title}) category mismatch`,
        );
        assert.ok(actual.evidence.length > 0, `${f.id} should return evidence`);
    }

    const buckets = new Set(replayFixtures.map((x) => x.expected.bucket));
    for (const required of [
        "misjudgment",
        "overreach",
        "param_anomaly",
        "recovery_failure",
    ] as const) {
        assert.ok(
            buckets.has(required),
            `missing required bucket coverage: ${required}`,
        );
    }
}

runReplayClassifierTests();
console.log("Replay classifier tests passed.");
