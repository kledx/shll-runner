/**
 * LLM Brain — AI-powered decision making with Tool Calling.
 *
 * V3.1: Multi-step reasoning with tool calling:
 *   1. Builds system prompt with user trading goal
 *   2. Sends observation + tool definitions to LLM
 *   3. If LLM returns tool_calls → executes tools → feeds results back
 *   4. Loops until LLM returns final decision or max steps reached
 *   5. Parses final response into a Decision
 *
 * Supports both:
 *   - Tool calling mode (LLM returns tool_calls)
 *   - Fallback text mode (LLM returns JSON in content)
 */

import type { IBrain, Decision } from "../interface.js";
import type { Observation } from "../../perception/interface.js";
import type { MemoryEntry } from "../../memory/interface.js";
import type { IAction, ToolResult } from "../../actions/interface.js";
import type { LLMConfig } from "../../agent/agent.js";
import type { LLMProvider, ChatMessage, ToolDefinition, ToolCall } from "./provider.js";
import { buildUserPrompt } from "./prompt.js";

// ═══════════════════════════════════════════════════════
//                     LLM Brain
// ═══════════════════════════════════════════════════════

export class LLMBrain implements IBrain {
    constructor(
        private config: LLMConfig,
        private provider: LLMProvider,
    ) { }

    async think(
        obs: Observation,
        memories: MemoryEntry[],
        actions: IAction[],
    ): Promise<Decision> {
        // Build tool definitions from actions
        const tools = actionsToTools(actions);

        // Build initial messages
        const systemPrompt = this.buildSystemPrompt(actions);
        const userPrompt = buildUserPrompt(obs, memories);

        const messages: ChatMessage[] = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ];

        // Multi-step tool calling loop
        const maxSteps = this.config.maxStepsPerRun || 3;

        for (let step = 0; step < maxSteps; step++) {
            try {
                const response = await this.provider.chatWithTools(messages, tools);

                // Case 1: LLM returns tool calls → execute and loop
                if (response.toolCalls.length > 0) {
                    // Add assistant message with tool calls
                    messages.push({
                        role: "assistant",
                        content: null,
                        tool_calls: response.toolCalls,
                    });

                    // Execute each tool call and add results
                    for (const tc of response.toolCalls) {
                        const result = await this.executeTool(tc, actions, obs);
                        messages.push({
                            role: "tool",
                            content: JSON.stringify(result),
                            tool_call_id: tc.id,
                        });
                    }

                    // Continue loop — LLM will see tool results
                    continue;
                }

                // Case 2: LLM returns content (final decision)
                if (response.content) {
                    return parseDecision(response.content);
                }

                // Case 3: Empty response — default to wait
                return {
                    action: "wait",
                    params: {},
                    reasoning: "LLM returned empty response",
                    confidence: 0,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : "Unknown LLM error";
                return {
                    action: "wait",
                    params: {},
                    reasoning: `LLM error at step ${step + 1}: ${message}`,
                    confidence: 0,
                };
            }
        }

        // Max steps reached — force a final completion without tools
        try {
            messages.push({
                role: "user",
                content: "You have reached the maximum number of tool calls. Make your final trading decision NOW based on the data you've gathered. Respond with JSON: { action, params, reasoning, confidence }.",
            });

            const finalResp = await this.provider.chatWithTools(messages); // no tools → forces content response
            if (finalResp.content) {
                return parseDecision(finalResp.content);
            }
        } catch {
            // ignore
        }

        return {
            action: "wait",
            params: {},
            reasoning: `Reached max steps (${maxSteps}) without final decision`,
            confidence: 0,
        };
    }

    /** Build system prompt with rules — tools are provided via API, not in prompt */
    private buildSystemPrompt(actions: IAction[]): string {
        const parts: string[] = [
            this.config.systemPrompt,
            "",
            "## Rules",
            "- You have access to tools you can call to gather information.",
            "- Use get_market_data to check current prices BEFORE trading.",
            "- Use get_portfolio to check your current holdings.",
            "- When ready to act, respond with plain JSON (no tool call):",
            "  { \"action\": \"<action_name>\", \"params\": { ... }, \"reasoning\": \"<why>\", \"confidence\": 0.0-1.0 }",
            "- Valid actions for final decision: " + actions.filter(a => !a.readonly).map(a => a.name).join(", ") + ", or 'wait'",
            "- Set action='wait' if no good opportunity exists right now.",
            "- Never exceed user safety limits.",
            "- Prefer capital preservation over risky trades.",
        ];

        return parts.join("\n");
    }

    /** Execute a single tool call and return the result */
    private async executeTool(
        tc: ToolCall,
        actions: IAction[],
        obs: Observation,
    ): Promise<ToolResult> {
        const action = actions.find(a => a.name === tc.function.name);
        if (!action) {
            return { success: false, data: null, error: `Unknown tool: ${tc.function.name}` };
        }

        if (!action.execute) {
            return { success: false, data: null, error: `Tool ${tc.function.name} does not support execution` };
        }

        try {
            const args = JSON.parse(tc.function.arguments);

            // Inject observation context for portfolio tool
            if (action.name === "get_portfolio") {
                args.__vaultTokens = obs.vault;
                args.__nativeBalance = obs.nativeBalance.toString();
            }

            return await action.execute(args);
        } catch (err) {
            return {
                success: false,
                data: null,
                error: err instanceof Error ? err.message : "Tool execution failed",
            };
        }
    }
}

// ═══════════════════════════════════════════════════════
//             Action → Tool Conversion
// ═══════════════════════════════════════════════════════

/** Convert IAction list to OpenAI tool definitions (read-only actions only) */
function actionsToTools(actions: IAction[]): ToolDefinition[] {
    return actions
        .filter(a => a.readonly && a.execute) // Only read-only tools with execute()
        .map(a => ({
            type: "function" as const,
            function: {
                name: a.name,
                description: a.description,
                parameters: a.parameters,
            },
        }));
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
