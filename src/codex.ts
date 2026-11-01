/**
 * Convert OpenAI Codex CLI session rollout files (`~/.codex/sessions/`
 * year/month/day `rollout-*.jsonl`) into .curt conversations, and .curt conversations into
 * Codex rollout JSONL (the format Codex writes natively — and the format both
 * `hermes sessions import` and OpenClaw's `sessions import` consume as a
 * third-party transcript source).
 *
 * Input schema verified read-only against rollout files written by
 * codex-cli 0.146.0 on 2026-11-01. See README.md for the full mapping and
 * provenance.
 *
 * Privacy: this module never emits instruction/system content
 * (`session_meta.base_instructions`, developer-role messages,
 * `<user_instructions>`/`<environment_context>` bootstrap turns), nor paths
 * (`cwd`, `workspace_roots`) — they are skipped and counted. Conversation
 * content flows through by design (the .curt output is record-equivalent),
 * but the metadata layer emits nothing identifying.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	type CurtConversation,
	type CurtMessage,
	parseCurt,
	serializeCurt,
} from "curt-format";

export const GENERATOR = "curt-codex@1.0.0";

/** Stable registry extensions this converter emits (see dot_curt EXTENSIONS.md). */
export const EXTENSIONS = ["usage-metadata"] as const;

export interface ConvertStats {
	/** Messages emitted into the conversation, by role. */
	roles: { user: number; assistant: number; tool: number };
	/** event_msg lines (turn lifecycle telemetry; duplicates response_item content). */
	skippedEventMsgs: number;
	/** world_state lines (environment snapshots; skipped). */
	skippedWorldState: number;
	/** Bootstrap turns skipped: developer-role messages and
	 *  `<environment_context>`/`<user_instructions>`-wrapped user turns. */
	skippedBootstrap: number;
	/** Lines with unparseable JSON, or non-object lines. */
	malformedLines: number;
	/** Lines whose top-level `type` is not part of the known schema. */
	unknownLineTypes: number;
	/** response_items whose payload `type` is not part of the known schema. */
	unknownItemTypes: number;
	/** reasoning response_items encountered (thinking passthrough). */
	reasoningItems: number;
	/** Reasoning text never attached to a following assistant message. */
	orphanReasoning: number;
	/** function_call items never answered by a function_call_output. */
	unmatchedToolCalls: number;
	/** function_call_output items with no preceding function_call. */
	unmatchedToolResults: number;
	/** User/assistant items dropped for empty content. */
	emptyDropped: number;
	/** token_count event_msg lines consumed for usage metadata. */
	tokenCountEvents: number;
	/** Known identifier/path/instruction fields dropped on purpose (aggregate). */
	redactedFields: number;
	/** Tool outputs that were JSON documents, re-serialized as text. */
	jsonPayloads: number;
}

export interface ConvertResult {
	conversation: CurtConversation;
	stats: ConvertStats;
}

export interface ConvertOptions {
	/** Derived title cap, matching the Curtis convention (60 chars). */
	titleMax?: number;
}

// ---- Codex rollout input types (structural; everything optional) ----

interface RolloutLine {
	timestamp?: unknown;
	type?: unknown;
	payload?: unknown;
	[key: string]: unknown;
}

interface ContentPart {
	type?: unknown;
	text?: unknown;
	[key: string]: unknown;
}

interface ResponseItem {
	type?: unknown;
	role?: unknown;
	content?: unknown;
	/** reasoning */
	summary?: unknown;
	/** function_call */
	name?: unknown;
	arguments?: unknown;
	call_id?: unknown;
	/** function_call_output */
	output?: unknown;
	[key: string]: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
	return typeof v === "string";
}

function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

/**
 * Codex rollout timestamps are ISO-8601 UTC strings with milliseconds
 * (`2026-11-01T19:29:59.707Z`) — normalize to epoch milliseconds; garbage
 * becomes 0.
 */
export function parseIsoMs(v: unknown): number {
	if (!isStr(v) || v.length === 0) return 0;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : 0;
}

