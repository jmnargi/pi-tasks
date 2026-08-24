/**
 * src/nudge.ts — pure nudge decisioning + message shaping + prompt appendix.
 *
 * When the agent settles (stops) with open tasks, the extension sends a
 * turn-triggering user message so even a weak model cannot miss that work
 * is outstanding. Three gates prevent a nudge→turn→settle→nudge loop from
 * burning tokens:
 *   - "agent acted since last nudge" (a nudge turn does not re-arm itself),
 *   - a cooldown between nudges,
 *   - an exhaustion cap: after MAX_CONSECUTIVE_NUDGES nudges without the open
 *     count dropping below its low-water mark, we stop nudging and escalate to
 *     the user instead (status warning + one notify).
 *
 * The prompt appendix is a short system-prompt block appended (via
 * before_agent_start) only while tasks are open, so the model is
 * continuously reminded to keep the list updated.
 */

import { nextOpenItem, openCount, renderTaskList, type TaskList } from "./store.ts";

/** The pi customType used for nudge messages (matches the renderer). */
export const NUDGE_CUSTOM_TYPE = "tasks-nudge";

/**
 * Consecutive nudges (without real progress) before giving up and leaving the
 * work to the user. Mirrors pi's own session_stop continuation cap in spirit.
 */
export const MAX_CONSECUTIVE_NUDGES = 5;

/** What should happen when the agent settles with open tasks. */
export type NudgeDecision =
	| { action: "nudge"; text: string }
	| { action: "escalate"; open: number }
	| { action: "none" };

/**
 * Short block appended to the system prompt while tasks are open. Kept
 * small (a few lines) so the per-turn token cost stays negligible.
 */
export function buildPlanAppendix(list: TaskList): string {
	const open = openCount(list);
	const next = nextOpenItem(list);
	const lines = [
		"[tasks] You have an active todo list for this session.",
		`[tasks] ${open} task${open === 1 ? "" : "s"} still open.`,
	];
	if (next) lines.push(`[tasks] Current: "${next.item.text}" (${next.phase})`);
	lines.push(
		"[tasks] Keep it updated as you work: tasks op=done / start / drop / block / append. Call tasks op=view to see the full list. You will be nudged if you stop with open items.",
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
export function recordProgress(state: NudgeState, list: TaskList | null): void {
	if (!list) {
		state.consecutive = 0;
		state.lowWater = Number.POSITIVE_INFINITY;
		return;
	}
	const open = openCount(list);
	if (open < state.lowWater) {
		state.lowWater = open;
		state.consecutive = 0;
	}
}

/** Reset all nudge state (e.g. after the list is cleared). */
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
export function evaluateNudge(state: NudgeState, list: TaskList | null, now: number): NudgeDecision {
	if (!list) return { action: "none" };
	const open = openCount(list);
	if (open === 0) return { action: "none" };
	if (state.consecutive >= MAX_CONSECUTIVE_NUDGES) {
		return state.consecutive === MAX_CONSECUTIVE_NUDGES ? { action: "escalate", open } : { action: "none" };
	}
	if (!state.agentActedSinceNudge) return { action: "none" };
	// Never nudged yet → nudge regardless of cooldown.
	if (state.lastNudgeAt !== 0 && now - state.lastNudgeAt < state.cooldownMs) return { action: "none" };
	return { action: "nudge", text: formatNudgeText(list) };
}

/**
 * Back-compat boolean form of evaluateNudge for callers that only need the
 * nudge/no-nudge answer (escalation is handled by the caller).
 */
export function shouldNudge(state: NudgeState, list: TaskList | null, now: number): boolean {
	return evaluateNudge(state, list, now).action === "nudge";
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
 * Shape the reminder text. This becomes a USER message via sendUserMessage —
 * the strongest signal available: it enters the conversation exactly like the
 * human typing it, so even a weak model treats it as instruction, not noise.
 */
export function formatNudgeText(list: TaskList): string {
	const open = openCount(list);
	const next = nextOpenItem(list);
	return [
		`[tasks] You stopped your turn, but your todo list still has ${open} open task${open === 1 ? "" : "s"} — the work is NOT complete.`,
		next ? `Current task: "${next.item.text}" (${next.phase})` : "",
		"Keep working through the list now. Do not stop until every item is closed (tasks op=done/drop/block). Do not reply to this message — just continue the work.",
		"",
		renderTaskList(list),
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * Custom-renderer payload (for the tasks-nudge renderer used in contexts
 * that cannot take user messages).
 */
export function formatNudgeMessage(list: TaskList): {
	customType: string;
	content: string;
	display: boolean;
	details: { open: number; next: string };
} {
	const open = openCount(list);
	const next = nextOpenItem(list);
	return {
		customType: NUDGE_CUSTOM_TYPE,
		content: formatNudgeText(list),
		display: true,
		details: { open, next: next?.item.text ?? "" },
	};
}
