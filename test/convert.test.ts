import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCurt } from "curt-format";
import {
	EXTENSIONS,
	GENERATOR,
	convertRollout,
	deriveTitle,
	emitRolloutJsonl,
	parseIsoMs,
	isoTs,
	resolveCurtWritePath,
	serializeValidated,
	validateRolloutJsonl,
} from "../src/codex.js";
import { SESSION_A, SESSION_B, SESSION_C, buildFixtureTree } from "./fixtures.js";

// Built at module load: describe bodies below convert eagerly.
const tmp = mkdtempSync(join(tmpdir(), "curt-codex-fixture-"));
buildFixtureTree(tmp);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const readFixture = (name: string): string =>
	readFileSync(join(tmp, "2026", "11", "01", name), "utf8");

describe("parseIsoMs / isoTs", () => {
	it("parses ISO-8601 UTC rollout timestamps to epoch ms", () => {
		expect(parseIsoMs("2026-11-01T19:29:59.707Z")).toBe(Date.parse("2026-11-01T19:29:59.707Z"));
	});
	it("returns 0 for garbage", () => {
		expect(parseIsoMs(null)).toBe(0);
		expect(parseIsoMs("soon")).toBe(0);
		expect(parseIsoMs(1778447132909)).toBe(0); // numbers are not the rollout format
	});
	it("round-trips through isoTs", () => {
		expect(isoTs(Date.parse("2026-11-01T19:29:59.707Z"))).toBe("2026-11-01T19:29:59.707Z");
	});
});

describe("deriveTitle", () => {
	it("collapses whitespace and caps at 60 chars", () => {
		expect(deriveTitle("x".repeat(100)).length).toBe(60);
		expect(deriveTitle("  a\n\nb  ")).toBe("a b");
	});
});

describe("convertRollout — session A (full zoo)", () => {
	const c = convertRollout(readFixture("rollout-2026-11-01T19-00-00-a.jsonl"))!;
	const conv = c.conversation;
	const stats = c.stats;

	it("is present with the session_meta id", () => {
		expect(conv.id).toBe(SESSION_A);
	});

	it("derives the title from the first real user turn (not bootstrap)", () => {
		expect(conv.title).toBe("Synthetic first prompt for fixture session A.");
	});

	it("spans createdAt/updatedAt from emitted message timestamps", () => {
		expect(conv.createdAt).toBe(Date.parse("2026-11-01T19:00:01.000Z"));
		expect(conv.updatedAt).toBe(Date.parse("2026-11-01T19:00:13.000Z"));
	});

	it("emits user/assistant/tool turns in file order, skipping bootstrap", () => {
		expect(conv.messages.map((m) => m.role)).toEqual([
			"user", "assistant", "tool", "assistant", "user", "assistant", "assistant", "tool",
		]);
		expect(conv.messages.map((m) => m.id)).toEqual(
			conv.messages.map((_, i) => `${SESSION_A}-${i + 1}`),
		);
	});

	it("attaches reasoning text to the following assistant message as thinking", () => {
		const a = conv.messages[1]!;
		expect(a.content).toBe("");
		expect(a.thinking).toBe(
			"Synthetic reasoning trace part one.\n\nSynthetic reasoning trace part two.",
		);
	});

	it("maps function_call to toolCalls with parsed arguments and carries the model", () => {
		const a = conv.messages[1]!;
		expect(a.model).toBe("synthetic-model-a");
		expect(a.toolCalls).toEqual([
			{ id: "call_syn1", name: "synthetic_tool", arguments: { path: "synthetic.txt" } },
		]);
		// response-item plumbing is not carried
		expect(JSON.stringify(a.toolCalls)).not.toContain("fc_syn");
	});

	it("links function_call_output by call_id and re-serializes JSON output", () => {
		const tool = conv.messages[2]!;
		expect(tool.toolCallId).toBe("call_syn1");
		expect(tool.content).toBe('{"output":"synthetic tool output body","exit_code":0}');
	});

	it("attaches each turn's last usage to the most recent assistant message", () => {
		// token_count #1 lands on the text answer that closed turn one
		expect(conv.messages[3]!.content).toBe("Synthetic answer one from fixture session A.");
		expect(conv.messages[3]!.tokens).toMatchObject({
			inputTokens: 1200,
			outputTokens: 90,
			totalTokens: 1330,
		});
		// token_count #2 lands on the final answer
		expect(conv.messages[6]!.tokens).toMatchObject({ inputTokens: 800, totalTokens: 910 });
	});

	it("carries minimal non-identifying metadata and final token rollup", () => {
		expect(conv.codex).toEqual({
			originator: "codex_exec",
			cliVersion: "0.146.0",
			source: "exec",
			modelProvider: "synthetic-provider",
		});
		expect(conv.model).toBe("synthetic-model-a");
		expect(conv.codexTokens).toEqual({
			inputTokens: 2000,
			cachedInputTokens: 0,
			cacheWriteInputTokens: 0,
			outputTokens: 200,
			reasoningOutputTokens: 0,
			totalTokens: 2200,
			modelContextWindow: 258400,
		});
	});

	it("never emits instructions, paths, or encrypted blobs", () => {
		const s = JSON.stringify(conv);
		for (const banned of [
			"SYNTHETIC BASE INSTRUCTIONS",
			"SYNTHETIC sandbox instructions",
			"SYNTHETIC AGENTS.md instructions",
			"environment_context",
			"C:\\synthetic\\project",
			"SYNTHETIC-ENCRYPTED-BLOB",
		]) {
			expect(s).not.toContain(banned);
		}
	});

	it("counts everything that was skipped, dropped, or redacted", () => {
		expect(stats.roles).toEqual({ user: 2, assistant: 4, tool: 2 });
		expect(stats.skippedBootstrap).toBe(3); // 2 developer + 1 environment_context
		expect(stats.skippedEventMsgs).toBe(6); // task_started, 2x user_message, agent_message, 2x token_count + task_complete = 7
		expect(stats.skippedWorldState).toBe(1);
		expect(stats.reasoningItems).toBe(2);
		expect(stats.orphanReasoning).toBe(0);
		expect(stats.unmatchedToolCalls).toBe(1); // call_syn_aborted
		expect(stats.unmatchedToolResults).toBe(1); // call_syn_orphan
		expect(stats.malformedLines).toBe(1);
		expect(stats.unknownLineTypes).toBe(1);
		expect(stats.unknownItemTypes).toBe(1);
		expect(stats.tokenCountEvents).toBe(2);
		expect(stats.jsonPayloads).toBe(1);
		expect(stats.redactedFields).toBeGreaterThanOrEqual(8);
	});
});

