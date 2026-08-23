/**
 * Tests for the nudge decisioning + message shaping (src/nudge.ts).
 */

import { describe, expect, test } from "bun:test";

import {
	NUDGE_CUSTOM_TYPE,
	buildPlanAppendix,
	formatNudgeMessage,
	newNudgeState,
	recordAgentActivity,
	recordNudge,
	shouldNudge,
} from "../src/nudge.ts";
import { initPlan } from "../src/store.ts";

const plan = () =>
	initPlan({
		goal: "Ship",
		project: "p",
		todos: ["a", "b"],
		now: 0,
	});

describe("shouldNudge", () => {
	test("nudges when open tasks exist and agent has acted", () => {
		const s = newNudgeState(60_000);
		expect(shouldNudge(s, plan(), 5000)).toBe(true);
	});

	test("does not nudge with no plan or all done", () => {
		const s = newNudgeState();
		expect(shouldNudge(s, null, 5000)).toBe(false);
		const done = plan();
		done.phases[0]!.items.forEach((i) => (i.status = "done"));
		expect(shouldNudge(s, done, 5000)).toBe(false);
	});

	test("respects the cooldown after a nudge", () => {
		const s = newNudgeState(60_000);
		recordNudge(s, 1000);
		expect(shouldNudge(s, plan(), 5000)).toBe(false);
		// Agent acts, then cooldown elapses → nudge again
		recordAgentActivity(s);
		expect(shouldNudge(s, plan(), 70_000)).toBe(true);
	});

	test("does not loop without agent activity after a nudge", () => {
		const s = newNudgeState(1);
		recordNudge(s, 1000);
		// No agent activity since nudge → even after cooldown, no re-nudge.
		expect(shouldNudge(s, plan(), 2000)).toBe(false);
	});
});

describe("formatNudgeMessage", () => {
	test("shapes a turn-triggering custom message with plan context", () => {
		const m = formatNudgeMessage(plan());
		expect(m.customType).toBe(NUDGE_CUSTOM_TYPE);
		expect(m.display).toBe(true);
		expect(m.details.open).toBe(2);
		expect(m.details.next).toBe("a");
		expect(m.content).toContain("Goal: Ship");
		expect(m.content).toContain("2 open task");
		expect(m.content).toContain("[ ] b");
	});
});

describe("buildPlanAppendix", () => {
	test("includes goal, open count, and current item", () => {
		const text = buildPlanAppendix(plan());
		expect(text).toContain("active goal + todo plan");
		expect(text).toContain("Goal: Ship (2 open items)");
		expect(text).toContain('Current: "a"');
		expect(text).toContain("op=view");
	});

	test("mentions nudging so the model keeps the list updated", () => {
		expect(buildPlanAppendix(plan())).toContain("nudged if you stop with open items");
	});
});
