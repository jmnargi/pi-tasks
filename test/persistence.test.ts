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

	test("projectKey normalizes to a safe filename", () => {
		expect(projectKey("/home/u/my repo/src")).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(planFile(tmp, "/a/b").endsWith(".json")).toBe(true);
	});
});
