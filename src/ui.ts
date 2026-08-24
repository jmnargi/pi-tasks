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

import { nextOpenItem, openCount, type TaskItem, type TaskList } from "./store.ts";

export interface ListStats {
	open: number;
	total: number;
	done: number;
	current: string;
	phase: string;
}

/** One-line summary of list progress. */
export function planStats(list: TaskList): ListStats {
	const total = list.phases.reduce((n, p) => n + p.items.length, 0);
	const done = list.phases.reduce((n, p) => n + p.items.filter((i) => i.status === "done").length, 0);
	const next = nextOpenItem(list);
	return { open: openCount(list), total, done, current: next?.item.text ?? "", phase: next?.phase ?? "" };
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
 * Full themed list rendering, shared by the widget, the /tasks command and the
 * expanded tool-result view. Plain-text variant lives in store.renderTaskList.
 */
export function renderPlanThemed(list: TaskList, theme: ThemeLike): string[] {
	const s = planStats(list);
	const out: string[] = [
		theme.fg(
			"muted",
			`${progressBar(s.done, s.total)} ${s.done}/${s.total} · ${s.open} open`,
		),
	];
	for (const phase of list.phases) {
		if (phase.items.length === 0) continue;
		out.push("");
		out.push(theme.fg("dim", theme.bold(phase.name.toUpperCase())));
		for (const item of phase.items) out.push(itemLine(item, theme));
	}
	return out;
}
