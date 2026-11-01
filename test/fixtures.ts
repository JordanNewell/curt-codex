/**
 * Synthetic rollout fixtures. Every string here is invented for the tests —
 * no real conversation content. Shapes mirror rollout files written by
 * codex-cli 0.146.0 (verified 2026-11-01).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const SESSION_B = "11111111-2222-4333-8444-555555555555";
export const SESSION_C = "99999999-8888-4777-8666-777777777777";

interface Line {
	t: string;
	p: Record<string, unknown>;
}

function line(timestamp: string, type: string, payload: Record<string, unknown>): string {
	return JSON.stringify({ timestamp, type, payload });
}

function meta(id: string, timestamp: string): string {
	return line(timestamp, "session_meta", {
		id,
		timestamp,
		cwd: "C:\\synthetic\\project",
		originator: "codex_exec",
		cli_version: "0.146.0",
		source: "exec",
		model_provider: "synthetic-provider",
		session_id: id,
		thread_source: null,
		history_mode: "legacy",
		context_window: { model_context_window: 258400 },
		base_instructions: "SYNTHETIC BASE INSTRUCTIONS — never emitted",
	});
}

function turnContext(timestamp: string, model: string): string {
	return line(timestamp, "turn_context", {
		cwd: "C:\\synthetic\\project",
		model,
		effort: null,
		summary: "",
		approval_policy: "never",
		sandbox_policy: { type: "workspace-write" },
		current_date: "2026-11-01",
		timezone: "America/New_York",
		turn_id: "synthetic-turn",
		personality: null,
		permission_profile: {},
		collaboration_mode: {},
		workspace_roots: ["C:\\synthetic\\project"],
		realtime_active: false,
		approvals_reviewer: null,
		multi_agent_version: null,
	});
}

function worldState(timestamp: string): string {
	return line(timestamp, "world_state", {
		full: { synthetic: "environment snapshot" },
		state: { cwd: "C:\\synthetic\\project" },
	});
}

function userMessage(timestamp: string, text: string): string {
	return line(timestamp, "response_item", {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text }],
		id: "msg_syn_u",
		internal_chat_message_metadata_passthrough: null,
	});
}

function assistantMessage(timestamp: string, text: string): string {
	return line(timestamp, "response_item", {
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text }],
		id: "msg_syn_a",
		internal_chat_message_metadata_passthrough: null,
	});
}

function developerMessage(timestamp: string, text: string): string {
	return line(timestamp, "response_item", {
		type: "message",
		role: "developer",
		content: [{ type: "input_text", text }],
		id: "msg_syn_d",
		internal_chat_message_metadata_passthrough: null,
	});
}

function reasoning(timestamp: string, text: string): string {
	return line(timestamp, "response_item", {
		type: "reasoning",
		id: "rs_syn",
		summary: [{ type: "summary_text", text }],
		encrypted_content: "SYNTHETIC-ENCRYPTED-BLOB",
	});
}

function functionCall(timestamp: string, callId: string, name: string, args: string): string {
	return line(timestamp, "response_item", {
		type: "function_call",
		id: "fc_syn",
		call_id: callId,
		name,
		arguments: args,
	});
}

function functionCallOutput(timestamp: string, callId: string, output: string): string {
	return line(timestamp, "response_item", {
		type: "function_call_output",
		call_id: callId,
		output,
	});
}

function tokenCount(timestamp: string, total: Record<string, number>, last: Record<string, number>): string {
	return line(timestamp, "event_msg", {
		type: "token_count",
		info: {
			total_token_usage: {
				input_tokens: 0,
				cached_input_tokens: 0,
				cache_write_input_tokens: 0,
				output_tokens: 0,
				reasoning_output_tokens: 0,
				total_tokens: 0,
				...total,
			},
			last_token_usage: {
				input_tokens: 0,
				cached_input_tokens: 0,
				cache_write_input_tokens: 0,
				output_tokens: 0,
				reasoning_output_tokens: 0,
				total_tokens: 0,
				...last,
			},
			model_context_window: 258400,
		},
		rate_limits: {},
	});
}

function taskStarted(timestamp: string): string {
	return line(timestamp, "event_msg", {
		type: "task_started",
		started_at: timestamp,
		turn_id: "synthetic-turn",
		collaboration_mode_kind: null,
		model_context_window: 258400,
	});
}

function userMessageEvent(timestamp: string, message: string): string {
	return line(timestamp, "event_msg", {
		type: "user_message",
		message,
		text_elements: [],
		images: [],
		audio: [],
		local_images: [],
		local_audio: [],
	});
}

function agentMessageEvent(timestamp: string, message: string): string {
	return line(timestamp, "event_msg", {
		type: "agent_message",
		message,
		phase: null,
		memory_citation: null,
	});
}

function taskComplete(timestamp: string): string {
	return line(timestamp, "event_msg", {
		type: "task_complete",
		completed_at: timestamp,
		started_at: timestamp,
		duration_ms: 1000,
		time_to_first_token_ms: 100,
		last_agent_message: "",
		turn_id: "synthetic-turn",
	});
}

/**
 * Session A: the full zoo. Developer bootstrap + <environment_context> turn,
 * reasoning -> assistant thinking, a function_call/function_call_output pair
 * (arguments as JSON string, output as JSON document), a second user turn,
 * an unmatched function_call (aborted), an orphan function_call_output, a
 * malformed JSON line, an unknown line type, and an unknown item type.
 */
