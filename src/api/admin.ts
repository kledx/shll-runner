/**
 * Admin Blueprint API — Manage agent blueprints for no-code composition.
 *
 * Routes:
 *   GET    /v3/admin/blueprints           — List all blueprints
 *   GET    /v3/admin/blueprints/:type     — Get blueprint by agent type
 *   PUT    /v3/admin/blueprints/:type     — Create or update blueprint
 *   DELETE /v3/admin/blueprints/:type     — Delete blueprint
 *
 * These are admin-only endpoints. Authentication should be enforced
 * by the caller (API key check) before calling these handlers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { writeJson, parseBody } from "../http.js";
import { blueprintStore } from "../agent/blueprintStore.js";
import { listRegisteredActions, listRegisteredBrains, listRegisteredPerceptions } from "../agent/factory.js";

export interface AdminRouteContext {
    pool: Pool;
}

/**
 * Handle admin blueprint API requests.
 * @returns true if the route was handled, false otherwise
 */
export async function handleAdminRoutes(
    method: string,
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
    ctx: AdminRouteContext,
): Promise<boolean> {
    // ── List all blueprints ────────────────
    if (method === "GET" && pathname === "/v3/admin/blueprints") {
        const result = await ctx.pool.query(
            `SELECT agent_type, brain_type, actions, perception, llm_config, created_by, created_at
             FROM agent_blueprints
             ORDER BY created_at ASC`,
        );
        const items = result.rows.map(mapBlueprintRow);
        writeJson(res, 200, { ok: true, count: items.length, items });
        return true;
    }

    // Match /v3/admin/blueprints/:type
    const match = pathname.match(/^\/v3\/admin\/blueprints\/([a-zA-Z0-9_-]+)$/);
    if (!match) return false;

    const agentType = match[1];

    // ── Get single blueprint ───────────────
    if (method === "GET") {
        const result = await ctx.pool.query(
            `SELECT * FROM agent_blueprints WHERE agent_type = $1`,
            [agentType],
        );
        if (result.rows.length === 0) {
            writeJson(res, 404, { error: `Blueprint not found: ${agentType}` });
            return true;
        }
        writeJson(res, 200, { ok: true, blueprint: mapBlueprintRow(result.rows[0]) });
        return true;
    }

    // ── Create or update blueprint ─────────
    if (method === "PUT") {
        const body = await parseBody(req) as Record<string, unknown>;

        const brainType = body.brainType as string;
        const actions = body.actions as string[];
        const perception = (body.perception as string) ?? "defi";
        const llmConfig = body.llmConfig ?? null;
        const createdBy = (body.createdBy as string) ?? null;

        if (!brainType || !actions || !Array.isArray(actions)) {
            writeJson(res, 400, { error: "brainType (string) and actions (string[]) are required" });
            return true;
        }

        // Phase 4: Validate that referenced modules exist
        const registeredBrains = listRegisteredBrains();
        if (!registeredBrains.includes(brainType)) {
            writeJson(res, 400, {
                error: `Brain module not registered: ${brainType}`,
                registered: registeredBrains,
            });
            return true;
        }

        const registeredPerceptions = listRegisteredPerceptions();
        if (!registeredPerceptions.includes(perception)) {
            writeJson(res, 400, {
                error: `Perception module not registered: ${perception}`,
                registered: registeredPerceptions,
            });
            return true;
        }

        const registeredActions = listRegisteredActions();
        const actionNames = actions.map((a: unknown) => typeof a === "string" ? a : (a as { name: string }).name);
        const unknown = actionNames.filter((n: string) => !registeredActions.includes(n));
        if (unknown.length > 0) {
            writeJson(res, 400, {
                error: `Action modules not registered: ${unknown.join(", ")}`,
                registered: registeredActions,
            });
            return true;
        }

        await ctx.pool.query(
            `INSERT INTO agent_blueprints (agent_type, brain_type, actions, perception, llm_config, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (agent_type) DO UPDATE SET
                brain_type = EXCLUDED.brain_type,
                actions = EXCLUDED.actions,
                perception = EXCLUDED.perception,
                llm_config = EXCLUDED.llm_config`,
            [
                agentType,
                brainType,
                JSON.stringify(actions),
                perception,
                llmConfig ? JSON.stringify(llmConfig) : null,
                createdBy,
            ],
        );

        const result = await ctx.pool.query(
            `SELECT * FROM agent_blueprints WHERE agent_type = $1`,
            [agentType],
        );
        writeJson(res, 200, { ok: true, blueprint: mapBlueprintRow(result.rows[0]) });
        // Hot-reload blueprint cache
        void blueprintStore.reload();
        return true;
    }

    // ── Delete blueprint ───────────────────
    if (method === "DELETE") {
        const result = await ctx.pool.query(
            `DELETE FROM agent_blueprints WHERE agent_type = $1`,
            [agentType],
        );
        if ((result.rowCount ?? 0) === 0) {
            writeJson(res, 404, { error: `Blueprint not found: ${agentType}` });
            return true;
        }
        writeJson(res, 200, { ok: true, deleted: agentType });
        // Hot-reload blueprint cache
        void blueprintStore.reload();
        return true;
    }

    return false;
}

// ── Row mapper ────────────────────────────

interface BlueprintRecord {
    agentType: string;
    brainType: string;
    actions: string[];
    perception: string;
    llmConfig: Record<string, unknown> | null;
    createdBy: string | null;
    createdAt: string;
}

function mapBlueprintRow(row: Record<string, unknown>): BlueprintRecord {
    return {
        agentType: String(row.agent_type),
        brainType: String(row.brain_type),
        actions: (row.actions ?? []) as string[],
        perception: String(row.perception ?? "defi"),
        llmConfig: (row.llm_config ?? null) as Record<string, unknown> | null,
        createdBy: row.created_by ? String(row.created_by) : null,
        createdAt: String(row.created_at),
    };
}
