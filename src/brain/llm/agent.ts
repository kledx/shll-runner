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
        const maxSteps = this.config.maxStepsPerRun || 5;

        // Always give LLM full tool access — let the model decide when to use them
        const aiTools = this.buildTools(actions, obs);
        const toolChoice = "auto" as const;

        console.log(`  [LLM] goal="${(this.config.tradingGoal ?? "").slice(0, 60)}" maxSteps=${maxSteps}`);

        try {
            const result = await generateText({
                model: this.model,
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

            // Log step count
            console.log(`  [LLM] ${result.steps.length} step(s), finish: ${result.finishReason}`);

            // Parse the final text response into a Decision
            if (result.text) {
                console.log(`  [LLM Raw] ${result.text.slice(0, 200)}`);
                return parseDecision(result.text);
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
                };
            }
            return {
                action: "wait",
                params: {},
                reasoning: "Agent completed processing — no additional output",
                confidence: 0,
            };
        } catch (error) {
            const rawMessage = error instanceof Error ? error.message : "Unknown LLM error";
            console.error(`  [LLM Error] ${rawMessage}`);
            const userMessage = sanitizeForUser(rawMessage);
            return {
                action: "wait",
                params: {},
                reasoning: `System error (details logged)`,
                message: userMessage,
                confidence: 0,
            };
        }
    }

    /** Build system prompt — tools are provided via API, not listed in prompt */
    private buildSystemPrompt(actions: IAction[]): string {
        const writeActions = actions.filter(a => !a.readonly).map(a => a.name);
        const chainId = getChainIdFromEnv();
        const chainDefaults = getChainAddressBook(chainId);
        const wbnb = process.env.WBNB_ADDRESS || chainDefaults.wbnb;
        const router = process.env.ROUTER_ADDRESS || chainDefaults.router;
        const usdt = chainDefaults.usdt;
        const busd = chainDefaults.busd;
        const parts: string[] = [
            this.config.systemPrompt,
            "",
            "## BSC Infrastructure",
            `- Chain ID: ${chainId}`,
            `- PancakeSwap V2 Router: ${router}`,
            `- WBNB: ${wbnb}`,
            `- Native BNB (for tokenIn): 0x0000000000000000000000000000000000000000`,
            `- USDT (BSC): ${usdt}`,
            `- BUSD (BSC): ${busd}`,
            "",
            "## Instructions",
            "- NEVER mix BSC mainnet and testnet addresses in the same action.",
            "- ASSESS the user's intent before calling tools. Ask yourself: does this request need real-time on-chain data?",
            "  1. NEEDS ON-CHAIN DATA → call tools first:",
            "     - Trade requests (swap, buy, sell, convert) → get_portfolio + get_market_data",
            "     - Balance / holdings queries → get_portfolio only",
            "     - Price / market queries → get_market_data only",
            "  2. DOES NOT NEED ON-CHAIN DATA → respond directly, NO tool calls, set done: true:",
            "     - Greetings, small talk, test messages",
            "     - Questions about the platform (what is SHLL, how to deposit, what can you do)",
            "     - Strategy explanations, safety policy questions",
            "     - General crypto / DeFi knowledge questions",
            "     - Error troubleshooting (use SHLL Platform Context below)",
            "- Use get_market_data to check token prices BEFORE making trade decisions.",
            "- Use get_portfolio to check your current vault holdings.",
            "- THEN output your final decision as a single JSON object:",
            '  { "action": "<name>", "params": { ... }, "reasoning": "<internal analysis>", "message": "<what you say to the user>", "confidence": 0.0-1.0 }',
            "- Valid actions for final decision: " + writeActions.join(", ") + ", or 'wait'",
            "- For swap: ALWAYS include router, tokenIn, tokenOut, amountIn, AND minOut (all in wei). Use the PancakeSwap V2 Router address above.",
            "  IMPORTANT: minOut MUST be non-zero! Calculate it as: expectedOutput * (1 - slippage). Use 2-5% slippage tolerance.",
            "",
            "## Two-Step Swap Workflow (CRITICAL — READ CAREFULLY)",
            "- MANDATORY RULE: You MUST call `get_allowance` BEFORE EVER outputting action='approve'.",
            "  NEVER output approve without checking allowance first. This is NON-NEGOTIABLE.",
            "- For ERC20 swaps (e.g. USDT → BNB), follow this EXACT sequence:",
            "  1. Call get_portfolio and get_market_data to gather data",
            "  2. Call get_allowance(token=tokenIn, owner=vaultAddress, spender=routerAddress)",
            "  3. If allowance >= amountIn → output action='swap' directly (SKIP approve entirely!)",
            "  4. If allowance == 0 or < amountIn → output action='approve', set done: false, nextCheckMs: 10000",
            "  5. On the NEXT cycle, call get_allowance again to verify, then output action='swap'",
            "- If swapping native BNB (tokenIn = 0x0000...0000), skip approve entirely → go directly to swap.",
            "- After approve, tell user: 'Approval done, swap executing next...'",
            "- For approve: spender must be the PancakeSwap V2 Router address listed above.",
            "- Never exceed user safety limits.",
            "- Prefer capital preservation over risky trades.",
            "- `reasoning`: internal analysis for debugging (not shown to user). Keep concise.",
            "- `message`: user-facing reply. Write in a friendly, conversational tone. Required for all responses. PLAIN TEXT ONLY — do NOT use markdown formatting (no **, *, #, ```, etc.).",
            "  Examples: 'I checked BNB price — it's at $312. No good entry yet, I'll keep watching.' or 'Your vault has 0.5 WBNB and 100 USDT. Everything looks healthy.'",
            "- IMPORTANT: After tool calls, your FINAL response must be ONLY valid JSON. Do NOT call tools in your final response.",
            "",
            "## Blocked Signal",
            "- Set `blocked: true` ONLY when you have CONCRETE EVIDENCE that the task cannot proceed:",
            "  - For trades: Vault balance for the token you are SPENDING (tokenIn) is literally 0 → blocked: true",
            "  - CRITICAL LOGIC: If the user wants to BUY a token (tokenOut), it is NORMAL for its balance to be 0! Do NOT block!",
            "  - Native BNB balance is 0 (cannot pay gas) → blocked: true",
            "  - Recent History shows a SPECIFIC error message (e.g. 'Unauthorized', 'insufficient funds') → blocked: true",
            "- CRITICAL: Do NOT preemptively assume failure. If no error appears in Recent History, ALWAYS attempt the action.",
            "  - If the user asks to swap USDT and vault has USDT → just do the approve + swap. Do NOT guess that 'previous attempt failed'.",
            "  - If you see `0xacfdb444` or `ExecutionFailed` in Recent History, it means a previous trade failed (e.g. liquidity issue), but it has NOTHING to do with authorization.",
            "  - DO NOT confuse `0xacfdb444` with `Unauthorized`.",
            "  - If a previous attempt failed with `0xacfdb444` or `ExecutionFailed`, YOU MUST IGNORE IT and output your planned action (e.g., `swap`) again! Do NOT output `wait`. The system has an external Circuit Breaker to handle retry loops, so DO NOT be afraid to retry.",
            "  - If you're unsure → attempt the action. The guardrails will block it if there's a real problem.",
            "- When blocked: set action='wait', done: false. The scheduler will back off to 5-min intervals until user fixes the issue.",
            "- Do NOT use blocked for: market conditions, token approvals (handled automatically), or speculative failure reasons.",
            "",
            "## SHLL Platform Context",
            "You are an AI Agent running on the SHLL platform. When encountering issues, guide the user:",
            "- If vault balance is 0 or too low for the token you need to SPEND:",
            '  → Set blocked: true, blockReason: "Your vault has insufficient balance for the token you want to spend. Please send it to your Agent Account address shown at the top of the Console page."',
            "- If a trade fails due to gas / insufficient BNB:",
            '  → Set blocked: true, blockReason: "Your Agent needs BNB for gas fees. Send a small amount of BNB (e.g. 0.01 BNB) to the Agent Account address."',
            "- If user asks how to deposit or fund the agent:",
            '  → Tell user: "Go to the Console page → Vault section. Your Agent Account address is shown at the top. Send tokens directly to that address from your wallet."',
            "- If user asks what you are or what SHLL is:",
            '  → Tell user: "I am an on-chain AI trading agent on the SHLL platform. I can execute trades, monitor markets, and manage your vault — all validated by on-chain safety rules (PolicyGuard)."',
            "- IMPORTANT: You are NOT responsible for checking DEX whitelists, token permissions, or spending limits.",
            "  The guardrails system does this automatically AFTER you submit an action.",
            "  Your job is to ATTEMPT the action. If it violates a policy, the system will block it and tell the user.",
            "  Do NOT preemptively set blocked: true for policy-related reasons. Just submit the action.",
            "- If a trade fails with 'Unauthorized' or 'operator expired' error specifically from on-chain execution (shown as [ERROR: ...] in Recent History):",
            '  → Set blocked: true, blockReason: "On-chain authorization may have expired. Go to Console → click Enable Autopilot to re-authorize."',
            "- NEVER invent or fabricate error messages. Only reference errors that appear verbatim in [ERROR: ...] entries in Recent History.",
            "",
            "## Scheduling Control",
            "- Set `done: true` when the user's request is FULLY SATISFIED and no further action is needed:",
            "  - Information queries: 'check my portfolio', 'what is BNB price' → answer the question, then done: true",
            "  - Single trades: 'swap 0.1 BNB to USDT' → execute, then done: true",
            "  - Any request that does NOT require ongoing monitoring → done: true",
            "- Set `done: false` (or omit) for tasks that require ONGOING monitoring or repeated checks:",
            "  - Conditional orders: 'buy when BNB drops below $300' → wait + nextCheckMs",
            "  - Recurring tasks: 'Buy 0.01 BNB automatically every hour' → wait + nextCheckMs",
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
