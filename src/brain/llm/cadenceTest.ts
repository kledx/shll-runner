import assert from "node:assert/strict";
import type { MemoryEntry } from "../../memory/interface.js";
import {
    attachCadenceParams,
    buildCadenceProgress,
    parseRecurringMessageIntent,
    parseTimedMonitoringIntent,
} from "./cadence.js";

function runCadenceTests(): void {
    const recurring = parseRecurringMessageIntent("接下来1分钟，每5秒发送一条 hi");
    assert.ok(recurring, "recurring Chinese message intent should parse");
    assert.equal(recurring?.intervalMs, 5_000);
    assert.equal(recurring?.durationMs, 60_000);
    assert.equal(recurring?.message, "hi");

    const recurringZhNum = parseRecurringMessageIntent("接下来5分钟，每一分钟发送一条 hi");
    assert.ok(recurringZhNum, "Chinese numeral cadence should parse");
    assert.equal(recurringZhNum?.intervalMs, 60_000);
    assert.equal(recurringZhNum?.durationMs, 300_000);

    const recurringNoDuration = parseRecurringMessageIntent("每5秒发 hi");
    assert.ok(recurringNoDuration, "recurring intent without explicit duration should parse");
    assert.equal(recurringNoDuration?.intervalMs, 5_000);
    assert.equal(recurringNoDuration?.durationMs, 60_000);
    assert.equal(recurringNoDuration?.message, "hi");

    const monitoring = parseTimedMonitoringIntent(
        "接下来5分钟，每一分钟扫描市场某一代币价格，低于300就购买",
    );
    assert.ok(monitoring, "timed monitoring instruction should parse");
    assert.equal(monitoring?.intervalMs, 60_000);
    assert.equal(monitoring?.durationMs, 300_000);

    const marker = "cadence:msg:5000:60000:hi";
    const oldNow = Date.UTC(2026, 1, 22, 16, 0, 0);
    const doneAt = oldNow - 15_000;
    const memories: MemoryEntry[] = [
        {
            type: "decision",
            action: "wait",
            params: attachCadenceParams({}, marker, "active"),
            timestamp: new Date(doneAt - 30_000),
        },
        {
            type: "decision",
            action: "wait",
            params: attachCadenceParams({}, marker, "done"),
            timestamp: new Date(doneAt),
        },
    ];
    const restarted = buildCadenceProgress({
        marker,
        intervalMs: 5_000,
        durationMs: 60_000,
        memories,
        nowMs: oldNow,
    });
    assert.equal(restarted.completed, false, "session should restart after done marker");
    assert.ok(restarted.elapsedMs < 5_000, "fresh session elapsed should be near zero");

    const twoMinuteStart = Date.UTC(2026, 1, 22, 16, 0, 0);
    const longRunMemories: MemoryEntry[] = [];
    for (let i = 0; i < 24; i++) {
        const at = twoMinuteStart + i * 5_000;
        longRunMemories.push({
            type: "decision",
            action: "wait",
            params: attachCadenceParams({}, marker, "active", twoMinuteStart),
            timestamp: new Date(at),
        });
    }
    const truncatedWindow = longRunMemories.slice(-20);
    const completedWithTruncatedWindow = buildCadenceProgress({
        marker,
        intervalMs: 5_000,
        durationMs: 120_000,
        memories: truncatedWindow,
        nowMs: twoMinuteStart + 120_000,
    });
    assert.equal(
        completedWithTruncatedWindow.completed,
        true,
        "should complete even when the first cadence entries are outside memory recall window",
    );
}

runCadenceTests();
console.log("Cadence tests passed.");
