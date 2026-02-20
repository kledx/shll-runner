/**
 * Agent Factory — Assembles Agent instances from chain data + blueprints.
 *
 * 1. Reads agentType from on-chain AgentNFA
 * 2. Looks up AgentBlueprint (hardcoded registry, future: DB table)
 * 3. Instantiates 5 capability modules
 * 4. Returns a fully assembled Agent
 */

import type { Address } from "viem";
import type { Agent, AgentBlueprint, LLMConfig } from "./agent.js";
import type { IPerception } from "../perception/interface.js";
import type { IMemory } from "../memory/interface.js";
import type { IBrain } from "../brain/interface.js";
import type { IAction } from "../actions/interface.js";
import type { IGuardrails } from "../guardrails/interface.js";

// ═══════════════════════════════════════════════════════
//                  Blueprint Registry
// ═══════════════════════════════════════════════════════

/**
 * Built-in agent blueprints.
 * Future: load from `agent_blueprints` DB table for no-code composition.
 */
const AGENT_BLUEPRINTS: Record<string, AgentBlueprint> = {
    hot_token: {
        brain: "rule:hotToken",
        actions: ["swap", "approve", "analytics"],
        perception: "defi",
    },
    llm_trader: {
        brain: "llm",
        actions: ["swap", "approve", "wrap", "analytics", "portfolio", "allowance"],
        perception: "defi",
        llmConfig: {
            systemPrompt: "You are a DeFi trading agent. Analyze market data and vault positions to make profitable trades. Be conservative and prioritize capital preservation.",
            provider: "openai",
            model: "gpt-4o-mini",
            maxStepsPerRun: 5,
        },
    },
    llm_defi: {
        brain: "llm",
        actions: ["swap", "approve", "wrap", "analytics", "portfolio", "allowance"],
        perception: "defi",
        llmConfig: {
            systemPrompt: "You are an advanced DeFi agent capable of multi-step strategies. Analyze positions, market trends, and optimize yield across protocols.",
            provider: "deepseek",
            model: "deepseek-chat",
            maxStepsPerRun: 5,
        },
    },
};

// ═══════════════════════════════════════════════════════
//                 Brain Config Context
// ═══════════════════════════════════════════════════════

/**
 * Context passed to brain factory functions.
 * Enables per-agent configuration via strategy params from DB.
 */
export interface BrainFactoryContext {
    llmConfig?: LLMConfig;
    strategyParams?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════
//                   Module Registries
// ═══════════════════════════════════════════════════════

// These registries are populated at startup via registerXxx() calls
// from the concrete module implementations.

const perceptionRegistry = new Map<string, (vault: Address, tokenId: bigint) => IPerception>();
const brainRegistry = new Map<string, (ctx: BrainFactoryContext) => IBrain>();
const actionRegistry = new Map<string, () => IAction>();
const guardrailsFactory: { create?: (tokenId: bigint) => IGuardrails } = {};
const memoryFactory: { create?: (tokenId: bigint) => IMemory } = {};

/** Register a perception module */
export function registerPerception(name: string, factory: (vault: Address, tokenId: bigint) => IPerception): void {
    perceptionRegistry.set(name, factory);
}

/** Register a brain module */
export function registerBrain(name: string, factory: (ctx: BrainFactoryContext) => IBrain): void {
    brainRegistry.set(name, factory);
}

/** Register an action module */
export function registerAction(name: string, factory: () => IAction): void {
    actionRegistry.set(name, factory);
}

/** Register the guardrails factory */
export function registerGuardrails(factory: (tokenId: bigint) => IGuardrails): void {
    guardrailsFactory.create = factory;
}

/** Register the memory factory */
export function registerMemory(factory: (tokenId: bigint) => IMemory): void {
    memoryFactory.create = factory;
}

// ═══════════════════════════════════════════════════════
//                    Chain Data Input
// ═══════════════════════════════════════════════════════

export interface ChainAgentData {
    tokenId: bigint;
    agentType: string;
    owner: Address;
    renter: Address;
    vault: Address;
    /** Per-agent strategy params from token_strategies table */
    strategyParams?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════
//                    Factory Function
// ═══════════════════════════════════════════════════════

/**
 * Create an Agent instance from chain data.
 *
 * @param data  On-chain agent metadata + DB strategy params
 * @returns     Fully assembled Agent
 * @throws      If agentType has no blueprint or required modules are missing
 */
export function createAgent(data: ChainAgentData): Agent {
    const blueprint = AGENT_BLUEPRINTS[data.agentType];
    if (!blueprint) {
        throw new Error(`No blueprint found for agentType: ${data.agentType}`);
    }

    // Perception
    const percFactory = perceptionRegistry.get(blueprint.perception);
    if (!percFactory) {
        throw new Error(`Perception module not registered: ${blueprint.perception}`);
    }

    // Brain — receives both blueprint llmConfig and per-agent strategyParams
    const brainFactory = brainRegistry.get(blueprint.brain);
    if (!brainFactory) {
        throw new Error(`Brain module not registered: ${blueprint.brain}`);
    }

    // Actions
    const actions: IAction[] = [];
    for (const actionName of blueprint.actions) {
        const actFactory = actionRegistry.get(actionName);
        if (!actFactory) {
            throw new Error(`Action module not registered: ${actionName}`);
        }
        actions.push(actFactory());
    }

    // Guardrails
    if (!guardrailsFactory.create) {
        throw new Error("Guardrails factory not registered");
    }

    // Memory
    if (!memoryFactory.create) {
        throw new Error("Memory factory not registered");
    }

    return {
        tokenId: data.tokenId,
        agentType: data.agentType,
        owner: data.owner,
        renter: data.renter,
        vault: data.vault,

        perception: percFactory(data.vault, data.tokenId),
        memory: memoryFactory.create(data.tokenId),
        brain: brainFactory({
            llmConfig: blueprint.llmConfig,
            strategyParams: data.strategyParams,
        }),
        actions,
        guardrails: guardrailsFactory.create(data.tokenId),
    };
}

/** Get a blueprint by agentType (for inspection) */
export function getBlueprint(agentType: string): AgentBlueprint | undefined {
    return AGENT_BLUEPRINTS[agentType];
}

/** List all registered agent types */
export function listAgentTypes(): string[] {
    return Object.keys(AGENT_BLUEPRINTS);
}
