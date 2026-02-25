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
import { sanitizeForUser } from "../../errors.js";
import { getChainAddressBook, getChainIdFromEnv } from "../../chainDefaults.js";
import * as cadenceRuntime from "./cadence.js";

// ═══════════════════════════════════════════════════════
//                   Decision Schema
// ═══════════════════════════════════════════════════════

const DecisionSchema = z.object({
    action: z.string().describe("Action name: 'swap', 'approve', 'wrap', or 'wait'"),
    params: z.record(z.string(), z.unknown()).describe("Action parameters (tokenIn, tokenOut, amountIn, etc.)"),
    reasoning: z.string().describe("Internal analysis of why this action was chosen — not shown to user"),
    message: z.string().optional().describe("User-facing reply: what you want to say to the user in a friendly, conversational tone"),
    confidence: z.number().min(0).max(1).describe("Confidence level 0.0 to 1.0"),
    done: z.boolean().optional().describe("Set true if the task is fully complete and no further checks are needed"),
    nextCheckMs: z.number().optional().describe("Suggested milliseconds until next check: 60000=1min, 300000=5min, 3600000=1h, 86400000=1day"),
    blocked: z.boolean().optional().describe("Set true if the task CANNOT proceed due to missing prerequisites (no funds, no approval, etc.)"),
    blockReason: z.string().optional().describe("User-facing reason why the agent is blocked"),
});

// ═══════════════════════════════════════════════════════
//                     LLM Brain
// ═══════════════════════════════════════════════════════

export class LLMBrain implements IBrain {
    private model: LanguageModelV3;
    private fallbackModel?: LanguageModelV3;

    constructor(
        private config: LLMConfig,
        _provider?: unknown, // kept for backward compat signature
    ) {
        this.model = this.createModel(config.provider, config.model, config.endpoint, config.apiKey);

        if (config.fallbackProvider && config.fallbackModel) {
            this.fallbackModel = this.createModel(
                config.fallbackProvider,
                config.fallbackModel,
                undefined,
                undefined
            );
        }
    }

    private createModel(providerStr: string, modelId: string, customEndpoint?: string, customApiKey?: string): LanguageModelV3 {
        const baseURL = customEndpoint || process.env.LLM_BASE_URL || this.resolveBaseURL(providerStr);
        const apiKey = customApiKey || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "";

        const isDeepSeek = baseURL.includes("deepseek.com") ||
            providerStr === "deepseek" ||
            modelId.includes("deepseek");

        if (isDeepSeek) {
            const ds = createDeepSeek({ baseURL, apiKey });
            return ds(modelId) as unknown as LanguageModelV3;
        } else {
            const openai = createOpenAI({ baseURL, apiKey, name: providerStr || "openai" });
            return openai.chat(modelId) as unknown as LanguageModelV3;
        }
    }

    async think(
        obs: Observation,
        memories: MemoryEntry[],
        actions: IAction[],
    ): Promise<Decision> {
        const systemPrompt = this.buildSystemPrompt(actions);
        const userPrompt = buildUserPrompt(obs, memories);
        const maxSteps = this.config.maxStepsPerRun || 5;

        // Always give LLM full tool access — let the model decide when to use them
        const aiTools = this.buildTools(actions, obs);
        const toolChoice = "auto" as const;

        console.log(`  [LLM] goal="${(this.config.tradingGoal ?? "").slice(0, 60)}" maxSteps=${maxSteps}`);

        let decision = await this.executeTurn(this.model, systemPrompt, userPrompt, aiTools, toolChoice, maxSteps, memories);

        if (decision.action === "wait" && decision.confidence === 0 && this.fallbackModel) {
            console.log(`  [LLM Fallback] Primary model failed, retrying with fallback model...`);
            decision = await this.executeTurn(this.fallbackModel, systemPrompt, userPrompt, aiTools, toolChoice, maxSteps, memories);
        }

        return decision;
    }

