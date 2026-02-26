/**
 * Goal Management Action — LLM tool for managing persistent goals and triggers.
 *
 * Allows the LLM to:
 *   - Create a text goal (e.g. "monitor Token X price")
 *   - Create a structured trigger (programmatic price monitoring)
 *   - Complete a goal/trigger
 *
 * Goals are stored in agent_memory and persist across cycles.
 * Triggers are evaluated programmatically by the scheduler every 3-5s.
 */

import type { Pool } from "pg";
import type { IAction, ToolResult, ActionPayload } from "./interface.js";
import type { TriggerCondition, TriggerAction } from "../triggers/interface.js";
import { PgMemory } from "../memory/pg.js";

export function createManageGoalAction(pool: Pool): IAction {
    return {
        name: "manage_goal",
        description:
            "Create, complete goals, or create programmatic price triggers. " +
            "Goals persist across cycles and are shown in 'Active Goals'. " +
            "IMPORTANT: For price monitoring tasks, use operation='create_trigger' instead of 'create'. " +
            "Triggers are checked every 3 seconds programmatically (no LLM cost). " +
            "You will be woken up ONLY when the condition is met.",
        readonly: true,

        parameters: {
            type: "object",
            properties: {
                operation: {
                    type: "string",
                    description: "'create' for text goal, 'complete' to finish, 'create_trigger' for programmatic price monitoring.",
                    enum: ["create", "complete", "create_trigger"],
                },
                goalId: {
                    type: "string",
                    description: "Unique goal ID (snake_case, e.g. 'monitor_bnb_price').",
                },
                description: {
                    type: "string",
                    description: "Goal description (for 'create' only).",
                },
                triggerType: {
                    type: "string",
                    description: "Trigger condition type (for 'create_trigger').",
                    enum: ["price_below", "price_above", "price_change_pct"],
                },
                token: {
                    type: "string",
                    description: "Token contract address to monitor (for 'create_trigger').",
                },
                threshold: {
                    type: "number",
                    description: "USD price threshold (for price_below/price_above).",
                },
                changePercent: {
                    type: "number",
                    description: "Percentage change to trigger on (for price_change_pct).",
                },
                direction: {
                    type: "string",
                    description: "Direction for pct change: 'up' or 'down'.",
                    enum: ["up", "down"],
                },
                basePrice: {
                    type: "number",
                    description: "Reference price for pct change (current price when creating trigger).",
                },
                actionType: {
                    type: "string",
                    description: "What to do when trigger fires.",
                    enum: ["swap", "notify"],
                },
                actionMessage: {
                    type: "string",
                    description: "User-facing message when trigger fires.",
                },
            },
            required: ["operation", "goalId"],
        },

        async execute(params: Record<string, unknown>): Promise<ToolResult> {
            const operation = params.operation as string;
            const goalId = params.goalId as string;
            const tokenId = params.__tokenId as bigint | undefined;

            if (!tokenId) {
                return { success: false, data: { error: "Missing tokenId context" } };
            }

            const memory = new PgMemory(tokenId, pool);

            try {
                if (operation === "create") {
                    const description = params.description as string;
                    if (!description) {
                        return { success: false, data: { error: "Missing 'description' for create" } };
                    }
                    await memory.storeGoal(goalId, description);
                    return { success: true, data: { message: `Goal '${goalId}' created: ${description}` } };

                } else if (operation === "create_trigger") {
                    const triggerType = params.triggerType as string;
                    const token = params.token as string;
                    if (!triggerType || !token) {
                        return { success: false, data: { error: "Missing 'triggerType' or 'token' for create_trigger" } };
                    }

                    const condition: TriggerCondition = {
                        type: triggerType as TriggerCondition["type"],
                        token,
                        threshold: params.threshold as number | undefined,
                        changePercent: params.changePercent as number | undefined,
                        direction: params.direction as "up" | "down" | undefined,
                    };

                    const action: TriggerAction = {
                        type: (params.actionType as "swap" | "notify") ?? "swap",
                        message: (params.actionMessage as string) ?? `Trigger ${triggerType} fired for ${token}`,
                    };

                    await memory.storeTrigger({
                        goalId,
                        condition,
                        action,
                        tokenId,
                        createdAt: new Date(),
                        basePrice: params.basePrice as number | undefined,
                    });

                    // Also create a regular goal so it shows in Active Goals
                    const desc =
                        `⚡ Trigger: ${triggerType} on ${token.slice(0, 10)}... ` +
                        (condition.threshold != null ? `threshold=$${condition.threshold}` : "") +
                        (condition.changePercent != null ? `change=${condition.changePercent}%` : "") +
                        ` → ${action.type}`;
                    await memory.storeGoal(goalId, desc);

                    return {
                        success: true,
                        data: {
                            message: `Trigger '${goalId}' created: ${triggerType} on ${token}`,
                            triggerType,
                            token,
                            threshold: condition.threshold,
                            note: "System will check every 3s programmatically. You will be woken when condition is met.",
                        },
                    };

                } else if (operation === "complete") {
                    await memory.completeGoal(goalId);
                    if (memory.completeTrigger) {
                        await memory.completeTrigger(goalId, "Completed by LLM");
                    }
                    return { success: true, data: { message: `Goal '${goalId}' completed` } };

                } else {
                    return { success: false, data: { error: `Unknown operation: ${operation}` } };
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
