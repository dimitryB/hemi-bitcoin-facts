import type { Hex } from "viem";
import type { ManifestV1 } from "./manifest.js";
import type { ReceiptFields } from "./receipt.js";
import { STAGES, stageIndex, type ReceiptFile, type ReceiptStage, type Stage, type StatusInfo } from "./types.js";

/**
 * Client for the receipts service HTTP API. Every function takes an optional `fetch`, so a
 * caller can pass an x402-paying fetch (e.g. @x402/fetch's wrapFetchWithPayment) and have a
 * 402 paid and retried transparently.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ServiceOptions {
  fetch?: FetchLike;
  /** Extra request headers (e.g. an API key). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** What the service returns for a receipt: the receipt file plus its current status (SCHEMA.md §2, §7). */
export type ServiceReceipt = ReceiptFile & { status: StatusInfo };

export interface SubmitRequest {
  /** The manifest. Sent so the service can hash it (and store it when `store` is true). */
  manifest?: ManifestV1;
  /** The on-chain fields, when the manifest is kept private. */
  receipt?: ReceiptFields;
  /** EIP-712 Receipt signature by the agent or its principal. */
  agentSignature: Hex;
  /** Ask the service to keep the manifest (it then appears in GET /receipts/:runId). */
  store?: boolean;
}

/**
 * POST /attest/direct's answer: the service's countersignature and ready-to-send calldata for
 * `registry.attest(receipt, agentSignature, deadline, serviceSignature)`. The caller sends the
 * transaction itself (`to`, `data`) before `deadline`; the service then detects it.
 */
export interface DirectAttestation {
  receipt: ReceiptFields;
  agentSignature: Hex;
  /** Unix seconds; the service signature is valid until then. */
  deadline: number;
  serviceSignature: Hex;
  registry: Hex;
  chainId: number;
  /** Transaction target (the registry) and calldata. */
  to: Hex;
  data: Hex;
}

export interface SubmitResult {
  /** 202 for a newly accepted receipt, 200 for an identical resubmission. */
  httpStatus: number;
  /** False when the service already had this exact receipt. */
  created: boolean;
  runId: Hex;
  stage: ReceiptStage;
  receiptUrl?: string;
  /** The stored receipt, when the service returned it (identical resubmission on the batch path). */
  receipt?: ServiceReceipt;
  /** submitDirect only: what to send on chain yourself. */
  direct?: DirectAttestation;
}

/** x402 payment requirement, as carried in a 402's PAYMENT-REQUIRED header (x402 v2) or body (v1). */
export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  /** Base units of `asset` (x402 v2). */
  amount?: string;
  /** x402 v1 spelling of the amount. */
  maxAmountRequired?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource?: { url?: string; description?: string; [key: string]: unknown };
  accepts: X402PaymentRequirements[];
  [key: string]: unknown;
}

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly url: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** 400: the service rejected the request (invalid manifest, bad signature, wrong fields). */
export class ValidationError extends ServiceError {
  constructor(message: string, status: number, body: unknown, url: string, readonly errors: string[]) {
    super(message, status, body, url);
    this.name = "ValidationError";
  }
}

/**
 * 409: the service refused this submission for now. `code` is why, and the cure differs:
 * `run_id_conflict` means the runId belongs to another submission, while `payment_pending` and
 * `already_submitted` are about a payment for this runId, so a new runId would mean paying twice.
 * `reason` is the service's own explanation.
 */
export class ConflictError extends ServiceError {
  constructor(message: string, status: number, body: unknown, url: string, readonly runId?: Hex, readonly code?: string, readonly reason?: string) {
    super(message, status, body, url);
    this.name = "ConflictError";
  }
}

/** 402: the service wants an x402 payment. `paymentRequired` holds the decoded requirements. */
export class PaymentRequiredError extends ServiceError {
  constructor(message: string, status: number, body: unknown, url: string, readonly paymentRequired: X402PaymentRequired | null) {
    super(message, status, body, url);
    this.name = "PaymentRequiredError";
  }
  get accepts(): X402PaymentRequirements[] {
    return this.paymentRequired?.accepts ?? [];
  }
}

/** 404: the service does not know this runId. */
export class NotFoundError extends ServiceError {
  constructor(message: string, status: number, body: unknown, url: string) {
    super(message, status, body, url);
    this.name = "NotFoundError";
  }
}