function sessionA(): string[] {
	return [
		meta(SESSION_A, "2026-11-01T19:00:00.000Z"),
		taskStarted("2026-11-01T19:00:00.005Z"),
		developerMessage("2026-11-01T19:00:00.010Z", "<permissions instructions>\nSYNTHETIC sandbox instructions."),
		developerMessage("2026-11-01T19:00:00.011Z", "<user_instructions>\nSYNTHETIC AGENTS.md instructions."),
		worldState("2026-11-01T19:00:00.012Z"),
		turnContext("2026-11-01T19:00:00.015Z", "synthetic-model-a"),
		userMessage("2026-11-01T19:00:00.020Z", "<environment_context>\n  <cwd>C:\\synthetic\\project</cwd>\n</environment_context>"),
		userMessage("2026-11-01T19:00:01.000Z", "Synthetic first prompt for fixture session A."),
		userMessageEvent("2026-11-01T19:00:01.001Z", "Synthetic first prompt for fixture session A."),
		reasoning("2026-11-01T19:00:02.000Z", "Synthetic reasoning trace part one."),
		reasoning("2026-11-01T19:00:02.500Z", "Synthetic reasoning trace part two."),
		functionCall("2026-11-01T19:00:03.000Z", "call_syn1", "synthetic_tool", '{"path":"synthetic.txt"}'),
		functionCallOutput("2026-11-01T19:00:04.000Z", "call_syn1", '{"output":"synthetic tool output body","exit_code":0}'),
		assistantMessage("2026-11-01T19:00:05.000Z", "Synthetic answer one from fixture session A."),
		agentMessageEvent("2026-11-01T19:00:05.001Z", "Synthetic answer one from fixture session A."),
		tokenCount(
			"2026-11-01T19:00:05.500Z",
			{ input_tokens: 1200, output_tokens: 90, reasoning_output_tokens: 40, total_tokens: 1330 },
			{ input_tokens: 1200, output_tokens: 90, reasoning_output_tokens: 40, total_tokens: 1330 },
		),
		userMessage("2026-11-01T19:00:10.000Z", "Synthetic second prompt for fixture session A."),
		functionCall("2026-11-01T19:00:11.000Z", "call_syn_aborted", "synthetic_tool", '{"path":"gone.txt"}'),
		assistantMessage("2026-11-01T19:00:12.000Z", "Synthetic final answer."),
		functionCallOutput("2026-11-01T19:00:13.000Z", "call_syn_orphan", "orphan synthetic output"),
		tokenCount(
			"2026-11-01T19:00:14.000Z",
			{ input_tokens: 2000, output_tokens: 200, total_tokens: 2200 },
			{ input_tokens: 800, output_tokens: 110, total_tokens: 910 },
		),
		taskComplete("2026-11-01T19:00:15.000Z"),
		"{not valid json",
		line("2026-11-01T19:00:16.000Z", "future_line_type", { whatever: 1 }),
		line("2026-11-01T19:00:17.000Z", "response_item", { type: "web_search_call", id: "ws_syn" }),
	];
}

/**
 * Session B: minimal — one user turn, an empty assistant item (dropped),
 * one assistant answer, no tool activity, one token_count.
 */
function sessionB(): string[] {
	return [
		meta(SESSION_B, "2026-11-01T20:00:00.000Z"),
		turnContext("2026-11-01T20:00:00.010Z", "synthetic-model-b"),
		worldState("2026-11-01T20:00:00.020Z"),
		taskStarted("2026-11-01T20:00:00.030Z"),
		userMessage("2026-11-01T20:00:01.000Z", "Synthetic prompt for fixture session B, the only user turn."),
		line("2026-11-01T20:00:02.000Z", "response_item", {
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "" }],
			id: "msg_syn_empty",
		}),
		assistantMessage("2026-11-01T20:00:03.000Z", "Synthetic session B answer."),
		tokenCount(
			"2026-11-01T20:00:04.000Z",
			{ input_tokens: 100, output_tokens: 20, total_tokens: 120 },
			{ input_tokens: 100, output_tokens: 20, total_tokens: 120 },
		),
		taskComplete("2026-11-01T20:00:05.000Z"),
	];
}

/**
 * Session C: unusable — session_meta + lifecycle events only, no real turns
 * (mirrors a rollout whose API calls all failed). convertRollout returns null.
 */
function sessionC(): string[] {
	return [
		meta(SESSION_C, "2026-11-01T21:00:00.000Z"),
		taskStarted("2026-11-01T21:00:00.010Z"),
		userMessage("2026-11-01T21:00:01.000Z", "<environment_context>\n  <cwd>C:\\synthetic\\project</cwd>\n</environment_context>"),
		taskComplete("2026-11-01T21:00:03.000Z"),
	];
}

/** Codex sessions tree layout: <root>/YYYY/MM/DD/rollout-*.jsonl */
export function buildFixtureTree(root: string): void {
	const day = join(root, "2026", "11", "01");
	mkdirSync(day, { recursive: true });
	writeFileSync(join(day, "rollout-2026-11-01T19-00-00-a.jsonl"), sessionA().join("\n") + "\n");
	writeFileSync(join(day, "rollout-2026-11-01T20-00-00-b.jsonl"), sessionB().join("\n") + "\n");
	writeFileSync(join(day, "rollout-2026-11-01T21-00-00-c.jsonl"), sessionC().join("\n") + "\n");
}
