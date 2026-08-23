/**
 * Tests for the nudge decisioning + message shaping (src/nudge.ts).
 */

import { describe, expect, test } from "bun:test";

import {
	evaluateNudge,
	MAX_CONSECUTIVE_NUDGES,
	NUDGE_CUSTOM_TYPE,
	buildPlanAppendix,
	newNudgeState,
	formatNudgeMessage,
	formatNudgeText,
	recordAgentActivity,
	recordEscalation,
	recordNudge,
	recordProgress,
	resetNudgeState,
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

describe("nudge exhaustion (evaluateNudge)", () => {
	test("escalates after MAX_CONSECUTIVE_NUDGES without progress", () => {
		const s = newNudgeState(1);
		let now = 1000;
		for (let i = 0; i < MAX_CONSECUTIVE_NUDGES; i++) {
			recordProgress(s, plan());
			const d = evaluateNudge(s, plan(), now);
			expect(d.action === "nudge" || d.action === "escalate").toBe(true);
			if (d.action === "nudge") recordNudge(s, now);
			recordAgentActivity(s);
			now += 2000;
		}
		recordProgress(s, plan());
		expect(evaluateNudge(s, plan(), now).action).toBe("escalate");
		// After escalation is recorded: silent.
		recordEscalation(s);
		expect(evaluateNudge(s, plan(), now + 2000).action).toBe("none");
	});

	test("real progress resets the exhaustion counter", () => {
		const s = newNudgeState(1);
		recordProgress(s, plan()); // open=2 → lowWater 2
		recordNudge(s, 1000);
		recordNudge(s, 3000); // consecutive = 2
		const smaller = plan();
		smaller.phases[0]!.items[1]!.status = "done"; // open drops to 1
		recordProgress(s, smaller);
		expect(s.consecutive).toBe(0);
	});

	test("all-done plan never nudges or escalates", () => {
		const s = newNudgeState(1);
		recordEscalation(s);
		const done = plan();
		done.phases[0]!.items.forEach((i) => (i.status = "done"));
		expect(evaluateNudge(s, done, 99999).action).toBe("none");
	});

	test("resetNudgeState clears everything", () => {
		const s = newNudgeState(1);
		recordNudge(s, 1000);
		recordEscalation(s);
		resetNudgeState(s);
		expect(shouldNudge(s, plan(), 1001)).toBe(true);
	});
});

describe("formatNudgeMessage", () => {
	test("shapes the reminder payload with goal-incomplete framing", () => {
		const m = formatNudgeMessage(plan());
		expect(m.customType).toBe(NUDGE_CUSTOM_TYPE);
		expect(m.display).toBe(true);
		expect(m.details.open).toBe(2);
		expect(m.details.next).toBe("a");
		expect(m.content).toContain("NOT complete");
		expect(m.content).toContain("Goal: Ship");
		expect(m.content).toContain("[ ] b");
	});

	test("formatNudgeText is user-message prose with plan", () => {
		const text = formatNudgeText(plan());
		expect(text).toContain("[tasks] You stopped your turn");
		expect(text).toContain("2 tasks still open");
		expect(text).toContain('Current task: "a"');
		expect(text).toContain("Do not reply to this message");
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
