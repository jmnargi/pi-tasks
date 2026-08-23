/**
 * src/nudge.ts — pure nudge decisioning + message shaping + prompt appendix.
 *
 * When the agent settles (stops) with open tasks, the extension sends a
 * turn-triggering custom message so even a weak model cannot miss that work
 * is outstanding. Three gates prevent a nudge→turn→settle→nudge loop from
 * burning tokens:
 *   - "agent acted since last nudge" (a nudge turn does not re-arm itself),
 *   - a cooldown between nudges,
 *   - an exhaustion cap: after MAX_CONSECUTIVE_NUDGES nudges without the open
 *     count dropping below its low-water mark, we stop nudging and escalate to
 *     the user instead (status warning + one notify).
 *
 * The prompt appendix is a short system-prompt block appended (via
 * before_agent_start) only while a plan is active, so the model is
 * continuously reminded to keep the todo list updated.
 */

import { nextOpenItem, openCount, renderPlan, type Plan } from "./store.ts";

/** The pi customType used for nudge messages (matches the renderer). */
export const NUDGE_CUSTOM_TYPE = "tasks-nudge";

/**
 * Consecutive nudges (without real progress) before giving up and leaving the
 * work to the user. Mirrors pi's own session_stop continuation cap in spirit.
 */
export const MAX_CONSECUTIVE_NUDGES = 5;

/** What should happen when the agent settles with open tasks. */
export type NudgeDecision =
	| { action: "nudge"; message: ReturnType<typeof formatNudgeMessage> }
	| { action: "escalate"; open: number; goal: string }
	| { action: "none" };

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
	/** Nudges sent since the open count last dropped (consecutive-no-progress counter). */
	consecutive: number;
	/** Lowest open count seen; progress = dropping strictly below this. */
	lowWater: number;
}

export function newNudgeState(cooldownMs = 60_000): NudgeState {
	return { lastNudgeAt: 0, agentActedSinceNudge: true, cooldownMs, consecutive: 0, lowWater: Number.POSITIVE_INFINITY };
}

/**
 * Track progress across settles. Called on every agent_settled (before the
 * decision): when the open count drops below the low-water mark, real progress
 * happened — reset the consecutive-nudge counter and re-arm.
 */
export function recordProgress(state: NudgeState, plan: Plan | null): void {
	if (!plan) {
		state.consecutive = 0;
		state.lowWater = Number.POSITIVE_INFINITY;
		return;
	}
	const open = openCount(plan);
	if (open < state.lowWater) {
		state.lowWater = open;
		state.consecutive = 0;
	}
}

/** Reset all nudge state (e.g. after a plan is cleared). */
export function resetNudgeState(state: NudgeState): void {
	state.lastNudgeAt = 0;
	state.agentActedSinceNudge = true;
	state.consecutive = 0;
	state.lowWater = Number.POSITIVE_INFINITY;
}

/**
 * Decide what to do when the agent settles. Nudge when:
 *   - there are open tasks,
 *   - the agent has acted (or never been nudged) since the last nudge,
 *   - the cooldown has elapsed,
 *   - and we have not exhausted MAX_CONSECUTIVE_NUDGES without progress.
 * When exhausted: escalate to the user (once — `none` on every settle after).
 */
export function evaluateNudge(state: NudgeState, plan: Plan | null, now: number): NudgeDecision {
	if (!plan) return { action: "none" };
	const open = openCount(plan);
	if (open === 0) return { action: "none" };
	if (state.consecutive >= MAX_CONSECUTIVE_NUDGES) {
		return state.consecutive === MAX_CONSECUTIVE_NUDGES ? { action: "escalate", open, goal: plan.goal } : { action: "none" };
	}
	if (!state.agentActedSinceNudge) return { action: "none" };
	// Never nudged yet → nudge regardless of cooldown.
	if (state.lastNudgeAt !== 0 && now - state.lastNudgeAt < state.cooldownMs) return { action: "none" };
	return { action: "nudge", message: formatNudgeMessage(plan) };
}

/**
 * Back-compat boolean form of evaluateNudge for callers that only need the
 * nudge/no-nudge answer (escalation is handled by the caller).
 */
export function shouldNudge(state: NudgeState, plan: Plan | null, now: number): boolean {
	return evaluateNudge(state, plan, now).action === "nudge";
}

/** Record that the agent produced a turn (resets the "needs agent action" gate). */
export function recordAgentActivity(state: NudgeState): void {
	state.agentActedSinceNudge = true;
}

/** Record that a nudge was sent. */
export function recordNudge(state: NudgeState, now: number): void {
	state.lastNudgeAt = now;
	state.agentActedSinceNudge = false;
	state.consecutive++;
}

/** Record that escalation happened (stops further nudges until progress). */
export function recordEscalation(state: NudgeState): void {
	state.consecutive = MAX_CONSECUTIVE_NUDGES + 1;
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