/** Inverse of parseIsoMs, for the emit direction. */
export function isoTs(ms: number): string {
	return new Date(ms > 0 ? ms : 0).toISOString();
}

/** First user text -> display title (single line, capped). */
export function deriveTitle(text: string, max = 60): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Bootstrap detection: Codex seeds each session with developer-role
 * instruction turns (`<permissions instructions>`, `<user_instructions>`,
 * skills/plugins manifests) and a `<environment_context>` user turn. None of
 * that is conversation. A user message whose first text starts with one of
 * these wrappers is environment, not prompt.
 */
const BOOTSTRAP_PREFIXES = ["<environment_context>", "<user_instructions>"] as const;

export function isBootstrapTurn(items: { type?: unknown; text?: unknown }[]): boolean {
	const first = items.find((p) => isStr(p.text) && p.text.length > 0);
	if (!first) return false;
	return BOOTSTRAP_PREFIXES.some((p) => (first.text as string).startsWith(p));
}

/** Flatten a message `content` array into one text blob. */
export function contentText(content: unknown, stats: ConvertStats): string {
	if (content === undefined || content === null) return "";
	if (isStr(content)) return content;
	if (!Array.isArray(content)) {
		stats.malformedLines++;
		return "";
	}
	const parts: string[] = [];
	for (const part of content) {
		if (!isObj(part)) {
			stats.malformedLines++;
			continue;
		}
		if (isStr(part.text)) parts.push(part.text);
	}
	return parts.join("\n");
}

/**
 * Reasoning items carry `summary[]` and/or `content[]` parts of type
 * `summary_text` / `reasoning_text`. Join both, summary first.
 */
export function reasoningText(item: ResponseItem, stats: ConvertStats): string {
	const parts: string[] = [];
	for (const key of ["summary", "content"]) {
		const arr = item[key];
		if (!Array.isArray(arr)) continue;
		for (const part of arr) {
			if (isObj(part) && isStr(part.text) && part.text.length > 0) parts.push(part.text);
		}
	}
	if (item.encrypted_content !== undefined) stats.redactedFields++;
	return parts.join("\n\n");
}

/**
 * `function_call.arguments` is a JSON-encoded string per the Responses API;
 * parsed so .curt carries the value. Malformed JSON is kept verbatim as text
 * (never dropped).
 */
export function parseArguments(raw: unknown): unknown {
	if (!isStr(raw) || raw.length === 0) return raw;
	const c = raw[0]!;
	if (c === "{" || c === "[") {
		try {
			return JSON.parse(raw);
		} catch {
			// keep verbatim
		}
	}
	return raw;
}

/**
 * `function_call_output.output` is a string in the verified corpus (Codex
 * stores the tool result body). JSON documents that parse as objects are
 * re-serialized canonically and counted, like other structured payloads.
 */
export function normalizeToolOutput(raw: unknown, stats: ConvertStats): string {
	if (raw === undefined || raw === null) return "";
	if (isObj(raw) || Array.isArray(raw)) {
		stats.redactedFields++;
		return JSON.stringify(raw);
	}
	if (!isStr(raw)) {
		stats.malformedLines++;
		return "";
	}
	if (raw.length > 1 && (raw[0] === "{" || raw[0] === "[")) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (isObj(parsed) || Array.isArray(parsed)) {
				stats.jsonPayloads++;
				return JSON.stringify(parsed);
			}
		} catch {
			// plain text that happens to start with a brace — emit verbatim
		}
	}
	return raw;
}

export function emptyStats(): ConvertStats {
	return {
		roles: { user: 0, assistant: 0, tool: 0 },
		skippedEventMsgs: 0,
		skippedWorldState: 0,
		skippedBootstrap: 0,
		malformedLines: 0,
		unknownLineTypes: 0,
		unknownItemTypes: 0,
		reasoningItems: 0,
		orphanReasoning: 0,
		unmatchedToolCalls: 0,
		unmatchedToolResults: 0,
		emptyDropped: 0,
		tokenCountEvents: 0,
		redactedFields: 0,
		jsonPayloads: 0,
	};
}

