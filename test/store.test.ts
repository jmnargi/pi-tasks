/**
 * Tests for the goal+todo state machine (src/store.ts).
 */

import { describe, expect, test } from "bun:test";

import {
	appendTasks,
	initPlan,
	markBlocked,
	markDone,
	markDropped,
	markStarted,
	nextOpenItem,
	openCount,
	renderPlan,
	unblock,
} from "../src/store.ts";

const now = 1000;

function plan() {
	return initPlan({
		goal: "Ship the API",
		project: "proj",
		todos: ["write endpoint", "write tests", "update docs"],
		now,
	});
}

describe("initPlan", () => {
	test("creates a single phase with the first item in_progress", () => {
		const p = plan();
		expect(p.goal).toBe("Ship the API");
		expect(p.phases).toHaveLength(1);
		expect(p.phases[0]!.items.map((i) => i.text)).toEqual(["write endpoint", "write tests", "update docs"]);
		expect(p.phases[0]!.items[0]!.status).toBe("in_progress");
		expect(openCount(p)).toBe(3);
	});

	test("supports phase-grouped checklists", () => {
		const p = initPlan({
			goal: "g",
			project: "p",
			phases: [
				{ name: "Build", items: ["a", "b"] },
				{ name: "Verify", items: ["c"] },
			],
			now,
		});
		expect(p.phases.map((ph) => ph.name)).toEqual(["Build", "Verify"]);
		expect(openCount(p)).toBe(3);
	});

	test("empty todos create an empty plan", () => {
		const p = initPlan({ goal: "g", project: "p", now });
		expect(openCount(p)).toBe(0);
	});
});

describe("markDone", () => {
	test("marks done and auto-promotes the next open item", () => {
		const p = plan();
		markDone(p, "write endpoint", now);
		expect(p.phases[0]!.items[0]!.status).toBe("done");
		expect(p.phases[0]!.items[1]!.status).toBe("in_progress");
		expect(openCount(p)).toBe(2);
	});

	test("errors on unknown task", () => {
		const p = plan();
		const r = markDone(p, "nope", now);
		expect(r.ok).toBe(false);
	});
});

describe("markStarted", () => {
	test("switches in_progress to the requested item", () => {
		const p = plan();
		const r = markStarted(p, "update docs", now);
		expect(r.ok).toBe(true);
		expect(p.phases[0]!.items[2]!.status).toBe("in_progress");
		expect(p.phases[0]!.items[0]!.status).toBe("pending");
	});
});

describe("markDropped / markBlocked / unblock", () => {
	test("drop removes from open count and promotes next", () => {
		const p = plan();
		markDropped(p, "write endpoint", now);
		expect(p.phases[0]!.items[0]!.status).toBe("dropped");
		expect(p.phases[0]!.items[1]!.status).toBe("in_progress");
	});

	test("block sets status + note and promotes next", () => {
		const p = plan();
		markBlocked(p, "write endpoint", "waiting on API key", now);
		expect(p.phases[0]!.items[0]!.status).toBe("blocked");
		expect(p.phases[0]!.items[0]!.note).toBe("waiting on API key");
		expect(p.phases[0]!.items[1]!.status).toBe("in_progress");
	});

	test("unblock returns item to open pool and promotes it", () => {
		const p = plan();
		markBlocked(p, "write endpoint", "waiting", now);
		unblock(p, "write endpoint", now);
		expect(p.phases[0]!.items[0]!.status).toBe("in_progress");
		expect(openCount(p)).toBe(3);
	});
});

describe("appendTasks", () => {
	test("appends to the first phase and auto-promotes when nothing is open", () => {
		const p = initPlan({ goal: "g", project: "p", now });
		const r = appendTasks(p, ["one"], undefined, now);
		expect(r.ok).toBe(true);
		expect(r.added).toBe(1);
		expect(p.phases[0]!.items[0]!.status).toBe("in_progress");
	});
});

describe("renderPlan + nextOpenItem", () => {
	test("renderPlan includes goal, markers and counts", () => {
		const text = renderPlan(plan());
		expect(text).toContain("Goal: Ship the API");
		expect(text).toContain("[~] write endpoint");
		expect(text).toContain("[ ] write tests");
		expect(text).toContain("3 open · 3 total");
	});

	test("nextOpenItem returns the earliest open item", () => {
		const n = nextOpenItem(plan());
		expect(n?.item.text).toBe("write endpoint");
	});
});
