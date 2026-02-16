/**
 * LLM Trader Strategy (V1.4.1 §5-§6)
 *
 * Flow: System Prompt → LLM Tool Loop → Structured Output (ActionIntent[])
 *       → Intent Validation → Encoder → ActionPayload
 *
 * Guardrails:
 * - maxSteps: 6 (maximum tool call iterations)
 * - maxIntents: 2 (maximum ActionIntents per run)
 * - confidence >= 0.6 (minimum required confidence)
 * - cooldown: 30 minutes between runs
 * - timeout: configurable (default 30s)
 */

import type { Address } from "viem";
import type { MarketSignalRecord, Observation, StrategyConfigRecord } from "../types.js";
import type { ActionIntent } from "../intentEncoder.js";
import { encodeActionIntent, validateActionIntent } from "../intentEncoder.js";
import { buildToolExecutors, getToolDefinitionsForLLM, type LLMToolContext } from "../llmTools.js";
import type { ActionPayload } from "../types.js";

// ── Configuration Types ────────────────────────────────────────────

export interface LLMTraderConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
    maxTokens: number;
    timeoutMs: number;
}

interface LLMTraderParams {
    maxSteps: number;
    maxIntents: number;
    minConfidence: number;
    cooldownMs: number;
    toolAllowList?: string[];
    systemPromptOverride?: string;
}

export interface LLMTraderResult {
    action?: ActionPayload;
    reason: string;
    intents?: ActionIntent[];
    explain?: string;
}

// ── Default Parameters ─────────────────────────────────────────────

const DEFAULT_PARAMS: LLMTraderParams = {
    maxSteps: 6,
    maxIntents: 2,
    minConfidence: 0.6,
    cooldownMs: 30 * 60 * 1000, // 30 minutes
};

// ── System Prompt ──────────────────────────────────────────────────

function buildSystemPrompt(obs: Observation): string {
    const instCfg = obs.instanceConfig;
    const limitInfo = instCfg
        ? `Policy: id=${instCfg.policyId}, slippage=${instCfg.slippageBps}bps, tradeLimit=${instCfg.tradeLimit.toString()}, dailyLimit=${instCfg.dailyLimit.toString()}, riskTier=${instCfg.riskTier}`
        : "No instance config bound.";

    return `You are a DeFi trading agent operating on-chain. Your task is to analyze market signals and decide whether to execute a swap.

## Context
- Agent Token ID: ${obs.tokenId.toString()}
- Agent Account (vault): ${obs.agentAccount}
- Agent Balance: ${obs.agentState.balance.toString()} wei
- Block: ${obs.blockNumber.toString()}
- ${limitInfo}

## Rules
1. You MUST use the available tools to gather market data before making a decision.
2. If no profitable opportunity exists, return an empty intents array.
3. Each intent must include a confidence score (0.0-1.0). Only intents with confidence >= threshold will be executed.
4. Never swap the entire balance. Leave at least 10% as reserve.
5. Always set minOut to protect against slippage.
6. Provide clear reasoning for each decision in the reason field.

## Output Format
Return a JSON object with:
{
  "intents": [
    {
      "type": "swap" | "approve",
      "router": "0x...",
      "tokenIn": "0x...",
      "tokenOut": "0x...",
      "amountIn": "...",
      "minOut": "...",
      "reason": ["step 1 reasoning", "step 2 reasoning"],
      "confidence": 0.85
    }
  ],
  "explain": "1-2 sentence summary of decision"
}`;
}

// ── LLM API Call (Gemini-compatible) ───────────────────────────────

interface LLMMessage {
    role: "user" | "model" | "function";
    parts: Array<{
        text?: string;
        functionCall?: { name: string; args: Record<string, unknown> };
        functionResponse?: { name: string; response: unknown };
    }>;
}

async function callLLM(
    config: LLMTraderConfig,
    messages: LLMMessage[],
    tools: unknown[]
): Promise<{
    text?: string;
    functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
        // Gemini API format
        const url = `${config.baseUrl}/models/${config.model}:generateContent?key=${config.apiKey}`;
        const body = {
            contents: messages,
            tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
            generationConfig: {
                maxOutputTokens: config.maxTokens,
                temperature: 0.2,
            },
        };

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`LLM API error ${response.status}: ${errText.slice(0, 200)}`);
        }

        const data = await response.json() as {
            candidates?: Array<{
                content?: {
                    parts?: Array<{
                        text?: string;
                        functionCall?: { name: string; args: Record<string, unknown> };
                    }>;
                };
            }>;
        };
        const parts = data.candidates?.[0]?.content?.parts ?? [];

        const functionCalls = parts
            .filter((p) => p.functionCall)
            .map((p) => p.functionCall!);

        const textParts = parts
            .filter((p) => p.text)
            .map((p) => p.text!)
            .join("");

        return {
            text: textParts || undefined,
            functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
        };
    } finally {
        clearTimeout(timeout);
    }
}

// ── Core Resolve Function ──────────────────────────────────────────

/**
 * Run the LLM trader strategy: observe → tool loop → structured output → encode
 */
