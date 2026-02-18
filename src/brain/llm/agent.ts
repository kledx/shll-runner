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
import { z } from "zod";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { IBrain, Decision } from "../interface.js";
import type { Observation } from "../../perception/interface.js";
import type { MemoryEntry } from "../../memory/interface.js";
import type { IAction } from "../../actions/interface.js";
import type { LLMConfig } from "../../agent/agent.js";
import { buildUserPrompt } from "./prompt.js";

// ═══════════════════════════════════════════════════════
//                     LLM Brain
// ═══════════════════════════════════════════════════════

export class LLMBrain implements IBrain {
    private model: LanguageModelV3;

    constructor(
        private config: LLMConfig,
        _provider?: unknown, // kept for backward compat signature
    ) {
        // Create OpenAI-compatible provider via Vercel AI SDK
        const baseURL = process.env.LLM_BASE_URL || this.resolveBaseURL(config.provider);
        const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || config.apiKey || "";
        const modelId = process.env.LLM_MODEL || config.model;

        const provider = createOpenAI({
            baseURL,
            apiKey,
            name: config.provider || "openai",
        });

        // Use .chat() to force Chat Completions API (not Responses API)
        this.model = provider.chat(modelId) as unknown as LanguageModelV3;
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
        const parts: string[] = [
            this.config.systemPrompt,
            "",
            "## Instructions",
            "- You have tools available to gather market data and portfolio info.",
            "- Use get_market_data to check token prices BEFORE making trade decisions.",
            "- Use get_portfolio to check your current vault holdings.",
            "- After gathering data, make your final decision as a JSON response:",
            '  { "action": "<name>", "params": { ... }, "reasoning": "<why>", "confidence": 0.0-1.0 }',
            "- Valid actions for final decision: " + writeActions.join(", ") + ", or 'wait'",
            "- Set action='wait' if no good opportunity exists right now.",
            "- Never exceed user safety limits.",
            "- Prefer capital preservation over risky trades.",
            "- IMPORTANT: Your final response must be ONLY valid JSON, no markdown or extra text.",
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
        // Try to extract JSON from the response (handle markdown code blocks)
        let jsonStr = response.trim();
        const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1].trim();
        }

        const parsed = JSON.parse(jsonStr);

        return {
            action: typeof parsed.action === "string" ? parsed.action : "wait",
            params: typeof parsed.params === "object" && parsed.params !== null
                ? parsed.params
                : {},
            reasoning: typeof parsed.reasoning === "string"
                ? parsed.reasoning
                : "No reasoning provided",
            confidence: typeof parsed.confidence === "number"
                ? Math.max(0, Math.min(1, parsed.confidence))
                : 0.5,
        };
    } catch {
        return {
            action: "wait",
            params: {},
            reasoning: `Failed to parse LLM response: ${response.slice(0, 200)}`,
            confidence: 0,
        };
    }
}