export function addStats(a: ConvertStats, b: ConvertStats): ConvertStats {
	a.roles.user += b.roles.user;
	a.roles.assistant += b.roles.assistant;
	a.roles.tool += b.roles.tool;
	a.skippedEventMsgs += b.skippedEventMsgs;
	a.skippedWorldState += b.skippedWorldState;
	a.skippedBootstrap += b.skippedBootstrap;
	a.malformedLines += b.malformedLines;
	a.unknownLineTypes += b.unknownLineTypes;
	a.unknownItemTypes += b.unknownItemTypes;
	a.reasoningItems += b.reasoningItems;
	a.orphanReasoning += b.orphanReasoning;
	a.unmatchedToolCalls += b.unmatchedToolCalls;
	a.unmatchedToolResults += b.unmatchedToolResults;
	a.emptyDropped += b.emptyDropped;
	a.tokenCountEvents += b.tokenCountEvents;
	a.redactedFields += b.redactedFields;
	a.jsonPayloads += b.jsonPayloads;
	return a;
}

interface TokenUsage {
	inputTokens?: number;
	cachedInputTokens?: number;
	cacheWriteInputTokens?: number;
	outputTokens?: number;
	reasoningOutputTokens?: number;
	totalTokens?: number;
	modelContextWindow?: number;
}

/** Extract the verified `token_count` usage shape; defensive over unknowns. */
export function parseTokenCount(payload: Record<string, unknown>): {
	total: TokenUsage;
	last: TokenUsage;
} {
	const info = isObj(payload.info) ? payload.info : {};
	const read = (u: Record<string, unknown>): TokenUsage => {
		const out: TokenUsage = {};
		if (isNum(u.input_tokens)) out.inputTokens = u.input_tokens;
		if (isNum(u.cached_input_tokens)) out.cachedInputTokens = u.cached_input_tokens;
		if (isNum(u.cache_write_input_tokens)) out.cacheWriteInputTokens = u.cache_write_input_tokens;
		if (isNum(u.output_tokens)) out.outputTokens = u.output_tokens;
		if (isNum(u.reasoning_output_tokens)) out.reasoningOutputTokens = u.reasoning_output_tokens;
		if (isNum(u.total_tokens)) out.totalTokens = u.total_tokens;
		return out;
	};
	const total = isObj(info.total_token_usage) ? read(info.total_token_usage) : {};
	const last = isObj(info.last_token_usage) ? read(info.last_token_usage) : {};
	const window = isNum(info.model_context_window) ? info.model_context_window : undefined;
	if (window !== undefined) {
		total.modelContextWindow = window;
		last.modelContextWindow = window;
	}
	return { total, last };
}

