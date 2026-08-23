/**
 * src/persistence.ts — plan persistence to the pi agent data dir.
 *
 * Plans are stored as one JSON file per project under
 * `<agentDir>/tasks/plans/<safe-project-key>.json` so each repo keeps its own
 * goal + checklist across sessions. Pure IO with no pi imports; the factory
 * supplies the data dir.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Plan } from "./store.ts";

/** Normalize a project path into a safe filename key. */
export function projectKey(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "root";
}

export function plansDir(dataDir: string): string {
	return path.join(dataDir, "tasks", "plans");
}

export function planFile(dataDir: string, cwd: string): string {
	return path.join(plansDir(dataDir), `${projectKey(cwd)}.json`);
}

/** Load a plan for `cwd`, or null when none exists. */
export function loadPlan(dataDir: string, cwd: string): Plan | null {
	try {
		const raw = fs.readFileSync(planFile(dataDir, cwd), "utf8");
		const parsed = JSON.parse(raw) as Plan;
		if (typeof parsed.goal !== "string" || !Array.isArray(parsed.phases)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Persist a plan (atomic write via temp + rename). */
export function savePlan(dataDir: string, plan: Plan): void {
	const file = planFile(dataDir, plan.project);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(plan, null, 2) + "\n");
	fs.renameSync(tmp, file);
}

/** Delete a plan (returns true when one existed). */
export function clearPlan(dataDir: string, cwd: string): boolean {
	const file = planFile(dataDir, cwd);
	if (!fs.existsSync(file)) return false;
	fs.rmSync(file);
	return true;
}
