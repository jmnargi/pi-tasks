/**
 * Factory-surface tests: the `tasks` tool, `/tasks` command, nudge renderer,
 * and lifecycle events all register. Guards the model-facing contract.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import makeTasks from "../src/index.ts";

interface RegisteredTool {
	name: string;
	label: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	execute: (...args: unknown[]) => unknown;
}

interface FakePi {
	pi: ExtensionAPI;
	tools: RegisteredTool[];
	commands: string[];
	events: string[];
	renderers: string[];
	sent: unknown[];
	fire(event: string, payload?: unknown, ctx?: unknown): void;
}

function makeFakePi(): FakePi {
	const tools: RegisteredTool[] = [];
	const commands: string[] = [];
	const events = new Set<string>();
	const renderers: string[] = [];
	const sent: unknown[] = [];
	const handlers = new Map<string, (event?: unknown, ctx?: unknown) => void>();
	const surface = {
		registerTool: (t: RegisteredTool) => tools.push(t),
		registerCommand: (name: string, _def: unknown) => commands.push(name),
		on: (event: string, handler: (event?: unknown, ctx?: unknown) => void) => {
			events.add(event);
			handlers.set(event, handler);
		},
		registerMessageRenderer: (customType: string, _r: unknown) => renderers.push(customType),
		sendMessage: (m: unknown) => sent.push(m),
		sendUserMessage: (content: unknown) => sent.push(content),
	} as unknown as ExtensionAPI;
	return {
		pi: surface,
		tools,
		commands,
		get events() {
			return [...events];
		},
		renderers,
		sent,
		fire: (event, payload, ctx) => handlers.get(event)?.(payload, ctx),
	};
}

let tmp: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-factory-"));
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmp;
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
});

describe("extension factory surface", () => {
	test("registers the tasks tool with snippets + guidelines", () => {
		const fake = makeFakePi();
		makeTasks(fake.pi);
		expect(fake.tools).toHaveLength(1);
		const tool = fake.tools[0]!;
		expect(tool.name).toBe("tasks");
		expect(tool.label).toBe("Tasks");
		expect(tool.promptSnippet).toContain("init a plan");
		expect(tool.promptGuidelines?.join(" ")).toContain("nudged");
	});

	test("registers /tasks command, nudge renderer, and lifecycle events", () => {
		const fake = makeFakePi();
		makeTasks(fake.pi);
		expect(fake.commands).toContain("tasks");
		expect(fake.renderers).toContain("tasks-nudge");
		expect(fake.events).toContain("agent_settled");
		expect(fake.events).toContain("message_end");
		expect(fake.events).toContain("before_agent_start");
		expect(fake.events).toContain("session_start");
		expect(fake.events).toContain("session_shutdown");
	});
});

describe("nudge flow (agent_settled fired)", () => {
	function makeToolCtx(cwd: string): { cwd: string; hasUI: boolean; mode: string; ui: never } {
		return { cwd, hasUI: false, mode: "json", ui: {} as never };
	}

	async function initPlanFor(fake: ReturnType<typeof makeFakePi>, cwd: string): Promise<void> {
		const tool = fake.tools[0]!;
		await tool.execute("call-1", { op: "init", goal: "Ship it", todos: ["a", "b"] }, undefined, undefined, makeToolCtx(cwd));
		fake.sent.length = 0;
	}

	test("settling with open items sends a user message nudge", async () => {
		const fake = makeFakePi();
		makeTasks(fake.pi);
		const cwd = path.join(tmp, "proj-a");
		fs.mkdirSync(cwd, { recursive: true });
		await initPlanFor(fake, cwd);
		// Simulate an assistant turn so the "agent acted" gate is armed.
		fake.fire("message_end", { message: { role: "assistant", content: "working…" } });
		fake.fire("agent_settled", {}, { cwd });
		expect(fake.sent).toHaveLength(1);
		const text = fake.sent[0] as string;
		expect(typeof text).toBe("string");
		expect(text).toContain("NOT complete");
		expect(text).toContain("2 task"); // open count
		expect(text).toContain("Ship it"); // goal
	});

	test("model answering then stopping again re-nudges after cooldown", async () => {
		const fake = makeFakePi();
		makeTasks(fake.pi);
		const cwd = path.join(tmp, "proj-a2");
		fs.mkdirSync(cwd, { recursive: true });
		await initPlanFor(fake, cwd);
		fake.fire("message_end", { message: { role: "assistant", content: "working…" } });
		fake.fire("agent_settled", {}, { cwd });
		expect(fake.sent).toHaveLength(1);
		// Model answers again and stops — but within the 60s cooldown → silent.
		fake.fire("message_end", { message: { role: "assistant", content: "more" } });
		fake.fire("agent_settled", {}, { cwd });
		expect(fake.sent).toHaveLength(1);
	});

	test("settling with all items done does not send anything", async () => {
		const fake = makeFakePi();
		makeTasks(fake.pi);
		const cwd = path.join(tmp, "proj-b");
		fs.mkdirSync(cwd, { recursive: true });
		const tool = fake.tools[0]!;
		await tool.execute("c1", { op: "init", goal: "Ship it", todos: ["a"] }, undefined, undefined, makeToolCtx(cwd));
		await tool.execute("c2", { op: "done", task: "a" }, undefined, undefined, makeToolCtx(cwd));
		fake.fire("message_end", { message: { role: "assistant", content: "done!" } });
		fake.fire("agent_settled", {}, { cwd });
		expect(fake.sent).toHaveLength(0);
	});

	test("tool results carry structured details", async () => {
		const fake = makeFakePi();
		makeTasks(fake.pi);
		const cwd = path.join(tmp, "proj-c");
		fs.mkdirSync(cwd, { recursive: true });
		const tool = fake.tools[0]!;
		const res = (await tool.execute(
			"c1",
			{ op: "init", goal: "Ship it", todos: ["a", "b"] },
			undefined,
			undefined,
			makeToolCtx(cwd),
		)) as { details: { open: number; total: number; current: string } };
		expect(res.details.open).toBe(2);
		expect(res.details.total).toBe(2);
		expect(res.details.current).toBe("a");
	});

	test("re-init over an active plan is rejected without replace=true", async () => {
		const fake = makeFakePi();
		makeTasks(fake.pi);
		const cwd = path.join(tmp, "proj-d");
		fs.mkdirSync(cwd, { recursive: true });
		const tool = fake.tools[0]!;
		await tool.execute("c1", { op: "init", goal: "First", todos: ["a"] }, undefined, undefined, makeToolCtx(cwd));
		await expect(
			tool.execute("c2", { op: "init", goal: "Second", todos: ["b"] }, undefined, undefined, makeToolCtx(cwd)),
		).rejects.toThrow("replace=true");
	});
});