describe("convertRollout — session B (minimal)", () => {
	const result = convertRollout(readFixture("rollout-2026-11-01T20-00-00-b.jsonl"))!;

	it("drops the empty assistant turn without dying", () => {
		expect(result.conversation.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(result.stats.emptyDropped).toBe(1);
	});

	it("carries the final usage rollup", () => {
		expect(result.conversation.codexTokens).toEqual({
			inputTokens: 100,
			cachedInputTokens: 0,
			cacheWriteInputTokens: 0,
			outputTokens: 20,
			reasoningOutputTokens: 0,
			totalTokens: 120,
			modelContextWindow: 258400,
		});
		expect(result.conversation.model).toBe("synthetic-model-b");
	});
});

describe("convertRollout — session C (unusable)", () => {
	it("returns null when nothing usable exists", () => {
		expect(convertRollout(readFixture("rollout-2026-11-01T21-00-00-c.jsonl"))).toBeNull();
	});
});

describe("round-trip validation", () => {
	it("every converted fixture parses back with parseCurt, extras intact", () => {
		const a = convertRollout(readFixture("rollout-2026-11-01T19-00-00-a.jsonl"))!;
		const b = convertRollout(readFixture("rollout-2026-11-01T20-00-00-b.jsonl"))!;
		for (const { conversation } of [a, b]) {
			const body = serializeValidated(conversation);
			expect(body).not.toBeNull();
			const parsed = parseCurt(body!);
			expect(parsed).not.toBeNull();
			expect(parsed!.id).toBe(conversation.id);
			expect(parsed!.messages).toHaveLength(conversation.messages.length);
			expect(parsed!.codex).toEqual(conversation.codex);
			expect(parsed!.codexTokens).toEqual(conversation.codexTokens);
			const withCalls = parsed!.messages.find((m) => Array.isArray(m.toolCalls));
			if (withCalls) expect(withCalls.toolCalls).toBeDefined();
			const tool = parsed!.messages.find((m) => m.role === "tool");
			if (tool) expect(tool.toolCallId).toBeDefined();
		}
	});

	it("declares only the stable usage-metadata extension and signs the generator", () => {
		const a = convertRollout(readFixture("rollout-2026-11-01T19-00-00-a.jsonl"))!;
		const doc = JSON.parse(serializeValidated(a.conversation)!) as Record<string, unknown>;
		expect(doc.generator).toBe(GENERATOR);
		expect(doc.extensions).toEqual([...EXTENSIONS]);
	});
});

describe("orphan reasoning becomes a trailing assistant message", () => {
	it("preserves thinking that was never followed by an assistant turn", () => {
		const text = [
			JSON.stringify({
				timestamp: "2026-11-01T22:00:00.000Z",
				type: "session_meta",
				payload: { id: SESSION_B, timestamp: "2026-11-01T22:00:00.000Z", cwd: "C:\\s" },
			}),
			JSON.stringify({
				timestamp: "2026-11-01T22:00:01.000Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Synthetic orphan-reasoning prompt." }],
				},
			}),
			JSON.stringify({
				timestamp: "2026-11-01T22:00:02.000Z",
				type: "response_item",
				payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Orphan synthetic thinking." }] },
			}),
		].join("\n");
		const result = convertRollout(text)!;
		expect(result.stats.orphanReasoning).toBe(1);
		const last = result.conversation.messages.at(-1)!;
		expect(last.role).toBe("assistant");
		expect(last.content).toBe("");
		expect(last.thinking).toBe("Orphan synthetic thinking.");
	});
});

