/**
 * Intent Classifier — Determines whether a user instruction needs on-chain tools.
 *
 * Classifies user instructions into three categories:
 *   - TRADE: requires portfolio + market data (swap, buy, sell, etc.)
 *   - QUERY: requires partial data (balance check, price check)
 *   - CONVERSATIONAL: no on-chain data needed (greetings, platform questions, etc.)
 *
 * Used by LLMBrain.think() to set Vercel AI SDK `toolChoice`:
 *   - TRADE / QUERY → toolChoice: "auto" (tools available)
 *   - CONVERSATIONAL → toolChoice: "none" (tools physically unavailable)
 */

// ═══════════════════════════════════════════════════════
//                    Intent Types
// ═══════════════════════════════════════════════════════

export type Intent = "TRADE" | "QUERY" | "CONVERSATIONAL";

// ═══════════════════════════════════════════════════════
//                  Keyword Sets
// ═══════════════════════════════════════════════════════

/** Keywords that indicate the user wants to execute a trade */
const TRADE_KEYWORDS = [
    // English
    "swap", "buy", "sell", "trade", "convert",
    "approve", "wrap", "unwrap", "transfer",
    "exchange", "send", "spend", "invest",
    "long", "short", "dca",
    // Chinese
    "买", "卖", "交换", "兑换", "转换",
    "交易", "发送", "投资", "购买",
];

/** Keywords that indicate the user wants to query on-chain data */
const QUERY_KEYWORDS = [
    // English
    "price", "balance", "portfolio", "how much",
    "check", "show", "worth", "value",
    "holdings", "position", "status",
    "gas", "fee",
    // Chinese
    "价格", "余额", "持仓", "查看",
    "多少", "资产", "仓位", "市值",
    "行情", "市场", "走势", "涨跌",
];

// ═══════════════════════════════════════════════════════
//                  Classifier
// ═══════════════════════════════════════════════════════

/**
 * Classify a user instruction into an intent category.
 *
 * Priority: TRADE > QUERY > CONVERSATIONAL
 * An empty or undefined input defaults to CONVERSATIONAL.
 */
export function classifyIntent(text: string | undefined): Intent {
    if (!text || !text.trim()) return "CONVERSATIONAL";

    const lower = text.toLowerCase();

    // Check trade keywords first (highest priority)
    if (TRADE_KEYWORDS.some(kw => lower.includes(kw))) {
        return "TRADE";
    }

    // Check query keywords
    if (QUERY_KEYWORDS.some(kw => lower.includes(kw))) {
        return "QUERY";
    }

    // Check for token address patterns (0x...) — likely a trade or query
    if (/0x[a-f0-9]{40}/i.test(lower)) {
        return "QUERY";
    }

    // Check for numeric amounts with common units — likely a trade
    if (/\d+(\.\d+)?\s*(bnb|usdt|busd|wbnb|eth|btc)/i.test(lower)) {
        return "TRADE";
    }

    return "CONVERSATIONAL";
}
