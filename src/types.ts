import type { Address, Hex } from "viem";

export type StrategyType = "llm_trader" | "llm_defi";



export interface AgentState {
    balance: bigint;
    status: number; // 0=Active, 1=Paused, 2=Terminated
    owner: Address;
    logicAddress: Address;
    lastActionTimestamp: bigint;
}


export interface Observation {
    tokenId: bigint;
    agentState: AgentState;
    agentAccount: Address;
    renter: Address;
    renterExpires: bigint;
    operator: Address;
    operatorExpires: bigint;
    blockNumber: bigint;
    blockTimestamp: bigint;
    timestamp: number;
}

export interface ActionPayload {
    target: Address;
    value: bigint;
    data: Hex;
}


export interface OperatorPermitPayload {
    tokenId: string | number | bigint;
    renter: string;
    operator: string;
    expires: string | number | bigint;
    nonce: string | number | bigint;
    deadline: string | number | bigint;
}

export interface EnableRequestPayload {
    permit: OperatorPermitPayload;
    sig: string;
    chainId?: number;
    nfaAddress?: string;
    waitForReceipt?: boolean;
}

export interface DisableRequestPayload {
    tokenId?: string | number | bigint;
    mode?: "local" | "onchain";
    waitForReceipt?: boolean;
    reason?: string;
}

export interface StrategyUpsertPayload {
    tokenId: string | number | bigint;
    strategyType?: StrategyType;
    target?: string;
    data?: string;
    value?: string | number | bigint;
    strategyParams?: Record<string, unknown>;
    minIntervalMs?: number;
    requirePositiveBalance?: boolean;
    maxFailures?: number;
    enabled?: boolean;
}

export interface StrategyQueryPayload {
    tokenId?: string;
}

export interface NormalizedPermit {
    tokenId: bigint;
    renter: Address;
    operator: Address;
    expires: bigint;
    nonce: bigint;
    deadline: bigint;
}

export interface EnableResult {
    hash: Hex;
    receiptStatus?: string;
    receiptBlock?: string;
}

export interface ActionResult {
    hash: Hex;
    receiptStatus: string;
    receiptBlock: string;
}

export interface AutopilotRecord {
    tokenId: string;
    chainId: number;
    renter: string;
    operator: string;
    permitExpires: string;
    permitDeadline: string;
    sig: string;
    enabled: boolean;
    lastReason?: string;
    lastEnableTxHash?: string;
    lastDisableTxHash?: string;
    lockedUntil?: string;
    createdAt: string;
    updatedAt: string;
}

export interface RunRecord {
    id: string;
    tokenId: string;
    actionType: string;
    actionHash: string;
    simulateOk: boolean;
    txHash?: string;
    error?: string;
    /** V1.4: hash of instance params at execution time */
    paramsHash?: string;
    /** V1.4: LLM strategy explanation text */
    strategyExplain?: string;
    /** V1.4: error category from PolicyGuardV2.validate pre-check */
    failureCategory?: string;
    /** P-2026-023: normalized machine-readable error code */
    errorCode?: string;
    /** P-2026-023: stage-by-stage runtime trace for replay/audit */
    executionTrace?: ExecutionTraceEntry[];
    /** P-2026-023 Phase 4: primary (default) or shadow mode run */
    runMode?: RunMode;
    /** P-2026-023 Phase 4: primary vs legacy planner comparison snapshot */
    shadowCompare?: ShadowComparison;
    /** V2.1: strategy/brain type that generated this action */
    brainType?: string;
    /** V2.1: semantic intent type (swap, approve, wrap, etc.) */
    intentType?: string;
    /** V2.1: human-readable decision reason */
    decisionReason?: string;
    /** V3.2: user-facing message from LLM agent */
    decisionMessage?: string;
    /** P-2026-027: gas consumed by the transaction */
    gasUsed?: string;
    /** P-2026-027: realized PnL in USD (positive = profit) */
    pnlUsd?: string;
    createdAt: string;
}

export type RunMode = "primary" | "shadow";

export interface ShadowComparison {
    primaryKind: "wait" | "readonly" | "write" | "blocked";
    legacyKind: "wait" | "readonly" | "write" | "blocked";
    primaryAction: string;
    legacyAction: string;
    primaryErrorCode?: string;
    legacyErrorCode?: string;
    diverged: boolean;
    reason?: string;
    at: string;
}

export interface ExecutionTraceEntry {
    stage:
    | "observe"
    | "propose"
    | "plan"
    | "validate"
    | "simulate"
    | "execute"
    | "verify"
    | "record";
    status: "ok" | "skip" | "blocked" | "error";
    at: string;
    note?: string;
    meta?: Record<string, unknown>;
}

export interface StrategyConfigRecord {
    tokenId: string;
    chainId: number;
    strategyType: StrategyType;
    target: string;
    data: Hex;
    value: string;
    strategyParams: Record<string, unknown>;
    source: string;
    minIntervalMs: number;
    requirePositiveBalance: boolean;
    maxFailures: number;
    failureCount: number;
    budgetDay?: string;
    dailyRunsUsed: number;
    dailyValueUsed: string;
    enabled: boolean;
    lastRunAt?: string;
    lastError?: string;
    nextCheckAt?: string;
    createdAt: string;
    updatedAt: string;
}


export interface MarketSignalUpsertPayload {
    pair: string;
    priceChangeBps: number;
    volume5m?: string | number | bigint;
    uniqueTraders5m?: number;
    sampledAt?: string;
    source?: string;
}

export interface MarketSignalBatchUpsertPayload {
    items: MarketSignalUpsertPayload[];
    source?: string;
}

export interface MarketSignalSyncRequestPayload {
    dryRun?: boolean;
}

export interface MarketSignalRecord {
    chainId: number;
    pair: string;
    priceChangeBps: number;
    volume5m: string;
    uniqueTraders5m: number;
    sampledAt: string;
    source: string;
    createdAt: string;
    updatedAt: string;
}
