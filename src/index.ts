/**
 * pi-tasks — todo-list tracking for the pi coding agent.
 *
 * Registers a single `tasks` tool (op-based, mirroring the todo tool of other
 * coding agents), a `/tasks` fullscreen TUI command, custom tool rendering,
 * a footer status + ambient widget, and a nudge: when the agent settles
 * (stops) with open items, a real user message tells it to keep working, so
 * even a weak model cannot silently stop with unfinished work. Nudges are
 * capped (see nudge.ts): after several consecutive no-progress settles the
 * extension escalates to the user instead of burning tokens on another turn.
 */

import { planStats, renderPlanThemed, type ThemeLike } from "./ui.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import {
	evaluateNudge,
	formatNudgeText,
	buildPlanAppendix,
	newNudgeState,
	recordAgentActivity,
	recordEscalation,
	recordNudge,
	recordProgress,
	NUDGE_CUSTOM_TYPE,
	type NudgeState,
} from "./nudge.ts";
import { clearPlan, loadPlan, planKey, projectKey, savePlan } from "./persistence.ts";
import { makeDashboardComponent } from "./dashboard.ts";


import {
	appendTasks,
	initList,
	markBlocked,
	markDone,
	markDropped,
	markStarted,
	openCount,
	renderTaskList,
	unblock,
	type TaskList,
} from "./store.ts";

/** Structured details returned by every mutating op (reconstructible state). */
interface TasksDetails {
	open: number;
	total: number;
	done: number;
	current: string;
}

function detailsOf(list: TaskList | null): TasksDetails {
	if (!list) return { open: 0, total: 0, done: 0, current: "" };
	const s = planStats(list);
	return { open: s.open, total: s.total, done: s.done, current: s.current };
}

