/**
 * LLM Prompt Builder — Constructs user prompts for the LLM Brain.
 *
 * V3.1: System prompt is now built by LLMBrain directly (includes rules for tool calling).
 * This module only provides the user prompt (current observation state).
 */

import type { Observation } from "../../perception/interface.js";
import type { MemoryEntry } from "../../memory/interface.js";

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
        const status = m.result?.success === true ? "OK" :
            m.result?.success === false ? "FAIL" : "-";
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
        "Analyze the current state. Use tools to gather more data if needed, then make your trading decision.",
    ];

    return parts.join("\n");
}