/** Convert one rollout file's text into a .curt conversation. */
export function convertRollout(text: string, options: ConvertOptions = {}): ConvertResult | null {
	const stats = emptyStats();
	const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

	let sessionId = "";
	let originator: string | undefined;
	let cliVersion: string | undefined;
	let source: string | undefined;
	let modelProvider: string | undefined;
	let model: string | undefined;

	const messagesOut: CurtMessage[] = [];
	let pendingThinking = "";
	let sawReasoning = false;
	let lastUsage: TokenUsage | undefined;
	let totalUsage: TokenUsage | undefined;

	const pushMessage = (m: CurtMessage, role: "user" | "assistant" | "tool"): boolean => {
		messagesOut.push(m);
		stats.roles[role]++;
		return true;
	};

	for (const line of lines) {
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			stats.malformedLines++;
			continue;
		}
		if (!isObj(obj)) {
			stats.malformedLines++;
			continue;
		}
		const rl = obj as RolloutLine;
		const ts = parseIsoMs(rl.timestamp);

		switch (rl.type) {
			case "session_meta": {
				const meta = isObj(rl.payload) ? rl.payload : {};
				if (isStr(meta.id)) sessionId = meta.id;
				if (isStr(meta.originator)) originator = meta.originator;
				if (isStr(meta.cli_version)) cliVersion = meta.cli_version;
				if (isStr(meta.source)) source = meta.source;
				if (isStr(meta.model_provider)) modelProvider = meta.model_provider;
				// base_instructions and cwd never leave this function; presence
				// is counted for the drop ledger.
				if (meta.base_instructions !== undefined) stats.redactedFields++;
				if (meta.cwd !== undefined) stats.redactedFields++;
				break;
			}
			case "turn_context": {
				const ctx = isObj(rl.payload) ? rl.payload : {};
				if (isStr(ctx.model)) model = ctx.model;
				if (ctx.cwd !== undefined) stats.redactedFields++;
				if (Array.isArray(ctx.workspace_roots)) stats.redactedFields++;
				break;
			}
			case "world_state":
				// Environment snapshot (full + state); not conversation.
				stats.skippedWorldState++;
				break;
			case "event_msg": {
				const ev = isObj(rl.payload) ? rl.payload : {};
				if (ev.type === "token_count") {
					stats.tokenCountEvents++;
					const { total, last } = parseTokenCount(ev);
					if (Object.keys(total).length > 0) totalUsage = total;
					if (Object.keys(last).length > 0) {
						lastUsage = last;
						// usage-metadata (stable extension): attach the turn's
						// usage to the most recent assistant message.
						for (let i = messagesOut.length - 1; i >= 0; i--) {
							if (messagesOut[i]!.role === "assistant") {
								messagesOut[i]!.tokens = { ...last };
								break;
							}
						}
					}
				}
				// user_message/agent_message events duplicate response_item
				// content; task_started/task_complete are lifecycle telemetry.
				stats.skippedEventMsgs++;
				break;
			}
			case "response_item": {
				const item = isObj(rl.payload) ? (rl.payload as ResponseItem) : ({} as ResponseItem);
				// response-item `id`s and Codex-internal metadata passthroughs
				// are plumbing; presence is counted, values dropped.
				if (item.id !== undefined) stats.redactedFields++;
				if (item.internal_chat_message_metadata_passthrough !== undefined) {
					stats.redactedFields++;
				}
				switch (item.type) {
					case "message": {
						const parts = Array.isArray(item.content)
							? (item.content as ContentPart[])
							: [];
						if (item.role === "user") {
							if (isBootstrapTurn(parts)) {
								stats.skippedBootstrap++;
								stats.redactedFields++;
								break;
							}
							const text = contentText(item.content, stats);
							if (!text) {
								stats.emptyDropped++;
								break;
							}
							pushMessage(
								{ id: "", role: "user", content: text, timestamp: ts },
								"user",
							);
						} else if (item.role === "assistant") {
							const text = contentText(item.content, stats);
							const message: CurtMessage = {
								id: "",
								role: "assistant",
								content: text,
								timestamp: ts,
							};
							if (pendingThinking) {
								message.thinking = pendingThinking;
								pendingThinking = "";
							}
							if (isStr(model) && model) message.model = model;
							if (text || message.thinking) {
								pushMessage(message, "assistant");
							} else {
								stats.emptyDropped++;
							}
						} else {
							// developer and any future role: instruction surface —
							// never emitted, content never read.
							stats.skippedBootstrap++;
							stats.redactedFields++;
						}
						break;
					}
					case "reasoning": {
						stats.reasoningItems++;
						const text = reasoningText(item, stats);
						if (pendingThinking) {
							// consecutive reasoning items join
							pendingThinking += "\n\n" + text;
						} else {
							pendingThinking = text;
							sawReasoning = true;
						}
						break;
					}
					case "function_call": {
						const call: Record<string, unknown> = {};
						if (isStr(item.call_id)) call.id = item.call_id;
						if (isStr(item.name)) call.name = item.name;
						if (item.arguments !== undefined) call.arguments = parseArguments(item.arguments);
						const message: CurtMessage = {
							id: "",
							role: "assistant",
							content: "",
							timestamp: ts,
						};
						if (pendingThinking) {
							message.thinking = pendingThinking;
							pendingThinking = "";
						}
						message.toolCalls = [call];
						if (isStr(model) && model) message.model = model;
						pushMessage(message, "assistant");
						break;
					}
					case "function_call_output": {
						const message: CurtMessage = {
							id: "",
							role: "tool",
							content: normalizeToolOutput(item.output, stats),
							timestamp: ts,
						};
						if (isStr(item.call_id)) message.toolCallId = item.call_id;
						pushMessage(message, "tool");
						break;
					}
					default:
						// local_shell_call, custom_tool_call(+output),
						// web_search_call, compaction, future types — counted,
						// never fatal.
						stats.unknownItemTypes++;
						break;
				}
				break;
			}
			default:
				stats.unknownLineTypes++;
				break;
		}
	}

	if (pendingThinking.trim()) stats.orphanReasoning++;

	// Tool linkage accounting over what was actually emitted.
	for (const m of messagesOut) {
		for (const call of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
			const id = (call as Record<string, unknown>).id;
			if (isStr(id) && !messagesOut.some((t) => t.role === "tool" && t.toolCallId === id)) {
				stats.unmatchedToolCalls++;
			}
		}
		if (m.role === "tool" && isStr(m.toolCallId)) {
			const answered = messagesOut.some((a) =>
				Array.isArray(a.toolCalls)
					? a.toolCalls.some((c) => (c as Record<string, unknown>).id === m.toolCallId)
					: false,
			);
			if (!answered) stats.unmatchedToolResults++;
		}
	}

	if (messagesOut.length === 0) return null;

	// Message ids: "<sessionId>-<n>" over emitted messages.
	const convId = sessionId || "codex-session";
	let n = 0;
	for (const m of messagesOut) m.id = `${convId}-${++n}`;

	const times = messagesOut.map((m) => m.timestamp).filter((t) => t > 0);
	const createdAt = times.length ? Math.min(...times) : 0;
	const updatedAt = times.length ? Math.max(...times) : createdAt;

	// Title: derived from the first emitted user message (rollouts store none).
	let title = "";
	for (const m of messagesOut) {
		if (m.role === "user") {
			title = deriveTitle(m.content, options.titleMax ?? 60);
			break;
		}
	}

	const conversation: CurtConversation = {
		id: convId,
		title,
		createdAt,
		updatedAt,
		messages: messagesOut,
	};

	// Minimal non-identifying session metadata.
	const meta: Record<string, unknown> = {};
	if (originator) meta.originator = originator;
	if (cliVersion) meta.cliVersion = cliVersion;
	if (source) meta.source = source;
	if (modelProvider) meta.modelProvider = modelProvider;
	if (Object.keys(meta).length > 0) conversation.codex = meta;

	if (isStr(model) && model) conversation.model = model;

	// Final cumulative token usage — numbers only.
	if (totalUsage) {
		const t: Record<string, unknown> = {};
		if (totalUsage.inputTokens !== undefined) t.inputTokens = totalUsage.inputTokens;
		if (totalUsage.cachedInputTokens !== undefined)
			t.cachedInputTokens = totalUsage.cachedInputTokens;
		if (totalUsage.cacheWriteInputTokens !== undefined)
			t.cacheWriteInputTokens = totalUsage.cacheWriteInputTokens;
		if (totalUsage.outputTokens !== undefined) t.outputTokens = totalUsage.outputTokens;
		if (totalUsage.reasoningOutputTokens !== undefined)
			t.reasoningOutputTokens = totalUsage.reasoningOutputTokens;
		if (totalUsage.totalTokens !== undefined) t.totalTokens = totalUsage.totalTokens;
		if (totalUsage.modelContextWindow !== undefined)
			t.modelContextWindow = totalUsage.modelContextWindow;
		if (Object.keys(t).length > 0) conversation.codexTokens = t;
	}

	// Orphan reasoning: emit as a trailing assistant message so the thinking
	// text survives the archive (content is empty; .curt allows that).
	if (stats.orphanReasoning > 0 && sawReasoning) {
		const m: CurtMessage = {
			id: `${convId}-${++n}`,
			role: "assistant",
			content: "",
			timestamp: updatedAt,
			thinking: pendingThinking.trim(),
		};
		messagesOut.push(m);
	}

	return { conversation, stats };
}

