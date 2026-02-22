# SHLL Runner

Deterministic agent runner for SHLL autonomous execution.

## What It Does

- Runs agent cycles with a fixed runtime pipeline:
  - `observe -> propose -> plan -> validate -> simulate -> execute -> verify -> record`
- Enforces hard/soft guardrails in code (not only prompt).
- Rejects low-confidence non-wait actions with runtime confidence gate.
- Writes structured run records (`failureCategory`, `errorCode`, `executionTrace`).
- Supports shadow mode for canary comparison without affecting on-chain state.

## Quick Start

1. Install dependencies:
   - `npm install`
2. Configure environment:
   - copy `.env.example` to `.env`
   - fill required vars (`RPC_URL`, `OPERATOR_PK`, `AGENT_NFA_ADDRESS`, DB config, etc.)
3. Run:
   - `npm run dev`
4. Verify build/tests:
   - `npm run test:replay`

## Production Minimum Env

Minimum required variables for production runtime:

- `RPC_URL`
- `CHAIN_ID`
- `OPERATOR_PK`
- `AGENT_NFA_ADDRESS`
- `DATABASE_URL` (or `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`)
- `API_KEY` (recommended non-empty)

Recommended baseline values:

- `LOG_LEVEL=info`
- `POLL_INTERVAL_MS=30000`
- `TOKEN_LOCK_LEASE_MS=90000`
- `MAX_RETRIES=3`
- `PG_POOL_MAX=10`
- `MAX_RUN_RECORDS=1000`
- `STATUS_RUNS_LIMIT=20`
- `LLM_MIN_ACTION_CONFIDENCE=0.45`

Confidence gate behavior:

- Applied only when `decision.action !== "wait"`.
- If `confidence < LLM_MIN_ACTION_CONFIDENCE`, runner blocks the action with:
  - `failureCategory=model_output_error`
  - `errorCode=MODEL_LOW_CONFIDENCE`

Deployment-ready template is provided in:

- `orchestrator/PROGRAMS/P-2026-023-runner-deprompt-refactor/workspace/env.production.template`

## Shadow Mode (Phase 4)

Use shadow mode to compare current planner behavior vs legacy planner behavior.

### Environment Flags

- `SHADOW_MODE_ENABLED=true|false`
- `SHADOW_MODE_TOKEN_IDS=1,2,3` (optional; empty means all schedulable tokens)
- `SHADOW_EXECUTE_TX=false|true`
  - `false`: dry-run only, no on-chain transaction submission
  - `true`: allow on-chain submit in shadow mode (use with caution)

### Stored Fields

Each run now includes:

- `run_mode`: `primary` or `shadow`
- `shadow_compare`: structured comparison between primary and legacy plans

### Metrics API

- `GET /shadow/metrics`
- Optional query:
  - `tokenId=<uint>`
  - `sinceHours=<1..720>`

Response contains per-mode metrics:

- total/success/rejected/exception/intervention counts
- success/reject/exception/intervention/divergence rates
- average end-to-end latency derived from execution trace
- shadow-vs-primary rate deltas

## Core API Endpoints

- `GET /health`
- `GET /status`
- `GET /status/all`
- `GET /agent/dashboard`
- `GET /agent/activity`
- `GET /shadow/metrics`
- `POST /enable`
- `POST /disable`
- `POST /strategy/upsert`
- `POST /strategy/clear-goal`

## Validation and Replay

- `npm run test:replay`
  - compiles TypeScript
  - runs replay classifier tests
  - runs params validator tests
  - runs run failure classifier tests
  - runs planner tests

## Compatibility

This runner-side refactor keeps chain interface behavior intact and remains compatible with BAP-578-based agent assets/contracts.
