/**
 * stub-tasks.mjs — OpenAI-compatible chat-completions stub for pi-tasks E2E.
 *
 * Reply logic:
 *   - History contains "Goal:"          -> plan exists: child reply "OK".
 *   - History contains a role:"tool"    -> main 2nd turn: report plan state.
 *   - Otherwise                          -> main 1st turn: tasks op=init tool call.
 *
 * Every request is appended as one JSON line to stub-requests.jsonl.
 */
import * as http from "node:http";
import * as fs from "node:fs";

const PORT = Number(process.argv[2] ?? 8788);
const HOST = "127.0.0.1";
const LOG_URL = new URL("./stub-tasks-requests.jsonl", import.meta.url);

const MODEL = "stub-tasks";
const TOOL_NAME = "tasks";
const TOOL_CALL_ID = "call_stub_tasks";
const USAGE = { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80 };

const TOOL_ARGS = JSON.stringify({
	op: "init",
	goal: "Verify pi-tasks works end to end",
	todos: ["call tasks op=init", "mark one done", "stop with one open"],
});

function textOf(m) {
	if (!m || typeof m !== "object") return "";
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content.map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : "")).join(" ");
	}
	return "";
}

function planReply(msgs) {
	const all = msgs.map(textOf).join("\n");
	if (all.includes("Goal:")) return { kind: "text", text: "OK" };
	if (msgs.some((m) => m.role === "tool")) {
		const hasGoal = all.includes("Goal: Verify pi-tasks works end to end");
		return { kind: "text", text: `tasks-inited: ${hasGoal ? "yes" : "no"}` };
	}
	return { kind: "tool", tool_name: TOOL_NAME, tool_call_id: TOOL_CALL_ID, tool_args: TOOL_ARGS };
}

function sseFrame(created, id, delta, finishReason) {
	const payload = {
		id,
		object: "chat.completion.chunk",
		created,
		model: MODEL,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	return "data: " + JSON.stringify(payload) + "\n\n";
}

function streamReply(res, plan) {
	const created = Math.floor(Date.now() / 1000);
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	if (plan.kind === "tool") {
		res.write(sseFrame(created, "c1", { role: "assistant", content: null }, null));
		res.write(
			sseFrame(created, "c2", { tool_calls: [{ index: 0, id: TOOL_CALL_ID, type: "function", function: { name: TOOL_NAME, arguments: TOOL_ARGS } }] }, null),
		);
		res.write(sseFrame(created, "c3", {}, "tool_calls"));
	} else {
		res.write(sseFrame(created, "c1", { role: "assistant", content: "" }, null));
		res.write(sseFrame(created, "c2", { content: plan.text }, null));
		res.write(sseFrame(created, "c3", {}, "stop"));
	}
	res.write("\ndata\n");
	res.end();
}

function jsonReply(res, plan) {
	const message =
		plan.kind === "tool"
			? { role: "assistant", content: null, tool_calls: [{ id: TOOL_CALL_ID, type: "function", function: { name: TOOL_NAME, arguments: TOOL_ARGS } }] }
			: { role: "assistant", content: plan.text };
	res.writeHead(200, { "content-type": "application/json" });
	res.end(
		JSON.stringify({
			id: "chatcmpl-stub-tasks",
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: MODEL,
			choices: [{ index: 0, message, finish_reason: plan.kind === "tool" ? "tool_calls" : "stop" }],
			usage: USAGE,
		}),
	);
}

function handleRequest(req, res) {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		let body;
		try {
			body = JSON.parse(raw || "{}");
		} catch {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "bad json" } }));
			return;
		}
		const msgs = Array.isArray(body.messages) ? body.messages : [];
		try {
			fs.appendFileSync(LOG_URL, `${JSON.stringify({ ts: Date.now(), msgs: msgs.map((m) => ({ role: m?.role ?? "", content: textOf(m) })) })}\n`);
		} catch {
			// best-effort logging
		}
		const plan = planReply(msgs);
		if (body.stream === true) streamReply(res, plan);
		else jsonReply(res, plan);
	});
}

const server = http.createServer(handleRequest);
server.listen(PORT, HOST, () => {
	console.log(`stub-tasks listening on ${HOST}:${PORT}`);
});
