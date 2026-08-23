/**
 * src/store.ts — pure goal + todo state machine.
 *
 * A plan is a single goal with a checklist, optionally grouped into phases.
 * Each item has one status: pending, in_progress, done, dropped, or blocked.
 * At most one item is in_progress at a time; completing/starting promotes the
 * next earliest still-open item (phase order) to in_progress, mirroring the
 * todo tool of other coding agents.
 *
 * Everything here is pure and unit-testable — no pi imports, no filesystem.
 */

export type TaskStatus = "pending" | "in_progress" | "done" | "dropped" | "blocked";

/** Statuses that count as "still open" (need work or a decision). */
export const OPEN_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "blocked"];

export interface TaskItem {
	/** Verbatim task text — what, not how. */
	text: string;
	status: TaskStatus;
	/** Blocked reason or any short note. */
	note?: string;
}

export interface PlanPhase {
	name: string;
	items: TaskItem[];
}

export interface Plan {
	/** The goal statement driving the checklist. */
	goal: string;
	phases: PlanPhase[];
	createdAt: number;
	updatedAt: number;
	/** Project key (cwd) this plan belongs to. */
	project: string;
}

export interface InitInput {
	goal: string;
	project: string;
	/** Flat checklist (goes into a single phase). */
	todos?: string[];
	/** Phase-grouped checklist (wins over `todos` when present). */
	phases?: { name: string; items: string[] }[];
	now?: number;
}

export function openCount(plan: Plan): number {
	let n = 0;
	for (const phase of plan.phases) {
		for (const item of phase.items) {
			if (OPEN_STATUSES.includes(item.status)) n++;
		}
	}
	return n;
}

export function nextOpenItem(plan: Plan): { phase: string; item: TaskItem } | null {
	return pickByStatus(plan, "in_progress") ?? pickByStatus(plan, "pending") ?? pickByStatus(plan, "blocked");
}
/** First item with the given status, scanning phases in order. */
function pickByStatus(plan: Plan, status: TaskStatus): { phase: string; item: TaskItem } | null {
	for (const phase of plan.phases) {
		for (const item of phase.items) {
			if (item.status === status) return { phase: phase.name, item };
		}
	}
	return null;
}


function touch(plan: Plan, now: number): void {
	plan.updatedAt = now;
}

/**
 * First duplicate text in a list of task texts, or null. Item identity is the
 * verbatim text, so duplicates would make ops ambiguous — reject up front.
 */
export function findDuplicateText(texts: string[]): string | null {
	const seen = new Set<string>();
	for (const t of texts) {
		if (seen.has(t)) return t;
		seen.add(t);
	}
	return null;
}

/** Create a new plan from an init request. */
export function initPlan(input: InitInput): Plan {
	const now = input.now ?? Date.now();
	const flat = input.phases && input.phases.length > 0 ? input.phases.flatMap((p) => p.items) : (input.todos ?? []);
	const dup = findDuplicateText(flat);
	if (dup) throw new Error(`duplicate task text "${dup}" — item text must be unique; reword one of them`);
	const phases: PlanPhase[] =
		input.phases && input.phases.length > 0
			? input.phases.map((p) => ({ name: p.name, items: p.items.map((t) => ({ text: t, status: "pending" as TaskStatus })) }))
			: [
					{
						name: "Tasks",
						items: (input.todos ?? []).map((t) => ({ text: t, status: "pending" as TaskStatus })),
					},
				];
	// Promote the first item so there is always a clear "current" task.
	if (phases.length > 0 && phases[0]!.items.length > 0) {
		phases[0]!.items[0]!.status = "in_progress";
	}
	return { goal: input.goal, phases, createdAt: now, updatedAt: now, project: input.project };
}


/**
 * Auto-promote the earliest still-open item (phase order) to in_progress.
 * Demotes any other in_progress first so at most one item is ever active —
 * even if a hand-edited plan file or future bug left two behind.
 */
function promoteNext(plan: Plan, now: number): void {
	let demoted = false;
	for (const phase of plan.phases) {
		for (const item of phase.items) {
			if (item.status === "in_progress") {
				item.status = "pending";
				demoted = true;
			}
		}
	}
	for (const phase of plan.phases) {
		for (const item of phase.items) {
			if (item.status === "pending") {
				item.status = "in_progress";
				touch(plan, now);
				return;
			}
		}
	}
	if (demoted) touch(plan, now);
}


/** Find an item by exact text (the task id is its text). */
export function findItem(plan: Plan, text: string): { phase: PlanPhase; item: TaskItem } | null {
	for (const phase of plan.phases) {
		for (const item of phase.items) {
			if (item.text === text) return { phase, item };
		}
	}
	return null;
}

