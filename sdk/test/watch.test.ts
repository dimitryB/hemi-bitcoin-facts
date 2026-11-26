/**
 * watch() against a fake Hemi client (just what watch() reads) and a fake Esplora in memory: no network. Written by the
 * review of the pre-mainnet fixes (docs/SECURITY-AUDIT.md) to pin down M-2's edges; its three
 * residuals (R-3, R-4, R-5) were then fixed, and the tests here assert the fixes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { hexToBytes, type Hex } from "viem";
import { remember, VERDICTS, watch, WATCH_DONE_LIMIT, WATCH_MAX_FAILURES, type Verdict } from "../src/finality.js";
import { buildAbrev, buildBlock, buildTx, P2PKH, popScript, type BuiltTx } from "./helpers/bitcoin.js";

const ZERO32: Hex = `0x${"0".repeat(64)}`;
const LATEST = 10_000;
const K = 9_950; // a keystone below LATEST
const FROM = 9_975; // the newest keystone: one checkpoint read per pass

/** A Bitcoin chain in memory: height -> { hash, raw }. */
class Chain {
  blocks = new Map<number, { hash: string; raw: Uint8Array }>();
  tip = 0;
  failHashAt?: number;
  add(height: number, txs: (BuiltTx | Uint8Array)[] = [], variant = 0): void {
    const coinbase = buildTx([{ value: 50n, script: P2PKH }], { coinbase: true }).raw;
    const hash = `${height.toString(16).padStart(8, "0")}${variant.toString(16).padStart(8, "0")}${"0".repeat(48)}`;
    const raws = txs.map((t) => (t instanceof Uint8Array ? t : t.raw));
    this.blocks.set(height, { hash, raw: buildBlock(1_700_000_000 + height * 600, [coinbase, ...raws]) });
    this.tip = Math.max(this.tip, height);
  }
  /** What watch() and scanBitcoinBlock() use of EsploraClient. */
  get client(): never {
    return {
      tipHeight: async () => this.tip,
      blockHashAtHeight: async (h: number) => {
        if (this.failHashAt === h) throw new Error(`GET /block-height/${h} answered 404: Block not found`);
        const b = this.blocks.get(h);
        if (!b) throw new Error(`GET /block-height/${h} answered 404: Block not found`);
        return b.hash;
      },
      rawBlock: async (hash: string) => {
        const b = [...this.blocks.values()].find((x) => x.hash === hash);
        if (!b) throw new Error("no such block");
        return b.raw;
      },
    } as never;
  }
}

/** The Hemi side: getBlockNumber, checkCheckpoint (stored), checkPublication (verdict per txid). */
function hemi(
  verdictOf: (txid: Hex) => Verdict,
  latest: () => number = () => LATEST,
  options: { receiptStatus?: "success" | "reverted"; throwFor?: Hex; checkpointStored?: boolean } = {},
): { client: never; checks: Hex[] } {
  const checks: Hex[] = [];
  const client = {
    chain: { id: 31_337 },
    getBlockNumber: async () => BigInt(latest()),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: options.receiptStatus ?? "success", transactionHash: hash, blockNumber: 1n, blockHash: ZERO32, logs: [] }),
    // keystoneAbrev: a block with no transactions is a KeystoneError, so exactMatch is null and the contract decides
    request: async () => ({ hash: `0x${"11".repeat(32)}`, parentHash: ZERO32, stateRoot: ZERO32, timestamp: "0x0", transactions: [] }),
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === "checkCheckpoint") return [0, `0x${"00".repeat(12)}`, options.checkpointStored ?? true];
      if (functionName !== "checkPublication") throw new Error(`unexpected ${functionName}`);
      const txid = args[1] as Hex;
      if (txid === options.throwFor) throw new Error(`an RPC error for ${txid} alone`);
      checks.push(txid);
      const v = verdictOf(txid);
      return {
        verdict: VERDICTS.indexOf(v),
        id: ZERO32,
        confirmations: v === "Ok" ? 5 : 0,
        btcHeight: 0,
        btcBlockHash: ZERO32,
        checkpoint: `0x${"00".repeat(12)}`,
        checkpointStored: true,
        keystone: { version: 1, l1Number: 0, l2Number: K, parentHashPrefix: "0x", prevKeystoneHashPrefix: "0x", stateRoot: ZERO32, blockHashPrefix: "0x" },
        abrev: "0x",
        recorded: false,
        best: false,
        becomesBest: true,
        bestTxid: ZERO32,
        bestVout: 0,
        bestConfirmations: 0,
      };
    },
  };
  return { client: client as never, checks };
}

