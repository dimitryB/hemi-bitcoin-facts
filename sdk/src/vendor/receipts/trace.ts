import type { Hex } from "viem";
import { contentHash, ManifestError, newRunId, normalizeManifest, RECEIPT_VERSION, type ManifestV1 } from "./manifest.js";

/**
 * Trace input (docs/SCHEMA.md §6). A trace is what an agent framework already records about a
 * run; buildManifest turns it into a v1 manifest, hashing raw payloads (prompt, output, tool
 * arguments and results) with contentHash. Only the hashes reach the manifest.
 */

/** One tool call. Give the raw `args`/`result` (hashed with contentHash) or their 32-byte hashes. */
export interface TraceToolCall {
  name: string;
  /** Unix seconds, or an ISO 8601 date-time string. */
  at: number | string;
  args?: unknown;
  argsHash?: string;
  result?: unknown;
  resultHash?: string;
}

export interface TraceSpend {
  asset: string;
  /** Canonical decimal string ("1000", "0.5"), a bigint, or a non-negative safe integer. */
  amount: string | number | bigint;
  txHash?: string;
}

/** A structured trace: the whole run as one object. */
export interface Trace {
  agent: string;
  /** Defaults to `agent`. */
  principal?: string;
  model: string;
  /** Defaults to 32 random bytes. */
  runId?: string;
  parentRunId?: string;
  tags?: string[];
  /** Unix seconds, or an ISO 8601 date-time string. */
  startedAt: number | string;
  endedAt: number | string;
  prompt?: unknown;
  promptHash?: string;
  output?: unknown;
  outputHash?: string;
  toolCalls?: TraceToolCall[];
  spend?: TraceSpend[];
}

/** Command-line style overrides; they win over the trace's own values. */
export interface TraceOverrides {
  agent?: string;
  principal?: string;
  model?: string;
  runId?: string;
}

export interface TraceIssue {
  /** 1-based line in the JSONL input, when the problem can be tied to one. */
  line?: number;
  message: string;
}

export class TraceError extends Error {
  constructor(readonly issues: TraceIssue[]) {
    super(`invalid trace: ${issues.map((i) => (i.line ? `line ${i.line}: ${i.message}` : i.message)).join("; ")}`);
    this.name = "TraceError";
  }
}

const has = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key) && (obj as Record<string, unknown>)[key] !== undefined;

function toSeconds(value: unknown, what: string, issues: string[]): number | undefined {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    issues.push(`${what}: must be non-negative integer unix seconds or an ISO 8601 date-time (got ${value})`);
    return undefined;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms >= 0) return Math.floor(ms / 1000);
  }
  issues.push(`${what}: must be non-negative integer unix seconds or an ISO 8601 date-time (got ${JSON.stringify(value)})`);
  return undefined;
}

function toAmount(value: unknown, what: string, issues: string[]): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  issues.push(
    `${what}: must be a canonical decimal string such as "1000" or "0.5" (got ${typeof value === "bigint" ? `${value}n` : JSON.stringify(value)}); write fractional amounts as strings`,
  );
  return undefined;
}

/** Exactly one of `raw` / `hashKey` must be present; returns the 32-byte hash. */
function payloadHash(obj: object, raw: string, hashKey: string, what: string, issues: string[]): Hex | undefined {
  const hasRaw = has(obj, raw);
  const hasHash = has(obj, hashKey);
  const record = obj as Record<string, unknown>;
  if (hasRaw && hasHash) {
    issues.push(`${what}: give either "${raw}" or "${hashKey}", not both`);
    return undefined;
  }
  if (hasHash) return record[hashKey] as Hex;
  if (hasRaw) {
    try {
      return contentHash(record[raw]);
    } catch (error) {
      issues.push(`${what}: cannot hash "${raw}": ${(error as Error).message}`);
      return undefined;
    }
  }
  issues.push(`${what}: "${raw}" or "${hashKey}" is required`);
  return undefined;
}

/**
 * Where each manifest path came from, so validation errors can name a line.
 * Keys are manifest paths ("model", "toolCalls[2]"); values are 1-based lines.
 */
type LineMap = (path: string) => number | undefined;