/** Serialize with round-trip validation. Returns null if the output fails `parseCurt`. */
export function serializeValidated(conversation: CurtConversation): string | null {
	const body = serializeCurt(conversation, GENERATOR, [...EXTENSIONS]);
	return parseCurt(body) ? body : null;
}

/**
 * Resolve a .curt output path against on-disk content. Identical content
 * overwrites in place (idempotent re-runs stay quiet); differing content is
 * a collision and gets a -N suffix instead of silently losing writes.
 */
export function resolveCurtWritePath(
	filePath: string,
	body: string,
): { path: string; collided: boolean } {
	if (!existsSync(filePath)) return { path: filePath, collided: false };
	if (readFileSync(filePath, "utf8") === body) return { path: filePath, collided: false };
	const stem = filePath.slice(0, -".curt".length);
	let n = 2;
	let target = `${stem}-2.curt`;
	while (existsSync(target)) target = `${stem}-${++n}.curt`;
	return { path: target, collided: true };
}

// ---- Direction 2: .curt -> Codex rollout JSONL ----

/**
 * Convert one .curt conversation into Codex rollout JSONL — the native
 * format `codex` writes, and the transcript format both `hermes sessions
 * import` and OpenClaw's `sessions import` consume from third-party sources.
 *
 * Line shape mirrors real rollouts: `session_meta` first, then
 * `response_item` lines (`message`, `reasoning`, `function_call`,
 * `function_call_output`), then a final `event_msg` `token_count` when the
 * archive carries usage rollups. Deterministic: same .curt in, byte-identical
 * JSONL out.
 */