const abrev = buildAbrev({ l2: K, parentHash: `0x${"aa".repeat(32)}`, prevKeystoneHash: `0x${"bb".repeat(32)}`, stateRoot: `0x${"cc".repeat(32)}`, blockHash: `0x${"dd".repeat(32)}` });
const abrevFor = (l2: number): Hex =>
  buildAbrev({ l2, parentHash: `0x${"aa".repeat(32)}`, prevKeystoneHash: `0x${"bb".repeat(32)}`, stateRoot: `0x${"cc".repeat(32)}`, blockHash: `0x${"dd".repeat(32)}` });
const popTx = (n: bigint, l2 = K): BuiltTx => buildTx([{ value: n, script: P2PKH }, { value: 0n, script: popScript(l2 === K ? abrev : abrevFor(l2)) }]);

test("a tip that goes down, then grows back with other blocks: the PoP in the regrown block is found", async () => {
  const chain = new Chain();
  for (let h = 101; h <= 103; h++) chain.add(h);
  const pop = popTx(7n);
  const { client } = hemi(() => "Ok");
  let pass = 0;
  const lines: string[] = [];
  const stats = await watch({
    client,
    contract: "0x0000000000000000000000000000000000000001",
    chainId: 31_337,
    esplora: chain.client,
    fromKeystone: FROM,
    backfillBlocks: 3,
    minConfirmations: 1,
    iterations: 4,
    log: (l) => lines.push(l),
    sleep: async () => {
      pass++;
      if (pass === 1) {
        // the tip goes down to 102, whose block is replaced
        chain.blocks.delete(103);
        chain.tip = 102;
        chain.add(102, [], 1);
      } else if (pass === 2) chain.add(103, [pop], 1); // the chain grows back, the PoP in the new 103
    },
  });
  assert.equal(stats.rescannedBlocks, 1, lines.join("\n"));
  assert.deepEqual(stats.wouldSend.filter((w) => w.startsWith("recordPublication")), [`recordPublication(${K}, ${pop.txid}, 1)`], lines.join("\n"));
});

test("the retry window: NotFound is retried below max(minConf + 12, 20) confirmations and dropped at it", async () => {
  const chain = new Chain();
  const pop = popTx(8n);
  chain.add(101, [pop]);
  for (let h = 102; h <= 103; h++) chain.add(h); // 3 confirmations at the first pass
  const { client, checks } = hemi(() => "NotFound");
  const stats = await watch({
    client,
    contract: "0x0000000000000000000000000000000000000001",
    chainId: 31_337,
    esplora: chain.client,
    fromKeystone: FROM,
    backfillBlocks: 3,
    iterations: 25,
    sleep: async () => chain.add(chain.tip + 1),
  });
  // checked at 3, 4, ..., 20 confirmations: retried at 3..19 (17 times), dropped at 20, then never again
  assert.equal(stats.retried, 17);
  assert.equal(checks.length, 18);
});

test("R-3: a PoP given up after the window is offered again when a later block carries it", async () => {
  const chain = new Chain();
  const pop = popTx(9n);
  chain.add(101, [pop]);
  for (let h = 102; h <= 103; h++) chain.add(h);
  let hvmSees = false;
  const { client } = hemi(() => (hvmSees ? "Ok" : "NotFound"));
  let pass = 0;
  const lines: string[] = [];
  const stats = await watch({
    client,
    contract: "0x0000000000000000000000000000000000000001",
    chainId: 31_337,
    esplora: chain.client,
    fromKeystone: FROM,
    backfillBlocks: 3,
    iterations: 24,
    log: (l) => lines.push(l),
    sleep: async () => {
      pass++;
      // block 101 (with the PoP) was orphaned: hVM never sees it there; the chain grows without it
      if (pass < 20) chain.add(chain.tip + 1);
      else if (pass === 20) {
        // the PoP transaction is mined again, much later, and hVM reads it at once
        chain.add(chain.tip + 1, [pop]);
        hvmSees = true;
      } else chain.add(chain.tip + 1);
    },
  });
  assert.equal(stats.errors, 0);
  assert.ok(lines.some((l) => l.includes(`${pop.txid}:1 for keystone ${K}: still NotFound (hVM may not see it yet) at 20 Bitcoin confirmations; given up`)), lines.join("\n"));
  assert.deepEqual(stats.wouldSend.filter((w) => w.startsWith("recordPublication")), [`recordPublication(${K}, ${pop.txid}, 1)`], "offered once re-mined");
});

