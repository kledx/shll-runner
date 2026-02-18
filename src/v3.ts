/**
 * V3.0 Module Index — Barrel exports for the Agent Runtime.
 *
 * Import paths:
 *   import { ... } from "./v3/index.js"
 *
 * Provides a clean public API for the new modular architecture.
 */

// ── Core ──────────────────────────────────────────────
export type { Agent, AgentBlueprint, LLMConfig } from "./agent/agent.js";
export { createAgent, getBlueprint, listAgentTypes } from "./agent/factory.js";
export type { ChainAgentData, BrainFactoryContext } from "./agent/factory.js";
export { AgentManager } from "./agent/manager.js";
export { runAgentCycle, recordExecution } from "./agent/runtime.js";
export type { RunResult } from "./agent/runtime.js";

// ── Modules ───────────────────────────────────────────
export type { IPerception, Observation, TokenBalance } from "./perception/interface.js";
export type { IMemory, MemoryEntry } from "./memory/interface.js";
export type { IBrain, Decision } from "./brain/interface.js";
export type { IAction, ActionPayload } from "./actions/interface.js";
export type { IGuardrails, PolicyCheckResult, ExecutionContext } from "./guardrails/interface.js";

// ── Bootstrap ─────────────────────────────────────────
export { bootstrapAgentModules } from "./bootstrap.js";
export type { BootstrapConfig } from "./bootstrap.js";

// ── API ───────────────────────────────────────────────
export { handleV3Routes } from "./api/router.js";
export type { V3RouterContext } from "./api/router.js";

// ── Store ─────────────────────────────────────────────
export { runV30Migrations } from "./store/migrations.js";
export { SafetyConfigStore } from "./store/safety.js";