/** waitForReceipt gave up: the timeout passed, or the receipt's batch was voided. */
export class WaitError extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "voided",
    readonly last?: ServiceReceipt,
  ) {
    super(message);
    this.name = "WaitError";
  }
}

function endpoint(serviceUrl: string, path: string): string {
  return `${serviceUrl.replace(/\/+$/, "")}${path}`;
}

function base64ToUtf8(value: string): string {
  const binary = atob(value.trim());
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Decodes the x402 requirements of a 402: the v2 PAYMENT-REQUIRED header, else a v1 JSON body. */
export function decodePaymentRequired(headers: Headers, body: unknown): X402PaymentRequired | null {
  const header = headers.get("payment-required");
  if (header) {
    try {
      const parsed = JSON.parse(base64ToUtf8(header));
      if (parsed && Array.isArray(parsed.accepts)) return parsed as X402PaymentRequired;
    } catch {
      // fall through to the body
    }
  }
  if (body && typeof body === "object" && Array.isArray((body as { accepts?: unknown }).accepts)) {
    return body as X402PaymentRequired;
  }
  return null;
}

/** "1000 base units of 0x… on eip155:743111 to 0x…" for each accepted payment option. */
export function describePaymentRequired(required: X402PaymentRequired | null): string {
  if (!required || required.accepts.length === 0) return "the service asked for payment but sent no x402 requirements";
  return required.accepts
    .map((a) => `${a.amount ?? a.maxAmountRequired ?? "?"} base units of ${a.asset} on ${a.network} to ${a.payTo} (${a.scheme}${a.extra?.assetTransferMethod ? `, ${String(a.extra.assetTransferMethod)}` : ""})`)
    .join("; or ");
}

function errorText(body: unknown): { message?: string; errors: string[] } {
  if (typeof body === "string") return { message: body.slice(0, 500) || undefined, errors: [] };
  if (!body || typeof body !== "object") return { errors: [] };
  const b = body as Record<string, unknown>;
  const errors = Array.isArray(b.errors) ? b.errors.map(String) : Array.isArray(b.details) ? b.details.map(String) : [];
  const message = typeof b.message === "string" ? b.message : typeof b.error === "string" ? b.error : undefined;
  return { message, errors };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(method: "GET" | "POST", url: string, payload: unknown, options: ServiceOptions): Promise<{ status: number; body: unknown }> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method,
      headers: { accept: "application/json", ...(payload !== undefined ? { "content-type": "application/json" } : {}), ...options.headers },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    // status 0: no HTTP answer. With a paying fetch this is also where payment-creation errors land.
    const e = new ServiceError(`cannot reach the receipts service at ${url}: ${(error as Error).message}`, 0, undefined, url);
    e.cause = error;
    throw e;
  }
  const body = await readBody(response);
  if (response.ok) return { status: response.status, body };

  const { message, errors } = errorText(body);
  const detail = [message, ...errors].filter(Boolean).join("; ");
  const what = `${method} ${url} answered ${response.status}`;
  switch (response.status) {
    case 400:
    case 422:
      throw new ValidationError(`${what}: ${detail || "invalid request"}`, response.status, body, url, errors.length ? errors : message ? [message] : []);
    case 402: {
      const required = decodePaymentRequired(response.headers, body);
      throw new PaymentRequiredError(`${what}: payment required: ${describePaymentRequired(required)}`, response.status, body, url, required);
    }
    case 404:
      throw new NotFoundError(`${what}: ${detail || "not found"}`, response.status, body, url);
    case 409: {
      const b = (body && typeof body === "object" ? body : {}) as { runId?: unknown; error?: unknown };
      const runId = typeof b.runId === "string" ? (b.runId as Hex) : undefined;
      const code = typeof b.error === "string" ? b.error : undefined;
      throw new ConflictError(`${what}: ${detail || "runId already used with a different manifest"}`, response.status, body, url, runId, code, detail || undefined);
    }
    default:
      throw new ServiceError(`${what}${detail ? `: ${detail}` : ""}`, response.status, body, url);
  }
}

function isServiceReceipt(body: unknown): body is ServiceReceipt {
  return !!body && typeof body === "object" && (body as { format?: unknown }).format === "hemi-agent-receipt";
}

