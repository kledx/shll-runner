/**
 * Lifecycle routes — /enable, /disable
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Hex } from "viem";
import type { ApiServerContext } from "../server.js";
import { parseBody, writeJson } from "../../http.js";
import { parseEnablePayload, parseDisablePayload, normalizePermit } from "../../validation.js";

export async function handleLifecycleRoutes(
    method: string,
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
    ctx: ApiServerContext,
): Promise<boolean> {
    const { store, chain, config, agentManager, log } = ctx;

    // ── Enable ─────────────────────────────────────
    if (method === "POST" && pathname === "/enable") {
        const body = await parseBody(req);
        const payload = parseEnablePayload(body);
        const permit = normalizePermit(payload.permit);

        if (
            payload.chainId != null &&
            payload.chainId !== config.chainId
        ) {
            writeJson(res, 400, {
                error: `chainId mismatch: expected ${config.chainId}`,
            });
            return true;
        }

        if (
            payload.nfaAddress != null &&
            payload.nfaAddress.toLowerCase() !==
            config.agentNfaAddress.toLowerCase()
        ) {
            writeJson(res, 400, {
                error: `nfaAddress mismatch: expected ${config.agentNfaAddress}`,
            });
            return true;
        }

        if (
            permit.operator.toLowerCase() !==
            chain.account.address.toLowerCase()
        ) {
            writeJson(res, 400, {
                error: "permit.operator must equal runner operator address",
                expectedOperator: chain.account.address,
            });
            return true;
        }

        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        if (permit.deadline < nowSec) {
            writeJson(res, 400, {
                error: "permit.deadline has expired",
            });
            return true;
        }

        const result = await chain.enableOperatorWithPermit(
            permit,
            payload.sig as Hex,
            payload.waitForReceipt ?? true,
        );

        await store.upsertEnabled({
            tokenId: permit.tokenId,
            renter: permit.renter,
            operator: permit.operator,
            permitExpires: permit.expires,
            permitDeadline: permit.deadline,
            sig: payload.sig,
            txHash: result.hash,
        });

        log.info(
            `Permit applied: tokenId=${permit.tokenId.toString()} hash=${result.hash}`,
        );
        writeJson(res, 200, {
            ok: true,
            txHash: result.hash,
            receiptStatus: result.receiptStatus,
            receiptBlock: result.receiptBlock,
        });
        return true;
    }

    // ── Disable ────────────────────────────────────
    if (method === "POST" && pathname === "/disable") {
        const body = await parseBody(req);
        const payload = parseDisablePayload(body);
        const tokenId =
            payload.tokenId != null
                ? BigInt(payload.tokenId)
                : config.tokenId;
        const mode = payload.mode ?? "local";
        const reason = payload.reason ?? "disabled by API";

        let txHash: string | undefined;
        if (mode === "onchain") {
            const result = await chain.clearOperator(
                tokenId,
                payload.waitForReceipt ?? true,
            );
            txHash = result.hash;
        }

        const record = await store.disable(
            tokenId,
            reason,
            txHash,
        );
        // Stop the in-memory agent instance so the scheduler won't re-run it
        agentManager.stopAgent(tokenId);
        await store.releaseAutopilotLock(tokenId);
        log.info(`[API] Disabled token ${tokenId.toString()} — reason: ${reason}`);
        writeJson(res, 200, {
            ok: true,
            tokenId: record.tokenId,
            mode,
            txHash,
        });
        return true;
    }

    return false;
}
