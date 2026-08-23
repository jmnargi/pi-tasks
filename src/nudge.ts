/**
 * src/nudge.ts — pure nudge decisioning + message shaping.
 *
 * When the agent settles (stops) with open tasks, the extension sends a
 * turn-triggering custom message so even a weak model cannot miss that work
 * is outstanding. A cooldown prevents a nudge→turn→settle→nudge loop from
 * burning tokens: we only nudge again after the agent has actually done a
 * turn since the last nudge.
 */

import { nextOpenItem, openCount, renderPlan, type Plan } from "./store.ts";

/** The pi customType used for nudge messages (matches the renderer). */
export const NUDGE_CUSTOM_TYPE = "tasks-nudge";

export interface NudgeState {
	lastNudgeAt: number;
	/** Set true after any real agent message since the last nudge. */
	agentActedSinceNudge: boolean;
	/** Minimum gap between nudges (ms). */
	cooldownMs: number;
}

export function newNudgeState(cooldownMs = 60_000): NudgeState {
	return { lastNudgeAt: 0, agentActedSinceNudge: true, cooldownMs };
}

/**
 * Should we nudge right now? Nudge when:
 *   - there are open tasks,
 *   - the agent has acted (or never been nudged) since the last nudge,
 *   - and the cooldown has elapsed.
 */
export function shouldNudge(state: NudgeState, plan: Plan | null, now: number): boolean {
	if (!plan) return false;
	if (openCount(plan) === 0) return false;
	if (!state.agentActedSinceNudge) return false;
	// Never nudged yet → nudge regardless of cooldown.
	if (state.lastNudgeAt === 0) return true;
	if (now - state.lastNudgeAt < state.cooldownMs) return false;
	return true;
}

/** Record that the agent produced a turn (resets the "needs agent action" gate). */
export function recordAgentActivity(state: NudgeState): void {
	state.agentActedSinceNudge = true;
}

/** Record that a nudge was sent. */
export function recordNudge(state: NudgeState, now: number): void {
	state.lastNudgeAt = now;
	state.agentActedSinceNudge = false;
}

/**
 * Shape the nudge message payload. The content tells the model exactly what
 * is open and what to do next; the renderer shows it as a distinct block.
 */
export function formatNudgeMessage(plan: Plan): {
	customType: string;
	content: string;
	display: boolean;
	details: { open: number; goal: string; next: string };
} {
	const open = openCount(plan);
	const next = nextOpenItem(plan);
	return {
		customType: NUDGE_CUSTOM_TYPE,
		content: [
			`You stopped with ${open} open task${open === 1 ? "" : "s"}.`,
			`Goal: ${plan.goal}`,
			next ? `Next: "${next.item.text}" (${next.phase})` : "",
			"Continue working or explicitly mark tasks done/dropped/blocked before stopping.",
			"",
			renderPlan(plan),
		]
			.filter(Boolean)
			.join("\n"),
		display: true,
		details: { open, goal: plan.goal, next: next?.item.text ?? "" },
	};
}
