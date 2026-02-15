/**
 * Functional test: Composable Strategies + BYOR validation
 *
 * Run with: npx tsx scripts/test-new-features.ts
 */

import type { Address, Hex } from "viem";
import type { StrategyConfigRecord, Observation } from "../src/types.js";
import { resolveStrategyAction, listSupportedStrategies } from "../src/strategyRegistry.js";
import { validateByorSubmission, checkByorSandbox, formatByorSchemaResponse } from "../src/byor.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ ${label}`);
        failed++;
    }
}

// ── Helpers ─────────────────────────────────────────────

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
const WBNB_ADDR = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" as Address;

function makeObservation(tokenId: bigint): Observation {
    return {
        tokenId,
        agentState: {
            balance: 1000000000000000000n, // 1 BNB
            status: 0,
            owner: ZERO_ADDR,
            logicAddress: ZERO_ADDR,
            lastActionTimestamp: 0n,
        },
        agentAccount: ZERO_ADDR,
        renter: ZERO_ADDR,
        renterExpires: 0n,
        operator: ZERO_ADDR,
        operatorExpires: 0n,
        blockNumber: 100n,
        blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        timestamp: Date.now(),
    };
}

function makeStrategy(overrides: Partial<StrategyConfigRecord>): StrategyConfigRecord {
    return {
        tokenId: "0",
        chainId: 97,
        strategyType: "fixed_action",
        target: WBNB_ADDR,
        data: "0xd0e30db0" as Hex,
        value: "100000000000000",
        strategyParams: {},
        source: "test",
        minIntervalMs: 0,
        requirePositiveBalance: false,
        maxFailures: 5,
        failureCount: 0,
        dailyRunsUsed: 0,
        dailyValueUsed: "0",
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

// ── Test 1: listSupportedStrategies includes composite ──

console.log("\n=== Test 1: Strategy Registry includes composite ===");
{
    const supported = listSupportedStrategies();
    assert(supported.includes("composite"), "composite is in supported list");
    assert(supported.includes("fixed_action"), "fixed_action is in supported list");
    assert(supported.includes("wrap_native"), "wrap_native is in supported list");
    assert(supported.includes("hotpump_watchlist"), "hotpump_watchlist is in supported list");
    assert(supported.length === 4, `total supported = 4 (got ${supported.length})`);
}

// ── Test 2: Composite strategy - first_match mode ──

console.log("\n=== Test 2: Composite strategy - first_match mode ===");
{
    const obs = makeObservation(0n);
    const strategy = makeStrategy({
        strategyType: "composite",
        strategyParams: {
            mode: "first_match",
            children: [
                {
                    strategyType: "wrap_native",
                    target: WBNB_ADDR,
                    data: "0xd0e30db0",
                    value: "0",  // value = 0 → wrap_native should skip
                    strategyParams: {},
                },
                {
                    strategyType: "fixed_action",
                    target: WBNB_ADDR,
                    data: "0xd0e30db0",
                    value: "50000000000000",
                    strategyParams: {},
                },
            ],
        },
    });

    const result = resolveStrategyAction(strategy, obs);
    assert(!!result.action, "first_match: returns action from second child (fixed_action)");
    assert(result.reason.includes("composite[1/fixed_action]"), `reason contains child index (got: ${result.reason})`);
    assert(result.action!.value === 50000000000000n, "action value matches fixed_action child");
}

// ── Test 3: Composite strategy - no match ──

console.log("\n=== Test 3: Composite strategy - no match ===");
{
    const obs = makeObservation(0n);
    const strategy = makeStrategy({
        strategyType: "composite",
        strategyParams: {
            mode: "first_match",
            children: [
                {
                    strategyType: "wrap_native",
                    target: WBNB_ADDR,
                    data: "0xd0e30db0",
                    value: "0",  // value = 0 → skip
                    strategyParams: {},
                },
            ],
        },
    });

    const result = resolveStrategyAction(strategy, obs);
    assert(!result.action, "no match: no action returned");
    assert(result.reason.includes("no child matched"), `reason says no child matched (got: ${result.reason})`);
}

// ── Test 4: Composite strategy - empty children ──

console.log("\n=== Test 4: Composite strategy - empty children ===");
{
    const obs = makeObservation(0n);
    const strategy = makeStrategy({
        strategyType: "composite",
        strategyParams: { children: [] },
    });

    const result = resolveStrategyAction(strategy, obs);
    assert(!result.action, "empty children: no action returned");
    assert(result.reason.includes("requires strategyParams.children"), `reason mentions requirement (got: ${result.reason})`);
}

// ── Test 5: Composite strategy - priority mode ──

console.log("\n=== Test 5: Composite strategy - priority mode ===");
{
    const obs = makeObservation(0n);
    const strategy = makeStrategy({
        strategyType: "composite",
        strategyParams: {
            mode: "priority",
            children: [
                {
                    strategyType: "fixed_action",
                    target: WBNB_ADDR,
                    data: "0xaaaa0001",
                    value: "100",
                    strategyParams: {},
                },
                {
                    strategyType: "fixed_action",
                    target: WBNB_ADDR,
                    data: "0xbbbb0002",
                    value: "200",
                    strategyParams: {},
                },
            ],
        },
    });

    const result = resolveStrategyAction(strategy, obs);
    assert(!!result.action, "priority: returns action");
    assert(result.action!.value === 100n, "priority: selects first (highest priority) child");
    assert(result.reason.includes("priority"), `reason mentions priority mode (got: ${result.reason})`);
}

// ── Test 6: BYOR validateByorSubmission - valid ──

console.log("\n=== Test 6: BYOR validation - valid submission ===");
{
    const result = validateByorSubmission({
        tokenId: "0",
        action: {
            target: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
            value: "100000000000000",
            data: "0xd0e30db0",
        },
    });
    assert(result.valid, "valid submission accepted");
    assert(!!result.action, "action parsed");
    assert(result.action!.target === "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd", "target correct");
    assert(result.action!.value === 100000000000000n, "value parsed to bigint");
}

// ── Test 7: BYOR validateByorSubmission - invalid ──

console.log("\n=== Test 7: BYOR validation - invalid submissions ===");
{
    const r1 = validateByorSubmission(null);
    assert(!r1.valid, "null body rejected");

    const r2 = validateByorSubmission({ tokenId: "0" });
    assert(!r2.valid, "missing action rejected");

    const r3 = validateByorSubmission({
        tokenId: "0",
        action: { target: "not-an-address", value: "0", data: "0x" },
    });
    assert(!r3.valid, "invalid target rejected");

    const r4 = validateByorSubmission({
        tokenId: "0",
        action: { target: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd", value: "abc", data: "0x" },
    });
    assert(!r4.valid, "non-numeric value rejected");
}

// ── Test 8: BYOR checkByorSandbox ──

console.log("\n=== Test 8: BYOR sandbox enforcement ===");
{
    const action = {
        target: WBNB_ADDR,
        value: 1000n,
        data: "0xd0e30db0" as Hex,
    };

    // No strategy — should pass
    const r1 = checkByorSandbox(null, action);
    assert(r1.ok, "no strategy: sandbox passes");

    // Strategy with allowed targets — match
    const s1 = makeStrategy({
        strategyParams: { allowedTargets: [WBNB_ADDR] },
    });
    const r2 = checkByorSandbox(s1, action);
    assert(r2.ok, "allowed target: sandbox passes");

    // Strategy with allowed targets — no match
    const s2 = makeStrategy({
        strategyParams: { allowedTargets: ["0x0000000000000000000000000000000000000001"] },
    });
    const r3 = checkByorSandbox(s2, action);
    assert(!r3.ok, "disallowed target: sandbox blocks");

    // Strategy with maxValuePerRun
    const s3 = makeStrategy({
        strategyParams: { maxValuePerRun: "500" },
    });
    const r4 = checkByorSandbox(s3, action);
    assert(!r4.ok, "value exceeds maxValuePerRun: sandbox blocks");
}

// ── Test 9: BYOR schema response ──

console.log("\n=== Test 9: BYOR schema response ===");
{
    const schema = formatByorSchemaResponse({
        chainId: 97,
        agentNfaAddress: "0xcf5d434d855155beba97e3554ef9afea5ed4eb4d",
        runnerOperator: "0x1234567890123456789012345678901234567890",
    });
    assert(schema.version === "1.0.0", "schema version is 1.0.0");
    assert(schema.chainId === 97, "schema chainId = 97");
    assert(schema.submitEndpoint.includes("/byor/submit"), "submit endpoint correct");
    assert(schema.supportedActions.includes("execute"), "supports execute action");
}

// ── Summary ──

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
