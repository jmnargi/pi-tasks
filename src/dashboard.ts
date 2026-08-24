/**
 * src/dashboard.ts — fullscreen tasks panel for the pi TUI (/tasks command).
 *
 * Same pattern as pi-envoy's dashboard: a Component handed to ctx.ui.custom()
 * that owns keyboard focus until esc. Pure rendering lives in ui.ts; this file
 * wires it to the TUI with selection and inline actions.
 *
 * FLICKER NOTE: render() must never touch the filesystem or recompute
 * anything expensive — pi calls it on every streaming delta (up to ~60fps)
 * and its differential renderer repaints whatever changed. The list is read
 * once at construction and cached; mutations update the cache in place and
 * persist to disk from the input handler (never inside render()).
 *
 * Keys:
 *   ↑/↓   move selection
 *   enter start the selected item (marks it in_progress)
 *   x     mark done
 *   b     block the selected item (type a reason, enter confirms)
 *   r     reload from disk
 *   esc/q close
 */

import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import { loadPlan, savePlan } from "./persistence.ts";
import { markBlocked, markDone, markStarted, type TaskList } from "./store.ts";
import { planStats, progressBar, itemLine, statusToken, type ThemeLike } from "./ui.ts";

export interface DashboardDeps {
	/** Data dir for load/save. */
	dataDir: string;
	/** Storage key of the list shown (session-scoped). */
	planKey: string;
}

/** One selectable row: an item identified by phase + verbatim text. */
interface Row {
	phase: string;
	text: string;
	status: string;
}

function rowsOf(list: TaskList): Row[] {
	const rows: Row[] = [];
	for (const phase of list.phases) {
		for (const item of phase.items) rows.push({ phase: phase.name, text: item.text, status: item.status });
	}
	return rows;
}

export function makeDashboardComponent(
	deps: DashboardDeps,
	tui: TUI,
	theme: ThemeLike,
	done: () => void,
): Component & { dispose(): void } {
	// Cached state — render() only reads these.
	let list: TaskList | null = loadPlan(deps.dataDir, deps.planKey);
	let selected = 0;
	let notice = "";
	let inputMode: null | { buffer: string } = null;

	const refresh = (): void => {
		try {
			tui.requestRender();
		} catch {
			// overlay may already be gone — ignore
		}
	};

	const clampSelected = (): void => {
		const n = list ? rowsOf(list).length : 0;
		if (selected >= n) selected = Math.max(0, n - 1);
	};

	const selectedRow = (): Row | null => {
		if (!list) return null;
		return rowsOf(list)[selected] ?? null;
	};

	const mutate = (fn:  (p: TaskList) => { ok: true } | { ok: false; error: string }): void => {
		if (!list) return;
		const r = fn(list);
		if (r.ok) {
			try {
				savePlan(deps.dataDir, list);
				notice = "";
			} catch {
				notice = "failed to save list";
			}
			clampSelected();
		} else {
			notice = r.error;
		}
		refresh();
	};

	/** Pure rendering from cached state — no IO, no recomputation of data. */
	const contentLines = (width: number): string[] => {
		if (inputMode !== null) {
			return [
				truncateToWidth(
					`${theme.fg("warning", "block reason")} ${theme.fg("dim", "type reason · enter confirm · esc cancel")}: ${inputMode.buffer}`,
					width,
				),
			];
		}
		if (!list) {
			return [
				truncateToWidth(`${theme.fg("accent", theme.bold("tasks"))} ${theme.fg("dim", "no tasks for this session")}`, width),
				"",
				theme.fg("dim", "ask the model to create one: tasks op=init …"),
				"",
				theme.fg("dim", "esc close"),
			];
		}

		const out: string[] = [];
		const s = planStats(list);
		out.push(truncateToWidth(theme.fg("muted", `${progressBar(s.done, s.total)} ${s.done}/${s.total} · ${s.open} open`), width));

		const rows = rowsOf(list);
		let rowIndex = 0;
		for (const phase of list.phases) {
			if (phase.items.length === 0) continue;
			out.push("");
			out.push(truncateToWidth(theme.fg("dim", theme.bold(phase.name.toUpperCase())), width));
			for (const item of phase.items) {
				const line = itemLine(item, theme);
				if (rowIndex === selected && inputMode === null) {
					const cursor = theme.fg(statusToken(item.status), "› ");
					out.push(truncateToWidth(cursor + line + theme.fg("dim", `  [${phase.name}]`), width));
				} else {
					out.push(truncateToWidth(`  ${line}`, width));
				}
				rowIndex++;
			}
		}
		out.push("");
		if (notice) out.push(theme.fg("warning", truncateToWidth(`⚠ ${notice}`, width)));
		out.push(theme.fg("dim", "↑/↓ select · enter start · x done · b block · r reload · esc close"));
		return out;
	};

	return {
		render(width: number): string[] {
			// Content-sized output (no terminal-height padding): the differential
			// renderer then has nothing to repaint unless a line actually changed.
			return contentLines(Math.max(10, width - 2));
		},

		invalidate(): void {
			// stateless render from cached state
		},

		async handleInput(data: string): Promise<void> {
			notice = "";
			if (inputMode !== null) {
				if (matchesKey(data, Key.escape)) {
					inputMode = null;
				} else if (matchesKey(data, Key.enter)) {
					const target = selectedRow();
					const reason = inputMode.buffer.trim();
					inputMode = null;
					if (target) mutate((p) => markBlocked(p, target.text, reason, Date.now()));
				} else if (data === "\x7f" || matchesKey(data, Key.backspace)) {
					inputMode.buffer = inputMode.buffer.slice(0, -1);
				} else if (data.length === 1 && data >= " ") {
					inputMode.buffer += data;
				}
				refresh();
				return;
			}
			if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
				done();
				return;
			}
			if (matchesKey(data, Key.up)) {
				selected = Math.max(0, selected - 1);
			} else if (matchesKey(data, Key.down)) {
				selected++;
				clampSelected();
			} else if (data === "r" || data === "R") {
				// Explicit reload from disk (the model may have updated the list).
							list = loadPlan(deps.dataDir, deps.planKey);
				clampSelected();
			} else if (matchesKey(data, Key.enter)) {
				const t = selectedRow();
				if (t) mutate((p) => markStarted(p, t.text, Date.now()));
			} else if (data === "x" || data === "X") {
				const t = selectedRow();
				if (t) mutate((p) => markDone(p, t.text, Date.now()));
			} else if (data === "b" || data === "B") {
				inputMode = { buffer: "" };
			}
			refresh();
		},

		dispose(): void {},
	};
}
