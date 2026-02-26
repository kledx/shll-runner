/**
 * Trigger Engine — Type definitions for programmatic condition monitoring.
 *
 * Triggers are created by LLM (via manage_goal), evaluated by the scheduler
 * at high frequency (every 3-5s) WITHOUT calling the LLM. When a condition
 * is met, the scheduler wakes the LLM to execute the action.
 */

// ═══════════════════════════════════════════════════════
//                    Trigger Types
// ═══════════════════════════════════════════════════════

/**
 * Extensible trigger type union.
 * To add a new trigger: (1) add type here, (2) add evaluator case.
 */
export type TriggerType =
    | "price_below"       // buy when price drops below threshold
    | "price_above"       // sell when price rises above threshold
    | "price_change_pct"  // act when price changes by N% from base
    | "time_interval";    // DCA: trigger every N ms

/** Condition that the evaluator checks programmatically */
export interface TriggerCondition {
    type: TriggerType;
    /** Token contract address to monitor */
    token: string;
    /** USD price threshold (for price_below / price_above) */
    threshold?: number;
    /** Percentage change to trigger (for price_change_pct) */
    changePercent?: number;
    /** Direction for pct change: "up" = price increased, "down" = price decreased */
    direction?: "up" | "down";
    /** Interval in ms (for time_interval) */
    intervalMs?: number;
}

/** Action to take when trigger fires */
export interface TriggerAction {
    /** "swap" = wake LLM to execute trade, "notify" = message only */
    type: "swap" | "notify";
    /** Pre-configured swap parameters (optional, LLM may override) */
    params?: Record<string, unknown>;
    /** User-facing message when trigger fires */
    message: string;
}

/** A structured, machine-evaluable goal */
export interface TriggerGoal {
    goalId: string;
    condition: TriggerCondition;
    action: TriggerAction;
    /** Agent token ID that owns this trigger */
    tokenId: bigint;
    createdAt: Date;
    /** Reference price when trigger was created (for pct change) */
    basePrice?: number;
    /** Last time this trigger was evaluated */
    lastCheckedAt?: Date;
    /** Last time a time_interval trigger fired */
    lastTriggeredAt?: Date;
}

/** Result from evaluator when a trigger fires */
export interface TriggerFired {
    trigger: TriggerGoal;
    currentPrice: number;
    firedAt: Date;
}
