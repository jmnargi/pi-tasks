/**
 * Persistence tests (src/persistence.ts) — plans survive across reloads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { clearPlan, loadPlan, planFile, projectKey, savePlan } from "../src/persistence.ts";
import { initPlan, markDone } from "../src/store.ts";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-persist-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("persistence", () => {
	test("save + load round-trips a plan", () => {
		const p = initPlan({ goal: "g", project: projectKey("/home/u/repo"), todos: ["a", "b"], now: 1 });
		markDone(p, "a", 2);
		savePlan(tmp, p);
		const loaded = loadPlan(tmp, "/home/u/repo");
		expect(loaded?.goal).toBe("g");
		expect(loaded?.phases[0]?.items[0]?.status).toBe("done");
	});

	test("missing plan loads as null; clear removes it", () => {
		expect(loadPlan(tmp, "/nope")).toBeNull();
		const p = initPlan({ goal: "g", project: projectKey("/x"), todos: ["a"], now: 1 });
		savePlan(tmp, p);
		expect(clearPlan(tmp, "/x")).toBe(true);
		expect(loadPlan(tmp, "/x")).toBeNull();
		expect(clearPlan(tmp, "/x")).toBe(false);
	});

	test("projectKey normalizes to a safe filename and is deterministic", () => {
		expect(projectKey("/home/u/my repo/src")).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(planFile(tmp, projectKey("/a/b")).endsWith(".json")).toBe(true);
		expect(projectKey("/home/u/repo")).toBe(projectKey("/home/u/repo"));
	});

	test("colliding sanitized keys get distinct files via hash suffix", () => {
		expect(projectKey("/a-b/c")).not.toBe(projectKey("/a/b-c"));
	});

	test("corrupt plan file degrades to null instead of crashing", () => {
		fs.mkdirSync(path.join(tmp, "tasks", "plans"), { recursive: true });
		const key = `${projectKey("/corrupt/repo")}.json`;
		fs.writeFileSync(path.join(tmp, "tasks", "plans", key), '{"goal":"g","phases":[{"name":"P"}]}');
		expect(loadPlan(tmp, "/corrupt/repo")).toBeNull();
		fs.writeFileSync(path.join(tmp, "tasks", "plans", key), "not json at all");
		expect(loadPlan(tmp, "/corrupt/repo")).toBeNull();
		fs.writeFileSync(
			path.join(tmp, "tasks", "plans", key),
			JSON.stringify({ goal: "g", phases: [{ name: "P", items: [{ text: "t", status: "bogus" }] }], createdAt: 1, updatedAt: 1, project: "x" }),
		);
		expect(loadPlan(tmp, "/corrupt/repo")).toBeNull();
		fs.writeFileSync(
			path.join(tmp, "tasks", "plans", key),
			JSON.stringify({ goal: "g", phases: [{ name: "P", items: [{ text: "t", status: "pending" }] }], createdAt: 1, updatedAt: 1, project: "x" }),
		);
		expect(loadPlan(tmp, "/corrupt/repo")?.goal).toBe("g");
	});
});
