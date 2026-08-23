/**
 * src/nudge.ts — pure nudge decisioning + message shaping + prompt appendix.
 *
 * When the agent settles (stops) with open tasks, the extension sends a
 * turn-triggering custom message so even a weak model cannot miss that work
 * is outstanding. A cooldown prevents a nudge→turn→settle→nudge loop from
 * burning tokens: we only nudge again after the agent has actually done a
 * turn since the last nudge.
 *
 * The prompt appendix is a short system-prompt block appended (via
 * before_agent_start) only while a plan is active, so the model is
 * continuously reminded to keep the todo list updated.
 */

import { nextOpenItem, openCount, renderPlan, type Plan } from "./store.ts";

/** The pi customType used for nudge messages (matches the renderer). */
export const NUDGE_CUSTOM_TYPE = "tasks-nudge";

/**
 * Short block appended to the system prompt while a plan is active. Kept
 * small (a few lines) so the per-turn token cost stays negligible.
 */
export function buildPlanAppendix(plan: Plan): string {
	const open = openCount(plan);
	const next = nextOpenItem(plan);
	const lines = [
		"[tasks] You have an active goal + todo plan for this project.",
		`[tasks] Goal: ${plan.goal} (${open} open item${open === 1 ? "" : "s"})`,
	];
	if (next) lines.push(`[tasks] Current: "${next.item.text}" (${next.phase})`);
	lines.push(
		"[tasks] Keep it updated as you work: tasks op=done / start / drop / block / append. Call tasks op=view to see the full plan. You will be nudged if you stop with open items.",
	);
	return lines.join("\n");
}

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
