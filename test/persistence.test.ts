/**
 * Persistence tests (src/persistence.ts) — session-scoped plans survive
 * restarts and never leak across sessions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { clearPlan, loadPlan, planFile, planKey, projectKey, savePlan } from "../src/persistence.ts";
import { initList, markDone } from "../src/store.ts";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-persist-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("persistence", () => {
	test("planKey prefers the session id and is deterministic", () => {
		expect(planKey("abc-123", "/any/cwd")).toBe(planKey("abc-123", "/other/cwd"));
		expect(planKey("abc-123", "/x")).toMatch(/^sid-[a-zA-Z0-9_-]+$/);
		expect(planKey(undefined, "/x")).toMatch(/^proj-/);
	});

	test("save + load round-trips a plan by key", () => {
		const key = planKey("sess-1", "/home/u/repo");
		const p = initList({ project: key, todos: ["a", "b"], now: 1 });
		markDone(p, "a", 2);
		savePlan(tmp, p);
		const loaded = loadPlan(tmp, key);
		expect(loaded?.phases[0]?.items[0]?.text).toBe("a");
		expect(loaded?.phases[0]?.items[0]?.status).toBe("done");
		// Round-trip survives a "restart" (same session id → same key).
		expect(loadPlan(tmp, planKey("sess-1", "/home/u/repo"))?.key).toBe(key);
	});

	test("different sessions get different lists (no leakage)", () => {
		const k1 = planKey("session-one", "/repo");
		const k2 = planKey("session-two", "/repo");
		expect(k1).not.toBe(k2);
		savePlan(tmp, initList({ project: k1, todos: ["a"], now: 1 }));
		savePlan(tmp, initList({ project: k2, todos: ["b"], now: 1 }));
		expect(loadPlan(tmp, k1)?.key).toBe(k1);
		expect(loadPlan(tmp, k2)?.key).toBe(k2);
	});

	test("missing plan loads as null; clear removes it", () => {
		const key = planKey("nope-session", "/x");
		expect(loadPlan(tmp, key)).toBeNull();
		const p = initList({ project: key, todos: ["a"], now: 1 });
		savePlan(tmp, p);
		expect(clearPlan(tmp, key)).toBe(true);
		expect(loadPlan(tmp, key)).toBeNull();
		expect(clearPlan(tmp, key)).toBe(false);
	});

	test("projectKey remains a safe deterministic fallback filename", () => {
		expect(projectKey("/home/u/my repo/src")).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(planFile(tmp, projectKey("/a/b")).endsWith(".json")).toBe(true);
		expect(projectKey("/home/u/repo")).toBe(projectKey("/home/u/repo"));
		expect(projectKey("/a-b/c")).not.toBe(projectKey("/a/b-c"));
	});

	test("corrupt plan file degrades to null instead of crashing", () => {
		fs.mkdirSync(path.join(tmp, "tasks", "sessions"), { recursive: true });
		const file = planFile(tmp, planKey("corrupt-sess", "/corrupt/repo"));
		fs.writeFileSync(file, '{"goal":"g","phases":[{"name":"P"}]}');
		expect(loadPlan(tmp, planKey("corrupt-sess", "/corrupt/repo"))).toBeNull();
		fs.writeFileSync(file, "not json at all");
		expect(loadPlan(tmp, planKey("corrupt-sess", "/corrupt/repo"))).toBeNull();
		fs.writeFileSync(
			file,
			JSON.stringify({ phases: [{ name: "P", items: [{ text: "t", status: "bogus" }] }], createdAt: 1, updatedAt: 1, project: "x" }),
		);
		expect(loadPlan(tmp, planKey("corrupt-sess", "/corrupt/repo"))).toBeNull();
		fs.writeFileSync(
			file,
			JSON.stringify({ phases: [{ name: "P", items: [{ text: "t", status: "pending" }] }], createdAt: 1, updatedAt: 1, key: "k" }),
		);
		expect(loadPlan(tmp, planKey("corrupt-sess", "/corrupt/repo"))?.phases[0]?.items[0]?.text).toBe("t");
	});
});
