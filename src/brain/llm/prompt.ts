/**
 * LLM Prompt Builder — Constructs system and user prompts.
 *
 * System prompt:
 *   - Custom system prompt from blueprint config
 *   - Available actions listed as tools
 *   - Output format rules (JSON)
 *
 * User prompt:
 *   - Current vault state
 *   - Prices and gas
 *   - Recent memory history
 */

import type { Observation } from "../../perception/interface.js";
import type { MemoryEntry } from "../../memory/interface.js";
import type { IAction } from "../../actions/interface.js";

// ═══════════════════════════════════════════════════════
//                 System Prompt
// ═══════════════════════════════════════════════════════

export function buildSystemPrompt(
    customPrompt: string,
    actions: IAction[],
): string {
    const parts: string[] = [
        customPrompt,
        "",
        "## Available Actions",
        ...actions.map(a =>
            `- **${a.name}**: ${a.description}${a.readonly ? " (read-only)" : ""}`
        ),
        "",
        "## Rules",
        "- Respond ONLY in JSON: { action, params, reasoning, confidence }",
        "- 'action' must be one of the available action names, or 'wait'",
        "- 'params' must contain the required parameters for the chosen action",
        "- 'reasoning' must explain WHY this decision was made",
        "- 'confidence' is a float 0-1 indicating how confident you are",
        "- Set action='wait' if no good opportunity exists right now",
        "- Never exceed user safety limits",
        "- Prefer capital preservation over risky trades",
    ];

    return parts.join("\n");
}

// ═══════════════════════════════════════════════════════
//                  User Prompt
// ═══════════════════════════════════════════════════════

export function buildUserPrompt(
    obs: Observation,
    memories: MemoryEntry[],
): string {
    // Vault state
    const vaultLines = obs.vault.length > 0
        ? obs.vault.map(t => `  ${t.symbol}: ${t.balance} (${t.decimals} decimals)`)
        : ["  No tracked tokens"];

    // Price data
    const priceEntries = Array.from(obs.prices.entries());
    const priceLines = priceEntries.length > 0
        ? priceEntries.map(([addr, price]) => `  ${addr}: $${price.toFixed(4)}`)
        : ["  No price data"];

    // Recent history
    const historyLines = memories.slice(0, 10).map(m => {
        const ts = m.timestamp.toISOString().slice(0, 19);
        const action = m.action ?? "N/A";
        const status = m.result?.success === true ? "✓" :
            m.result?.success === false ? "✗" : "·";
        return `  [${ts}] ${status} ${m.type}: ${action} — ${m.reasoning ?? ""}`;
    });

    const parts: string[] = [
        "## Current State",
        `Native Balance: ${obs.nativeBalance.toString()} wei`,
        "",
        "Vault Tokens:",
        ...vaultLines,
        "",
        "Prices:",
        ...priceLines,
        "",
        `Gas: ${obs.gasPrice} wei`,
        `Block: ${obs.blockNumber}`,
        `Paused: ${obs.paused}`,
        "",
        "## Recent History",
        ...(historyLines.length > 0 ? historyLines : ["  No previous activity"]),
        "",
        "What should the agent do now?",
    ];

    return parts.join("\n");
}
