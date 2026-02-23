import { Hex, Address, PublicClient, WalletClient } from 'viem';

interface RunnerConfig {
    /** RPC endpoint to connect to the network */
    rpcUrl: string;
    /** Private key of the operator executing actions on behalf of users */
    operatorPrivateKey: Hex;
    /** The SHLL AgentNFA contract address */
    agentNfaAddress: Address;
    /** Optional PolicyGuard address for off-chain simulation to save gas */
    policyGuardAddress?: Address;
}
interface StepResult {
    /** True if the agent decided to take an action this cycle */
    acted: boolean;
    /** The semantic action type (e.g. "swap", "approve", "wait") */
    action: string;
    /** Explanation of the agent's decision */
    reasoning: string;
    /** User-facing message from the agent */
    message?: string;
    /** True if the agent is blocked from acting (e.g. missing prerequisites) */
    blocked: boolean;
    /** Why the agent is blocked, if applicable */
    blockReason?: string;
    /** True if the agent has finished its goal */
    done?: boolean;
    /** The payload to execute on-chain, if any */
    payload?: {
        target: Address;
        value: bigint;
        data: Hex;
    };
    /** Timestamp for the next scheduled check, if applicable */
    nextCheckMs?: number;
    /** Raw parameters extracted by the action */
    params?: Record<string, unknown>;
}
interface AgentBlueprint {
    /** E.g. "llm_trader" */
    type: string;
    /** The semantic intents this agent can produce */
    intents: string[];
}
interface RunnerStatus {
    uptime: number;
    activeAgents: number;
    lastError?: string;
}
interface AgentStatus {
    tokenId: bigint;
    agentType: string;
    isRunning: boolean;
    lastActionAt?: number;
}
interface IShllRunner {
    /** Start the runner and establish chain connections */
    start(config: RunnerConfig): Promise<void>;
    /** Stop the runner and gracefully shut down resources */
    stop(): Promise<void>;
    /** Register an agent token to be managed by this runner instance */
    registerAgent(tokenId: bigint, blueprint: AgentBlueprint): Promise<void>;
    /** Stop managing an agent token */
    unregisterAgent(tokenId: bigint): Promise<void>;
    /**
     * Perform one execution cycle for a token.
     * Implementations handle perception, memory, and cognitive action.
     */
    executeStep(tokenId: bigint): Promise<StepResult>;
    /** Get the runner's overall health status */
    getStatus(): RunnerStatus;
    /** Get an individual agent's status */
    getAgentStatus(tokenId: bigint): AgentStatus;
}

interface ExecutionTraceEntry {
    stage: "observe" | "propose" | "plan" | "validate" | "simulate" | "execute" | "verify" | "record";
    status: "ok" | "skip" | "blocked" | "error";
    at: string;
    note?: string;
    meta?: Record<string, unknown>;
}
interface ShadowComparison {
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
type RunMode = "primary" | "shadow";

interface Observation {
    tokenId: bigint;
    agentState: {
        balance: bigint;
        status: number;
        owner: Address;
        logicAddress: Address;
        lastActionTimestamp: bigint;
    };
    agentAccount: Address;
    renter: Address;
    renterExpires: bigint;
    operator: Address;
    operatorExpires: bigint;
    blockNumber: bigint;
    blockTimestamp: bigint;
    timestamp: number;
}
interface ChainReaderConfig {
    rpcUrl: string;
    agentNfaAddress: Address;
    rpcTimeoutMs?: number;
    rpcRetryCount?: number;
    /** Additional agent type strings to recognize beyond the built-in ones */
    customAgentTypes?: string[];
}
declare const MinimalAgentNFAAbi: readonly [{
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "tokenId";
        readonly type: "uint256";
    }];
    readonly name: "getState";
    readonly outputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "uint256";
            readonly name: "balance";
            readonly type: "uint256";
        }, {
            readonly internalType: "enum AgentNFA.AgentStatus";
            readonly name: "status";
            readonly type: "uint8";
        }, {
            readonly internalType: "address";
            readonly name: "owner";
            readonly type: "address";
        }, {
            readonly internalType: "address";
            readonly name: "logicAddress";
            readonly type: "address";
        }, {
            readonly internalType: "uint256";
            readonly name: "lastActionTimestamp";
            readonly type: "uint256";
        }];
        readonly internalType: "struct AgentNFA.AgentState";
        readonly name: "";
        readonly type: "tuple";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "tokenId";
        readonly type: "uint256";
    }];
    readonly name: "accountOf";
    readonly outputs: readonly [{
        readonly internalType: "address";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "tokenId";
        readonly type: "uint256";
    }];
    readonly name: "userOf";
    readonly outputs: readonly [{
        readonly internalType: "address";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "tokenId";
        readonly type: "uint256";
    }];
    readonly name: "userExpires";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "tokenId";
        readonly type: "uint256";
    }];
    readonly name: "operatorOf";
    readonly outputs: readonly [{
        readonly internalType: "address";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "tokenId";
        readonly type: "uint256";
    }];
    readonly name: "operatorExpiresOf";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "tokenId";
        readonly type: "uint256";
    }];
    readonly name: "operatorNonceOf";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "tokenId";
        readonly type: "uint256";
    }];
    readonly name: "agentType";
    readonly outputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "";
        readonly type: "bytes32";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "tokenId";
        readonly type: "uint256";
    }, {
        readonly components: readonly [{
            readonly internalType: "address";
            readonly name: "target";
            readonly type: "address";
        }, {
            readonly internalType: "uint256";
            readonly name: "value";
            readonly type: "uint256";
        }, {
            readonly internalType: "bytes";
            readonly name: "data";
            readonly type: "bytes";
        }];
        readonly internalType: "struct AgentNFA.ActionPayload";
        readonly name: "action";
        readonly type: "tuple";
    }];
    readonly name: "execute";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "uint256";
            readonly name: "tokenId";
            readonly type: "uint256";
        }, {
            readonly internalType: "address";
            readonly name: "renter";
            readonly type: "address";
        }, {
            readonly internalType: "address";
            readonly name: "operator";
            readonly type: "address";
        }, {
            readonly internalType: "uint64";
            readonly name: "expires";
            readonly type: "uint64";
        }, {
            readonly internalType: "uint256";
            readonly name: "nonce";
            readonly type: "uint256";
        }, {
            readonly internalType: "uint256";
            readonly name: "deadline";
            readonly type: "uint256";
        }];
        readonly internalType: "struct NativeSigner.EnableRequest";
        readonly name: "req";
        readonly type: "tuple";
    }, {
        readonly internalType: "bytes";
        readonly name: "signature";
        readonly type: "bytes";
    }];
    readonly name: "setOperatorWithSig";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "tokenId";
        readonly type: "uint256";
    }];
    readonly name: "clearOperator";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}];
