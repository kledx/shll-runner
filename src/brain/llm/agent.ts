/**
 * LLM Brain — AI-powered decision making using Vercel AI SDK.
 *
 * Uses `generateText` with tool calling for multi-step reasoning:
 *   1. Sends observation + tool definitions to LLM
 *   2. LLM can call tools (get_market_data, get_portfolio) mid-reasoning
 *   3. Tool results are automatically fed back for further reasoning
 *   4. Parses final text response into a Decision
 *
 * Powered by Vercel AI SDK (`ai` + `@ai-sdk/openai`):
 *   - Automatic multi-step tool calling via `stopWhen`
 *   - Type-safe tool schemas via Zod
 *   - Full reasoning chain tracking via `result.steps`
 *   - Works with any OpenAI-compatible provider
 */

import { generateText, tool, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { z } from "zod";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { IBrain, Decision } from "../interface.js";
import type { Observation } from "../../perception/interface.js";
import type { MemoryEntry } from "../../memory/interface.js";
import type { IAction } from "../../actions/interface.js";
import type { LLMConfig } from "../../agent/agent.js";
import { buildUserPrompt } from "./prompt.js";

// ═══════════════════════════════════════════════════════
//                   Decision Schema
// ═══════════════════════════════════════════════════════

/** Zod schema for structured Decision output — sent to LLM as JSON Schema */
const DecisionSchema = z.object({
    action: z.string().describe("Action name: 'swap', 'approve', 'wrap', or 'wait'"),
    params: z.record(z.string(), z.unknown()).describe("Action parameters (tokenIn, tokenOut, amountIn, etc.)"),
    reasoning: z.string().describe("Brief explanation of why this action was chosen"),
    confidence: z.number().min(0).max(1).describe("Confidence level 0.0 to 1.0"),
    done: z.boolean().optional().describe("Set true if the task is fully complete and no further checks are needed"),
    nextCheckMs: z.number().optional().describe("Suggested milliseconds until next check: 60000=1min, 300000=5min, 3600000=1h, 86400000=1day"),
});

// ═══════════════════════════════════════════════════════
//                     LLM Brain
// ═══════════════════════════════════════════════════════

export class LLMBrain implements IBrain {
    private model: LanguageModelV3;

    constructor(
        private config: LLMConfig,
        _provider?: unknown, // kept for backward compat signature
    ) {
        const baseURL = process.env.LLM_BASE_URL || this.resolveBaseURL(config.provider);
        const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || config.apiKey || "";
        const modelId = process.env.LLM_MODEL || config.model;

        // Use dedicated @ai-sdk/deepseek provider for DeepSeek models
        // (handles tool calling format correctly)
        const isDeepSeek = baseURL.includes("deepseek.com") ||
            config.provider === "deepseek" ||
            modelId.includes("deepseek");

        if (isDeepSeek) {
            const ds = createDeepSeek({ baseURL, apiKey });
            this.model = ds(modelId) as unknown as LanguageModelV3;
        } else {
            const openai = createOpenAI({
                baseURL,
                apiKey,
                name: config.provider || "openai",
            });
            // Use .chat() to force Chat Completions API (not Responses API)
            this.model = openai.chat(modelId) as unknown as LanguageModelV3;
        }
    }

    async think(
        obs: Observation,
        memories: MemoryEntry[],
        actions: IAction[],
    ): Promise<Decision> {
        const systemPrompt = this.buildSystemPrompt(actions);
        const userPrompt = buildUserPrompt(obs, memories);
        const maxSteps = this.config.maxStepsPerRun || 3;

        // Build tools from read-only actions
        const aiTools = this.buildTools(actions, obs);

        try {
            const result = await generateText({
                model: this.model,
                system: systemPrompt,
                prompt: userPrompt,
                tools: aiTools,
                stopWhen: stepCountIs(maxSteps),
                onStepFinish: (step) => {
                    // Log tool calls for observability
                    if (step.toolCalls && step.toolCalls.length > 0) {
                        for (const tc of step.toolCalls) {
                            if (tc) {
                                console.log(`  [LLM Tool] ${tc.toolName}(${JSON.stringify(tc.input).slice(0, 100)})`);
                            }
                        }
                    }
                },
            });

            // Log step count
            console.log(`  [LLM] ${result.steps.length} step(s), finish: ${result.finishReason}`);

            // Parse the final text response into a Decision
            if (result.text) {
                return parseDecision(result.text);
            }

            // If no text (e.g. ended on tool call), default to wait
            return {
                action: "wait",
                params: {},
                reasoning: "LLM ended without a text response after tool calls",
                confidence: 0,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown LLM error";
            console.error(`  [LLM Error] ${message}`);
            return {
                action: "wait",
                params: {},
                reasoning: `LLM error: ${message}`,
                confidence: 0,
            };
        }
    }

    /** Build system prompt — tools are provided via API, not listed in prompt */
    private buildSystemPrompt(actions: IAction[]): string {
        const writeActions = actions.filter(a => !a.readonly).map(a => a.name);
        const wbnb = process.env.WBNB_ADDRESS || "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
        const parts: string[] = [
            this.config.systemPrompt,
            "",
            "## BSC Infrastructure",
            `- PancakeSwap V2 Router: 0xD99D1c33F9fC3444f8101754aBC46c52416550D1`,
            `- WBNB: ${wbnb}`,
            `- Native BNB (for tokenIn): 0x0000000000000000000000000000000000000000`,
            `- USDT (BSC): 0x55d398326f99059fF775485246999027B3197955`,
            `- BUSD (BSC): 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56`,
            "",
            "## Instructions",
            "- You have tools available to gather market data and portfolio info.",
            "- Use get_market_data to check token prices BEFORE making trade decisions.",
            "- Use get_portfolio to check your current vault holdings.",
            "- FIRST use tools to gather data (get_portfolio, get_market_data).",
            "- THEN output your final decision as a single JSON object:",
            '  { "action": "<name>", "params": { ... }, "reasoning": "<why>", "confidence": 0.0-1.0 }',
            "- Valid actions for final decision: " + writeActions.join(", ") + ", or 'wait'",
            "- For swap: ALWAYS include router, tokenIn, tokenOut, amountIn (in wei). Use the PancakeSwap V2 Router address above.",
            "- Set action='wait' if no good opportunity exists right now.",
            "- Never exceed user safety limits.",
            "- Prefer capital preservation over risky trades.",
            "- IMPORTANT: After tool calls, your FINAL response must be ONLY valid JSON. Do NOT call tools in your final response.",
            "",
            "## Scheduling Control",
            "- Set `done: true` when the user's request is FULLY SATISFIED and no further action is needed:",
            "  - Information queries: 'check my portfolio', 'what is BNB price' → answer the question, then done: true",
            "  - Single trades: 'swap 0.1 BNB to USDT' → execute, then done: true",
            "  - Any request that does NOT require ongoing monitoring → done: true",
            "- Set `done: false` (or omit) for tasks that require ONGOING monitoring or repeated checks:",
            "  - Conditional orders: 'buy when BNB drops below $300' → wait + nextCheckMs",
            "  - Recurring tasks: 'DCA 0.01 BNB into USDT every hour' → wait + nextCheckMs",
            "  - Active trading sessions: 'trade actively for the next hour' → wait + nextCheckMs",
            "- When waiting, set `nextCheckMs` to suggest re-check interval:",
            "  - Active trading: 60000 (1 min)",
            "  - Casual monitoring: 300000 (5 min)",
            "  - Low-priority: 3600000 (1 hour)",
            "- IMPORTANT: Most user queries are one-shot. Default to done: true unless the task explicitly requires re-checking.",
        ];
        return parts.join("\n");
    }

    /** Convert read-only IActions to Vercel AI SDK tools */
    private buildTools(
        actions: IAction[],
        obs: Observation,
    ) {
        // Build tool definitions from read-only actions
        // Using direct object literals to avoid complex AI SDK generic issues
        const readonlyActions = actions.filter(a => a.readonly && a.execute);

        const marketDataAction = readonlyActions.find(a => a.name === "get_market_data");
        const portfolioAction = readonlyActions.find(a => a.name === "get_portfolio");

        return {
            ...(marketDataAction ? {
                get_market_data: tool({
                    description: marketDataAction.description,
                    inputSchema: z.object({
                        tokenAddress: z.string().describe("Token contract address (0x...)"),
                    }),
                    execute: async ({ tokenAddress }) => {
                        const result = await marketDataAction.execute!({ tokenAddress });
                        return result.success ? result.data : { error: result.error };
                    },
                }),
            } : {}),
            ...(portfolioAction ? {
                get_portfolio: tool({
                    description: portfolioAction.description,
                    inputSchema: z.object({}),
                    execute: async () => {
                        const result = await portfolioAction.execute!({
                            __vaultTokens: obs.vault,
                            __nativeBalance: obs.nativeBalance.toString(),
                        });
                        return result.success ? result.data : { error: result.error };
                    },
                }),
            } : {}),
        };
    }

    /** Resolve provider name to base URL */
    private resolveBaseURL(provider: string): string {
        const PROVIDER_BASE_URLS: Record<string, string> = {
            openai: "https://api.openai.com/v1",
            deepseek: "https://api.deepseek.com/v1",
            ollama: "http://localhost:11434/v1",
        };
        return PROVIDER_BASE_URLS[provider] ?? provider;
    }
}

// ═══════════════════════════════════════════════════════
//                 Response Parsing
// ═══════════════════════════════════════════════════════

function parseDecision(response: string): Decision {
    try {
        let jsonStr = response.trim();

        // 1. Try to extract JSON from markdown code blocks
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
            jsonStr = codeBlockMatch[1].trim();
        }

        // 2. Try direct parse first
        try {
            const parsed = JSON.parse(jsonStr);
            return normalizeDecision(parsed);
        } catch {
            // Not valid JSON as-is, try extraction
        }

        // 3. Extract JSON object from mixed text (find first { to last })
        const firstBrace = jsonStr.indexOf("{");
        const lastBrace = jsonStr.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            const extracted = jsonStr.slice(firstBrace, lastBrace + 1);
            const parsed = JSON.parse(extracted);
            return normalizeDecision(parsed);
        }

        throw new Error("No JSON object found in response");
    } catch {
        return {
            action: "wait",
            params: {},
            reasoning: `Failed to parse LLM response: ${response.slice(0, 200)}`,
            confidence: 0,
        };
    }
}

/** Normalize a parsed JSON object into a typed Decision */
function normalizeDecision(parsed: Record<string, unknown>): Decision {
    return {
        action: typeof parsed.action === "string" ? parsed.action : "wait",
        params: typeof parsed.params === "object" && parsed.params !== null
            ? (parsed.params as Record<string, unknown>)
            : {},
        reasoning: typeof parsed.reasoning === "string"
            ? parsed.reasoning
            : "No reasoning provided",
        confidence: typeof parsed.confidence === "number"
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0.5,
        done: typeof parsed.done === "boolean" ? parsed.done : undefined,
        nextCheckMs: typeof parsed.nextCheckMs === "number" && parsed.nextCheckMs >= 0
            ? parsed.nextCheckMs
            : undefined,
    };
}
