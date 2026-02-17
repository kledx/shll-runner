/**
 * DCA (Dollar-Cost Averaging) strategy handler.
 *
 * Periodically buys a target token using a specified spend token with a
 * fixed investment amount per execution. Relies on the existing interval
 * mechanism in index.ts (reason() function) for timing control.
 *
 * Strategy params (stored in strategy.strategyParams):
 *   tokenToBuy   — ERC20 address to accumulate
 *   tokenToSpend — ERC20 address to spend (e.g. WBNB)
 *   amountPerExecution — wei string, amount to spend each time
 *   slippageBps  — max slippage in bps (default: 100 = 1%)
 *   routerAddress — DEX router address (PancakeSwap V2)
 *   vaultAddress  — optional override; defaults to obs.agentAccount
 *
 * The handler generates a swap ActionPayload via intentEncoder.
 * Approve handling is NOT included here because PolicyGuard enforces
 * infinite-approve semantics on first interaction — see V2.2 for
 * explicit allowance checks if needed.
 */

import type { Address, Hex } from "viem";
import type {
    Observation,
    StrategyConfigRecord,
} from "../types.js";
import type { StrategyResolution, StrategyRuntimeContext } from "../strategyRegistry.js";
import {
    encodeSwapIntent,
    encodeApproveIntent,
    type ActionIntent,
} from "../intentEncoder.js";

// ── DCA param validation ───────────────────────────────────────────

export interface DCAStrategyParams {
    tokenToBuy: string;          // ERC20 address
    tokenToSpend: string;        // ERC20 address (usually WBNB)
    amountPerExecution: string;  // wei string
    slippageBps?: number;        // default 100 (1%)
    routerAddress: string;       // PancakeSwap V2 router
    vaultAddress?: string;       // recipient override (default: obs.agentAccount)
}

const DEFAULT_SLIPPAGE_BPS = 100; // 1%
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function validateDCAParams(
    raw: Record<string, unknown>
): { ok: true; params: DCAStrategyParams } | { ok: false; reason: string } {
    const tokenToBuy = raw.tokenToBuy;
    if (typeof tokenToBuy !== "string" || !ADDRESS_RE.test(tokenToBuy)) {
        return { ok: false, reason: "dca: invalid or missing tokenToBuy address" };
    }

    const tokenToSpend = raw.tokenToSpend;
    if (typeof tokenToSpend !== "string" || !ADDRESS_RE.test(tokenToSpend)) {
        return { ok: false, reason: "dca: invalid or missing tokenToSpend address" };
    }

    if (tokenToBuy.toLowerCase() === tokenToSpend.toLowerCase()) {
        return { ok: false, reason: "dca: tokenToBuy and tokenToSpend must be different" };
    }

    const amountPerExecution = raw.amountPerExecution;
    if (typeof amountPerExecution !== "string" || !amountPerExecution.trim()) {
        return { ok: false, reason: "dca: missing amountPerExecution" };
    }
    try {
        const amount = BigInt(amountPerExecution);
        if (amount <= 0n) {
            return { ok: false, reason: "dca: amountPerExecution must be > 0" };
        }
    } catch {
        return { ok: false, reason: "dca: amountPerExecution is not a valid bigint" };
    }

    const routerAddress = raw.routerAddress;
    if (typeof routerAddress !== "string" || !ADDRESS_RE.test(routerAddress)) {
        return { ok: false, reason: "dca: invalid or missing routerAddress" };
    }

    const slippageBps =
        typeof raw.slippageBps === "number" && Number.isFinite(raw.slippageBps)
            ? Math.max(0, Math.min(10000, Math.floor(raw.slippageBps)))
            : DEFAULT_SLIPPAGE_BPS;

    const vaultAddress = raw.vaultAddress;
    if (vaultAddress != null && (typeof vaultAddress !== "string" || !ADDRESS_RE.test(vaultAddress))) {
        return { ok: false, reason: "dca: invalid vaultAddress" };
    }

    return {
        ok: true,
        params: {
            tokenToBuy,
            tokenToSpend,
            amountPerExecution,
            slippageBps,
            routerAddress,
            vaultAddress: typeof vaultAddress === "string" ? vaultAddress : undefined,
        },
    };
}

// ── DCA resolver ───────────────────────────────────────────────────

export async function resolveDCA(
    strategy: StrategyConfigRecord,
    obs: Observation,
    _context: StrategyRuntimeContext
): Promise<StrategyResolution> {
    const validation = validateDCAParams(strategy.strategyParams);
    if (!validation.ok) {
        return { reason: validation.reason };
    }

    const { params } = validation;
    const amountIn = BigInt(params.amountPerExecution);
    const recipient = (params.vaultAddress ?? obs.agentAccount) as Address;

    if (recipient.toLowerCase() === ZERO_ADDRESS) {
        return { reason: "dca: vault address is zero — cannot proceed" };
    }

    // Build swap intent using the existing intentEncoder
    const swapIntent: ActionIntent = {
        type: "swap",
        router: params.routerAddress,
        tokenIn: params.tokenToSpend,
        tokenOut: params.tokenToBuy,
        amountIn: amountIn.toString(),
        // minOut calculated from slippage — but we don't have a price oracle here,
        // so we set minOut to 0 and rely on PolicyGuardV3's slippageBps enforcement.
        // V2.2 can add on-chain getAmountsOut() call for better slippage protection.
        minOut: "0",
        reason: ["DCA periodic buy"],
        confidence: 1.0,
    };

    const action = encodeSwapIntent(swapIntent, recipient);

    return {
        action,
        reason: `dca: buy ${params.tokenToBuy.slice(0, 10)}... with ${amountIn.toString()} of ${params.tokenToSpend.slice(0, 10)}...`,
        explain: `DCA periodic execution — spending ${params.amountPerExecution} wei of ${params.tokenToSpend} to buy ${params.tokenToBuy}, slippage=${params.slippageBps}bps`,
    };
}
