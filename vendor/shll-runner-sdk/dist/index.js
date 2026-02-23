// src/modules/ChainReader.ts
import {
  createPublicClient,
  http,
  keccak256,
  toHex
} from "viem";
var DEFAULT_KNOWN_TYPES = ["llm_trader", "llm_defi", "hot_token", "simple_dca", "smart_dca"];
var MinimalAgentNFAAbi = [
  {
    "inputs": [{ "internalType": "uint256", "name": "tokenId", "type": "uint256" }],
    "name": "getState",
    "outputs": [{
      "components": [
        { "internalType": "uint256", "name": "balance", "type": "uint256" },
        { "internalType": "enum AgentNFA.AgentStatus", "name": "status", "type": "uint8" },
        { "internalType": "address", "name": "owner", "type": "address" },
        { "internalType": "address", "name": "logicAddress", "type": "address" },
        { "internalType": "uint256", "name": "lastActionTimestamp", "type": "uint256" }
      ],
      "internalType": "struct AgentNFA.AgentState",
      "name": "",
      "type": "tuple"
    }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "uint256", "name": "tokenId", "type": "uint256" }],
    "name": "accountOf",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "uint256", "name": "tokenId", "type": "uint256" }],
    "name": "userOf",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "uint256", "name": "tokenId", "type": "uint256" }],
    "name": "userExpires",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "uint256", "name": "tokenId", "type": "uint256" }],
    "name": "operatorOf",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "uint256", "name": "tokenId", "type": "uint256" }],
    "name": "operatorExpiresOf",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "uint256", "name": "tokenId", "type": "uint256" }],
    "name": "operatorNonceOf",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  // ... Read methods ...
  {
    "inputs": [{ "internalType": "uint256", "name": "tokenId", "type": "uint256" }],
    "name": "agentType",
    "outputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }],
    "stateMutability": "view",
    "type": "function"
  },
  // Write methods
  {
    "inputs": [
      { "internalType": "uint256", "name": "tokenId", "type": "uint256" },
      {
        "components": [
          { "internalType": "address", "name": "target", "type": "address" },
          { "internalType": "uint256", "name": "value", "type": "uint256" },
          { "internalType": "bytes", "name": "data", "type": "bytes" }
        ],
        "internalType": "struct AgentNFA.ActionPayload",
        "name": "action",
        "type": "tuple"
      }
    ],
    "name": "execute",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          { "internalType": "uint256", "name": "tokenId", "type": "uint256" },
          { "internalType": "address", "name": "renter", "type": "address" },
          { "internalType": "address", "name": "operator", "type": "address" },
          { "internalType": "uint64", "name": "expires", "type": "uint64" },
          { "internalType": "uint256", "name": "nonce", "type": "uint256" },
          { "internalType": "uint256", "name": "deadline", "type": "uint256" }
        ],
        "internalType": "struct NativeSigner.EnableRequest",
        "name": "req",
        "type": "tuple"
      },
      { "internalType": "bytes", "name": "signature", "type": "bytes" }
    ],
    "name": "setOperatorWithSig",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "uint256", "name": "tokenId", "type": "uint256" }],
    "name": "clearOperator",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];
