/**
 * E2E Test — LLM Tool Calling via Vercel AI SDK.
 *
 * Directly tests the LLMBrain with mock observation data to verify:
 *   1. createOpenAI connects to the configured LLM provider
 *   2. Tool definitions are properly sent
 *   3. Multi-step reasoning works (tool call → tool result → final decision)
 *   4. parseDecision produces a valid Decision object
 *
 * Usage: npx tsx scripts/test-llm-e2e.ts
 */

import "dotenv/config";
import { LLMBrain } from "../src/brain/llm/agent.js";
import type { IAction, ToolResult } from "../src/actions/interface.js";
import type { Observation } from "../src/perception/interface.js";
import type { MemoryEntry } from "../src/memory/interface.js";
import type { LLMConfig } from "../src/agent/agent.js";

// ── Mock observation ──────────────────────────────────
const mockObservation: Observation = {
    vault: [
        { symbol: "WBNB", balance: 500000000000000000n, decimals: 18, token: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" },
    ],
    prices: new Map([
        ["0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd", 600],
    ]),
    nativeBalance: 100000000000000000n, // 0.1 BNB
    gasPrice: 3000000000n,
    blockNumber: 91100000n,
    paused: false,
};

const mockMemories: MemoryEntry[] = [];

// ── Mock read-only actions ───────────────────────────
const mockAnalytics: IAction = {
    name: "get_market_data",
    description: "Fetch real-time market data for a token on BSC.",
    readonly: true,
    parameters: {
        type: "object",
        properties: {
            tokenAddress: { type: "string", description: "Token contract address (0x...)" },
        },
        required: ["tokenAddress"],
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
        console.log("  [TOOL CALLED] get_market_data:", params);
        return {
            success: true,
            data: {
                pair: "CAKE/WBNB",
                priceUsd: "2.45",
                volume24h: 12500000,
                priceChange24h: "-3.2%",
                liquidityUsd: 8500000,
            },
        };
    },
    encode() {
        return { target: "0x0000000000000000000000000000000000000000" as `0x${string}`, value: 0n, data: "0x" as `0x${string}` };
    },
};

const mockPortfolio: IAction = {
    name: "get_portfolio",
    description: "Get the agent's current vault holdings.",
    readonly: true,
    parameters: { type: "object", properties: {}, required: [] },
    async execute(): Promise<ToolResult> {
        console.log("  [TOOL CALLED] get_portfolio");
        return {
            success: true,
            data: {
                vaultAddress: "0xMockVault",
                nativeBalance: "100000000000000000",
                tokens: [{ symbol: "WBNB", balance: "500000000000000000", decimals: 18 }],
            },
        };
    },
    encode() {
        return { target: "0x0000000000000000000000000000000000000000" as `0x${string}`, value: 0n, data: "0x" as `0x${string}` };
    },
};

const mockSwap: IAction = {
    name: "swap",
    description: "Execute a token swap on PancakeSwap.",
    readonly: false,
    parameters: {
        type: "object",
        properties: {
            tokenIn: { type: "string", description: "Input token address" },
            tokenOut: { type: "string", description: "Output token address" },
            amountIn: { type: "string", description: "Amount to swap in wei" },
        },
        required: ["tokenIn", "tokenOut", "amountIn"],
    },
    encode() {
        return { target: "0x0000000000000000000000000000000000000000" as `0x${string}`, value: 0n, data: "0x" as `0x${string}` };
    },
};

// ── Main ──────────────────────────────────────────────
async function main() {
    console.log("═══════════════════════════════════════════════");
    console.log("  LLM Tool Calling E2E Test");
    console.log("═══════════════════════════════════════════════");
    console.log();

    const provider = process.env.LLM_PROVIDER || "openai";
    const model = process.env.LLM_MODEL || "gpt-4o-mini";
    const baseUrl = process.env.LLM_BASE_URL || "";
    const apiKey = process.env.LLM_API_KEY || "";

    console.log(`Provider: ${provider}`);
    console.log(`Model:    ${model}`);
    console.log(`Base URL: ${baseUrl}`);
    console.log(`API Key:  ${apiKey ? apiKey.slice(0, 8) + "..." : "(empty)"}`);
    console.log();

    const llmConfig: LLMConfig = {
        systemPrompt: "You are a DeFi trading agent on BSC testnet. Analyze market data and vault positions. Be conservative.",
        provider,
        model,
        apiKey,
        maxStepsPerRun: 3,
    };

    const brain = new LLMBrain(llmConfig);
    const actions: IAction[] = [mockAnalytics, mockPortfolio, mockSwap];

    console.log("Calling brain.think() — expecting multi-step tool calls...\n");

    const startTime = Date.now();
    const decision = await brain.think(mockObservation, mockMemories, actions);
    const elapsed = Date.now() - startTime;

    console.log();
    console.log("═══════════════════════════════════════════════");
    console.log("  Result");
    console.log("═══════════════════════════════════════════════");
    console.log(`  Action:     ${decision.action}`);
    console.log(`  Params:     ${JSON.stringify(decision.params)}`);
    console.log(`  Reasoning:  ${decision.reasoning}`);
    console.log(`  Confidence: ${decision.confidence}`);
    console.log(`  Elapsed:    ${elapsed}ms`);
    console.log();

    if (decision.action === "wait" && decision.reasoning.includes("error")) {
        console.log("❌ FAIL — LLM returned an error");
        process.exit(1);
    } else {
        console.log("✅ PASS — LLM completed reasoning successfully");
        process.exit(0);
    }
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
