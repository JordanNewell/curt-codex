#!/usr/bin/env node
/** curt-codex CLI: Codex session rollouts -> .curt files; .curt -> rollout JSONL. */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { curtFilename, parseCurt } from "curt-format";
import {
	GENERATOR,
	addStats,
	convertRollout,
	emitRolloutJsonl,
	emptyStats,
	resolveCurtWritePath,
	serializeValidated,
	validateRolloutJsonl,
} from "./codex.js";

interface Options {
	outDir?: string;
	stdout: boolean;
	sample?: number;
	emitRollout?: boolean;
}

function usage(): never {
	console.error(`curt-codex — OpenAI Codex CLI session rollouts <-> .curt conversations

Direction 1 (export/archive): rollout-*.jsonl -> .curt files
  curt-codex <sessionsDir>              # e.g. ~/.codex/sessions (recursive)
  curt-codex <file.jsonl>
  curt-codex <sessionsDir> -o ./out
  curt-codex <sessionsDir> --sample 5
  curt-codex <file.jsonl> --stdout > one.curt

Input is Codex CLI rollout files (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl),
read-only. Instructions/system content (base_instructions, developer-role
messages, <environment_context>/<user_instructions> turns) and paths (cwd,
workspace_roots) are never emitted — skipped and counted.

Direction 2 (bridge into importers): .curt -> Codex rollout JSONL
  curt-codex --emit-rollout <file.curt|dir> [-o out]

Emits the native Codex rollout format that Codex itself writes — and that both
'hermes sessions import' and OpenClaw's 'sessions import' natively consume —
so .curt archives gain two downstream import paths. One .jsonl per
conversation.

Options:
  -o, --out <dir>       Output directory (default: alongside the input)
  --sample <n>          Direction 1: only the first n matching rollout files
  --stdout              Direction 1: print .curt bodies instead of writing
  --emit-rollout        Direction 2: .curt file(s) -> rollout JSONL
  -h, --help            Show this help`);
	process.exit(2);
}

function parseArgs(argv: string[]): { input?: string; options: Options } {
	const options: Options = { stdout: false };
	let input: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") usage();
		if (a === "--stdout") {
			options.stdout = true;
		} else if (a === "--emit-rollout") {
			options.emitRollout = true;
		} else if (a === "-o" || a === "--out") {
			const v = argv[++i];
			if (!v) usage();
			options.outDir = v;
		} else if (a === "--sample") {
			const v = argv[++i];
			const n = v ? Number(v) : NaN;
			if (!Number.isInteger(n) || n < 1) usage();
			options.sample = n;
		} else if (a.startsWith("-")) {
			console.error(`Unknown option: ${a}`);
			usage();
		} else if (input === undefined) {
			input = a;
		} else {
			console.error(`Unexpected extra argument: ${a}`);
			usage();
		}
	}
	return { input, options };
}

/** Recursive rollout-file discovery: any *.jsonl under the sessions tree. */
function findRolloutFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(d).sort();
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e);
			let st;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(p);
			else if (extname(e) === ".jsonl") out.push(p);
		}
	};
	walk(dir);
	return out;
}

// ---- Direction 1 ----

