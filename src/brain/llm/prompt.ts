/**
 * LLM Prompt Builder — Constructs user prompts for the LLM Brain.
 *
 * V3.1: System prompt is now built by LLMBrain directly (includes rules for tool calling).
 * This module only provides the user prompt (current observation state).
 */

import type { Observation, TokenBalance } from "../../perception/interface.js";
import type { MemoryEntry } from "../../memory/interface.js";

// ═══════════════════════════════════════════════════════
//                  Helpers
// ═══════════════════════════════════════════════════════

/** Convert raw wei balance to human-readable string (e.g. 298700000000000000 with 18 decimals → "0.2987") */
function formatBalance(bal: TokenBalance): string {
    const raw = bal.balance.toString();
    const d = bal.decimals;
    if (d === 0) return raw;

    const padded = raw.padStart(d + 1, "0");
    const intPart = padded.slice(0, padded.length - d) || "0";
    const fracPart = padded.slice(padded.length - d).replace(/0+$/, "");
    // Show up to 6 decimal places
    const truncFrac = fracPart.slice(0, 6);
    return truncFrac ? `${intPart}.${truncFrac}` : intPart;
}

/** Convert raw wei string to human-readable BNB string */
function weiToBnb(wei: bigint): string {
    const raw = wei.toString();
    const padded = raw.padStart(19, "0");
    const intPart = padded.slice(0, padded.length - 18) || "0";
    const fracPart = padded.slice(padded.length - 18).replace(/0+$/, "").slice(0, 6);
    return fracPart ? `${intPart}.${fracPart}` : intPart;
}

// ═══════════════════════════════════════════════════════
//                  User Prompt
// ═══════════════════════════════════════════════════════

export function buildUserPrompt(
    obs: Observation,
    memories: MemoryEntry[],
): string {
    // Vault state — show human-readable balances
    const vaultLines = obs.vault.length > 0
        ? obs.vault.map(t => `  ${t.symbol}: ${formatBalance(t)} (raw: ${t.balance} wei, ${t.decimals} decimals)`)
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
        `Native Balance: ${weiToBnb(obs.nativeBalance)} BNB (${obs.nativeBalance.toString()} wei)`,
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
        "Analyze the user's intent. Only call tools if you need more data to fulfill the request.",
    ];

    return parts.join("\n");
}