var ChainReader = class {
  publicClient;
  agentNfaAddress;
  agentTypeMap;
  constructor(config) {
    this.agentNfaAddress = config.agentNfaAddress;
    const transport = http(config.rpcUrl, {
      timeout: config.rpcTimeoutMs ?? 3e4,
      retryCount: config.rpcRetryCount ?? 3
    });
    this.publicClient = createPublicClient({
      transport
    });
    const allTypes = [...DEFAULT_KNOWN_TYPES, ...config.customAgentTypes ?? []];
    this.agentTypeMap = Object.fromEntries(
      allTypes.map((t) => [keccak256(toHex(t)), t])
    );
  }
  /**
   * Get a comprehensive snapshot of the agent's current on-chain state
   */
  async observe(tokenId) {
    const [
      agentState,
      agentAccount,
      renter,
      renterExpires,
      operator,
      operatorExpires,
      block
    ] = await Promise.all([
      this.publicClient.readContract({
        address: this.agentNfaAddress,
        abi: MinimalAgentNFAAbi,
        functionName: "getState",
        args: [tokenId]
      }),
      this.publicClient.readContract({
        address: this.agentNfaAddress,
        abi: MinimalAgentNFAAbi,
        functionName: "accountOf",
        args: [tokenId]
      }),
      this.publicClient.readContract({
        address: this.agentNfaAddress,
        abi: MinimalAgentNFAAbi,
        functionName: "userOf",
        args: [tokenId]
      }),
      this.publicClient.readContract({
        address: this.agentNfaAddress,
        abi: MinimalAgentNFAAbi,
        functionName: "userExpires",
        args: [tokenId]
      }),
      this.publicClient.readContract({
        address: this.agentNfaAddress,
        abi: MinimalAgentNFAAbi,
        functionName: "operatorOf",
        args: [tokenId]
      }),
      this.publicClient.readContract({
        address: this.agentNfaAddress,
        abi: MinimalAgentNFAAbi,
        functionName: "operatorExpiresOf",
        args: [tokenId]
      }),
      this.publicClient.getBlock()
    ]);
    return {
      tokenId,
      agentState,
      agentAccount,
      renter,
      renterExpires,
      operator,
      operatorExpires,
      blockNumber: block.number,
      blockTimestamp: block.timestamp,
      timestamp: Date.now()
    };
  }
  /**
   * Read just the operational limits of the agent (operator / lease state)
   */
  async readStatus(tokenId) {
    const [
      onchainOperator,
      operatorExpires,
      renter,
      renterExpires,
      operatorNonce
    ] = await Promise.all([
      this.publicClient.readContract({
        address: this.agentNfaAddress,
        abi: MinimalAgentNFAAbi,
        functionName: "operatorOf",
        args: [tokenId]
      }),
      this.publicClient.readContract({
        address: this.agentNfaAddress,
        abi: MinimalAgentNFAAbi,
        functionName: "operatorExpiresOf",
        args: [tokenId]
      }),
      this.publicClient.readContract({
        address: this.agentNfaAddress,
        abi: MinimalAgentNFAAbi,
        functionName: "userOf",
        args: [tokenId]
      }),
      this.publicClient.readContract({
        address: this.agentNfaAddress,
        abi: MinimalAgentNFAAbi,
        functionName: "userExpires",
        args: [tokenId]
      }),
      this.publicClient.readContract({
        address: this.agentNfaAddress,
        abi: MinimalAgentNFAAbi,
        functionName: "operatorNonceOf",
        args: [tokenId]
      })
    ]);
    return {
      onchainOperator,
      operatorExpires,
      renter,
      renterExpires,
      operatorNonce
    };
  }
  /**
   * Reads the agentType (bytes32) and maps it back to a human-readable string.
   */
  async readAgentType(tokenId) {
    const raw = await this.publicClient.readContract({
      address: this.agentNfaAddress,
      abi: MinimalAgentNFAAbi,
      functionName: "agentType",
      args: [tokenId]
    });
    const hex = raw.toLowerCase();
    return this.agentTypeMap[hex] ?? "unknown";
  }
};

