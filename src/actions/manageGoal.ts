/**
 * Goal Management Action — Read-only action for LLM to manage persistent goals.
 *
 * Allows the LLM to:
 *   - Create a new goal (e.g. "monitor Token X price")
 *   - Complete a goal (e.g. "bought Token X, goal achieved")
 *
 * Goals are stored in agent_memory with type='goal' and persist across cycles.
 * Active goals are injected into the LLM context each cycle so
 * the agent remembers what it's supposed to be doing.
 */

import type { Pool } from "pg";
import type { IAction, ToolResult, ActionPayload } from "./interface.js";
import { PgMemory } from "../memory/pg.js";

export function createManageGoalAction(pool: Pool): IAction {
    return {
        name: "manage_goal",
        description:
            "Create or complete a persistent goal. Goals are remembered across cycles " +
            "and shown to you in the 'Active Goals' section of each check-in. " +
            "Use this to track long-running objectives like price monitoring, DCA plans, " +
            "or position management targets.",
        readonly: true,

        parameters: {
            type: "object",
            properties: {
                operation: {
                    type: "string",
                    description: "Operation: 'create' to set a new goal, 'complete' to mark a goal as done.",
                    enum: ["create", "complete"],
                },
                goalId: {
                    type: "string",
                    description: "Unique goal ID (e.g. 'monitor_bnb_price', 'dca_usdt_weekly'). Use snake_case.",
                },
                description: {
                    type: "string",
                    description: "Human-readable goal description (only for 'create'). E.g. 'Buy 10 USDT when BNB drops below $600'.",
                },
            },
            required: ["operation", "goalId"],
        },

        async execute(params: Record<string, unknown>): Promise<ToolResult> {
            const operation = params.operation as string;
            const goalId = params.goalId as string;
            const tokenId = params.__tokenId as bigint;

            if (!tokenId) {
                return { success: false, data: { error: "Missing tokenId context" } };
            }

            const memory = new PgMemory(tokenId, params.__pool as Pool);

            try {
                if (operation === "create") {
                    const description = params.description as string;
                    if (!description) {
                        return { success: false, data: { error: "Missing 'description' for create operation" } };
                    }
                    await memory.storeGoal(goalId, description);
                    return {
                        success: true,
                        data: { message: `Goal '${goalId}' created: ${description}` },
                    };
                } else if (operation === "complete") {
                    await memory.completeGoal(goalId);
                    return {
                        success: true,
                        data: { message: `Goal '${goalId}' marked as completed` },
                    };
                } else {
                    return {
                        success: false,
                        data: { error: `Unknown operation: ${operation}. Use 'create' or 'complete'.` },
                    };
                }
            } catch (err) {
                return {
                    success: false,
                    data: {
                        error: "Goal operation failed",
                        details: err instanceof Error ? err.message : String(err),
                    },
                };
            }
        },

        encode(): ActionPayload {
            throw new Error("manage_goal is read-only and cannot be encoded");
        },
    };
}
