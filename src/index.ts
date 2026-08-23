/**
 * pi-tasks — goal + todo tracking for the pi coding agent.
 *
 * Registers a single `tasks` tool (op-based, mirroring the todo tool of other
 * coding agents), a `/tasks` TUI command, and a nudge: when the agent settles
 * (stops) with open items, a turn-triggering custom message reminds it of the
 * goal and what is left, so even a weak model cannot silently stop with
 * unfinished work.
 */

import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import {
	NUDGE_CUSTOM_TYPE,
	buildPlanAppendix,
	formatNudgeMessage,
	newNudgeState,
	recordAgentActivity,
	recordNudge,
	shouldNudge,
} from "./nudge.ts";
import { clearPlan, loadPlan, planFile, projectKey, savePlan } from "./persistence.ts";
import {
	appendTasks,
	initPlan,
	markBlocked,
	markDone,
	markDropped,
	markStarted,
	openCount,
	renderPlan,
	unblock,
	type Plan,
} from "./store.ts";

export default function (pi: ExtensionAPI): void {
	if (process.env.PI_TASKS_DISABLED === "1") return;

	const dataDir = process.env.PI_CODING_AGENT_DIR ?? (process.env.HOME ? `${process.env.HOME}/.pi/agent` : ".");
	const nudge = newNudgeState();
	let uiHost:
		| { hasUI: boolean; ui: { setStatus(key: string, text: string | undefined): void } }
		| undefined = undefined;

	const loadFor = (cwd: string): Plan | null => loadPlan(dataDir, cwd);

	const updateStatus = (plan: Plan | null): void => {
		try {
			if (!uiHost?.hasUI) return;
			const open = plan ? openCount(plan) : 0;
			if (open > 0) uiHost.ui.setStatus("tasks", `tasks ${open} open`);
			else uiHost.ui.setStatus("tasks", undefined);
		} catch {
			// UI best-effort only
		}
	};

	// ------------------------------------------------------------------
	// Tool: tasks
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "tasks",
		label: "Tasks",
		promptSnippet: "Track the active goal + todo list: init a plan when starting work, update items as you go (done/start/drop/block)",
		promptGuidelines: [
			"tasks: always call tasks op=init with a goal + todos before starting substantial multi-step work — it keeps you and the user aligned on what is left.",
			"tasks: keep items as short verbatim actions (what, not how); address them by their EXACT text.",
			"tasks: update the list as you work — mark done the item you just finished, start the item you are working on, drop items you will not do, block items waiting on something (with a reason).",
			"tasks: call tasks op=view whenever you need the current state; the plan persists across turns and sessions.",
			"tasks: you WILL be nudged if you stop while items are open — before stopping, finish the goal or explicitly close every open item (done/drop/block).",
		],
		description: [
			"Goal + todo tracking for the current work. The plan persists per project across sessions.",
			"Workflow: op=init (goal + checklist) → as you work, op=start the current item, op=done when finished, op=drop for abandoned items, op=block (with reason) for blocked ones, op=append to add more, op=view to see the plan.",
			"Items are addressed by their EXACT text — copy the item text verbatim from the most recent view; do not paraphrase.",
			"Completing an item auto-promotes the next open one as the active item. op=clear deletes the plan.",
			"You will be nudged (an injected message) if you stop while items remain open.",
		].join(" "),
		parameters: Type.Object({
			op: StringEnum(
				["init", "view", "start", "done", "drop", "block", "unblock", "append", "clear"] as const,
				{
					description:
						"Operation: init=create plan; view=show plan; start=mark item as the one being worked on; done=mark finished; drop=abandon; block=waiting (needs reason); unblock=re-open; append=add items; clear=delete plan",
				},
			),
			goal: Type.Optional(Type.String({ description: "The goal statement, one sentence (op=init)" })),
			todos: Type.Optional(Type.Array(Type.String({ description: "Checklist items, short verbatim actions (op=init / op=append)" }))),
			phases: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "Phase name (e.g. 'Build', 'Verify')" }),
						items: Type.Array(Type.String({ description: "Checklist items in this phase" })),
					}),
					{ description: "Phase-grouped checklist (op=init; wins over todos when provided)" },
				),
			),
			phase: Type.Optional(Type.String({ description: "Phase to append into (op=append; default: first phase)" })),
			task: Type.Optional(Type.String({ description: "The EXACT item text to start/done/drop/block/unblock — copy it verbatim from op=view" })),
			reason: Type.Optional(Type.String({ description: "Why the item is blocked (op=block)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd ?? process.cwd();
			const now = Date.now();
			const requireTask = (): string => {
				const t = params.task ?? "";
				if (t.trim() === "") throw new Error("task is required (the exact item text)");
				return t;
			};
			const persistAndRender = (p: Plan) => {
				savePlan(dataDir, p);
				updateStatus(p);
				return { content: [{ type: "text" as const, text: renderPlan(p) }], details: {} };
			};

			switch (params.op) {
				case "init": {
					const goal = (params.goal ?? "").trim();
					if (goal === "") throw new Error("goal is required for init");
					const p = initPlan({ goal, project: projectKey(cwd), todos: params.todos, phases: params.phases, now });
					return persistAndRender(p);
				}
				case "view": {
					const p = loadPlan(dataDir, cwd);
					if (!p)
						return {
							content: [{ type: "text" as const, text: "no plan yet — call tasks op=init with a goal and todos" }],
							details: {},
						};
					return persistAndRender(p);
				}
				case "start": {
					const p = loadPlan(dataDir, cwd);
					if (!p) throw new Error("no plan yet — call tasks op=init with a goal and todos first");
					const r = markStarted(p, requireTask(), now);
					if (!r.ok) throw new Error(r.error);
					return persistAndRender(p);
				}
				case "done": {
					const p = loadPlan(dataDir, cwd);
					if (!p) throw new Error("no plan yet — call tasks op=init with a goal and todos first");
					const r = markDone(p, requireTask(), now);
					if (!r.ok) throw new Error(r.error);
					return persistAndRender(p);
				}
				case "drop": {
					const p = loadPlan(dataDir, cwd);
					if (!p) throw new Error("no plan yet — call tasks op=init with a goal and todos first");
					const r = markDropped(p, requireTask(), now);
					if (!r.ok) throw new Error(r.error);
					return persistAndRender(p);
				}
				case "block": {
					const p = loadPlan(dataDir, cwd);
					if (!p) throw new Error("no plan yet — call tasks op=init with a goal and todos first");
					const r = markBlocked(p, requireTask(), params.reason ?? "", now);
					if (!r.ok) throw new Error(r.error);
					return persistAndRender(p);
				}
				case "unblock": {
					const p = loadPlan(dataDir, cwd);
					if (!p) throw new Error("no plan yet — call tasks op=init with a goal and todos first");
					const r = unblock(p, requireTask(), now);
					if (!r.ok) throw new Error(r.error);
					return persistAndRender(p);
				}
				case "append": {
					const p = loadPlan(dataDir, cwd);
					if (!p) throw new Error("no plan yet — call tasks op=init with a goal and todos first");
					const todos = params.todos ?? [];
					if (todos.length === 0) throw new Error("todos is required for append");
					const r = appendTasks(p, todos, params.phase, now);
					if (!r.ok) throw new Error("could not append tasks");
					return persistAndRender(p);
				}
				case "clear": {
					const removed = clearPlan(dataDir, cwd);
					updateStatus(null);
					return { content: [{ type: "text" as const, text: removed ? "plan cleared" : "no plan to clear" }], details: {} };
				}
			}
		},
	});

	// ------------------------------------------------------------------
	// TUI rendering for tool calls
	// ------------------------------------------------------------------

	// ------------------------------------------------------------------
	// Nudge: agent_settled + message_end
	// ------------------------------------------------------------------

	pi.on("before_agent_start", (event, ctx) => {
		const plan = loadFor(ctx.cwd ?? process.cwd());
		if (!plan) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildPlanAppendix(plan)}`,
		};
	});

	pi.on("message_end", (event) => {
		if (event.message?.role === "assistant") recordAgentActivity(nudge);
	});

	pi.on("agent_settled", () => {
		const plan = loadFor(process.cwd());
		if (!plan) return;
		if (!shouldNudge(nudge, plan, Date.now())) return;
		try {
			pi.sendMessage(formatNudgeMessage(plan), { triggerTurn: true, deliverAs: "steer" });
			recordNudge(nudge, Date.now());
		} catch (err) {
			// nudge is best-effort
			console.error("tasks nudge failed:", String(err));
		}
	});

	pi.registerMessageRenderer(NUDGE_CUSTOM_TYPE, (message, _options, theme) => {
		const details = message.details as { open?: number; goal?: string; next?: string } | undefined;
		const open = details?.open ?? 0;
		const head = theme.fg("warning", theme.bold(`⚠ tasks: ${open} open`)) + (details?.next ? theme.fg("dim", ` — next: ${details.next}`) : "");
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(`${head}\n${content}`, 1, 0);
	});

	// ------------------------------------------------------------------
	// /tasks command
	// ------------------------------------------------------------------

	pi.registerCommand("tasks", {
		description: "Show the current goal + todo plan",
		handler: async (_args, cmdCtx) => {
			uiHost = cmdCtx;
			const plan = loadFor(cmdCtx.cwd ?? process.cwd());
			updateStatus(plan);
			if (!plan) {
				if (cmdCtx.hasUI) cmdCtx.ui.notify("tasks: no plan yet — ask the model to init one", "info");
				return;
			}
			if (cmdCtx.hasUI) cmdCtx.ui.notify(renderPlan(plan), "info");
		},
	});

	// ------------------------------------------------------------------
	// Session events
	// ------------------------------------------------------------------

	pi.on("session_start", (_event, eventCtx) => {
		uiHost = eventCtx;
		const plan = loadFor(process.cwd());
		updateStatus(plan);
	});

	pi.on("session_shutdown", () => {
		uiHost = undefined;
		updateStatus(null);
	});
}