// src/modules/TransactionBuilder.ts
import {
  createPublicClient as createPublicClient2,
  createWalletClient,
  http as http2
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
var TransactionBuilder = class {
  walletClient;
  accountAddress;
  agentNfaAddress;
  publicClient;
  constructor(config) {
    this.agentNfaAddress = config.agentNfaAddress;
    const account = privateKeyToAccount(config.operatorPrivateKey);
    this.accountAddress = account.address;
    const transport = http2(config.rpcUrl);
    this.publicClient = createPublicClient2({ transport });
    this.walletClient = createWalletClient({
      transport,
      account
    });
  }
  /**
   * Executes an action on behalf of the agent's token ID.
   * Simulates first, then broadcasts.
   */
  async executeAction(tokenId, action) {
    const simulation = await this.publicClient.simulateContract({
      address: this.agentNfaAddress,
      abi: MinimalAgentNFAAbi,
      functionName: "execute",
      args: [tokenId, action],
      account: this.walletClient.account
    });
    const hash = await this.walletClient.writeContract(simulation.request);
    return { hash };
  }
  /**
   * Updates an operator permit on-chain using an EIP-712 signature
   */
  async enableOperatorWithPermit(permit, sig) {
    const simulation = await this.publicClient.simulateContract({
      address: this.agentNfaAddress,
      abi: MinimalAgentNFAAbi,
      functionName: "setOperatorWithSig",
      args: [
        {
          tokenId: permit.tokenId,
          renter: permit.renter,
          operator: permit.operator,
          expires: permit.expires,
          nonce: permit.nonce,
          deadline: permit.deadline
        },
        sig
      ],
      account: this.walletClient.account
    });
    const hash = await this.walletClient.writeContract(simulation.request);
    return { hash };
  }
  /**
   * Clears the operator permit on-chain
   */
  async clearOperator(tokenId) {
    const simulation = await this.publicClient.simulateContract({
      address: this.agentNfaAddress,
      abi: MinimalAgentNFAAbi,
      functionName: "clearOperator",
      args: [tokenId],
      account: this.walletClient.account
    });
    const hash = await this.walletClient.writeContract(simulation.request);
    return { hash };
  }
};

// src/modules/DecisionLogger.ts
var DecisionLogger = class {
  label;
  constructor(label = "AgentRunner") {
    this.label = label;
  }
  logDecision(entry) {
    const time = new Date(entry.timestampMs).toISOString();
    const prefix = `[${this.label}][${entry.tokenId.toString()}][${time}] ${entry.action.toUpperCase()}`;
    if (entry.blocked) {
      console.warn(`${prefix} (BLOCKED: ${entry.blockReason ?? "unknown reason"}): ${entry.reasoning}`);
    } else {
      console.info(`${prefix}: ${entry.reasoning}`);
    }
  }
};

// src/modules/PolicySimulator.ts
var POLICY_GUARD_V4_VALIDATE_ABI = [
  {
    name: "validate",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "nfa", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "agentAccount", type: "address" },
      { name: "caller", type: "address" },
      {
        name: "action",
        type: "tuple",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" }
        ]
      }
    ],
    outputs: [
      { name: "ok", type: "bool" },
      { name: "reason", type: "string" }
    ]
  }
];
var PolicySimulator = class {
  config;
  constructor(config) {
    this.config = config;
  }
  /**
   * Simulates the policy evaluation that would happen automatically on-chain 
   * when calling AgentNFA.execute().
   * If this fails, the action should not be attempted as it will revert.
   */
  async simulateAction(tokenId, vaultAddress, action) {
    if (!this.config.policyGuardV4Address || this.config.policyGuardV4Address === "0x0000000000000000000000000000000000000000") {
      return { ok: true };
    }
    try {
      const [ok, reason] = await this.config.publicClient.readContract({
        address: this.config.policyGuardV4Address,
        abi: POLICY_GUARD_V4_VALIDATE_ABI,
        functionName: "validate",
        args: [
          this.config.agentNfaAddress,
          tokenId,
          vaultAddress,
          this.config.operatorAddress,
          {
            target: action.target,
            value: action.value,
            data: action.data
          }
        ]
      });
      return { ok, reason: reason || void 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Simulation reverted";
      return { ok: false, reason: `Simulation reverted: ${message.slice(0, 200)}` };
    }
  }
};
export {
  ChainReader,
  DecisionLogger,
  MinimalAgentNFAAbi,
  PolicySimulator,
  TransactionBuilder
};
//# sourceMappingURL=index.js.map