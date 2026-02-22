import type { MemoryEntry } from "../../memory/interface.js";

export type CadenceState = "active" | "done";

export type RecurringMessageIntent = {
    intervalMs: number;
    durationMs: number;
    message: string;
    doneMessage: string;
    signature: string;
};

export type TimedMonitoringIntent = {
    intervalMs: number;
    durationMs: number;
    activeMessage: string;
    doneMessage: string;
    signature: string;
};

export type CadenceProgress = {
    startedAtMs: number;
    elapsedMs: number;
    completed: boolean;
};

type CadenceEntry = {
    atMs: number;
    state: CadenceState;
    startedAtMs?: number;
};

type CadenceProgressInput = {
    marker: string;
    intervalMs: number;
    durationMs: number;
    memories: MemoryEntry[];
    nowMs?: number;
};

const ZH_NUM_TOKEN = "[0-9\\u96f6\\u4e00\\u4e8c\\u4e24\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+";
const DEFAULT_RECURRING_DURATION_MS = 60_000;

export function attachCadenceParams(
    base: Record<string, unknown> | undefined,
    marker: string,
    state: CadenceState,
    startedAtMs?: number,
): Record<string, unknown> {
    const existingStartedAtMs = typeof base?.__cadenceStartedAtMs === "number" && Number.isFinite(base.__cadenceStartedAtMs)
        ? base.__cadenceStartedAtMs
        : undefined;
    return {
        ...(base ?? {}),
        __cadenceMarker: marker,
        __cadenceState: state,
        __cadenceStartedAtMs: startedAtMs ?? existingStartedAtMs,
    };
}

export function buildCadenceProgress(input: CadenceProgressInput): CadenceProgress {
    const nowMs = input.nowMs ?? Date.now();
    const entries: CadenceEntry[] = [];
    for (const m of input.memories) {
        const marker = typeof m.params?.__cadenceMarker === "string" ? m.params.__cadenceMarker : "";
        if (marker !== input.marker) continue;
        const state: CadenceState = m.params?.__cadenceState === "done" ? "done" : "active";
        const startedAtMs = typeof m.params?.__cadenceStartedAtMs === "number" && Number.isFinite(m.params.__cadenceStartedAtMs)
            ? m.params.__cadenceStartedAtMs
            : undefined;
        entries.push({
            atMs: m.timestamp.getTime(),
            state,
            startedAtMs,
        });
    }
    entries.sort((a, b) => a.atMs - b.atMs);

    let lastDoneAt = -1;
    for (const entry of entries) {
        if (entry.state === "done") lastDoneAt = entry.atMs;
    }

    const activeEntries = entries.filter((entry) => entry.atMs > lastDoneAt);
    let startedAtMs = nowMs;
    if (activeEntries.length > 0) {
        const explicitStartedAtValues = activeEntries
            .map((entry) => entry.startedAtMs)
            .filter((v): v is number => typeof v === "number" && v > 0 && v <= nowMs);
        if (explicitStartedAtValues.length > 0) {
            startedAtMs = Math.min(...explicitStartedAtValues);
        } else {
            const firstAt = activeEntries[0].atMs;
            const lastAt = activeEntries[activeEntries.length - 1].atMs;
            const staleGapMs = Math.max(input.durationMs, input.intervalMs * 3);
            startedAtMs = nowMs - lastAt > staleGapMs ? nowMs : firstAt;
        }
    }

    const elapsedMs = Math.max(0, nowMs - startedAtMs);
    return {
        startedAtMs,
        elapsedMs,
        completed: elapsedMs >= input.durationMs,
    };
}

