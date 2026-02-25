/**
 * Market signals store operations — upsert, batch upsert, listing.
 */

import type { Pool } from "pg";
import type { MarketSignalRecord } from "../types.js";
import { mapMarketSignalRow } from "./helpers.js";

export interface UpsertMarketSignalInput {
    pair: string;
    priceChangeBps: number;
    volume5m: bigint;
    uniqueTraders5m: number;
    sampledAt?: Date;
    source: string;
}

export async function upsertMarketSignal(
    pool: Pool,
    chainId: number,
    input: UpsertMarketSignalInput,
): Promise<MarketSignalRecord> {
    const normalizedPair = input.pair.toLowerCase();
    const sampledAt = input.sampledAt ?? new Date();
    const result = await pool.query(
        `
        INSERT INTO market_signals (
            chain_id, pair, price_change_bps, volume_5m,
            unique_traders_5m, sampled_at, source, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (chain_id, pair)
        DO UPDATE SET
            price_change_bps = EXCLUDED.price_change_bps,
            volume_5m = EXCLUDED.volume_5m,
            unique_traders_5m = EXCLUDED.unique_traders_5m,
            sampled_at = EXCLUDED.sampled_at,
            source = EXCLUDED.source,
            updated_at = NOW()
        RETURNING *
        `,
        [
            chainId,
            normalizedPair,
            input.priceChangeBps,
            input.volume5m.toString(),
            input.uniqueTraders5m,
            sampledAt.toISOString(),
            input.source,
        ],
    );
    return mapMarketSignalRow(result.rows[0] as Record<string, unknown>);
}

export async function upsertMarketSignals(
    pool: Pool,
    chainId: number,
    inputs: UpsertMarketSignalInput[],
): Promise<number> {
    if (inputs.length === 0) return 0;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        let count = 0;
        for (const input of inputs) {
            const normalizedPair = input.pair.toLowerCase();
            const sampledAt = input.sampledAt ?? new Date();
            await client.query(
                `
                INSERT INTO market_signals (
                    chain_id, pair, price_change_bps, volume_5m,
                    unique_traders_5m, sampled_at, source, updated_at
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
                ON CONFLICT (chain_id, pair)
                DO UPDATE SET
                    price_change_bps = EXCLUDED.price_change_bps,
                    volume_5m = EXCLUDED.volume_5m,
                    unique_traders_5m = EXCLUDED.unique_traders_5m,
                    sampled_at = EXCLUDED.sampled_at,
                    source = EXCLUDED.source,
                    updated_at = NOW()
                `,
                [
                    chainId,
                    normalizedPair,
                    input.priceChangeBps,
                    input.volume5m.toString(),
                    input.uniqueTraders5m,
                    sampledAt.toISOString(),
                    input.source,
                ],
            );
            count++;
        }
        await client.query("COMMIT");
        return count;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

export async function listMarketSignals(
    pool: Pool,
    chainId: number,
    pairs?: string[],
    limit = 200,
): Promise<MarketSignalRecord[]> {
    if (pairs && pairs.length > 0) {
        const normalizedPairs = pairs.map((pair) => pair.toLowerCase());
        const result = await pool.query(
            `SELECT * FROM market_signals WHERE chain_id = $1 AND pair = ANY($2::text[]) ORDER BY sampled_at DESC`,
            [chainId, normalizedPairs],
        );
        return result.rows.map((row) => mapMarketSignalRow(row as Record<string, unknown>));
    }

    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const result = await pool.query(
        `SELECT * FROM market_signals WHERE chain_id = $1 ORDER BY sampled_at DESC LIMIT $2`,
        [chainId, boundedLimit],
    );
    return result.rows.map((row) => mapMarketSignalRow(row as Record<string, unknown>));
}