function runConvert(input: string, options: Options): number {
	const st = statSync(input);
	const files = st.isDirectory() ? findRolloutFiles(input) : [input];
	if (files.length === 0) {
		console.error(`No .jsonl rollout files found in ${input}`);
		return 2;
	}

	const outDir = options.outDir
		? resolve(options.outDir)
		: st.isDirectory()
			? resolve(input)
			: resolve(input, "..");
	if (!options.stdout) mkdirSync(outDir, { recursive: true });

	let converted = 0;
	let skipped = 0;
	let roundtripFailures = 0;
	let collisions = 0;
	const totals = emptyStats();

	for (const file of files) {
		if (options.sample && converted >= options.sample) break;
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			console.error(`unreadable: ${file}`);
			skipped++;
			continue;
		}
		const result = convertRollout(text);
		if (!result) {
			skipped++;
			continue;
		}
		addStats(totals, result.stats);
		const body = serializeValidated(result.conversation);
		if (!body) {
			roundtripFailures++;
			console.error(`round-trip validation failed for ${result.conversation.id}; not written`);
			continue;
		}
		if (options.stdout) {
			console.log(body);
		} else {
			const file2 = join(outDir, curtFilename(result.conversation));
			const target = resolveCurtWritePath(file2, body);
			if (target.collided) {
				collisions++;
				console.error(`filename collision for ${result.conversation.id}; wrote ${target.path} instead`);
			}
			writeFileSync(target.path, body);
			console.log(target.path);
		}
		converted++;
	}

	console.error(
		`${GENERATOR}: ${converted} converted, ${skipped} skipped, ${roundtripFailures} round-trip failures` +
			(collisions > 0 ? `, ${collisions} filename collisions (suffixed)` : "") +
			` (messages: ${totals.roles.user} user / ${totals.roles.assistant} assistant / ${totals.roles.tool} tool; ` +
			`${totals.skippedEventMsgs} event_msg lines, ${totals.skippedWorldState} world_state lines, ` +
			`${totals.skippedBootstrap} bootstrap/instruction turns, ${totals.reasoningItems} reasoning items ` +
			`(${totals.orphanReasoning} orphan), ${totals.unmatchedToolCalls} unmatched calls, ` +
			`${totals.unmatchedToolResults} unmatched outputs, ${totals.emptyDropped} empty dropped, ` +
			`${totals.malformedLines} malformed lines, ${totals.unknownLineTypes} unknown line types, ` +
			`${totals.unknownItemTypes} unknown item types, ${totals.tokenCountEvents} token_count events, ` +
			`${totals.jsonPayloads} JSON tool outputs, ${totals.redactedFields} identifier/path/instruction fields dropped)`,
	);
	// Per-file problems are counted, never fatal.
	return 0;
}

// ---- Direction 2 ----

function jsonlName(conversationId: string, createdAt: number, title: string): string {
	// Curtis bulk-convention name, .curt -> .jsonl.
	const fake = {
		id: conversationId,
		title,
		createdAt: Number.isFinite(createdAt) ? createdAt : 0,
	};
	const name = curtFilename(fake as never);
	return `${name.slice(0, -".curt".length)}.jsonl`;
}

function runEmitRollout(input: string, options: Options): number {
	const st = statSync(input);
	const curtFiles: string[] = [];
	if (st.isDirectory()) {
		for (const f of readdirSync(input).sort()) {
			if (extname(f) === ".curt") curtFiles.push(join(input, f));
		}
	} else if (extname(input) === ".curt") {
		curtFiles.push(input);
	} else {
		console.error(`Not a .curt file or directory of .curt files: ${input}`);
		return 2;
	}
	if (curtFiles.length === 0) {
		console.error(`No .curt files found in ${input}`);
		return 2;
	}

	const outDir = options.outDir ? resolve(options.outDir) : st.isDirectory() ? resolve(input) : resolve(input, "..");
	if (!options.stdout) mkdirSync(outDir, { recursive: true });

	let written = 0;
	let rejected = 0;
	for (const file of curtFiles) {
		let body: string;
		try {
			body = readFileSync(file, "utf8");
		} catch {
			console.error(`unreadable: ${file}`);
			rejected++;
			continue;
		}
		const parsed = parseCurt(body);
		if (!parsed) {
			console.error(`not a valid .curt file, skipped: ${file}`);
			rejected++;
			continue;
		}
		const jsonl = emitRolloutJsonl(parsed);
		const check = validateRolloutJsonl(jsonl);
		if (check.errors.length > 0) {
			console.error(`structural validation failed for ${parsed.id}; not written (${check.errors.length} errors)`);
			rejected++;
			continue;
		}
		if (check.orphanToolOutputs > 0) {
			console.error(`${parsed.id}: ${check.orphanToolOutputs} orphan function_call_output(s) carried through from the archive`);
		}
		if (options.stdout) {
			process.stdout.write(jsonl);
		} else {
			const target = join(outDir, jsonlName(parsed.id, parsed.createdAt, parsed.title));
			writeFileSync(target, jsonl);
			console.log(target);
		}
		written++;
	}
	console.error(
		`${GENERATOR}: ${written} rollout JSONL emitted (${curtFiles.length - written - rejected} empty), ${rejected} rejected`,
	);
	return 0;
}

function main(): number {
	const { input, options } = parseArgs(process.argv.slice(2));
	if (options.emitRollout) {
		if (!input) usage();
		return runEmitRollout(resolve(input), options);
	}
	if (!input) usage();
	const target = resolve(input);
	if (!existsSync(target)) {
		console.error(`No such file or directory: ${target}`);
		return 2;
	}
	return runConvert(target, options);
}

process.exitCode = main();