export type OpError = { ok: false; error: string };
export type OpOk<T = { ok: true }> = { ok: true } & T;

export function markStarted(plan: Plan, text: string, now: number): OpOk | OpError {
	const hit = findItem(plan, text);
	if (!hit) return { ok: false, error: `no task "${text}"` };
	if (hit.item.status === "done" || hit.item.status === "dropped") {
		return { ok: false, error: `task "${text}" is already ${hit.item.status}` };
	}
	// Clear any other in_progress, then start this one.
	for (const phase of plan.phases) {
		for (const item of phase.items) {
			if (item.status === "in_progress") item.status = "pending";
		}
	}
	hit.item.status = "in_progress";
	touch(plan, now);
	return { ok: true };
}

export function markDone(plan: Plan, text: string, now: number): OpOk | OpError {
	const hit = findItem(plan, text);
	if (!hit) return { ok: false, error: `no task "${text}"` };
	if (hit.item.status === "dropped") return { ok: false, error: `task "${text}" was dropped` };
	if (hit.item.status === "blocked") {
		return { ok: false, error: `task "${text}" is blocked (${hit.item.note ?? "no reason"}) — unblock it first` };
	}
	hit.item.status = "done";
	hit.item.note = undefined;
	touch(plan, now);
	promoteNext(plan, now);
	return { ok: true };
}

export function markDropped(plan: Plan, text: string, now: number): OpOk | OpError {
	const hit = findItem(plan, text);
	if (!hit) return { ok: false, error: `no task "${text}"` };
	if (hit.item.status === "done") return { ok: false, error: `task "${text}" is already done` };
	hit.item.status = "dropped";
	touch(plan, now);
	promoteNext(plan, now);
	return { ok: true };
}

export function markBlocked(plan: Plan, text: string, reason: string, now: number): OpOk | OpError {
	const hit = findItem(plan, text);
	if (!hit) return { ok: false, error: `no task "${text}"` };
	hit.item.status = "blocked";
	hit.item.note = reason || hit.item.note;
	touch(plan, now);
	promoteNext(plan, now);
	return { ok: true };
}

export function unblock(plan: Plan, text: string, now: number): OpOk | OpError {
	const hit = findItem(plan, text);
	if (!hit) return { ok: false, error: `no task "${text}"` };
	if (hit.item.status !== "blocked") return { ok: false, error: `task "${text}" is not blocked` };
	hit.item.status = "pending";
	hit.item.note = undefined;
	touch(plan, now);
	promoteNext(plan, now);
	return { ok: true };
}

export function appendTasks(plan: Plan, todos: string[], phaseName: string | undefined, now: number): OpOk<{ added: number }> | OpError {
	if (todos.length === 0) return { ok: true, added: 0 };
	const existing = new Set<string>();
	for (const phase of plan.phases) for (const item of phase.items) existing.add(item.text);
	for (const t of todos) {
		if (existing.has(t)) return { ok: false, error: `duplicate task text "${t}" — already in the plan` };
		existing.add(t);
	}
	let phase = phaseName ? plan.phases.find((p) => p.name === phaseName) : undefined;
	if (phaseName && !phase) {
		phase = { name: phaseName, items: [] };
		plan.phases.push(phase);
	}
	if (!phase) phase = plan.phases[0] ?? { name: "Tasks", items: [] };
	if (plan.phases.length === 0) plan.phases.push(phase);
	for (const t of todos) phase.items.push({ text: t, status: "pending" as TaskStatus });
	touch(plan, now);
	promoteNext(plan, now);
	return { ok: true, added: todos.length };
}

const STATUS_MARK: Record<TaskStatus, string> = {
	pending: "[ ]",
	in_progress: "[~]",
	done: "[x]",
	dropped: "[-]",
	blocked: "[!]",
};

/** Render the plan as a compact text block for tool results / nudges. */
export function renderPlan(plan: Plan): string {
	const lines: string[] = [`Goal: ${plan.goal}`];
	for (const phase of plan.phases) {
		if (phase.items.length === 0) continue;
		lines.push("");
		lines.push(`## ${phase.name}`);
		for (const item of phase.items) {
			const mark = STATUS_MARK[item.status];
			const note = item.note ? ` — ${item.note}` : "";
			lines.push(`${mark} ${item.text}${note}`);
		}
	}
	const open = openCount(plan);
	lines.push("", `${open} open · ${plan.phases.reduce((n, p) => n + p.items.length, 0)} total`);
	return lines.join("\n");
}
