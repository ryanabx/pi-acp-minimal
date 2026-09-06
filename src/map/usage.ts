import type { UsageUpdate } from "@agentclientprotocol/sdk";
import type { PiSessionStats } from "../pi/rpc-types.js";

/**
 * pi session stats -> ACP usage update.
 *
 * ACP reports context occupancy (`used` of `size`), which is pi's `contextUsage`
 * rather than its cumulative token totals: the latter counts every token the
 * session ever spent, including history that compaction has since dropped.
 *
 * Returns `null` when pi has nothing meaningful to report — no model, no context
 * window, or the window immediately after compaction, where pi sets `tokens` to
 * null until a fresh assistant response supplies real usage.
 */
export function toAcpUsageUpdate(stats: PiSessionStats): UsageUpdate | null {
	const context = stats.contextUsage;
	if (!context || typeof context.tokens !== "number" || !context.contextWindow) return null;

	const update: UsageUpdate = { used: context.tokens, size: context.contextWindow };
	// pi's model catalog prices everything in USD.
	if (typeof stats.cost === "number") update.cost = { amount: stats.cost, currency: "USD" };
	return update;
}