export function emitRolloutJsonl(conversation: CurtConversation): string {
	const lines: Record<string, unknown>[] = [];

	const meta: Record<string, unknown> = {
		id: conversation.id,
		timestamp: isoTs(conversation.createdAt),
		cwd: "",
		originator: "curt-codex",
		cli_version: GENERATOR,
		source: "curt-import",
	};
	if (isObj(conversation.codex)) {
		const c = conversation.codex as Record<string, unknown>;
		if (isStr(c.originator)) meta.originator = c.originator;
		if (isStr(c.source)) meta.source = c.source;
		if (isStr(c.modelProvider)) meta.model_provider = c.modelProvider;
	}
	lines.push({ timestamp: isoTs(conversation.createdAt), type: "session_meta", payload: meta });

	if (isStr(conversation.model) && conversation.model) {
		lines.push({
			timestamp: isoTs(conversation.createdAt),
			type: "turn_context",
			payload: { model: conversation.model, cwd: "" },
		});
	}

	for (const m of conversation.messages) {
		const ts = isoTs(m.timestamp);
		if (m.role === "user") {
			lines.push({
				timestamp: ts,
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: m.content }],
				},
			});
		} else if (m.role === "assistant") {
			if (isStr(m.thinking) && m.thinking) {
				lines.push({
					timestamp: ts,
					type: "response_item",
					payload: {
						type: "reasoning",
						summary: [{ type: "summary_text", text: m.thinking }],
					},
				});
			}
			for (const call of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
				const c = call as Record<string, unknown>;
				lines.push({
					timestamp: ts,
					type: "response_item",
					payload: {
						type: "function_call",
						call_id: isStr(c.id) ? c.id : `${conversation.id}:call`,
						name: isStr(c.name) ? c.name : "unknown",
						arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}),
					},
				});
			}
			if (isStr(m.content) && m.content) {
				const message: Record<string, unknown> = {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: m.content }],
				};
				if (isStr(m.model) && m.model) message.model = m.model;
				lines.push({ timestamp: ts, type: "response_item", payload: message });
			}
		} else if (m.role === "tool") {
			lines.push({
				timestamp: ts,
				type: "response_item",
				payload: {
					type: "function_call_output",
					call_id: isStr(m.toolCallId) ? m.toolCallId : `${conversation.id}:orphan`,
					output: m.content,
				},
			});
		} else {
			// system and anything else: closest native shape is a
			// developer-role message (note: the import direction treats
			// developer turns as instructions and would skip them — a known
			// asymmetry documented in the README).
			lines.push({
				timestamp: ts,
				type: "response_item",
				payload: {
					type: "message",
					role: "developer",
					content: [{ type: "input_text", text: m.content }],
				},
			});
		}
	}

	if (isObj(conversation.codexTokens)) {
		const t = conversation.codexTokens as Record<string, unknown>;
		const usage: Record<string, unknown> = {};
		if (isNum(t.inputTokens)) usage.input_tokens = t.inputTokens;
		if (isNum(t.cachedInputTokens)) usage.cached_input_tokens = t.cachedInputTokens;
		if (isNum(t.cacheWriteInputTokens)) usage.cache_write_input_tokens = t.cacheWriteInputTokens;
		if (isNum(t.outputTokens)) usage.output_tokens = t.outputTokens;
		if (isNum(t.reasoningOutputTokens)) usage.reasoning_output_tokens = t.reasoningOutputTokens;
		if (isNum(t.totalTokens)) usage.total_tokens = t.totalTokens;
		const info: Record<string, unknown> = {
			total_token_usage: usage,
			last_token_usage: usage,
		};
		if (isNum(t.modelContextWindow)) info.model_context_window = t.modelContextWindow;
		lines.push({
			timestamp: isoTs(conversation.updatedAt),
			type: "event_msg",
			payload: { type: "token_count", info },
		});
	}

	return lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "");
}