/** The direct path answers with the attestation itself (plus `status` on a resubmission), not a receipt file. */
function isDirectBody(body: unknown): body is DirectAttestation & { receiptUrl?: string; status?: unknown } {
  const b = body as { receipt?: { runId?: unknown }; to?: unknown; data?: unknown; serviceSignature?: unknown; deadline?: unknown } | undefined;
  return (
    !!b &&
    typeof b === "object" &&
    typeof b.receipt?.runId === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(b.receipt.runId) &&
    typeof b.to === "string" &&
    typeof b.data === "string" &&
    typeof b.serviceSignature === "string" &&
    typeof b.deadline === "number"
  );
}

function toSubmitResult(status: number, body: unknown, url: string): SubmitResult {
  if (isDirectBody(body)) {
    const { receiptUrl, status: statusInfo, ...direct } = body;
    return {
      httpStatus: status,
      created: status !== 200,
      runId: direct.receipt.runId,
      stage: isStatusInfo(statusInfo) ? statusInfo.stage : "pending",
      receiptUrl,
      direct,
    };
  }
  if (isServiceReceipt(body)) {
    return {
      httpStatus: status,
      created: status === 201 || status === 202,
      runId: body.receipt.runId,
      stage: body.status?.stage ?? (body.anchor ? "hemi-included" : "pending"),
      receipt: body,
    };
  }
  const b = (body ?? {}) as { runId?: Hex; status?: unknown; receiptUrl?: string; receipt?: unknown };
  if (typeof b.runId !== "string") throw new ServiceError(`unexpected response from ${url}: no runId in ${JSON.stringify(body)?.slice(0, 200)}`, status, body, url);
  const stage = typeof b.status === "string" ? (b.status as ReceiptStage) : isStatusInfo(b.status) ? b.status.stage : "pending";
  return {
    httpStatus: status,
    created: status !== 200,
    runId: b.runId,
    stage,
    receiptUrl: b.receiptUrl,
    receipt: isServiceReceipt(b.receipt) ? b.receipt : undefined,
  };
}

function isStatusInfo(value: unknown): value is StatusInfo {
  return !!value && typeof value === "object" && typeof (value as { stage?: unknown }).stage === "string";
}

function submitBody(input: SubmitRequest): Record<string, unknown> {
  if (!input.manifest && !input.receipt) throw new TypeError("submit: give a manifest or a receipt");
  if (!input.agentSignature) throw new TypeError("submit: agentSignature is required");
  const body: Record<string, unknown> = { agentSignature: input.agentSignature };
  if (input.manifest) body.manifest = input.manifest;
  if (input.receipt) body.receipt = input.receipt;
  if (input.store !== undefined) body.store = input.store;
  return body;
}

/**
 * POST /attest: queue a signed receipt for the next Merkle batch. Resolves with 202 (new) or 200
 * (identical resubmission). Throws ValidationError (400), PaymentRequiredError (402),
 * ConflictError (409: its `code` says why) or ServiceError.
 */
export async function submit(serviceUrl: string, input: SubmitRequest, options: ServiceOptions = {}): Promise<SubmitResult> {
  const url = endpoint(serviceUrl, "/attest");
  const { status, body } = await request("POST", url, submitBody(input), options);
  return toSubmitResult(status, body, url);
}

/**
 * POST /attest/direct: anchor this one receipt in its own transaction (a batch of one). The
 * result's `direct` holds the countersignature and calldata to send; nothing is anchored until
 * the caller's transaction is mined. 202 (new) or 200 (identical resubmission, re-signed if the
 * signature was about to expire).
 */
export async function submitDirect(serviceUrl: string, input: SubmitRequest, options: ServiceOptions = {}): Promise<SubmitResult> {
  const url = endpoint(serviceUrl, "/attest/direct");
  const { status, body } = await request("POST", url, submitBody(input), options);
  return toSubmitResult(status, body, url);
}

/** GET /receipts/:runId. Throws NotFoundError for an unknown runId. */
export async function getReceipt(serviceUrl: string, runId: string, options: ServiceOptions = {}): Promise<ServiceReceipt> {
  const url = endpoint(serviceUrl, `/receipts/${encodeURIComponent(runId.toLowerCase())}`);
  const { body } = await request("GET", url, undefined, options);
  if (!isServiceReceipt(body)) throw new ServiceError(`unexpected response from ${url}: not a receipt file`, 200, body, url);
  return body;
}

