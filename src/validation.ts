import { z } from "zod";
import type {
    DisableRequestPayload,
    EnableRequestPayload,
    MarketSignalBatchUpsertPayload,
    MarketSignalSyncRequestPayload,
    MarketSignalUpsertPayload,
    NormalizedPermit,
    OperatorPermitPayload,
    StrategyQueryPayload,
    StrategyUpsertPayload,
} from "./types.js";

const bigintLike = z.union([z.string(), z.number(), z.bigint()]);

const permitSchema = z.object({
    tokenId: bigintLike,
    renter: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    operator: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    expires: bigintLike,
    nonce: bigintLike,
    deadline: bigintLike,
});

const enableRequestSchema = z.object({
    permit: permitSchema,
    sig: z.string().regex(/^0x[0-9a-fA-F]+$/),
    chainId: z.number().int().positive().optional(),
    nfaAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    waitForReceipt: z.boolean().optional(),
});

const disableRequestSchema = z.object({
    tokenId: bigintLike.optional(),
    mode: z.enum(["local", "onchain"]).optional(),
    waitForReceipt: z.boolean().optional(),
    reason: z.string().min(1).max(200).optional(),
});

const statusQuerySchema = z.object({
    tokenId: z.string().regex(/^\d+$/).optional(),
    runsLimit: z.string().optional(),
});

const strategyUpsertSchema = z.object({
    tokenId: bigintLike,
    strategyType: z
        .enum(["llm_trader", "llm_defi"])
        .optional(),
    target: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    data: z.string().regex(/^0x[0-9a-fA-F]*$/).optional(),
    value: bigintLike.optional(),
    strategyParams: z.record(z.string(), z.unknown()).optional(),
    minIntervalMs: z.number().int().positive().max(86_400_000).optional(),
    requirePositiveBalance: z.boolean().optional(),
    maxFailures: z.number().int().positive().max(1000).optional(),
    enabled: z.boolean().optional(),
});

const strategyQuerySchema = z.object({
    tokenId: z.string().regex(/^\d+$/).optional(),
});


const marketSignalUpsertSchema = z.object({
    pair: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    priceChangeBps: z.number().int().min(-1_000_000).max(1_000_000),
    volume5m: bigintLike.optional(),
    uniqueTraders5m: z.number().int().min(0).max(1_000_000).optional(),
    sampledAt: z.string().datetime().optional(),
    source: z.string().min(1).max(64).optional(),
});

const marketSignalBatchUpsertSchema = z.object({
    items: z.array(marketSignalUpsertSchema).min(1).max(500),
    source: z.string().min(1).max(64).optional(),
});

const marketSignalSyncRequestSchema = z.object({
    dryRun: z.boolean().optional(),
});

export function parseEnablePayload(body: unknown): EnableRequestPayload {
    return enableRequestSchema.parse(body);
}

export function parseDisablePayload(body: unknown): DisableRequestPayload {
    return disableRequestSchema.parse(body);
}

export function parseStrategyUpsertPayload(body: unknown): StrategyUpsertPayload {
    return strategyUpsertSchema.parse(body);
}


export function parseMarketSignalUpsertPayload(body: unknown): MarketSignalUpsertPayload {
    return marketSignalUpsertSchema.parse(body);
}

export function parseMarketSignalBatchUpsertPayload(
    body: unknown
): MarketSignalBatchUpsertPayload {
    return marketSignalBatchUpsertSchema.parse(body);
}

export function parseMarketSignalSyncRequestPayload(
    body: unknown
): MarketSignalSyncRequestPayload {
    return marketSignalSyncRequestSchema.parse(body);
}

export function parseStatusQuery(raw: Record<string, string | undefined>): {
    tokenId?: bigint;
    runsLimit?: number;
} {
    const parsed = statusQuerySchema.parse(raw);
    const runsLimit =
        parsed.runsLimit != null ? Number.parseInt(parsed.runsLimit, 10) : undefined;
    if (runsLimit != null) {
        if (!Number.isInteger(runsLimit) || runsLimit <= 0 || runsLimit > 200) {
            throw new Error("runsLimit must be an integer between 1 and 200");
        }
    }
    return {
        tokenId: parsed.tokenId != null ? BigInt(parsed.tokenId) : undefined,
        runsLimit,
    };
}

export function parseStrategyQuery(
    raw: Record<string, string | undefined>
): StrategyQueryPayload {
    return strategyQuerySchema.parse(raw);
}

export function normalizePermit(raw: OperatorPermitPayload): NormalizedPermit {
    return {
        tokenId: BigInt(raw.tokenId),
        renter: raw.renter as `0x${string}`,
        operator: raw.operator as `0x${string}`,
        expires: BigInt(raw.expires),
        nonce: BigInt(raw.nonce),
        deadline: BigInt(raw.deadline),
    };
}
