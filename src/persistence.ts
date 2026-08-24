/**
 * src/persistence.ts — todo-list persistence to the pi agent data dir.
 *
 * Lists are scoped to a SESSION (not the project): each session gets its own
 * file keyed by the pi session id, stored under
 * `<agentDir>/tasks/sessions/<safe-key>.json`. The session id is stable —
 * pi reads it back from the session header when a session is resumed — so a
 * list survives CLI restarts exactly as long as the session does, and
 * switching sessions never shows another session's tasks.
 *
 * Pure IO with no pi imports; callers supply the data dir and the key.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { TaskList } from "./store.ts";

const VALID_STATUSES: readonly string[] = ["pending", "in_progress", "done", "dropped", "blocked"];

/** Sanitize any string into a safe filename fragment. */
function safeFragment(s: string): string {
	const base = s.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return `${base || "k"}-${(h >>> 0).toString(36)}`;
}

/**
 * Storage key for a list. Prefers the pi session id (stable across restarts,
 * unique per session); falls back to the project path when no session manager
 * is available (tests, headless embeds).
 */
export function planKey(sessionId: string | undefined, cwd: string): string {
	return sessionId ? `sid-${safeFragment(sessionId)}` : `proj-${projectKey(cwd)}`;
}

/** Normalize a project path into a safe filename key (fallback scoping). */
export function projectKey(cwd: string): string {
	let h = 5381;
	for (let i = 0; i < cwd.length; i++) h = ((h << 5) + h + cwd.charCodeAt(i)) | 0;
	return `${cwd.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "root"}-${(h >>> 0).toString(36)}`;
}

export function plansDir(dataDir: string): string {
	return path.join(dataDir, "tasks", "sessions");
}

/** File path for a storage key. */
export function planFile(dataDir: string, key: string): string {
	return path.join(plansDir(dataDir), `${key}.json`);
}

/** Structural validation for a loaded list — a truncated/corrupt file must
 *  degrade to "no tasks" rather than crash every later operation. */
function isValidList(p: unknown): p is TaskList {
	if (typeof p !== "object" || p === null) return false;
	const list = p as TaskList;
	if (!Array.isArray(list.phases)) return false;
	for (const phase of list.phases) {
		if (typeof phase !== "object" || phase === null || typeof phase.name !== "string" || !Array.isArray(phase.items)) return false;
		for (const item of phase.items) {
			if (typeof item !== "object" || item === null || typeof item.text !== "string") return false;
			if (!VALID_STATUSES.includes(item.status)) return false;
		}
	}
	return typeof list.createdAt === "number" && typeof list.updatedAt === "number" && typeof list.key === "string";
}

/** Load a list for `key`, or null when none exists (or the file is corrupt). */
export function loadPlan(dataDir: string, key: string): TaskList | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(planFile(dataDir, key), "utf8"));
		return isValidList(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Persist a list (atomic write via temp + rename). */
export function savePlan(dataDir: string, list: TaskList): void {
	const file = planFile(dataDir, list.key);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
	fs.renameSync(tmp, file);
}

/** Delete a list (returns true when one existed). */
export function clearPlan(dataDir: string, key: string): boolean {
	const file = planFile(dataDir, key);
	if (!fs.existsSync(file)) return false;
	fs.rmSync(file);
	return true;
}
