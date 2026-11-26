import { bytesToHex, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { canonicalize } from "./canonicalize.js";
import { isBytes32, isLowerAddress, lowerAddress, lowerBytes32, ZERO_ADDRESS, ZERO_BYTES32 } from "./hex.js";

/**
 * Manifest schema v1. docs/SCHEMA.md is the human-readable source of truth; the field
 * tables there are checked against MANIFEST_V1_FIELDS by sdk/test/schema-doc.test.ts.
 * v1 is frozen (the registry is deployed on mainnet): any change bumps receiptVersion.
 */
export const RECEIPT_VERSION = 1 as const;

export interface ToolCallV1 {
  name: string;
  argsHash: Hex;
  resultHash: Hex;
  at: number;
}

export interface SpendV1 {
  asset: string;
  amount: string;
  txHash?: Hex;
}

export interface ManifestV1 {
  receiptVersion: typeof RECEIPT_VERSION;
  runId: Hex;
  agent: Address;
  principal: Address;
  startedAt: number;
  endedAt: number;
  model: string;
  promptHash: Hex;
  outputHash: Hex;
  toolCalls: ToolCallV1[];
  spend: SpendV1[];
  parentRunId?: Hex;
  tags?: string[];
}

export type FieldType =
  | "integer"
  | "bytes32"
  | "address"
  | "string"
  | "decimal-string"
  | "array<ToolCall>"
  | "array<Spend>"
  | "array<string>";

export interface FieldSpec {
  name: string;
  type: FieldType;
  required: boolean;
}

export const MANIFEST_V1_FIELDS = [
  { name: "receiptVersion", type: "integer", required: true },
  { name: "runId", type: "bytes32", required: true },
  { name: "agent", type: "address", required: true },
  { name: "principal", type: "address", required: true },
  { name: "startedAt", type: "integer", required: true },
  { name: "endedAt", type: "integer", required: true },
  { name: "model", type: "string", required: true },
  { name: "promptHash", type: "bytes32", required: true },
  { name: "outputHash", type: "bytes32", required: true },
  { name: "toolCalls", type: "array<ToolCall>", required: true },
  { name: "spend", type: "array<Spend>", required: true },
  { name: "parentRunId", type: "bytes32", required: false },
  { name: "tags", type: "array<string>", required: false },
] as const satisfies readonly FieldSpec[];

export const TOOL_CALL_V1_FIELDS = [
  { name: "name", type: "string", required: true },
  { name: "argsHash", type: "bytes32", required: true },
  { name: "resultHash", type: "bytes32", required: true },
  { name: "at", type: "integer", required: true },
] as const satisfies readonly FieldSpec[];

export const SPEND_V1_FIELDS = [
  { name: "asset", type: "string", required: true },
  { name: "amount", type: "decimal-string", required: true },
  { name: "txHash", type: "bytes32", required: false },
] as const satisfies readonly FieldSpec[];

/**
 * Compile-time guard: the field lists above name exactly the keys of the TypeScript types, and
 * mark exactly the optional ones as not required. `npm run typecheck -w sdk` fails on any drift;
 * sdk/test/schema-doc.test.ts ties the same lists to docs/SCHEMA.md.
 */
type Names<L extends readonly FieldSpec[]> = L[number]["name"];
type Optional<L extends readonly FieldSpec[]> = Extract<L[number], { required: false }>["name"];
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type FieldListsMatchTypes = [
  Assert<Same<Names<typeof MANIFEST_V1_FIELDS>, keyof ManifestV1>>,
  Assert<Same<Optional<typeof MANIFEST_V1_FIELDS>, OptionalKeys<ManifestV1>>>,
  Assert<Same<Names<typeof TOOL_CALL_V1_FIELDS>, keyof ToolCallV1>>,
  Assert<Same<Optional<typeof TOOL_CALL_V1_FIELDS>, OptionalKeys<ToolCallV1>>>,
  Assert<Same<Names<typeof SPEND_V1_FIELDS>, keyof SpendV1>>,
  Assert<Same<Optional<typeof SPEND_V1_FIELDS>, OptionalKeys<SpendV1>>>,
];

/** Limits from docs/SCHEMA.md. */
export const LIMITS = {
  modelLength: 256,
  toolCalls: 10_000,
  toolNameLength: 128,
  spend: 1_000,
  assetLength: 256,
  amountLength: 78,
  tags: 32,
  tagLength: 64,
  /** The service refuses canonical manifests larger than this many UTF-8 bytes. */
  canonicalBytes: 1_048_576,
} as const;

/** Canonical non-negative decimal: no sign, no exponent, no leading zeros, no trailing fractional zeros. */
export const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;

export class ManifestError extends Error {
  constructor(readonly errors: string[]) {
    super(`invalid manifest: ${errors.join("; ")}`);
    this.name = "ManifestError";
  }
}

export type ManifestValidation = { ok: true; manifest: ManifestV1 } | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSafeUint(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkString(value: unknown, path: string, max: number, errors: string[]): void {
  if (typeof value !== "string") errors.push(`${path}: must be a string`);
  else if (value.length === 0) errors.push(`${path}: must not be empty`);
  else if (value.length > max) errors.push(`${path}: must be at most ${max} characters`);
  else if (!value.isWellFormed()) errors.push(`${path}: contains a lone surrogate`);
}

function checkKeys(obj: Record<string, unknown>, specs: readonly FieldSpec[], path: string, errors: string[]): void {
  const allowed = new Set(specs.map((s) => s.name));
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`${path}${key}: unknown field (v1 is closed; new fields need a new receiptVersion)`);
  }
  for (const spec of specs) {
    // A member set to undefined is absent, as it would be once sent as JSON.
    const present = Object.prototype.hasOwnProperty.call(obj, spec.name) && obj[spec.name] !== undefined;
    if (present && obj[spec.name] === null) {
      errors.push(`${path}${spec.name}: must be omitted rather than null`);
    } else if (spec.required && !present) {
      errors.push(`${path}${spec.name}: required`);
    }
  }
}