/** GET /health: the service's chain and registry, which define the EIP-712 domain agents sign. */
export async function getServiceInfo(serviceUrl: string, options: ServiceOptions = {}): Promise<{ chainId: number; registry: Hex; [key: string]: unknown }> {
  const url = endpoint(serviceUrl, "/health");
  const { body } = await request("GET", url, undefined, options);
  const b = body as { chainId?: unknown; registry?: unknown } | undefined;
  if (!b || typeof b.chainId !== "number" || typeof b.registry !== "string") {
    throw new ServiceError(`unexpected response from ${url}: expected { chainId, registry }`, 200, body, url);
  }
  return b as { chainId: number; registry: Hex };
}

export interface WaitOptions extends ServiceOptions {
  /** Resolve once the receipt reaches this stage or a later one. Default "hemi-included". */
  until?: Stage;
  /** Give up after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Poll interval. Default 5 s. */
  intervalMs?: number;
  /** Called with every status read. */
  onStatus?: (receipt: ServiceReceipt) => void;
}

/** True when `stage` is at or past `target` on the ladder (voided never is). */
export function stageReached(stage: ReceiptStage, target: Stage): boolean {
  return stage !== "voided" && (STAGES as readonly string[]).includes(stage) && stageIndex(stage) >= stageIndex(target);
}

/** Bounds even custom fetches and response bodies that ignore their AbortSignal. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Polls GET /receipts/:runId until the receipt reaches `until`. Transient failures (network,
 * 5xx, 429) are retried until the timeout; 404 and 4xx fail at once. Throws WaitError on
 * timeout or when the batch is voided. The deadline includes requests and response bodies;
 * a caller's signal cancels requests and polling sleeps with its original abort reason.
 */
export async function waitForReceipt(serviceUrl: string, runId: string, options: WaitOptions = {}): Promise<ServiceReceipt> {
  const until = options.until ?? "hemi-included";
  if (!(STAGES as readonly string[]).includes(until)) throw new TypeError(`unknown stage ${until}; expected one of ${STAGES.join(", ")}`);
  const timeoutMs = options.timeoutMs ?? 600_000;
  const intervalMs = options.intervalMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError("timeoutMs must be a finite non-negative number");
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new TypeError("intervalMs must be a finite non-negative number");
  const deadline = Date.now() + timeoutMs;
  let last: ServiceReceipt | undefined;
  let lastError: unknown;
  const timeoutError = () => {
    const where = last?.status ? `still ${last.status.stage}` : lastError ? `last error: ${(lastError as Error).message}` : "no status";
    return new WaitError(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${runId} to reach ${until} (${where})`, "timeout", last);
  };
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const checkDeadline = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) {
      timeout.abort(timeoutError());
      signal.throwIfAborted();
    }
  };
  let timer: ReturnType<typeof setTimeout>;
  // Long waits must not overflow setTimeout's signed 32-bit delay.
  const armDeadline = () => {
    timer = setTimeout(() => {
      if (Date.now() < deadline) armDeadline();
      else timeout.abort(timeoutError());
    }, Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647));
  };
  armDeadline();
  try {
    for (;;) {
      checkDeadline();
      try {
        const next = await abortable(getReceipt(serviceUrl, runId, { ...options, signal }), signal);
        checkDeadline();
        last = next;
        lastError = undefined;
        options.onStatus?.(last);
        checkDeadline();
        if (last.status?.stage === "voided") throw new WaitError(`receipt ${runId} was voided`, "voided", last);
        if (last.status && stageReached(last.status.stage, until)) return last;
      } catch (error) {
        checkDeadline();
        if (error instanceof WaitError) throw error;
        const transient = error instanceof ServiceError && (error.status === 0 || error.status === 429 || error.status >= 500);
        if (!transient) throw error;
        lastError = error;
      }
      let sleepTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await abortable(new Promise<void>((resolve) => {
          sleepTimer = setTimeout(resolve, Math.min(intervalMs, deadline - Date.now(), 2_147_483_647));
        }), signal);
      } finally {
        clearTimeout(sleepTimer);
      }
    }
  } finally {
    clearTimeout(timer!);
  }
}