test("R-4: a PoP seen while the Hemi RPC is behind its keystone is retried, and offered once the RPC catches up", async () => {
  const chain = new Chain();
  const pop = popTx(10n);
  chain.add(101, [pop]);
  for (let h = 102; h <= 103; h++) chain.add(h);
  let latest = K; // the RPC has not yet served a block past K
  const { client, checks } = hemi(() => "Ok", () => latest);
  const lines: string[] = [];
  const stats = await watch({
    client,
    contract: "0x0000000000000000000000000000000000000001",
    chainId: 31_337,
    esplora: chain.client,
    fromKeystone: K - 25,
    backfillBlocks: 3,
    iterations: 3,
    log: (l) => lines.push(l),
    sleep: async () => {
      latest = LATEST; // caught up
      chain.add(chain.tip + 1);
    },
  });
  assert.ok(lines.some((l) => l.includes(`${pop.txid}:1 for keystone ${K}: keystone beyond the Hemi RPC's block ${K}`)), lines.join("\n"));
  assert.equal(stats.retried, 1);
  assert.equal(checks.length, 1, "offered to checkPublication once the RPC has block K");
  assert.deepEqual(stats.wouldSend.filter((w) => w.startsWith("recordPublication")), [`recordPublication(${K}, ${pop.txid}, 1)`]);
});

test("R-5: an Esplora error ends that pass only; the watch carries on with what it had", async () => {
  const chain = new Chain();
  const pop = popTx(11n);
  for (let h = 101; h <= 103; h++) chain.add(h);
  const { client } = hemi(() => "Ok");
  let pass = 0;
  const lines: string[] = [];
  const stats = await watch({
    client,
    contract: "0x0000000000000000000000000000000000000001",
    chainId: 31_337,
    esplora: chain.client,
    fromKeystone: FROM,
    backfillBlocks: 3,
    minConfirmations: 1,
    iterations: 4,
    log: (l) => lines.push(l),
    sleep: async () => {
      pass++;
      if (pass === 1) chain.failHashAt = 103; // a fallback instance that answers 404 for the newest scanned height
      if (pass === 2) {
        chain.failHashAt = undefined;
        chain.add(104, [pop]);
      }
    },
  });
  assert.equal(stats.errors, 1);
  assert.ok(lines.some((l) => /^pass 2 stopped: .*block-height\/103 answered 404.*; the next pass carries on$/.test(l)), lines.join("\n"));
  assert.deepEqual(stats.wouldSend.filter((w) => w.startsWith("recordPublication")), [`recordPublication(${K}, ${pop.txid}, 1)`]);
});

test("remember: an insertion-ordered set that forgets its oldest entries past the limit (M-2 item 3)", () => {
  const s = new Set<string>();
  for (let i = 0; i < 5; i++) remember(s, `k${i}`, 3);
  assert.deepEqual([...s], ["k2", "k3", "k4"]);
  remember(s, "k2", 3); // seen again: the newest now
  remember(s, "k5", 3);
  assert.deepEqual([...s], ["k4", "k2", "k5"]);
  assert.equal(WATCH_DONE_LIMIT, 10_000);
});

// ---------------------------------------------------------------------------------------------
// Review N-1 to N-3 and N-6 (docs/SECURITY-AUDIT.md), from that review's scratch tests, now asserting the fixes
// ---------------------------------------------------------------------------------------------

/** A (non-standard, consensus-valid) transaction with 65,536 empty outputs and then a PoP output at vout 65,536. */
function hugeTx(): Uint8Array {
  const n = 65_537;
  const pop = hexToBytes(popScript(abrev));
  const head = [0x01, 0, 0, 0, 0x01, ...new Array(32).fill(0xab), 0, 0, 0, 0, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0];
  const out = new Uint8Array(head.length + 65_536 * 9 + 8 + 1 + pop.length + 4);
  out.set(head, 0);
  let i = head.length + 65_536 * 9 + 8; // the empty outputs and the PoP output's value are all zero bytes
  out[i++] = pop.length;
  out.set(pop, i);
  return out;
}

const CONTRACT = "0x0000000000000000000000000000000000000001" as const;

test("N-1: a PoP output past vout 65,535 is ignored when its block is scanned; the publications after it are offered", async () => {
  const chain = new Chain();
  chain.add(101, [hugeTx()]);
  const good = popTx(12n);
  chain.add(102, [good]);
  chain.add(103);
  const { client } = hemi(() => "Ok");
  const lines: string[] = [];
  const stats = await watch({
    client, contract: CONTRACT, chainId: 31_337, esplora: chain.client, fromKeystone: FROM, backfillBlocks: 3, minConfirmations: 1, iterations: 2,
    log: (l) => lines.push(l),
    sleep: async () => chain.add(chain.tip + 1),
  });
  assert.equal(stats.errors, 0, lines.join("\n").slice(0, 2000));
  assert.ok(lines.some((l) => /PoP output 0x[0-9a-f]{64}:65536 is past vout 65,535; ignored/.test(l)));
  assert.deepEqual(stats.wouldSend.filter((w) => w.startsWith("recordPublication")), [`recordPublication(${K}, ${good.txid}, 1)`]);
});

