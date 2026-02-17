import type { Address, Hex } from "viem";

export type StrategyType = "fixed_action" | "wrap_native" | "hotpump_watchlist" | "composite" | "llm_trader" | "manual_swap" | "dca";

/**
 * Child strategy definition used inside a composite strategy's strategyParams.children.
 * Each child carries its own strategyType, target, data, value, and params.
 */
export interface CompositeChildStrategy {
    strategyType: Exclude<StrategyType, "composite">;
    target: string;
    data: string;
    value: string;
    strategyParams: Record<string, unknown>;
}

export interface AgentState {
    balance: bigint;
    status: number; // 0=Active, 1=Paused, 2=Terminated
    owner: Address;
    logicAddress: Address;
    lastActionTimestamp: bigint;
}

/**
 * On-chain instance configuration data read from InstanceConfig contract.
 * These params are immutable once bound, so can be cached after first read.
 */
export interface InstanceConfigData {
    policyId: number;
    version: number;
    slippageBps: number;
    tradeLimit: bigint;
    dailyLimit: bigint;
    tokenGroupId: number;
    dexGroupId: number;
    riskTier: number;
    paramsPacked: string;  // raw hex
    paramsHash: string;    // 0x...
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
    /** V1.4 on-chain instance config (cached after first read) */
    instanceConfig?: InstanceConfigData;
}

export interface ActionPayload {
    target: Address;
    value: bigint;
    data: Hex;
}

export interface Decision {
    shouldAct: boolean;
    reason: string;
    action?: ActionPayload;
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
    target: string;
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
    /** V2.1: strategy/brain type that generated this action */
    brainType?: string;
    /** V2.1: semantic intent type (swap, approve, wrap, etc.) */
    intentType?: string;
    /** V2.1: human-readable decision reason */
    decisionReason?: string;
    createdAt: string;
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
    createdAt: string;
    updatedAt: string;
}

export interface StrategyLoadPackPayload {
    filePath?: string;
    pack?: unknown;
    tokenIds?: Array<string | number | bigint>;
    hash?: string;
    signature?: string;
    publicKey?: string;
    dryRun?: boolean;
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