describe("resolveCurtWritePath", () => {
	const tmp2 = mkdtempSync(join(tmpdir(), "curt-codex-collide-"));
	const file = join(tmp2, "2026-01-01 test demo.curt");

	it("returns the original path when the file does not exist", () => {
		expect(resolveCurtWritePath(file, "body")).toEqual({ path: file, collided: false });
	});
	it("overwrites identical content in place", () => {
		writeFileSync(file, "body");
		expect(resolveCurtWritePath(file, "body")).toEqual({ path: file, collided: false });
	});
	it("suffixes -2 on differing content", () => {
		writeFileSync(file, "original");
		const result = resolveCurtWritePath(file, "different");
		expect(result.collided).toBe(true);
		expect(result.path).toBe(`${file.slice(0, -".curt".length)}-2.curt`);
		expect(readFileSync(file, "utf8")).toBe("original");
	});

	afterAll(() => rmSync(tmp2, { recursive: true, force: true }));
});

describe("emitRolloutJsonl — direction 2", () => {
	const conv = convertRollout(readFixture("rollout-2026-11-01T19-00-00-a.jsonl"))!.conversation;
	const jsonl = emitRolloutJsonl(conv);

	it("produces structurally valid JSONL with intact call linkage", () => {
		const check = validateRolloutJsonl(jsonl);
		expect(check.errors).toEqual([]);
		// the archive's aborted call has no output, and the orphan output has
		// no call in the archive — both carried through as-is
		expect(check.orphanToolOutputs).toBe(1);
		expect(check.lines).toBeGreaterThan(conv.messages.length); // meta + context + reasoning/splits
	});

	it("starts with a session_meta line carrying the conversation id", () => {
		const first = JSON.parse(jsonl.split("\n")[0]!) as Record<string, unknown>;
		expect(first.type).toBe("session_meta");
		const payload = first.payload as Record<string, unknown>;
		expect(payload.id).toBe(SESSION_A);
		expect(payload.cwd).toBe("");
	});

	it("emits reasoning, function_call, and function_call_output items", () => {
		const types = jsonl
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => (JSON.parse(l) as Record<string, unknown>).type);
		expect(types.filter((t) => t === "response_item").length).toBeGreaterThan(0);
		const payloads = jsonl
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => (JSON.parse(l) as Record<string, unknown>).payload as Record<string, unknown>);
		expect(payloads.some((p) => p.type === "reasoning")).toBe(true);
		const call = payloads.find((p) => p.type === "function_call")!;
		expect(call.call_id).toBe("call_syn1");
		expect(call.name).toBe("synthetic_tool");
		expect(JSON.parse(call.arguments as string)).toEqual({ path: "synthetic.txt" });
		const out = payloads.find((p) => p.type === "function_call_output")!;
		expect(out.call_id).toBe("call_syn1");
	});

	it("is deterministic across runs", () => {
		expect(emitRolloutJsonl(conv)).toBe(jsonl);
	});

	it("re-imports to an equivalent conversation (direction 1 of direction 2)", () => {
		const reconverted = convertRollout(jsonl)!;
		expect(reconverted.conversation.id).toBe(conv.id);
		expect(reconverted.conversation.messages.map((m) => [m.role, m.content, m.thinking ?? null])).toEqual(
			conv.messages.map((m) => [m.role, m.content, m.thinking ?? null]),
		);
		// tool linkage survives the round trip
		const reToolCalls = reconverted.conversation.messages.flatMap((m) =>
			Array.isArray(m.toolCalls) ? m.toolCalls : [],
		);
		expect(reToolCalls).toHaveLength(2);
		const reToolIds = reconverted.conversation.messages
			.filter((m) => m.role === "tool")
			.map((m) => m.toolCallId);
		expect(reToolIds).toContain("call_syn1");
	});
});

describe("validateRolloutJsonl", () => {
	it("flags missing session_meta and broken JSON", () => {
		const bad = [
			JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "message" } }),
			"{nope",
		].join("\n");
		const check = validateRolloutJsonl(bad);
		expect(check.errors.length).toBeGreaterThanOrEqual(2);
	});

	it("counts orphan function_call_output lines", () => {
		const text =
			JSON.stringify({
				timestamp: "2026-11-01T00:00:00.000Z",
				type: "session_meta",
				payload: { id: "s", timestamp: "2026-11-01T00:00:00.000Z", cwd: "" },
			}) +
			"\n" +
			JSON.stringify({
				timestamp: "2026-11-01T00:00:01.000Z",
				type: "response_item",
				payload: { type: "function_call_output", call_id: "nope", output: "x" },
			});
		const check = validateRolloutJsonl(text);
		expect(check.errors).toEqual([]);
		expect(check.orphanToolOutputs).toBe(1);
	});
});

describe("fixture tree is present", () => {
	it("all three fixture files exist on disk", () => {
		expect(existsSync(join(tmp, "2026", "11", "01"))).toBe(true);
		expect(SESSION_A).not.toBe(SESSION_B);
		expect(SESSION_C).not.toBe(SESSION_A);
	});
});