test("N-1, P-1: an output that keeps failing goes to the back, backs off, and is given up only past the window; the others are not starved", async () => {
  const chain = new Chain();
  const poison = popTx(20n);
  const good = popTx(21n);
  chain.add(101, [poison]);
  chain.add(102, [good]);
  chain.add(103);
  const { client, checks } = hemi(() => "Ok", () => LATEST, { throwFor: poison.txid });
  const lines: string[] = [];
  const stats = await watch({
    client, contract: CONTRACT, chainId: 31_337, esplora: chain.client, fromKeystone: FROM, backfillBlocks: 3, minConfirmations: 1, iterations: 40,
    log: (l) => lines.push(l),
    sleep: async () => chain.add(chain.tip + 1),
  });
  assert.deepEqual(stats.wouldSend.filter((w) => w.startsWith("recordPublication")), [`recordPublication(${K}, ${good.txid}, 1)`], "offered on the second pass");
  assert.equal(checks.filter((t) => t === good.txid).length, 1);
  // Tried at passes 1, 2, 4, 8, 16 (3 to 18 confirmations: inside the window, so kept) and 32 (34: given up).
  assert.equal(stats.errors, 6);
  assert.ok(lines.some((l) => l.includes(`${poison.txid}:1 for keystone ${K}: failed 6 times in a row (an RPC error for ${poison.txid} alone); given up`)), lines.join("\n"));
});

test("P-1: an outage of the hVM calls alone delays the waiting publications; none is given up inside the window", async () => {
  const chain = new Chain();
  const pops = [popTx(30n), popTx(31n), popTx(32n)];
  chain.add(101, pops); // 3 outputs, each with 3 confirmations, waiting
  chain.add(102);
  chain.add(103);
  let pass = 0;
  const { client } = hemi(() => "Ok");
  const failing = {
    ...(client as object),
    readContract: async (args: { functionName: string }) => {
      // getBlockNumber and checkCheckpoint (no hVM) answer; every checkPublication fails for passes 1..15
      if (args.functionName === "checkPublication" && pass < 15) throw new Error("HTTP request failed. Status: 429");
      return (client as unknown as { readContract: (a: unknown) => Promise<unknown> }).readContract(args);
    },
  } as never;
  const lines: string[] = [];
  const stats = await watch({
    client: failing, contract: CONTRACT, chainId: 31_337, esplora: chain.client, fromKeystone: FROM, backfillBlocks: 3, iterations: 50,
    log: (l) => lines.push(l),
    sleep: async () => {
      pass++;
    },
  });
  assert.ok(stats.errors > 0 && stats.errors <= 15, `${stats.errors}`);
  assert.ok(!lines.some((l) => l.includes("given up")), lines.join("\n"));
  assert.deepEqual(stats.wouldSend.filter((w) => w.startsWith("recordPublication")).sort(), pops.map((t) => `recordPublication(${K}, ${t.txid}, 1)`).sort());
});

test("N-2: a send that keeps failing (a reverted receipt) backs off, and is given up past the window: a bounded number of sends", async () => {
  const chain = new Chain();
  const first = popTx(13n);
  const second = popTx(14n);
  chain.add(101, [first]);
  chain.add(102, [second]);
  chain.add(103);
  const { client } = hemi(() => "Ok", () => LATEST, { receiptStatus: "reverted" });
  let sends = 0;
  const wallet = { chain: { id: 31_337 }, writeContract: async () => (sends++, `0x${sends.toString(16).padStart(64, "0")}` as Hex) };
  const stats = await watch({
    client, contract: CONTRACT, chainId: 31_337,
    send: { wallet: wallet as never, account: { address: "0x00000000000000000000000000000000000000aa", type: "json-rpc" } as never },
    esplora: chain.client, fromKeystone: FROM, backfillBlocks: 3, minConfirmations: 1, iterations: 80,
    sleep: async () => chain.add(chain.tip + 1),
  });
  assert.ok(sends <= 2 * (WATCH_MAX_FAILURES + 2), `${sends} sends in 80 passes`);
  assert.equal(stats.errors, sends);
  assert.equal(stats.totals.recorded, 0);
});

