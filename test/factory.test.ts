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
}

function makeFakePi(): FakePi {
	const tools: RegisteredTool[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	const renderers: string[] = [];
	const sent: unknown[] = [];
	const surface = {
		registerTool: (t: RegisteredTool) => tools.push(t),
		registerCommand: (name: string, _def: unknown) => commands.push(name),
		on: (event: string, _handler: unknown) => events.push(event),
		registerMessageRenderer: (customType: string, _r: unknown) => renderers.push(customType),
		sendMessage: (m: unknown) => sent.push(m),
	} as unknown as ExtensionAPI;
	return { pi: surface, tools, commands, events, renderers, sent };
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
		expect(fake.events).toContain("session_start");
		expect(fake.events).toContain("session_shutdown");
	});
});