function has(obj: Record<string, unknown>, key: string): boolean {
  return obj[key] !== undefined && obj[key] !== null;
}

/**
 * Strict structural validation of a v1 manifest. Never mutates or normalizes: a manifest
 * that passes hashes to exactly one digest. Use normalizeManifest first for user input.
 */
export function validateManifest(input: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["manifest: must be a JSON object"] };
  const m = input;
  checkKeys(m, MANIFEST_V1_FIELDS, "", errors);

  if (has(m, "receiptVersion") && m.receiptVersion !== RECEIPT_VERSION) {
    errors.push(`receiptVersion: must be ${RECEIPT_VERSION}`);
  }
  if (has(m, "runId")) {
    if (!isBytes32(m.runId)) errors.push("runId: must be 0x-prefixed lowercase 32-byte hex");
    else if (m.runId === ZERO_BYTES32) errors.push("runId: must not be zero");
  }
  for (const key of ["agent", "principal"] as const) {
    if (!has(m, key)) continue;
    if (!isLowerAddress(m[key])) errors.push(`${key}: must be a 0x-prefixed lowercase 20-byte address`);
    else if (m[key] === ZERO_ADDRESS) errors.push(`${key}: must not be the zero address`);
  }
  for (const key of ["startedAt", "endedAt"] as const) {
    if (has(m, key) && !isSafeUint(m[key])) errors.push(`${key}: must be a non-negative safe integer (unix seconds)`);
  }
  if (isSafeUint(m.startedAt) && isSafeUint(m.endedAt) && m.endedAt < m.startedAt) {
    errors.push("endedAt: must not be before startedAt");
  }
  if (has(m, "model")) checkString(m.model, "model", LIMITS.modelLength, errors);
  for (const key of ["promptHash", "outputHash"] as const) {
    if (has(m, key) && !isBytes32(m[key])) errors.push(`${key}: must be 0x-prefixed lowercase 32-byte hex`);
  }

  if (has(m, "toolCalls")) {
    if (!Array.isArray(m.toolCalls)) errors.push("toolCalls: must be an array");
    else {
      if (m.toolCalls.length > LIMITS.toolCalls) errors.push(`toolCalls: at most ${LIMITS.toolCalls} entries`);
      m.toolCalls.forEach((call: unknown, i: number) => {
        const p = `toolCalls[${i}]`;
        if (!isPlainObject(call)) return void errors.push(`${p}: must be an object`);
        checkKeys(call, TOOL_CALL_V1_FIELDS, `${p}.`, errors);
        if (has(call, "name")) checkString(call.name, `${p}.name`, LIMITS.toolNameLength, errors);
        for (const key of ["argsHash", "resultHash"] as const) {
          if (has(call, key) && !isBytes32(call[key])) errors.push(`${p}.${key}: must be 0x-prefixed lowercase 32-byte hex`);
        }
        if (has(call, "at") && !isSafeUint(call.at)) errors.push(`${p}.at: must be a non-negative safe integer (unix seconds)`);
      });
    }
  }

  if (has(m, "spend")) {
    if (!Array.isArray(m.spend)) errors.push("spend: must be an array");
    else {
      if (m.spend.length > LIMITS.spend) errors.push(`spend: at most ${LIMITS.spend} entries`);
      m.spend.forEach((item: unknown, i: number) => {
        const p = `spend[${i}]`;
        if (!isPlainObject(item)) return void errors.push(`${p}: must be an object`);
        checkKeys(item, SPEND_V1_FIELDS, `${p}.`, errors);
        if (has(item, "asset")) checkString(item.asset, `${p}.asset`, LIMITS.assetLength, errors);
        if (has(item, "amount")) {
          if (typeof item.amount !== "string" || item.amount.length > LIMITS.amountLength || !DECIMAL_RE.test(item.amount)) {
            errors.push(`${p}.amount: must be a canonical non-negative decimal string (e.g. "1000" or "0.5"), at most ${LIMITS.amountLength} characters`);
          }
        }
        if (has(item, "txHash") && !isBytes32(item.txHash)) errors.push(`${p}.txHash: must be 0x-prefixed lowercase 32-byte hex`);
      });
    }
  }

  if (has(m, "parentRunId")) {
    if (!isBytes32(m.parentRunId)) errors.push("parentRunId: must be 0x-prefixed lowercase 32-byte hex");
    else if (m.parentRunId === m.runId) errors.push("parentRunId: must differ from runId");
  }

  if (has(m, "tags")) {
    if (!Array.isArray(m.tags)) errors.push("tags: must be an array of strings");
    else {
      if (m.tags.length > LIMITS.tags) errors.push(`tags: at most ${LIMITS.tags} entries`);
      const seen = new Set<string>();
      m.tags.forEach((tag: unknown, i: number) => {
        checkString(tag, `tags[${i}]`, LIMITS.tagLength, errors);
        if (typeof tag === "string") {
          if (seen.has(tag)) errors.push(`tags[${i}]: duplicate tag "${tag}"`);
          seen.add(tag);
        }
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  try {
    const bytes = stringToBytes(canonicalize(m)).length;
    if (bytes > LIMITS.canonicalBytes) return { ok: false, errors: [`manifest: canonical form is ${bytes} bytes; the limit is ${LIMITS.canonicalBytes}`] };
  } catch (error) {
    return { ok: false, errors: [(error as Error).message] };
  }
  return { ok: true, manifest: m as unknown as ManifestV1 };
}

export function assertManifest(input: unknown): ManifestV1 {
  const result = validateManifest(input);
  if (!result.ok) throw new ManifestError(result.errors);
  return result.manifest;
}

/**
 * Accepts the spellings people actually write and returns the one canonical v1 manifest:
 * hex and addresses lowercased (EIP-55 accepted), members whose value is undefined dropped.
 * Anything it cannot fix (wrong types, unknown fields, null) is left for validation to reject.
 * Throws ManifestError if the result is not a valid v1 manifest.
 */
export function normalizeManifest(input: unknown): ManifestV1 {
  if (!isPlainObject(input)) throw new ManifestError(["manifest: must be a JSON object"]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  for (const key of ["runId", "promptHash", "outputHash", "parentRunId"]) {
    if (key in out) out[key] = lowerBytes32(out[key]);
  }
  for (const key of ["agent", "principal"]) {
    if (key in out) out[key] = lowerAddress(out[key]);
  }
  if (Array.isArray(out.toolCalls)) {
    out.toolCalls = out.toolCalls.map((call: unknown) => {
      if (!isPlainObject(call)) return call;
      const c: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(call)) if (v !== undefined) c[k] = v;
      if ("argsHash" in c) c.argsHash = lowerBytes32(c.argsHash);
      if ("resultHash" in c) c.resultHash = lowerBytes32(c.resultHash);
      return c;
    });
  }
  if (Array.isArray(out.spend)) {
    out.spend = out.spend.map((item: unknown) => {
      if (!isPlainObject(item)) return item;
      const s: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(item)) if (v !== undefined) s[k] = v;
      if ("txHash" in s) s.txHash = lowerBytes32(s.txHash);
      return s;
    });
  }
  return assertManifest(out);
}

/** RFC 8785 canonical JSON of a valid manifest. Throws ManifestError if invalid. */
export function canonicalManifest(manifest: unknown): string {
  return canonicalize(assertManifest(manifest));
}

/** manifestHash = keccak256(UTF-8 bytes of the RFC 8785 canonical JSON). Throws if invalid. */
export function hashManifest(manifest: unknown): Hex {
  return keccak256(stringToBytes(canonicalManifest(manifest)));
}

/**
 * The SDK's convention for payload hashes (promptHash, outputHash, argsHash, resultHash).
 * A string hashes as its UTF-8 bytes; a Uint8Array as its bytes; anything else as its
 * RFC 8785 canonical JSON. The schema only requires 32 bytes; this is a convention.
 */
export function contentHash(value: unknown): Hex {
  if (typeof value === "string") return keccak256(stringToBytes(value));
  if (value instanceof Uint8Array) return keccak256(value);
  return keccak256(stringToBytes(canonicalize(value)));
}

/** 32 random bytes from the platform CSPRNG, as a lowercase 0x hex runId. */
export function newRunId(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