test("N-3: a forged PoP for a far-future keystone is dropped at once; a retried output is logged once, not every pass", async () => {
  const chain = new Chain();
  const forged = Array.from({ length: 50 }, (_, i) => popTx(BigInt(100 + i), 4_000_000_000));
  const lagging = popTx(99n);
  chain.add(101, [...forged, lagging]);
  chain.add(102);
  chain.add(103);
  const { client, checks } = hemi(() => "NotFound");
  const lines: string[] = [];
  const stats = await watch({
    client, contract: CONTRACT, chainId: 31_337, esplora: chain.client, fromKeystone: FROM, backfillBlocks: 3, iterations: 18,
    log: (l) => lines.push(l),
    sleep: async () => chain.add(chain.tip + 1),
  });
  assert.equal(lines.filter((l) => l.includes("names keystone 4000000000, far past the Hemi RPC's block")).length, 50, "each forgery once");
  assert.ok(!lines.some((l) => l.includes("keystone beyond the Hemi RPC's block")));
  assert.equal(checks.filter((t) => forged.some((f) => f.txid === t)).length, 0, "no RPC call for a forgery");
  assert.equal(lines.filter((l) => l.includes(`${lagging.txid}:1`) && l.includes("retried next time")).length, 1, "the NotFound one is logged once");
  assert.equal(stats.retried, 17);
});

test("N-6: the stats lists are capped but totals count everything", async () => {
  const chain = new Chain();
  const pops = Array.from({ length: 3 }, (_, i) => popTx(BigInt(200 + i)));
  chain.add(101, pops);
  chain.add(102);
  chain.add(103);
  const { client } = hemi(() => "Ok");
  const stats = await watch({ client, contract: CONTRACT, chainId: 31_337, esplora: chain.client, fromKeystone: FROM, backfillBlocks: 3, iterations: 1, sleep: async () => {} });
  assert.equal(stats.totals.wouldSend, stats.wouldSend.length);
  assert.equal(stats.wouldSend.filter((w) => w.startsWith("recordPublication")).length, 3);
});

test("N-2, P-2: a checkpoint whose send keeps failing is tried again after 1, 2, 4, … passes, staying on that keystone", async () => {
  const { client } = hemi(() => "Ok", () => LATEST, { receiptStatus: "reverted", checkpointStored: false });
  let sends = 0;
  const wallet = { chain: { id: 31_337 }, writeContract: async () => (sends++, `0x${sends.toString(16).padStart(64, "0")}` as Hex) };
  const lines: string[] = [];
  const stats = await watch({
    client, contract: CONTRACT, chainId: 31_337,
    send: { wallet: wallet as never, account: { address: "0x00000000000000000000000000000000000000aa", type: "json-rpc" } as never },
    fromKeystone: FROM, iterations: 8, log: (l) => lines.push(l), sleep: async () => {},
  });
  assert.equal(sends, 4, `passes 1, 2, 4 and 8: ${lines.join("\n")}`);
  assert.equal(stats.errors, 4);
});

test("P-2: an hour without gas: once topped up, every keystone cut meanwhile is checkpointed, in order", async () => {
  let latest = 10_000;
  let funded = false;
  const stored = new Set<number>();
  const sent: number[] = [];
  const client = {
    chain: { id: 31_337 },
    getBlockNumber: async () => BigInt(latest),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: "success", transactionHash: hash, blockNumber: 1n, blockHash: ZERO32, logs: [] }),
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName !== "checkCheckpoint") throw new Error(`unexpected ${functionName}`);
      return [0, `0x${"00".repeat(12)}`, stored.has(Number(args[0]))];
    },
  } as never;
  const wallet = {
    chain: { id: 31_337 },
    writeContract: async ({ args }: { args: readonly unknown[] }) => {
      if (!funded) throw new Error("insufficient funds for gas * price + value");
      const k = Number(args[0]);
      stored.add(k);
      sent.push(k);
      return `0x${k.toString(16).padStart(64, "0")}` as Hex;
    },
  };
  let pass = 0;
  await watch({
    client, contract: CONTRACT, chainId: 31_337,
    send: { wallet: wallet as never, account: { address: "0x00000000000000000000000000000000000000aa", type: "json-rpc" } as never },
    fromKeystone: 9_975, iterations: 80,
    sleep: async () => {
      pass++;
      latest += 5; // 60 s passes, 12 s Hemi blocks: a keystone every 5 passes
      if (pass === 60) funded = true; // topped up after an hour
    },
  });
  const expected: number[] = [];
  for (let k = 9_975; k <= Math.floor((latest - 1) / 25) * 25; k += 25) expected.push(k);
  assert.deepEqual(sent, expected, "every keystone, none skipped, in order");
});