    private async executeTurn(
        activeModel: LanguageModelV3,
        systemPrompt: string,
        userPrompt: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        aiTools: any,
        toolChoice: "auto" | "none" | "required",
        maxSteps: number,
        memories: MemoryEntry[]
    ): Promise<Decision> {
        try {
            const result = await generateText({
                model: activeModel,
                system: systemPrompt,
                prompt: userPrompt,
                tools: aiTools,
                toolChoice,
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

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawUsage = result.usage as any;
            const usage = rawUsage ? {
                promptTokens: typeof rawUsage.promptTokens === 'number' ? rawUsage.promptTokens : (rawUsage.promptTokenCount || 0),
                completionTokens: typeof rawUsage.completionTokens === 'number' ? rawUsage.completionTokens : (rawUsage.completionTokenCount || 0),
            } : undefined;

            // Log step count and token usage
            console.log(`  [LLM] ${result.steps.length} step(s), finish: ${result.finishReason}, tokens: ${usage?.promptTokens || 0} in / ${usage?.completionTokens || 0} out`);

            // Parse the final text response into a Decision
            if (result.text) {
                console.log(`  [LLM Raw] ${result.text.slice(0, 200)}`);
                const parsed = parseDecision(result.text);
                parsed.usage = usage;
                return this.applyCadenceFallback(parsed, memories);
            }

            // If no text (e.g. maxSteps exhausted on tool call), extract last tool result
            const lastStep = result.steps[result.steps.length - 1];
            const lastToolResults = lastStep?.toolResults;
            if (lastToolResults && lastToolResults.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const toolData = (lastToolResults as any[]).filter(Boolean).map((tr) =>
                    `[${tr.toolName}] ${JSON.stringify(tr.result).slice(0, 300)}`
                ).join("\n");
                console.log(`  [LLM] No final text — using tool results as reasoning`);
                return {
                    action: "wait",
                    params: {},
                    reasoning: toolData,
                    confidence: 0.6,
                    done: true,
                    usage,
                };
            }
            const fallback: Decision = {
                action: "wait",
                params: {},
                reasoning: "Agent completed processing — no additional output",
                confidence: 0,
                usage,
            };
            return this.applyCadenceFallback(fallback, memories);
        } catch (error) {
            const rawMessage = error instanceof Error ? error.message : "Unknown LLM error";
            console.error(`  [LLM Error] ${rawMessage}`);
            const userMessage = sanitizeForUser(rawMessage);
            const fallback: Decision = {
                action: "wait",
                params: {},
                reasoning: `System error (details logged)`,
                message: userMessage,
                confidence: 0, // 0 confidence used as trigger for fallback in caller
            };
            return this.applyCadenceFallback(fallback, memories);
        }
    }

    private applyCadenceFallback(decision: Decision, memories: MemoryEntry[]): Decision {
        const goal = this.config.tradingGoal ?? "";
        const recurringCadence = cadenceRuntime.parseRecurringMessageIntent(goal);
        if (recurringCadence) {
            const marker = `cadence:${recurringCadence.signature}`;
            const progress = cadenceRuntime.buildCadenceProgress({
                marker,
                intervalMs: recurringCadence.intervalMs,
                durationMs: recurringCadence.durationMs,
                memories,
            });

            if (progress.completed) {
                return {
                    ...decision,
                    action: "wait",
                    params: cadenceRuntime.attachCadenceParams(decision.params, marker, "done", progress.startedAtMs),
                    message: recurringCadence.doneMessage,
                    done: true,
                    nextCheckMs: undefined,
                    blocked: false,
                    blockReason: undefined,
                    reasoning: "Cadence task completed by runtime fallback.",
                    confidence: Math.max(decision.confidence ?? 0, 0.8),
                };
            }

            return {
                ...decision,
                action: "wait",
                params: cadenceRuntime.attachCadenceParams(decision.params, marker, "active", progress.startedAtMs),
                message: recurringCadence.message,
                done: false,
                nextCheckMs: recurringCadence.intervalMs,
                blocked: false,
                blockReason: undefined,
                reasoning: "Cadence task active via runtime fallback.",
                confidence: Math.max(decision.confidence ?? 0, 0.8),
            };
        }

        const timedCadence = cadenceRuntime.parseTimedMonitoringIntent(goal);
        if (!timedCadence) {
            return decision;
        }

        const marker = `cadence:${timedCadence.signature}`;
        const progress = cadenceRuntime.buildCadenceProgress({
            marker,
            intervalMs: timedCadence.intervalMs,
            durationMs: timedCadence.durationMs,
            memories,
        });

        if (progress.completed) {
            if (decision.action !== "wait") {
                return {
                    ...decision,
                    params: cadenceRuntime.attachCadenceParams(decision.params, marker, "done", progress.startedAtMs),
                };
            }
            return {
                ...decision,
                action: "wait",
                params: cadenceRuntime.attachCadenceParams(decision.params, marker, "done", progress.startedAtMs),
                message: timedCadence.doneMessage,
                done: true,
                nextCheckMs: undefined,
                blocked: false,
                blockReason: undefined,
                reasoning: "Timed monitoring window completed by runtime fallback.",
                confidence: Math.max(decision.confidence ?? 0, 0.75),
            };
        }

        if (decision.action === "wait") {
            return {
                ...decision,
                params: cadenceRuntime.attachCadenceParams(decision.params, marker, "active", progress.startedAtMs),
                message: decision.message ?? timedCadence.activeMessage,
                done: false,
                nextCheckMs: timedCadence.intervalMs,
                blocked: decision.blocked ?? false,
                blockReason: decision.blockReason,
                reasoning: "Timed monitoring window active via runtime fallback.",
                confidence: Math.max(decision.confidence ?? 0, 0.75),
            };
        }

        return {
            ...decision,
            params: cadenceRuntime.attachCadenceParams(decision.params, marker, "active", progress.startedAtMs),
        };
    }

    /** Build system prompt — structured and compressed */
    private buildSystemPrompt(actions: IAction[]): string {
        const writeActions = actions.filter(a => !a.readonly).map(a => a.name);
        const chainId = getChainIdFromEnv();
        const chainDefaults = getChainAddressBook(chainId);
        const wbnb = process.env.WBNB_ADDRESS || chainDefaults.wbnb;
        const router = process.env.ROUTER_ADDRESS || chainDefaults.router;
        const usdt = chainDefaults.usdt;
        const busd = chainDefaults.busd;

        return [
            this.config.systemPrompt,
            "",
            "## Environment",
            `- Chain ID: ${chainId} | Router: ${router}`,
            `- WBNB: ${wbnb} | Native BNB: 0x0000000000000000000000000000000000000000`,
            `- USDT: ${usdt} | BUSD: ${busd}`,
            "",
            "## Core Rules",
            "1. DECISIONS: Output JSON only: {action, params, reasoning, message, confidence, done?, nextCheckMs?, blocked?, blockReason?}",
            `   Valid actions: ${writeActions.join(", ")}, or 'wait'`,
            "2. TOOL USE: Use get_market_data prior to trading. Use get_portfolio to check vault balances. Do NOT call tools for conversational queries.",
            "3. SWAP PARAMS: Ensure action='swap' has {router, tokenIn, tokenOut, amountIn}. Do NOT set minOut — it is auto-calculated from on-chain price.",
            "4. AUTOMATED APPROVALS: 'approve' is handled automatically. NEVER output action='approve', just output 'swap'.",
            "5. ROUTING OPTS: Minimize hops. When selling an ERC20, swap to WBNB (not USDT) unless user requests stablecoins.",
            "6. SCHEDULING: Set done=true for one-shot requests. Set done=false with nextCheckMs for recurring/monitoring tasks.",
            "7. MESSAGING: Reply in the SAME language as the user. Use a conversational tone.",
            "",
            "## Handling Blocks & Errors",
            "- DO NOT refuse trades for 'whitelist' or 'policy' reasons. The systemic guardrails handle this. Submit the trade anyway.",
            "- Ignore [POLICY: handled by user] lines in history.",
            "- Set blocked=true ONLY if: (a) Vault balance for tokenIn is exactly 0, or (b) Native BNB is 0 (no gas).",
            "- If a trade fails due to gas, set blockReason prompting the user to send BNB to their Agent Account.",
            "- If user asks about deposits, tell them to send tokens to the Agent Account (visible in Console -> Vault).",
            "- NEVER split a trade into test/batch amounts. Execute the FULL requested amount in one swap.",
            "- If user says 'buy $X worth', calculate amountIn = $X / tokenPrice_in_native (e.g. $1 / $621_per_BNB = 0.00161 BNB = 1610000000000000 wei). Do NOT round down."
        ].join("\n");
    }
    /** Convert read-only IActions to Vercel AI SDK tools */
    private buildTools(
        actions: IAction[],
        obs: Observation,
    ) {
        // Build tool definitions from read-only actions
        const readonlyActions = actions.filter(a => a.readonly && a.execute);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tools: Record<string, any> = {};

        const marketDataAction = readonlyActions.find(a => a.name === "get_market_data");
        if (marketDataAction) {
            tools.get_market_data = tool({
                description: marketDataAction.description,
                inputSchema: z.object({
                    tokenAddress: z.string().describe("Token contract address (0x...)"),
                }),
                execute: async ({ tokenAddress }: { tokenAddress: string }) => {
                    const result = await marketDataAction.execute!({ tokenAddress });
                    return result.success ? result.data : { error: result.error };
                },
            });
        }

        const portfolioAction = readonlyActions.find(a => a.name === "get_portfolio");
        if (portfolioAction) {
            tools.get_portfolio = tool({
                description: portfolioAction.description,
                inputSchema: z.object({}),
                execute: async () => {
                    const result = await portfolioAction.execute!({
                        __vaultTokens: obs.vault,
                        __nativeBalance: obs.nativeBalance.toString(),
                    });
                    return result.success ? result.data : { error: result.error };
                },
            });
        }

        const allowanceAction = readonlyActions.find(a => a.name === "get_allowance");
        if (allowanceAction) {
            tools.get_allowance = tool({
                description: allowanceAction.description,
                inputSchema: z.object({
                    token: z.string().describe("ERC20 token contract address"),
                    spender: z.string().describe("Spender address (e.g. PancakeSwap router)"),
                }),
                execute: async ({ token, spender }: { token: string; spender: string }) => {
                    const result = await allowanceAction.execute!({ token, owner: obs.vaultAddress, spender });
                    return result.success ? result.data : { error: result.error };
                },
            });
        }

        return tools;
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
            // Capture text OUTSIDE the code block as potential conversational content
            const textOutside = jsonStr
                .replace(/```(?:json)?\s*[\s\S]*?```/, "")
                .trim();
            jsonStr = codeBlockMatch[1].trim();

            // Parse the JSON
            try {
                const parsed = JSON.parse(jsonStr);
                const decision = normalizeDecision(parsed);
                // If text outside code block is conversational content, use as message
                if (textOutside.length > 20 && !decision.message) {
                    decision.message = textOutside.slice(0, 1000);
                }
                return decision;
            } catch { /* fall through to other strategies */ }
        }

        // 2. Try direct parse first (entire response is pure JSON)
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
            // Capture text before the JSON as conversational content
            const textBefore = jsonStr.slice(0, firstBrace).trim();
            const extracted = jsonStr.slice(firstBrace, lastBrace + 1);
            try {
                const parsed = JSON.parse(extracted);
                const decision = normalizeDecision(parsed);
                // Use conversational text as message if not already set
                if (textBefore.length > 20 && !decision.message) {
                    decision.message = textBefore.slice(0, 1000);
                }
                return decision;
            } catch { /* fall through */ }
        }

        throw new Error("No JSON object found in response");
    } catch {
        // If the response is not JSON at all, treat it as a conversational answer
        const trimmed = response.trim();
        if (trimmed.length > 0 && !trimmed.startsWith("{")) {
            return {
                action: "wait",
                params: {},
                reasoning: "Conversational response — no action needed",
                message: trimmed.slice(0, 1000),
                confidence: 0.8,
                done: true,
            };
        }
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
            : parsed.reasoning != null
                ? String(parsed.reasoning)
                : "No reasoning provided",
        message: typeof parsed.message === "string" ? parsed.message : undefined,
        confidence: typeof parsed.confidence === "number"
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0.5,
        done: typeof parsed.done === "boolean" ? parsed.done : undefined,
        nextCheckMs: typeof parsed.nextCheckMs === "number" && parsed.nextCheckMs >= 0
            ? parsed.nextCheckMs
            : undefined,
        blocked: typeof parsed.blocked === "boolean" ? parsed.blocked : undefined,
        blockReason: typeof parsed.blockReason === "string" ? parsed.blockReason : undefined,
    };
}

