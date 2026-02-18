/**
 * LLM Brain — AI-powered decision making for agents.
 *
 * Implements IBrain using LLM reasoning:
 *   1. Builds system prompt with available actions
 *   2. Constructs user prompt with observation + memories
 *   3. Calls LLM provider for structured JSON response
 *   4. Parses response into a Decision
 *
 * Migrated from strategies/llmTrader.ts, adapted to IBrain interface.
 */

import type { IBrain, Decision } from "../interface.js";
import type { Observation } from "../../perception/interface.js";
import type { MemoryEntry } from "../../memory/interface.js";
import type { IAction } from "../../actions/interface.js";
import type { LLMConfig } from "../../agent/agent.js";
import type { LLMProvider } from "./provider.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";

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
        // Build prompts
        const systemPrompt = buildSystemPrompt(this.config.systemPrompt, actions);
        const userPrompt = buildUserPrompt(obs, memories);

        try {
            // Call LLM
            const response = await this.provider.chat(systemPrompt, userPrompt);

            // Parse structured JSON response
            const parsed = parseDecision(response);
            return parsed;
        } catch (error) {
            // On LLM failure, default to wait
            const message = error instanceof Error ? error.message : "Unknown LLM error";
            return {
                action: "wait",
                params: {},
                reasoning: `LLM error: ${message}`,
                confidence: 0,
            };
        }
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
            reasoning: `Failed to parse LLM response: ${response.slice(0, 100)}`,
            confidence: 0,
        };
    }
}
