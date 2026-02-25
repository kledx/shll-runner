/**
 * Agent Factory — Assembles Agent instances from chain data + blueprints.
 *
 * 1. Reads agentType from on-chain AgentNFA
 * 2. Looks up AgentBlueprint (DB cache → hardcoded fallback)
 * 3. Instantiates 5 capability modules
 * 4. Returns a fully assembled Agent
 */

import type { Address } from "viem";
import type { Agent, AgentBlueprint, LLMConfig, ActionConfig } from "./agent.js";
import type { IPerception } from "../perception/interface.js";
import type { IMemory } from "../memory/interface.js";
import type { IBrain } from "../brain/interface.js";
import type { IAction } from "../actions/interface.js";
import type { IGuardrails } from "../guardrails/interface.js";
import { blueprintStore } from "./blueprintStore.js";

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

/** Get all registered action names (for blueprint validation) */
export function listRegisteredActions(): string[] {
    return [...actionRegistry.keys()];
}

/** Get all registered brain names */
export function listRegisteredBrains(): string[] {
    return [...brainRegistry.keys()];
}

/** Get all registered perception names */
export function listRegisteredPerceptions(): string[] {
    return [...perceptionRegistry.keys()];
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
 * Blueprint lookup: DB cache → hardcoded fallback → error
 *
 * @param data  On-chain agent metadata + DB strategy params
 * @returns     Fully assembled Agent
 * @throws      If agentType has no blueprint or required modules are missing
 */
export function createAgent(data: ChainAgentData): Agent {
    // DB cache → hardcoded fallback
    const blueprint = blueprintStore.get(data.agentType);
    if (!blueprint) {
        throw new Error(`No blueprint found for agentType: ${data.agentType}`);
    }

    // Perception — supports single string or array
    const perceptionNames = Array.isArray(blueprint.perception)
        ? blueprint.perception
        : [blueprint.perception];
    const primaryPerception = perceptionNames[0];
    const percFactory = perceptionRegistry.get(primaryPerception);
    if (!percFactory) {
        throw new Error(`Perception module not registered: ${primaryPerception}`);
    }

    // Brain — receives both blueprint llmConfig and per-agent strategyParams
    const brainFactory = brainRegistry.get(blueprint.brain);
    if (!brainFactory) {
        throw new Error(`Brain module not registered: ${blueprint.brain}`);
    }

    // Actions — supports string or ActionConfig
    const actions: IAction[] = [];
    for (const entry of blueprint.actions) {
        const isConfig = typeof entry !== "string";
        const name = isConfig ? (entry as ActionConfig).name : entry;
        const actionConfig = isConfig ? (entry as ActionConfig) : undefined;

        // Skip disabled actions
        if (actionConfig?.enabled === false) continue;

        const actFactory = actionRegistry.get(name);
        if (!actFactory) {
            throw new Error(`Action module not registered: ${name}`);
        }

        const action = actFactory();

        // Pass blueprint-level config to action if available
        if (actionConfig?.config && action.configure) {
            action.configure(actionConfig.config);
        }

        actions.push(action);
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
    return blueprintStore.get(agentType);
}

/** List all registered agent types */
export function listAgentTypes(): string[] {
    return blueprintStore.listTypes();
}
