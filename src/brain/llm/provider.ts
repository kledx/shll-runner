/**
 * LLM Provider — Unified HTTP caller for LLM APIs.
 *
 * Works with any OpenAI-compatible API:
 *   - OpenAI
 *   - DeepSeek
 *   - Gemini (via OpenAI-compatible endpoint)
 *   - Ollama
 *   - Any custom endpoint
 *
 * Config-driven: change provider via env vars, no code changes needed.
 */

// ═══════════════════════════════════════════════════════
//                 LLM Provider Interface
// ═══════════════════════════════════════════════════════

export interface LLMProvider {
    chat(system: string, user: string): Promise<string>;
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

    async chat(system: string, user: string): Promise<string> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            // Build request body — only include response_format for
            // providers known to support it (OpenAI, DeepSeek).
            // Ollama and Gemini may reject the parameter.
            const body: Record<string, unknown> = {
                model: this.model,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                ],
                max_tokens: this.maxTokens,
            };

            if (JSON_MODE_PROVIDERS.has(this.provider)) {
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
                throw new Error(`LLM API ${res.status}: ${errorText.slice(0, 200)}`);
            }

            const data = await res.json() as {
                choices?: Array<{ message?: { content?: string } }>;
            };

            const content = data.choices?.[0]?.message?.content;
            if (!content) {
                throw new Error("LLM response has no content");
            }

            return content;
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
