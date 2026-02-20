/**
 * Agent — Core entity in V3.0 Agent Runtime.
 *
 * An Agent is composed of 5 capability modules:
 *   Perception → Memory → Brain → Actions → Guardrails
 *
 * The Agent interface is intentionally data-oriented (no methods).
 * Behavior lives in agent/runtime.ts which orchestrates the cognitive loop.
 */

import type { Address } from "viem";
import type { IPerception } from "../perception/interface.js";
import type { IMemory } from "../memory/interface.js";
import type { IBrain } from "../brain/interface.js";
import type { IAction } from "../actions/interface.js";
import type { IGuardrails } from "../guardrails/interface.js";

// ═══════════════════════════════════════════════════════
//                     Agent Interface
// ═══════════════════════════════════════════════════════

export interface Agent {
    /** On-chain token ID */
    tokenId: bigint;
    /** Agent type from chain (e.g. "llm_trader", "llm_defi", "hot_token") */
    agentType: string;
    /** NFT owner address */
    owner: Address;
    /** Current renter address (zero if none) */
    renter: Address;
    /** ERC-6551 vault (AgentAccount) address */
    vault: Address;

    // Five capability modules
    perception: IPerception;
    memory: IMemory;
    brain: IBrain;
    actions: IAction[];
    guardrails: IGuardrails;
}

// ═══════════════════════════════════════════════════════
//                   Agent Blueprint
// ═══════════════════════════════════════════════════════

/** Blueprint defines how to assemble an Agent from its agentType */
export interface AgentBlueprint {
    /** Brain type identifier: "rule:hotToken" | "llm" */
    brain: string;
    /** Action module names to include: ["swap", "approve", "analytics", ...] */
    actions: string[];
    /** Perception module name: "defi" */
    perception: string;
    /** LLM configuration (only if brain starts with "llm") */
    llmConfig?: LLMConfig;
}

/** LLM-specific configuration within a blueprint */
export interface LLMConfig {
    systemPrompt: string;
    provider: string;  // "openai" | "deepseek" | "gemini" | "ollama"
    model: string;
    maxStepsPerRun: number;
    /** Optional endpoint override (defaults to provider's standard URL) */
    endpoint?: string;
    /** Optional API key override (defaults to env) */
    apiKey?: string;
    /** User instruction — used for intent classification (tool gating) */
    tradingGoal?: string;
}