/**
 * Common ChainReader extracted from SHLL architecture.
 * Facilitates reading agent ownership, lease times, and operator permits
 * from the standard AgentNFA contract.
 */
declare class ChainReader {
    readonly publicClient: PublicClient;
    private readonly agentNfaAddress;
    private readonly agentTypeMap;
    constructor(config: ChainReaderConfig);
    /**
     * Get a comprehensive snapshot of the agent's current on-chain state
     */
    observe(tokenId: bigint): Promise<Observation>;
    /**
     * Read just the operational limits of the agent (operator / lease state)
     */
    readStatus(tokenId: bigint): Promise<{
        onchainOperator: Address;
        operatorExpires: bigint;
        renter: Address;
        renterExpires: bigint;
        operatorNonce: bigint;
    }>;
    /**
     * Reads the agentType (bytes32) and maps it back to a human-readable string.
     */
    readAgentType(tokenId: bigint): Promise<string>;
}

interface TransactionBuilderConfig {
    rpcUrl: string;
    operatorPrivateKey: Hex;
    agentNfaAddress: Address;
}
interface ActionPayload {
    target: Address;
    value: bigint;
    data: Hex;
}
interface ActionResult {
    hash: Hex;
}
interface NormalizedPermit {
    tokenId: bigint;
    renter: Address;
    operator: Address;
    expires: bigint;
    nonce: bigint;
    deadline: bigint;
}
/**
 * Common TransactionBuilder extracted from SHLL architecture.
 * Facilitates executing actions and managing operator permits on-chain.
 */
declare class TransactionBuilder {
    readonly walletClient: WalletClient;
    readonly accountAddress: Address;
    private readonly agentNfaAddress;
    private readonly publicClient;
    constructor(config: TransactionBuilderConfig);
    /**
     * Executes an action on behalf of the agent's token ID.
     * Simulates first, then broadcasts.
     */
    executeAction(tokenId: bigint, action: ActionPayload): Promise<ActionResult>;
    /**
     * Updates an operator permit on-chain using an EIP-712 signature
     */
    enableOperatorWithPermit(permit: NormalizedPermit, sig: Hex): Promise<ActionResult>;
    /**
     * Clears the operator permit on-chain
     */
    clearOperator(tokenId: bigint): Promise<ActionResult>;
}

interface DecisionLogEntry {
    tokenId: bigint;
    action: string;
    reasoning: string;
    blocked: boolean;
    blockReason?: string;
    timestampMs: number;
    meta?: Record<string, unknown>;
}
interface IDecisionLogger {
    logDecision(entry: DecisionLogEntry): void;
}
/**
 * Common DecisionLogger extracted from SHLL architecture.
 * Formats and outputs LLM reasoning logs consistently.
 */
declare class DecisionLogger implements IDecisionLogger {
    private readonly label;
    constructor(label?: string);
    logDecision(entry: DecisionLogEntry): void;
}

interface PolicySimulatorConfig {
    publicClient: PublicClient;
    policyGuardV4Address: Address;
    operatorAddress: Address;
    agentNfaAddress: Address;
}
interface SimulationResult {
    ok: boolean;
    reason?: string;
}
/**
 * Common PolicySimulator extracted from SHLL architecture.
 * Safely simulates SHLL PolicyGuard validation off-chain to prevent reverts.
 */
declare class PolicySimulator {
    private readonly config;
    constructor(config: PolicySimulatorConfig);
    /**
     * Simulates the policy evaluation that would happen automatically on-chain
     * when calling AgentNFA.execute().
     * If this fails, the action should not be attempted as it will revert.
     */
    simulateAction(tokenId: bigint, vaultAddress: Address, action: ActionPayload): Promise<SimulationResult>;
}

export { type ActionPayload, type ActionResult, type AgentBlueprint, type AgentStatus, ChainReader, type ChainReaderConfig, type DecisionLogEntry, DecisionLogger, type ExecutionTraceEntry, type IDecisionLogger, type IShllRunner, MinimalAgentNFAAbi, type NormalizedPermit, type Observation, PolicySimulator, type PolicySimulatorConfig, type RunMode, type RunnerConfig, type RunnerStatus, type ShadowComparison, type SimulationResult, type StepResult, TransactionBuilder, type TransactionBuilderConfig };
