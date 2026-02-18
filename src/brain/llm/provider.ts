/**
 * LLM Provider — Unified HTTP caller for LLM APIs with Tool Calling support.
 *
 * Works with any OpenAI-compatible API:
 *   - OpenAI, DeepSeek, SiliconFlow, Together, Azure OpenAI
 *   - Ollama, Gemini (via OpenAI-compatible endpoint)
 *
 * V3.1: Added multi-turn tool calling support.
 *   - chatWithTools(): sends tools definitions, handles tool_calls responses
 *   - Backward-compatible chat() still works for simple single-turn
 */

import type { ToolParameters } from "../../actions/interface.js";

// ═══════════════════════════════════════════════════════
//                  Message Types
// ═══════════════════════════════════════════════════════

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    /** For assistant messages with tool calls */
    tool_calls?: ToolCall[];
    /** For tool response messages */
    tool_call_id?: string;
}

export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string; // JSON string
    };
}

export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: ToolParameters;
    };
}

/** Response from chatWithTools — either content or tool calls */
export interface ChatResponse {
    /** If the LLM returned text content (final answer) */
    content: string | null;
    /** If the LLM wants to call tools */
    toolCalls: ToolCall[];
    /** Raw finish reason */
    finishReason: string;
}

// ═══════════════════════════════════════════════════════
//                 LLM Provider Interface
// ═══════════════════════════════════════════════════════

export interface LLMProvider {
    /** Simple single-turn chat (backward compat) */
    chat(system: string, user: string): Promise<string>;

    /** Multi-turn chat with tool calling support */
    chatWithTools(
        messages: ChatMessage[],
        tools?: ToolDefinition[],
    ): Promise<ChatResponse>;
}

// ═══════════════════════════════════════════════════════
//            Generic LLM Provider (OpenAI-compatible)
// ═══════════════════════════════════════════════════════

export interface GenericLLMProviderConfig {
    endpoint: string;
    apiKey: string;
    model: string;
    provider: string;
    maxTokens?: number;
    timeoutMs?: number;
}

/** Providers known to support response_format: { type: "json_object" } */
const JSON_MODE_PROVIDERS = new Set(["openai", "deepseek"]);

export class GenericLLMProvider implements LLMProvider {
    private endpoint: string;
    private apiKey: string;
    private model: string;
    private provider: string;
    private maxTokens: number;
    private timeoutMs: number;

    constructor(config: GenericLLMProviderConfig) {
        this.endpoint = config.endpoint;
        this.apiKey = config.apiKey;
        this.model = config.model;
        this.provider = config.provider;
        this.maxTokens = config.maxTokens ?? 2048;
        this.timeoutMs = config.timeoutMs ?? 30_000;
    }

    /** Simple single-turn chat (backward compat for rule brains) */
    async chat(system: string, user: string): Promise<string> {
        const resp = await this.chatWithTools([
            { role: "system", content: system },
            { role: "user", content: user },
        ]);
        return resp.content ?? "";
    }

    /** Multi-turn chat with tool calling */
    async chatWithTools(
        messages: ChatMessage[],
        tools?: ToolDefinition[],
    ): Promise<ChatResponse> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const body: Record<string, unknown> = {
                model: this.model,
                messages,
                max_tokens: this.maxTokens,
            };

            // Add tools if provided
            if (tools && tools.length > 0) {
                body.tools = tools;
                body.tool_choice = "auto";
            } else if (JSON_MODE_PROVIDERS.has(this.provider)) {
                // Only use JSON mode when no tools are provided
                body.response_format = { type: "json_object" };
            }

            const res = await fetch(this.endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (!res.ok) {
                const errorText = await res.text().catch(() => "Unknown error");
                throw new Error(`LLM API ${res.status}: ${errorText.slice(0, 300)}`);
            }

            const data = await res.json() as {
                choices?: Array<{
                    message?: {
                        role?: string;
                        content?: string | null;
                        tool_calls?: ToolCall[];
                    };
                    finish_reason?: string;
                }>;
            };

            const choice = data.choices?.[0];
            if (!choice?.message) {
                throw new Error("LLM response has no message");
            }

            return {
                content: choice.message.content ?? null,
                toolCalls: choice.message.tool_calls ?? [],
                finishReason: choice.finish_reason ?? "stop",
            };
        } finally {
            clearTimeout(timeout);
        }
    }
}

// ═══════════════════════════════════════════════════════
//               Provider Factory
// ═══════════════════════════════════════════════════════

/** Known provider endpoint templates */
const PROVIDER_ENDPOINTS: Record<string, string> = {
    openai: "https://api.openai.com/v1/chat/completions",
    deepseek: "https://api.deepseek.com/v1/chat/completions",
    ollama: "http://localhost:11434/v1/chat/completions",
};

/**
 * Create an LLMProvider from a provider name + config.
 *
 * @param provider   Provider identifier: "openai", "deepseek", "ollama", or custom URL
 * @param apiKey     API key (empty for local providers)
 * @param model      Model name (e.g. "gpt-4o-mini", "deepseek-chat")
 * @param options    Optional: maxTokens, timeoutMs
 */
export function createLLMProvider(
    provider: string,
    apiKey: string,
    model: string,
    options?: { maxTokens?: number; timeoutMs?: number; endpoint?: string },
): LLMProvider {
    const endpoint = options?.endpoint
        ?? PROVIDER_ENDPOINTS[provider]
        ?? provider; // Treat unknown provider as a raw endpoint URL

    return new GenericLLMProvider({
        endpoint,
        apiKey,
        model,
        provider,
        maxTokens: options?.maxTokens,
        timeoutMs: options?.timeoutMs,
    });
}