export function parseRecurringMessageIntent(goal: string): RecurringMessageIntent | null {
    const raw = goal.trim();
    if (!raw) return null;

    const intervalMs = parseIntervalMs(raw);
    const parsedDurationMs = parseDurationMs(raw);
    const message = parseRepeatedMessage(raw);
    if (!intervalMs || !message) return null;

    const durationMs = parsedDurationMs ?? DEFAULT_RECURRING_DURATION_MS;
    if (durationMs < intervalMs) return null;

    const safeIntervalMs = Math.max(5_000, intervalMs);
    const durationSeconds = Math.round(durationMs / 1000);
    const intervalSeconds = Math.round(safeIntervalMs / 1000);
    const signature = `msg:${safeIntervalMs}:${durationMs}:${message.toLowerCase()}`;
    return {
        intervalMs: safeIntervalMs,
        durationMs,
        message,
        doneMessage: `已完成：按要求每${intervalSeconds}秒发送“${message}”，持续${durationSeconds}秒。`,
        signature,
    };
}

export function parseTimedMonitoringIntent(goal: string): TimedMonitoringIntent | null {
    const raw = goal.trim();
    if (!raw) return null;

    const intervalMs = parseIntervalMs(raw);
    const durationMs = parseDurationMs(raw);
    if (!intervalMs || !durationMs) return null;
    if (durationMs < intervalMs) return null;
    if (!looksLikeMonitoringGoal(raw)) return null;

    const safeIntervalMs = Math.max(5_000, intervalMs);
    const signatureSeed = normalizeGoalForSignature(raw);
    const signature = `monitor:${safeIntervalMs}:${durationMs}:${simpleHash(signatureSeed)}`;
    return {
        intervalMs: safeIntervalMs,
        durationMs,
        activeMessage: "定时监控进行中，我会按你设定的频率继续检查。",
        doneMessage: "监控窗口已结束，当前自动监控任务已停止。",
        signature,
    };
}

function parseIntervalMs(text: string): number | null {
    const zhPatterns: Array<[RegExp, number]> = [
        [new RegExp(`\\u6bcf(?:\\u9694)?\\s*(${ZH_NUM_TOKEN})\\s*(?:\\u79d2|\\u79d2\\u949f)`, "u"), 1000],
        [new RegExp(`\\u6bcf(?:\\u9694)?\\s*(${ZH_NUM_TOKEN})\\s*(?:\\u5206(?:\\u949f)?)`, "u"), 60_000],
    ];
    for (const [pattern, unitMs] of zhPatterns) {
        const matched = text.match(pattern);
        const value = matched ? parseNumericToken(matched[1]) : null;
        if (value && value > 0) return value * unitMs;
    }

    const enPatterns: Array<[RegExp, number]> = [
        [/every\s+([0-9]+)\s*(?:seconds?|secs?|s)\b/i, 1000],
        [/every\s+([0-9]+)\s*(?:minutes?|mins?|m)\b/i, 60_000],
    ];
    for (const [pattern, unitMs] of enPatterns) {
        const matched = text.match(pattern);
        const value = matched ? Number.parseInt(matched[1], 10) : NaN;
        if (Number.isFinite(value) && value > 0) return value * unitMs;
    }

    return null;
}