export interface RolloutValidation {
	lines: number;
	/** Structural breakage: unparseable lines, missing session_meta, duplicate call_ids. */
	errors: string[];
	/** function_call_output lines referencing no preceding function_call —
	 *  content-level lossiness inherited from the archive (aborted calls),
	 *  not structural. */
	orphanToolOutputs: number;
}

/**
 * Structural validation of emitted (or any) rollout JSONL: every line
 * parses, `session_meta` is first, and function_call/function_call_output
 * linkage by `call_id` is intact. Orphan outputs are counted, not fatal.
 */
export function validateRolloutJsonl(text: string): RolloutValidation {
	const errors: string[] = [];
	let orphanToolOutputs = 0;
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	const callIds = new Set<string>();
	let first = true;
	let sawMeta = false;
	for (const line of lines) {
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			errors.push("line not JSON");
			continue;
		}
		if (!isObj(obj)) {
			errors.push("line not an object");
			continue;
		}
		if (!isStr(obj.timestamp) || !isStr(obj.type)) {
			errors.push("line missing timestamp or type");
		}
		if (first && obj.type !== "session_meta") {
			errors.push("first line is not session_meta");
		}
		first = false;
		if (obj.type === "session_meta") sawMeta = true;

		const payload = isObj(obj.payload) ? obj.payload : {};
		if (payload.type === "function_call" && isStr(payload.call_id)) {
			if (callIds.has(payload.call_id)) errors.push(`duplicate call_id ${payload.call_id}`);
			callIds.add(payload.call_id);
		}
		if (payload.type === "function_call_output") {
			if (!isStr(payload.call_id) || !callIds.has(payload.call_id)) {
				orphanToolOutputs++;
			}
		}
	}
	if (!sawMeta && lines.length > 0) errors.push("no session_meta line");
	return { lines: lines.length, errors, orphanToolOutputs };
}
