# Runner Strategy Plugin Guide

## Overview

The SHLL Runner V1.4.1 supports extensible strategy plugins that determine when and how to execute on-chain actions for each agent instance. 

## Strategy Types

| Type | Description | Async | LLM |
|------|-------------|-------|-----|
| `fixed_action` | Executes a fixed action payload | No | No |
| `wrap_native` | Wraps native token (BNB→WBNB) | No | No |
| `hotpump_watchlist` | Monitors market signals for pump events | No | No |
| `composite` | Runs multiple child strategies with priority | No | No |
| `llm_trader` | LLM-driven autonomous trading | Yes | Yes |
| `manual_swap` | Manual swap via BYOR/API | No | No |

## Creating a Strategy

### Via API

```bash
curl -X POST http://localhost:8787/strategy/upsert \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "tokenId": "1",
    "strategyType": "llm_trader",
    "target": "0x0000000000000000000000000000000000000000",
    "strategyParams": {
      "maxSteps": 6,
      "minConfidence": 0.6,
      "cooldownMs": 1800000
    },
    "minIntervalMs": 300000,
    "maxFailures": 5,
    "enabled": true
  }'
```

### Via Capability Pack

```bash
curl -X POST http://localhost:8787/strategy/load-pack \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "filePath": "./configs/policies/swapSafe_v1.json",
    "tokenIds": ["13"]
  }'
```

Notes:
- `tokenIds` is optional for legacy strategy packs (`strategies[]` with per-token entries).
- For manifest packs (`schemaVersion` + `runner`), `tokenIds` is required when runner allowlist has multiple token IDs.

Smoke test script:

```bash
npm run smoke:pack-load
```

## LLM Trader Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_API_KEY` | Yes (for llm_trader) | — | API key for Gemini/OpenAI |
| `LLM_BASE_URL` | No | Gemini endpoint | LLM API base URL |
| `LLM_MODEL` | No | `gemini-2.0-flash` | Model identifier |
| `LLM_MAX_TOKENS` | No | `2048` | Max output tokens |
| `LLM_TIMEOUT_MS` | No | `30000` | Request timeout |

### Strategy Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `maxSteps` | number | 6 | Max tool-calling iterations |
| `maxIntents` | number | 2 | Max ActionIntents per run |
| `minConfidence` | number | 0.6 | Minimum confidence score |
| `cooldownMs` | number | 1800000 | Cooldown between runs (ms) |
| `toolAllowList` | string[] | all tools | Restrict available tools |

### Available Tools

| Tool | Description |
|------|-------------|
| `getMarketSignal` | Get market data for a specific pair |
| `listMarketSignals` | List all available market signals |
| `getInstanceContext` | Get on-chain instance configuration |

## ActionIntent Flow

```
LLM Output → ActionIntent → Validation → Encoder → ActionPayload → Simulate → Execute
```

The LLM outputs structured `ActionIntent` objects:

```typescript
interface ActionIntent {
  type: "swap" | "approve";
  router: string;       // DEX router address
  tokenIn: string;      // ERC20 address
  tokenOut: string;     // ERC20 address
  amountIn: string;     // wei string
  minOut?: string;      // slippage protection
  confidence?: number;  // 0.0-1.0
  reason?: string[];    // reasoning chain
}
```

## V1.4 Contract Integration

### InstanceConfig

The Runner reads on-chain instance parameters on first encounter:
- `INSTANCE_CONFIG_ADDRESS` — InstanceConfig contract
- Parameters are immutable and cached after first read
- Available to LLM via `getInstanceContext` tool

### PolicyGuardV2

Pre-validation for error attribution:
- `POLICY_GUARD_V2_ADDRESS` — PolicyGuardV2 contract
- Called after execution failures to classify errors
- Results stored in `RunRecord.failureCategory`

## Error Attribution

When execution fails, the Runner calls `PolicyGuardV2.validate()` to get structured error reasons:

- `TOKEN_NOT_IN_GROUP` — Token not in allowed token group
- `RECEIVER_NOT_VAULT` — Receiver is not the agent vault
- `DAILY_LIMIT_EXCEEDED` — Daily spending limit exceeded
- `SLIPPAGE_EXCEEDED` — Slippage exceeds policy limit