function build(trace: Trace, overrides: TraceOverrides, lineOf: LineMap): ManifestV1 {
  const issues: TraceIssue[] = [];
  const at = (path: string) => (message: string) => issues.push({ line: lineOf(path), message });
  const collect = (path: string, list: string[]) => list.forEach(at(path));

  if (typeof trace !== "object" || trace === null || Array.isArray(trace)) throw new TraceError([{ message: "trace must be an object" }]);

  const header: string[] = [];
  const agent = overrides.agent ?? trace.agent;
  const principal = overrides.principal ?? trace.principal ?? agent;
  const model = overrides.model ?? trace.model;
  const runId = overrides.runId ?? trace.runId ?? newRunId();
  if (agent === undefined) header.push("agent: required (in the trace or with --agent)");
  if (model === undefined) header.push("model: required (in the trace or with --model)");
  const startedAt = trace.startedAt === undefined ? (header.push("startedAt: required"), undefined) : toSeconds(trace.startedAt, "startedAt", header);
  const promptHash = payloadHash(trace, "prompt", "promptHash", "run", header);
  collect("startedAt", header);

  const endIssues: string[] = [];
  const endedAt = trace.endedAt === undefined ? (endIssues.push("endedAt: required"), undefined) : toSeconds(trace.endedAt, "endedAt", endIssues);
  const outputHash = payloadHash(trace, "output", "outputHash", "end", endIssues);
  collect("endedAt", endIssues);

  const toolCalls = (trace.toolCalls ?? []).map((call, i) => {
    const p = `toolCalls[${i}]`;
    const list: string[] = [];
    if (typeof call !== "object" || call === null) {
      collect(p, ["tool_call: must be an object"]);
      return call as never;
    }
    const label = typeof call.name === "string" ? `tool_call "${call.name}"` : `tool_call #${i + 1}`;
    const out = {
      name: call.name,
      argsHash: payloadHash(call, "args", "argsHash", label, list),
      resultHash: payloadHash(call, "result", "resultHash", label, list),
      at: call.at === undefined ? (list.push(`${label}: at: required`), undefined) : toSeconds(call.at, `${label}: at`, list),
    };
    collect(p, list);
    return out;
  });

  const spend = (trace.spend ?? []).map((item, i) => {
    const p = `spend[${i}]`;
    const list: string[] = [];
    if (typeof item !== "object" || item === null) {
      collect(p, ["spend: must be an object"]);
      return item as never;
    }
    const out = {
      asset: item.asset,
      amount: item.amount === undefined ? (list.push("spend: amount: required"), undefined) : toAmount(item.amount, "spend: amount", list),
      txHash: item.txHash,
    };
    collect(p, list);
    return out;
  });

  if (issues.length > 0) throw new TraceError(issues);

  const candidate = {
    receiptVersion: RECEIPT_VERSION,
    runId,
    agent,
    principal,
    startedAt,
    endedAt,
    model,
    promptHash,
    outputHash,
    toolCalls,
    spend,
    parentRunId: trace.parentRunId,
    tags: trace.tags,
  };
  try {
    return normalizeManifest(candidate);
  } catch (error) {
    if (!(error instanceof ManifestError)) throw error;
    throw new TraceError(
      error.errors.map((message) => {
        const path = /^([A-Za-z]+(?:\[\d+\])?)/.exec(message)?.[1] ?? "";
        return { line: lineOf(path), message };
      }),
    );
  }
}

/** Builds and validates a v1 manifest from a structured trace. Throws TraceError. */
export function buildManifest(trace: Trace, overrides: TraceOverrides = {}): ManifestV1 {
  return build(trace, overrides, () => undefined);
}

const RUN_FIELDS = ["type", "agent", "principal", "model", "runId", "parentRunId", "tags", "startedAt", "prompt", "promptHash"];
const TOOL_FIELDS = ["type", "name", "at", "args", "argsHash", "result", "resultHash"];
const SPEND_FIELDS = ["type", "asset", "amount", "txHash"];
const END_FIELDS = ["type", "endedAt", "output", "outputHash"];
const FIELDS: Record<string, string[]> = { run: RUN_FIELDS, tool_call: TOOL_FIELDS, spend: SPEND_FIELDS, end: END_FIELDS };

/**
 * Parses trace JSONL (docs/SCHEMA.md §6) into a v1 manifest. Blank lines are ignored; exactly
 * one `run` line comes first and exactly one `end` line last. Unknown fields are rejected, so a
 * misspelt field can never silently drop out of the hash. Errors carry 1-based line numbers.
 */
export function parseTraceJsonl(text: string, overrides: TraceOverrides = {}): ManifestV1 {
  const issues: TraceIssue[] = [];
  const events: { line: number; event: Record<string, unknown> }[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      issues.push({ line, message: `not valid JSON (${(error as Error).message})` });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      issues.push({ line, message: "each line must be a JSON object" });
      return;
    }
    const event = parsed as Record<string, unknown>;
    const allowed = typeof event.type === "string" ? FIELDS[event.type] : undefined;
    if (!allowed) {
      issues.push({ line, message: `unknown type ${JSON.stringify(event.type)}; expected "run", "tool_call", "spend" or "end"` });
      return;
    }
    const unknown = Object.keys(event).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
      issues.push({ line, message: `${event.type}: unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")} (allowed: ${allowed.slice(1).join(", ")})` });
      return;
    }
    events.push({ line, event });
  });
  if (issues.length > 0) throw new TraceError(issues);
  if (events.length === 0) throw new TraceError([{ message: "trace is empty; expected a run line, then tool_call/spend lines, then an end line" }]);

  const first = events[0]!;
  const last = events[events.length - 1]!;
  if (first.event.type !== "run") issues.push({ line: first.line, message: `the first line must be a "run" line, not "${first.event.type}"` });
  if (last.event.type !== "end") issues.push({ line: last.line, message: `the last line must be an "end" line, not "${last.event.type}"` });
  for (const { line, event } of events.slice(1)) {
    if (event.type === "run") issues.push({ line, message: `a second "run" line; a trace describes exactly one run` });
  }
  for (const { line, event } of events.slice(0, -1)) {
    if (event.type === "end") issues.push({ line, message: `"end" line before the last line; nothing may follow the end of the run` });
  }
  if (issues.length > 0) throw new TraceError(issues);

  const run = first.event;
  const end = last.event;
  const tools = events.filter((e) => e.event.type === "tool_call");
  const spends = events.filter((e) => e.event.type === "spend");
  const strip = ({ type: _type, ...rest }: Record<string, unknown>) => rest;

  const trace = {
    ...strip(run),
    ...strip(end),
    toolCalls: tools.map((t) => strip(t.event)),
    spend: spends.map((s) => strip(s.event)),
  } as unknown as Trace;

  const lineOf: LineMap = (path) => {
    const indexed = /^(toolCalls|spend)\[(\d+)\]/.exec(path);
    if (indexed) return (indexed[1] === "toolCalls" ? tools : spends)[Number(indexed[2])]?.line;
    if (path === "endedAt" || path === "outputHash") return last.line;
    if (path === "toolCalls" || path === "spend" || path === "manifest") return undefined;
    return first.line;
  };
  return build(trace, overrides, lineOf);
}
