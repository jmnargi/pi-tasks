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

import type { Plan, TaskStatus } from "./store.ts";

const VALID_STATUSES: readonly string[] = ["pending", "in_progress", "done", "dropped", "blocked"];

/** Normalize a project path into a safe filename key.
 *  A short hash of the raw path is appended so distinct projects whose
 *  sanitized keys collide (e.g. `/a-b/c` vs `/a/b-c`) get separate files. */
export function projectKey(cwd: string): string {
	const base = cwd.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "root";
	let h = 5381;
	for (let i = 0; i < cwd.length; i++) h = ((h << 5) + h + cwd.charCodeAt(i)) | 0;
	return `${base}-${(h >>> 0).toString(36)}`;
}

export function plansDir(dataDir: string): string {
	return path.join(dataDir, "tasks", "plans");
}

/** File path for a plan. `key` must be the output of `projectKey(rawPath)` —
 *  callers pass either a raw cwd or `plan.project` (already a key). */
export function planFile(dataDir: string, key: string): string {
	return path.join(plansDir(dataDir), `${key}.json`);
}

function fileFor(dataDir: string, cwdOrProject: string): string {
	// Already-keyed strings (from plan.project) contain no path separators and
	// end in our hash suffix; raw cwds contain "/" (or "\\" on Windows).
	const isRaw = cwdOrProject.includes("/") || cwdOrProject.includes("\\");
	return planFile(dataDir, isRaw ? projectKey(cwdOrProject) : cwdOrProject);
}

/** Structural validation for a loaded plan — a truncated/corrupt file must
 *  degrade to "no plan" rather than crash every later operation. */
function isValidPlan(p: unknown): p is Plan {
	if (typeof p !== "object" || p === null) return false;
	const plan = p as Plan;
	if (typeof plan.goal !== "string") return false;
	if (!Array.isArray(plan.phases)) return false;
	for (const phase of plan.phases) {
		if (typeof phase !== "object" || phase === null || typeof phase.name !== "string" || !Array.isArray(phase.items)) return false;
		for (const item of phase.items) {
			if (typeof item !== "object" || item === null || typeof item.text !== "string") return false;
			if (!VALID_STATUSES.includes(item.status)) return false;
		}
	}
	return typeof plan.createdAt === "number" && typeof plan.updatedAt === "number" && typeof plan.project === "string";
}

/** Load a plan for `cwd`, or null when none exists (or the file is corrupt). */
export function loadPlan(dataDir: string, cwd: string): Plan | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(fileFor(dataDir, cwd), "utf8"));
		return isValidPlan(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Persist a plan (atomic write via temp + rename). */
export function savePlan(dataDir: string, plan: Plan): void {
	const file = fileFor(dataDir, plan.project);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(plan, null, 2) + "\n");
	fs.renameSync(tmp, file);
}

/** Delete a plan (returns true when one existed). */
export function clearPlan(dataDir: string, cwd: string): boolean {
	const file = fileFor(dataDir, cwd);
	if (!fs.existsSync(file)) return false;
	fs.rmSync(file);
	return true;
}