export async function resolveLlmTrader(
    strategy: StrategyConfigRecord,
    obs: Observation,
    marketSignals: Map<string, MarketSignalRecord>,
    llmConfig: LLMTraderConfig,
    chainId: number
): Promise<LLMTraderResult> {
    // Parse strategy params with defaults
    const params: LLMTraderParams = {
        ...DEFAULT_PARAMS,
        ...(strategy.strategyParams as Partial<LLMTraderParams>),
    };

    // Check cooldown
    if (strategy.lastRunAt) {
        const elapsed = Date.now() - new Date(strategy.lastRunAt).getTime();
        if (elapsed < params.cooldownMs) {
            const remainingMin = Math.ceil((params.cooldownMs - elapsed) / 60_000);
            return {
                reason: `llm_trader: cooldown active (${remainingMin}min remaining)`,
            };
        }
    }

    // Check LLM API key
    if (!llmConfig.apiKey) {
        return { reason: "llm_trader: LLM_API_KEY not configured" };
    }

    // Build tool context
    const toolCtx: LLMToolContext = {
        tokenId: obs.tokenId,
        agentAccount: obs.agentAccount,
        instanceConfig: obs.instanceConfig,
        marketSignals,
        chainId,
    };
    const toolExecutors = buildToolExecutors(toolCtx, params.toolAllowList);
    const toolDefs = getToolDefinitionsForLLM(params.toolAllowList);

    // Initialize conversation
    const systemPrompt = params.systemPromptOverride ?? buildSystemPrompt(obs);
    const messages: LLMMessage[] = [
        {
            role: "user",
            parts: [{ text: systemPrompt }],
        },
    ];

    // Tool loop with step limit
    let step = 0;
    while (step < params.maxSteps) {
        step++;

        const response = await callLLM(llmConfig, messages, toolDefs);

        // If LLM returns function calls, execute them and feed results back
        if (response.functionCalls && response.functionCalls.length > 0) {
            // Add model's function call to messages
            messages.push({
                role: "model",
                parts: response.functionCalls.map((fc) => ({
                    functionCall: { name: fc.name, args: fc.args },
                })),
            });

            // Execute each tool and collect responses
            const functionResponses: LLMMessage["parts"] = [];
            for (const fc of response.functionCalls) {
                const executor = toolExecutors.get(fc.name);
                let result: unknown;
                if (!executor) {
                    result = { success: false, error: `unknown tool: ${fc.name}` };
                } else {
                    try {
                        result = await executor(fc.args);
                    } catch (err) {
                        result = {
                            success: false,
                            error: err instanceof Error ? err.message : String(err),
                        };
                    }
                }
                functionResponses.push({
                    functionResponse: { name: fc.name, response: result },
                });
            }

            messages.push({ role: "function", parts: functionResponses });
            continue;
        }

        // No function calls = final text response
        if (response.text) {
            return parseAndEncodeResponse(response.text, obs, params);
        }

        // No text, no function calls = done
        break;
    }

    return { reason: `llm_trader: exhausted ${params.maxSteps} steps without decision` };
}

// ── Response Parsing ───────────────────────────────────────────────

function parseAndEncodeResponse(
    text: string,
    obs: Observation,
    params: LLMTraderParams
): LLMTraderResult {
    // Extract JSON from markdown code blocks if needed
    let jsonStr = text;
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1];
    }

    let parsed: { intents?: unknown[]; explain?: string };
    try {
        parsed = JSON.parse(jsonStr) as { intents?: unknown[]; explain?: string };
    } catch {
        return { reason: `llm_trader: failed to parse LLM response as JSON` };
    }

    const explain = parsed.explain ? String(parsed.explain) : undefined;

    if (!Array.isArray(parsed.intents) || parsed.intents.length === 0) {
        return {
            reason: "llm_trader: LLM decided no action needed",
            explain,
        };
    }

    // Validate and filter intents
    const validIntents: ActionIntent[] = [];
    for (const raw of parsed.intents.slice(0, params.maxIntents)) {
        const validationError = validateActionIntent(raw);
        if (validationError) {
            continue; // skip invalid intents
        }
        const intent = raw as ActionIntent;

        // Check confidence threshold
        if ((intent.confidence ?? 0) < params.minConfidence) {
            continue;
        }

        validIntents.push(intent);
    }

    if (validIntents.length === 0) {
        return {
            reason: "llm_trader: all intents filtered (validation or confidence)",
            explain,
            intents: [],
        };
    }

    // Encode the first valid intent (approve-first ordering handled by caller)
    // Sort: approve first, then swap
    validIntents.sort((a, b) => {
        if (a.type === "approve" && b.type !== "approve") return -1;
        if (a.type !== "approve" && b.type === "approve") return 1;
        return 0;
    });

    const primaryIntent = validIntents[0];
    try {
        const action = encodeActionIntent(primaryIntent, obs.agentAccount);
        return {
            action,
            reason: `llm_trader: executing ${primaryIntent.type} (confidence=${primaryIntent.confidence?.toFixed(2)})`,
            intents: validIntents,
            explain,
        };
    } catch (err) {
        return {
            reason: `llm_trader: encode failed: ${err instanceof Error ? err.message : String(err)}`,
            explain,
            intents: validIntents,
        };
    }
}
