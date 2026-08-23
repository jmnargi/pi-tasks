/**
 * src/ui.ts — pure TUI formatting helpers for pi-tasks.
 *
 * No pi imports — everything here takes an injected theme-like object and
 * plain data, so it is unit-testable without a terminal (same split as
 * pi-envoy's ui.ts / dashboard.ts).
 */

/** Subset of pi's Theme used here. */
export interface ThemeLike {
	fg(color: string, ...text: string[]): string;
	bold(text: string): string;
}

import { nextOpenItem, openCount, type Plan, type TaskItem } from "./store.ts";

export interface PlanStats {
	open: number;
	total: number;
	done: number;
	current: string;
	phase: string;
}

/** One-line summary of plan progress, e.g. "2/5 · ▸ update docs". */
export function planStats(plan: Plan): PlanStats {
	const total = plan.phases.reduce((n, p) => n + p.items.length, 0);
	const done = plan.phases.reduce((n, p) => n + p.items.filter((i) => i.status === "done").length, 0);
	const next = nextOpenItem(plan);
	return { open: openCount(plan), total, done, current: next?.item.text ?? "", phase: next?.phase ?? "" };
}

/** "Ship the API — 2/5 · ▸ update docs" for footer status lines. */
export function statusLine(plan: Plan): string {
	const s = planStats(plan);
	const parts = [`${s.done}/${s.total}`];
	if (s.current) parts.push(`▸ ${s.current}`);
	return `${plan.goal} — ${parts.join(" · ")}`;
}

/** Theme token for a task status (subset of pi's ThemeColor). */
export function statusToken(status: TaskItem["status"]): "success" | "error" | "warning" | "accent" | "dim" {
	switch (status) {
		case "done":
			return "success";
		case "blocked":
			return "warning";
		case "in_progress":
			return "accent";
		case "dropped":
			return "dim";
		default:
			return "dim";
	}
}

const GLYPH: Record<TaskItem["status"], string> = {
	pending: "○",
	in_progress: "▸",
	done: "✓",
	dropped: "·",
	blocked: "!",
};

/** Themed single line for one item: "✓ write tests" / "! api — waiting on key". */
export function itemLine(item: TaskItem, theme: ThemeLike): string {
	const glyph = theme.fg(statusToken(item.status), GLYPH[item.status]);
	const label = item.status === "in_progress" ? theme.fg("accent", theme.bold(item.text)) : item.text;
	const note = item.note ? theme.fg("dim", ` — ${item.note}`) : "";
	return `${glyph} ${label}${note}`;
}

/** Progress bar: 3/5 → "█████░░░░░" style, always `width` cells. */
export function progressBar(done: number, total: number, width = 12): string {
	if (total === 0) return "".padEnd(width, "░");
	const filled = Math.round((done / total) * width);
	return "█".repeat(Math.min(filled, width)) + "░".repeat(Math.max(0, width - Math.min(filled, width)));
}

/**
 * Full themed plan rendering, shared by the widget, the /tasks command and the
 * expanded tool-result view. Plain-text variant lives in store.renderPlan.
 */
export function renderPlanThemed(plan: Plan, theme: ThemeLike): string[] {
	const s = planStats(plan);
	const out: string[] = [
		theme.fg("accent", theme.bold(`◈ ${plan.goal}`)),
		theme.fg(
			"muted",
			`${progressBar(s.done, s.total)} ${s.done}/${s.total} · ${s.open} open`,
		),
	];
	for (const phase of plan.phases) {
		if (phase.items.length === 0) continue;
		out.push("");
		out.push(theme.fg("dim", theme.bold(phase.name.toUpperCase())));
		for (const item of phase.items) out.push(itemLine(item, theme));
	}
	return out;
}
