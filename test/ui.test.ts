/**
 * Tests for pure TUI helpers (src/ui.ts).
 */

import { describe, expect, test } from "bun:test";

import { initList } from "../src/store.ts";
import { itemLine, planStats, progressBar, renderPlanThemed } from "../src/ui.ts";

/** Theme stand-in that strips colors — assertions check structure only. */
const theme = {
	fg: (_c: string, ...t: string[]) => t.join(""),
	bold: (t: string) => t,
};

const plan = () => initList({ project: "p", todos: ["a", "b"], now: 0 });

describe("planStats", () => {
	test("computes done/total/open/current", () => {
		const s = planStats(plan());
		expect(s.total).toBe(2);
		expect(s.open).toBe(2);
		expect(s.done).toBe(0);
		expect(s.current).toBe("a");
	});
});

describe("itemLine", () => {
	test("includes glyph, text and note", () => {
		const p = plan();
		p.phases[0]!.items[0]!.note = "why";
		expect(itemLine(p.phases[0]!.items[0]!, theme)).toBe("▸ a — why");
	});
});

describe("progressBar", () => {
	test("fills proportionally at fixed width", () => {
		expect(progressBar(0, 4, 8)).toBe("░░░░░░░░");
		expect(progressBar(4, 4, 8)).toBe("████████");
		expect(progressBar(1, 2, 8)).toBe("████░░░░");
		expect(progressBar(0, 0, 4)).toBe("░░░░");
	});
});

describe("renderPlanThemed", () => {
	test("renders progress line and items", () => {
		const lines = renderPlanThemed(plan(), theme);
		expect(lines[0]).toContain("0/2 · 2 open");
		expect(lines.join("\n")).toContain("a");
	});
});
