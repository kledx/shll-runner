/**
 * Agent Manager — Lifecycle management for Agent instances.
 *
 * Responsibilities:
 *   - Maintain a cache of active Agent instances
 *   - Start/stop agents on enable/disable events
 *   - Provide agent lookup for the scheduler and API layer
 */

import type { Agent } from "./agent.js";
import { createAgent, type ChainAgentData } from "./factory.js";

// ═══════════════════════════════════════════════════════
//                   Agent Manager
// ═══════════════════════════════════════════════════════

export class AgentManager {
    /** Active agent instances keyed by tokenId */
    private agents = new Map<string, Agent>();

    /**
     * Start an agent: create from chain data and add to active set.
     *
     * @param data On-chain agent metadata
     * @returns The created Agent instance
     */
    startAgent(data: ChainAgentData): Agent {
        const key = data.tokenId.toString();

        // If already running, stop first
        if (this.agents.has(key)) {
            this.stopAgent(data.tokenId);
        }

        const agent = createAgent(data);
        this.agents.set(key, agent);
        return agent;
    }

    /**
     * Stop an agent: remove from active set.
     * Future: could persist final state, flush memory, etc.
     */
    stopAgent(tokenId: bigint): boolean {
        const key = tokenId.toString();
        return this.agents.delete(key);
    }

    /** Get an active agent by tokenId */
    getAgent(tokenId: bigint): Agent | undefined {
        return this.agents.get(tokenId.toString());
    }

    /** List all active agent tokenIds */
    listActiveTokenIds(): bigint[] {
        return Array.from(this.agents.keys()).map(BigInt);
    }

    /** Get count of active agents */
    get activeCount(): number {
        return this.agents.size;
    }

    /** Check if an agent is active */
    isActive(tokenId: bigint): boolean {
        return this.agents.has(tokenId.toString());
    }

    /** Stop all agents (for graceful shutdown) */
    stopAll(): void {
        this.agents.clear();
    }
}