export default function (pi: ExtensionAPI): void {
	if (process.env.PI_TASKS_DISABLED === "1") return;

	const dataDir = process.env.PI_CODING_AGENT_DIR ?? (process.env.HOME ? `${process.env.HOME}/.pi/agent` : ".");
	const nudge: NudgeState = newNudgeState();
	let uiHost:
		| {
				mode?: string;
				hasUI: boolean;
				ui: {
					setStatus(key: string, text: string | undefined): void;
					setWidget(
						key: string,
						content: string[] | ((tui: never, theme: never) => Component & { dispose?(): void }) | undefined,
						options?: { placement?: "aboveEditor" | "belowEditor" },
					): void;
					notify(message: string, type?: "info" | "warning" | "error"): void;
				};
				cwd?: string;
		  }
		| undefined = undefined;

	/**
	 * Storage key of the active list: the pi session id when available
	 * (stable across resume/restart — read back from the session header),
	 * else a project-path fallback. Every context-bearing callback refreshes
	 * this so switching sessions switches lists.
	 */
	let activeKey = planKey(undefined, process.cwd());

	const syncKey = (ctx: { cwd?: string; sessionManager?: { getSessionId(): string } } | undefined): string => {
		const cwd = ctx?.cwd ?? process.cwd();
		let sid: string | undefined;
		try {
			sid = ctx?.sessionManager?.getSessionId() || undefined;
		} catch {
			sid = undefined;
		}
		activeKey = planKey(sid, cwd);
		return activeKey;
	};

	const loadFor = (): TaskList | null => loadPlan(dataDir, activeKey);

	const updateUI = (): void => {
		const ctx = uiHost;
		if (!ctx?.hasUI) return;
		try {
			const list = loadFor();
			const key = "tasks";
			if (!list || openCount(list) === 0) {
				ctx.ui.setStatus(key, undefined);
				ctx.ui.setWidget(key, undefined);
				return;
			}
			const s = planStats(list);
			ctx.ui.setStatus(key, `tasks ${s.done}/${s.total} · ▸ ${s.current}`);
			// Ambient widget above the editor while work is outstanding (≤10 lines).
			ctx.ui.setWidget(key, widgetLines(list));
		} catch {
			// UI best-effort only (print/rpc/teardown)
		}
	};

	function widgetLines(list: TaskList): string[] {
		const fakeTheme: ThemeLike = {
			fg: (_c, ...t) => t.join(""),
			bold: (t) => t,
		};
		return renderPlanThemed(list, fakeTheme).slice(0, 9);
	}

	const escalateToUser = (list: TaskList): void => {
		try {
			if (uiHost?.hasUI) uiHost.ui.notify(`tasks: still ${openCount(list)} open after repeated nudges. Taking over or closing items is up to you.`, "warning");
			if (uiHost?.hasUI) uiHost.ui.setStatus("tasks", "tasks STUCK");
		} catch {
			// best-effort
		}
	};

	// ------------------------------------------------------------------
	// Tool: tasks
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "tasks",
		label: "Tasks",
		promptSnippet: "Track a todo list: init it when starting multi-step work, update items as you go (done/start/drop/block)",
		promptGuidelines: [
			"tasks: always call tasks op=init with your todos before starting substantial multi-step work — it keeps you and the user aligned on what is left.",
			"tasks: keep items as short verbatim actions (what, not how); address them by their EXACT text.",
			"tasks: update the list as you work — mark done the item you just finished, start the item you are working on, drop items you will not do, block items waiting on something (with a reason).",
			"tasks: call tasks op=view whenever you need the current state; the list persists across turns and sessions.",
			"tasks: you WILL be nudged if you stop while items are open — before stopping, explicitly close every open item (done/drop/block).",
		],
		description: [
			"Todo-list tracking for the current work: tasks with statuses (pending/in-progress/done/dropped/blocked), optionally grouped into phases. The list persists per session across turns and CLI restarts.",
			"Workflow: op=init (todos) → as you work, op=start the current item, op=done when finished, op=drop for abandoned items, op=block (with reason) for blocked ones, op=append to add more, op=view to see the list.",
			"Items are addressed by their EXACT text — copy the item text verbatim from the most recent view; do not paraphrase. Duplicate texts are rejected.",
			"Completing an item auto-promotes the next open one as the active item. op=clear deletes the list; re-init over an active list requires replace=true.",
			"You will be nudged with a user message if you stop while items remain open.",
		].join(" "),
		parameters: Type.Object({
			op: StringEnum(
				["init", "view", "start", "done", "drop", "block", "unblock", "append", "clear"] as const,
				{
					description:
						"Operation: init=create the list; view=show the list; start=mark item as the one being worked on; done=mark finished; drop=abandon; block=waiting (needs reason); unblock=re-open; append=add items; clear=delete the list",
				},
			),
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
			replace: Type.Optional(Type.Boolean({ description: "op=init over an existing list with open items: must be true to discard it" })),
		}),
		renderCall(args, theme, context) {
			const text = `tasks ${String(args.op)}${args.task ? ` · ${String(args.task)}` : ""}`;
			return lineComponent(theme.fg("toolTitle", theme.bold("tasks")) + theme.fg("dim", ` ${text.replace(/^tasks /, "")}`), context);
		},
		renderResult(result, options, theme, context) {
			const details = result.details as TasksDetails | undefined;
			if (options.expanded) {
				const list = (syncKey(context), loadFor());
				if (list) {
					const body = ["", ...renderPlanThemed(list, theme)].map((l) => l).join("\n");
					return lineComponent(body, context);
				}
			}
			if (details && typeof details.open === "number") {
				const summary =
					details.open === 0
						? theme.fg("success", "all done")
						: `${theme.fg("accent", `${details.open} open`)}${theme.fg("dim", ` · ${details.total} total${details.current ? ` · next: ${details.current}` : ""}`)}`;
				return lineComponent(summary, context);
			}
			const fallback =
				(Array.isArray(result.content) ? result.content : [])
					.filter((c) => typeof c === "object" && c !== null && "text" in c && typeof (c as { text?: unknown }).text === "string")
					.map((c) => (c as { text: string }).text)
					.join(" ")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 150) || "";

			return lineComponent(theme.fg("muted", fallback || "ok"), context);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd ?? process.cwd();
			const key = syncKey(ctx);
			const now = Date.now();
			const requireTask = (): string => {
				const t = params.task ?? "";
				if (t.trim() === "") throw new Error("task is required (the exact item text)");
				return t;
			};
			const persistAndRender = (p: TaskList) => {
				savePlan(dataDir, p);
				updateUI();
				nudge.lowWater = Math.min(nudge.lowWater, openCount(p));
				if (openCount(p) === 0) resetNudges();
				return { content: [{ type: "text" as const, text: renderTaskList(p) }], details: detailsOf(p) };
			};
			switch (params.op) {
				case "init": {
					const todos = params.todos ?? [];
					const phases = params.phases ?? [];
					if (todos.length === 0 && phases.length === 0) throw new Error("todos (or phases) is required for init");
					const existing = loadPlan(dataDir, key);
					if (existing && openCount(existing) > 0 && params.replace !== true) {
						throw new Error(
							`a list with ${openCount(existing)} open item(s) already exists. Finish it, op=clear, or pass replace=true to discard it`,
						);
					}
					let p: TaskList;
					try {
						p = initList({ project: key, todos, phases, now });
					} catch (err) {
						throw new Error(err instanceof Error ? err.message : String(err));
					}
					resetNudges();
					return persistAndRender(p);
				}
				case "view": {
					const p = loadPlan(dataDir, key);
					if (!p)
						return {
							content: [{ type: "text" as const, text: "no tasks yet — call tasks op=init with todos" }],
							details: detailsOf(null),
						};
					updateUI();
					return { content: [{ type: "text" as const, text: renderTaskList(p) }], details: detailsOf(p) };
				}
				case "start": {
					const p = needList();
					const r = markStarted(p, requireTask(), now);
					if (!r.ok) throw new Error(r.error);
					return persistAndRender(p);
				}
				case "done": {
					const p = needList();
					const r = markDone(p, requireTask(), now);
					if (!r.ok) throw new Error(r.error);
					return persistAndRender(p);
				}
				case "drop": {
					const p = needList();
					const r = markDropped(p, requireTask(), now);
					if (!r.ok) throw new Error(r.error);
					return persistAndRender(p);
				}
				case "block": {
					const p = needList();
					const r = markBlocked(p, requireTask(), params.reason ?? "", now);
					if (!r.ok) throw new Error(r.error);
					return persistAndRender(p);
				}
				case "unblock": {
					const p = needList();
					const r = unblock(p, requireTask(), now);
					if (!r.ok) throw new Error(r.error);
					return persistAndRender(p);
				}
				case "append": {
					const p = needList();
					const todos = params.todos ?? [];
					if (todos.length === 0) throw new Error("todos is required for append");
					const r = appendTasks(p, todos, params.phase, now);
					if (!r.ok) throw new Error(r.error);
					return persistAndRender(p);
				}
				case "clear": {
					const removed = clearPlan(dataDir, key);
					resetNudges();
					updateUI();
					return {
						content: [{ type: "text" as const, text: removed ? "list cleared" : "nothing to clear" }],
						details: detailsOf(null),
					};
				}
			}
		},
	});

	function needList(): TaskList {
		const p = loadPlan(dataDir, activeKey);
		if (!p) throw new Error("no tasks yet — call tasks op=init with todos first");
		return p;
	}

	function resetNudges(): void {
		nudge.lastNudgeAt = 0;
		nudge.agentActedSinceNudge = true;
		nudge.consecutive = 0;
		nudge.lowWater = Number.POSITIVE_INFINITY;
		try {
			uiHost?.ui.setStatus("tasks", undefined);
		} catch {
			// best-effort
		}
	}

	// ------------------------------------------------------------------
	// Nudge: agent_settled + message_end
	// ------------------------------------------------------------------

	pi.on("before_agent_start", (event, ctx) => {
		syncKey(ctx);
		const list = loadFor();
		if (!list) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildPlanAppendix(list)}`,
		};
	});

	pi.on("message_end", (event) => {
		if (event.message?.role === "assistant") recordAgentActivity(nudge);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const list = (syncKey(ctx), loadFor());
		recordProgress(nudge, list);
		const decision = evaluateNudge(nudge, list, Date.now());
		if (decision.action === "none") return;
		if (decision.action === "escalate") {
			escalateToUser(list!);
			recordEscalation(nudge);
			return;
		}
		try {
			// Deliver as a real user message through the prompt flow — the same
			// path as the human typing it — so the model reliably starts a new
			// turn and treats the reminder as instruction, not ambient noise.
			void pi.sendUserMessage(formatNudgeText(list!), { deliverAs: "followUp" });
			recordNudge(nudge, Date.now());
			updateUI();
		} catch (err) {
			// nudge is best-effort
			console.error("tasks nudge failed:", String(err));
		}
	});

	pi.registerMessageRenderer(NUDGE_CUSTOM_TYPE, (message, _options, theme) => {
		const t = theme as unknown as ThemeLike;
		const details = message.details as { open?: number; next?: string } | undefined;
		const open = details?.open ?? 0;
		const head = t.fg("warning", t.bold(`⚠ tasks: ${open} open`)) + (details?.next ? t.fg("dim", ` — next: ${details.next}`) : "");
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(`${head}\n${content}`, 1, 0);
	});

	// ------------------------------------------------------------------
	// /tasks command — fullscreen panel in TUI mode, notify otherwise
	// ------------------------------------------------------------------

	pi.registerCommand("tasks", {
		description: "Open the tasks panel (progress, phases, inline actions)",
		handler: async (_args, cmdCtx) => {
			uiHost = cmdCtx;
			const key = syncKey(cmdCtx);
			if (cmdCtx.mode === "tui" && cmdCtx.hasUI) {
				await cmdCtx.ui.custom<null>(
					(tui, theme, _keybindings, done) =>
						makeDashboardComponent({ dataDir, planKey: key }, tui, theme as unknown as ThemeLike, () => done(null)),
				);
				updateUI();
				return;
			}
			const list = loadFor();
			updateUI();
			if (!list) {
				if (cmdCtx.hasUI) cmdCtx.ui.notify("tasks: no tasks yet — ask the model to init the list", "info");
				return;
			}
			if (cmdCtx.hasUI) cmdCtx.ui.notify(renderTaskList(list), "info");
		},
	});

	// ------------------------------------------------------------------
	// Session events
	// ------------------------------------------------------------------

	pi.on("session_start", (_event, eventCtx) => {
		uiHost = eventCtx;
		resetNudges(); // a different session must not inherit this session's nudge history
		syncKey(eventCtx);
		updateUI();
	});

	pi.on("session_shutdown", () => {
		try {
			uiHost?.ui.setStatus("tasks", undefined);
			uiHost?.ui.setWidget("tasks", undefined);
		} catch {
			// teardown race — best-effort
		}
		uiHost = undefined;
	});
}

/** Reuse the previous component for this row when possible (kills flicker). */
function lineComponent(content: string, context: { lastComponent?: Component }): Text & Component {
	const prev = context.lastComponent as Text | undefined;
	const text = prev && typeof prev.setText === "function" ? prev : new Text("", 0, 0);
	text.setText(content);
	return text as Text & Component;
}