function parseDurationMs(text: string): number | null {
    const zhPatterns: Array<[RegExp, number]> = [
        [new RegExp(`\\u63a5\\u4e0b\\u6765\\s*(${ZH_NUM_TOKEN})\\s*(?:\\u5206(?:\\u949f)?)`, "u"), 60_000],
        [new RegExp(`\\u63a5\\u4e0b\\u6765\\s*(${ZH_NUM_TOKEN})\\s*(?:\\u79d2(?:\\u949f)?)`, "u"), 1000],
        [new RegExp(`(?:\\u6301\\u7eed|\\u5728|\\u672a\\u6765)\\s*(${ZH_NUM_TOKEN})\\s*(?:\\u5206(?:\\u949f)?)(?:\\u5185)?`, "u"), 60_000],
        [new RegExp(`(?:\\u6301\\u7eed|\\u5728|\\u672a\\u6765)\\s*(${ZH_NUM_TOKEN})\\s*(?:\\u79d2(?:\\u949f)?)(?:\\u5185)?`, "u"), 1000],
    ];
    for (const [pattern, unitMs] of zhPatterns) {
        const matched = text.match(pattern);
        const value = matched ? parseNumericToken(matched[1]) : null;
        if (value && value > 0) return value * unitMs;
    }

    const enPatterns: Array<[RegExp, number]> = [
        [/for\s+(?:the\s+next\s+)?([0-9]+)\s*minutes?\b/i, 60_000],
        [/for\s+(?:the\s+next\s+)?([0-9]+)\s*seconds?\b/i, 1000],
        [/next\s+([0-9]+)\s*minutes?\b/i, 60_000],
        [/next\s+([0-9]+)\s*seconds?\b/i, 1000],
    ];
    for (const [pattern, unitMs] of enPatterns) {
        const matched = text.match(pattern);
        const value = matched ? Number.parseInt(matched[1], 10) : NaN;
        if (Number.isFinite(value) && value > 0) return value * unitMs;
    }

    return null;
}

function parseRepeatedMessage(text: string): string | null {
    const quoted = text.match(/["'\u201c\u2018\u300c\u300e]([^"'\u201d\u2019\u300d\u300f]{1,120})["'\u201d\u2019\u300d\u300f]/u);
    if (quoted) return quoted[1].trim();

    const zh = text.match(/(?:\u53d1\u9001|\u53d1|\u8bf4|\u56de\u590d)(?:\u4e00\u6761|\u4e00\u53e5|\u4e00\u6b21)?\s*([^\s\uff0c\u3002,!.!\uff1f?]{1,80})/u);
    if (zh) return zh[1].trim();

    const en = text.match(/send\s+(?:a\s+message\s+)?([a-z0-9 _-]{1,80})/i);
    if (en) return en[1].trim();

    return null;
}

function looksLikeMonitoringGoal(text: string): boolean {
    const zhMonitor = /(?:\u626b\u63cf|\u76d1\u63a7|\u76d1\u6d4b|\u89c2\u5bdf|\u67e5\u770b|\u8ffd\u8e2a)/u.test(text);
    const zhCondition = /(?:\u4ef7\u683c|\u884c\u60c5|\u4f4e\u4e8e|\u9ad8\u4e8e|\u4e70\u5165|\u5356\u51fa|\u4e70)/u.test(text);
    const enMonitor = /\b(?:scan|monitor|watch|check)\b/i.test(text);
    const enCondition = /\b(?:price|market|token|below|above|buy|sell|if|when)\b/i.test(text);
    return (zhMonitor && zhCondition) || (enMonitor && enCondition);
}

function parseNumericToken(token: string): number | null {
    const trimmed = token.trim();
    if (!trimmed) return null;
    if (/^[0-9]+$/.test(trimmed)) {
        const n = Number.parseInt(trimmed, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    return parseChineseNumber(trimmed);
}

function parseChineseNumber(token: string): number | null {
    const map: Record<string, number> = {
        "\u96f6": 0,
        "\u4e00": 1,
        "\u4e8c": 2,
        "\u4e24": 2,
        "\u4e09": 3,
        "\u56db": 4,
        "\u4e94": 5,
        "\u516d": 6,
        "\u4e03": 7,
        "\u516b": 8,
        "\u4e5d": 9,
    };

    if (token === "\u5341") return 10;
    if (token.includes("\u5341")) {
        const [left, right] = token.split("\u5341");
        const tens = left ? map[left] : 1;
        const ones = right ? map[right] : 0;
        if (!Number.isFinite(tens) || !Number.isFinite(ones)) return null;
        const value = tens * 10 + ones;
        return value > 0 ? value : null;
    }

    const value = map[token];
    return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeGoalForSignature(goal: string): string {
    return goal
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
}

function simpleHash(value: string): string {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
}
