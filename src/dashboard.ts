/**
 * src/dashboard.ts — fullscreen tasks panel for the pi TUI (/tasks command).
 *
 * Same pattern as pi-envoy's dashboard: a Component handed to ctx.ui.custom()
 * that owns keyboard focus until esc. Pure rendering lives in ui.ts; this file
 * wires it to the TUI with selection and inline actions.
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
import { markBlocked, markDone, markStarted, type Plan } from "./store.ts";
import { renderPlanThemed, statusToken, type ThemeLike } from "./ui.ts";

export interface DashboardDeps {
	/** Data dir for load/save. */
	dataDir: string;
	/** Working directory whose plan is shown. */
	cwd: string;
}

/** One selectable row: an item identified by phase + verbatim text. */
interface Row {
	phase: string;
	text: string;
	status: string;
}

function rowsOf(plan: Plan): Row[] {
	const rows: Row[] = [];
	for (const phase of plan.phases) {
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

	const mutate = (fn: (p: Plan) => { ok: true } | { ok: false; error: string }): void => {
		const plan = loadPlan(deps.dataDir, deps.cwd);
		if (!plan) return;
		const r = fn(plan);
		if (r.ok) {
			savePlan(deps.dataDir, plan);
			notice = "";
		} else {
			notice = r.error;
		}
		refresh();
	};

	const clampSelected = (): void => {
		const plan = loadPlan(deps.dataDir, deps.cwd);
		const n = plan ? rowsOf(plan).length : 0;
		if (selected >= n) selected = Math.max(0, n - 1);
	};

	const selectedRow = (): Row | null => {
		const plan = loadPlan(deps.dataDir, deps.cwd);
		if (!plan) return null;
		const rows = rowsOf(plan);
		return rows[selected] ?? null;
	};

	const contentLines = (width: number): string[] => {
		if (inputMode !== null) {
			return [
				truncateToWidth(
					`${theme.fg("warning", "block reason")} ${theme.fg("dim", "type reason · enter confirm · esc cancel")}: ${inputMode.buffer}`,
					width,
				),
			];
		}
		const plan = loadPlan(deps.dataDir, deps.cwd);
		if (!plan) {
			return [
				truncateToWidth(`${theme.fg("accent", theme.bold("tasks"))} ${theme.fg("dim", "no plan for this project")}`, width),
				"",
				theme.fg("dim", "ask the model to create one: tasks op=init …"),
			];
		}
		const out: string[] = [];
		for (const line of renderPlanThemed(plan, theme)) out.push(truncateToWidth(line, width));

		// Selection footer over item rows.
		const rows = rowsOf(plan);
		out.push("");
		clampSelected();
		if (rows.length > 0) {
			const sel = rows[selected]!;
			const token = statusToken(sel.status as Parameters<typeof statusToken>[0]);
			out.push(truncateToWidth(`${theme.fg(token, "›")} ${sel.text} ${theme.fg("dim", `(${sel.phase})`)}`, width));
		}
		if (notice) out.push(theme.fg("warning", truncateToWidth(`⚠ ${notice}`, width)));
		out.push(theme.fg("dim", "↑/↓ select · enter start · x done · b block · r reload · esc close"));
		return out;
	};

	return {
		render(width: number): string[] {
			const content = contentLines(Math.max(10, width - 2));
			let height = 24;
			try {
				const tuiRows = tui.terminal?.rows;
				if (typeof tuiRows === "number" && Number.isFinite(tuiRows) && tuiRows > 4) {
					height = Math.min(tuiRows, Math.max(height, tuiRows - 2));
				}
			} catch {
				// terminal size unknown — fall back to content height
			}
			while (content.length < height - 2) content.push("");
			if (content.length > height - 2) content.length = height - 2;
			return content;
		},

		invalidate(): void {
			// stateless render
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
			if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
			else if (matchesKey(data, Key.down)) selected++;
			else if (data === "r" || data === "R") {
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
