/**
 * `hbf finality`: checkpoint keystones, record their Bitcoin PoP publications in PopFinality, verify publication
 * fact files, show a Hemi block's Bitcoin finality, and watch for new keystones.
 *
 * Exit codes: 0 success (status: the block is shown Hemi-PoP-final through an exact-matched publication; verify:
 * valid), 1 not done / invalid, 2 usage.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Address, type Hex } from "viem";
import {
  assertWriteAllowed,
  COMMON_OPTIONS,
  connect,
  loadSigner,
  requireAddress,
  requireBytes32,
  requireUint,
  redactUrl,
  toJson,
  UsageError,
  hasKnownCode,
  walletFor,
  type Connection,
} from "../common.js";
import {
  BTC_FINAL_CONFIRMATIONS,
  checkCheckpoint,
  checkPublication,
  coveringKeystone,
  DEFAULT_ESPLORA_MAINNET,
  defaultMiners,
  esploraClient,
  exactMatch,
  recordCandidates,
  finalityStatus,
  findPopHints,
  HISTORY_SERVE_WINDOW,
  HVM_VISIBLE_CONFIRMATIONS,
  isKeystone,
  KEYSTONE_PERIOD,
  NotRecordableError,
  parseAbrev,
  parseStateOverride,
  popFinalityCreate2Address,
  publicationFileFor,
  publicationFileJson,
  readCheckpoint,
  sendCheckpoint,
  sendPublication,
  serializePublicationFile,
  VERDICT_MEANING,
  verifyPublicationFile,
  verifyPublicationKeystone,
  watch,
  writePublicationFile,
  type ConfirmationsResult,
  type ExactMatch,
  type PublicationCheck,
  type PublicationFactFile,
  type PublicationRecordResult,
  type VerifyExtras,
  POP_FINALITY_RUNTIME,
  POP_FINALITY_RUNTIMES,
} from "../finality.js";
import { HEMI_MAINNET_CHAIN_ID } from "../common.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  keystone: { type: "string" },
  block: { type: "string" },
  "btc-txid": { type: "string" },
  vout: { type: "string" },
  out: { type: "string" },
  esplora: { type: "string", multiple: true },
  "scan-blocks": { type: "string" },
  miner: { type: "string", multiple: true },
  search: { type: "string" },
  "skip-reader": { type: "boolean" },
  "skip-exact": { type: "boolean" },
  "from-keystone": { type: "string" },
  "backfill-blocks": { type: "string" },
  "min-confirmations": { type: "string" },
  interval: { type: "string" },
  iterations: { type: "string" },
  "dry-run": { type: "boolean" },
  "allow-inexact": { type: "boolean" },
  "code-override": { type: "boolean" },
  "state-override": { type: "string" },
} as const;

const GROUP_USAGE = `usage: hbf finality <checkpoint|record|verify|status|watch> [options]

  checkpoint  store keystone K's block hash prefix in PopFinality (a transaction; needs a key)
  record      record the Bitcoin PoP transaction that publishes keystone K (a transaction; needs a key)
  verify      check a publication fact file, or a stored publication, against the contract (RPC and address only)
  status      a Hemi block's Bitcoin finality through PopFinality (exact-match and anchored), beside the receipts reader
  watch       checkpoint every new keystone and record its publication when it appears (sends transactions)

Run "hbf finality <command> --help" for its options.`;

const COMMON_HELP = `  --rpc <url>            Hemi JSON-RPC URL (repeat for fallbacks; each must serve the same chain). Required.
  --contract <0x…>       the PopFinality contract. Required.
  --chain-id <n>         expected chain id (checked against the RPC)
  --json                 machine-readable output`;

const KEY_HELP = `  --key-file <path>      a file under a .secrets/ directory holding the 0x private key (required to sign; no prompt)
  --allow-mainnet        required to send on Hemi mainnet (43111)`;

const ESPLORA_HELP = `  --esplora <url>        Esplora base URL (repeat for fallbacks, tried in order). Default on Hemi mainnet:
                         ${DEFAULT_ESPLORA_MAINNET.join(", then ")}; no default elsewhere`;

const HELP: Record<string, string> = {
  checkpoint: `usage: hbf finality checkpoint --keystone <K> --rpc <url> --contract <0x…> [options]

Checks by eth_call (checkCheckpoint), then sends checkpoint(K), which stores the first 12 bytes of block K's
hash. The hash is readable for ${HISTORY_SERVE_WINDOW.toLocaleString("en-US")} blocks (about 27 hours): blockhash within 256, the EIP-2935 history
contract beyond. Outside that window nothing is sent (exit 1). A stored checkpoint is not sent again.

  --keystone <K>         a positive multiple of ${KEYSTONE_PERIOD}
${KEY_HELP}
${COMMON_HELP}`,
  record: `usage: hbf finality record --keystone <K> [--btc-txid <hex> [--vout <n>]] --rpc <url> --contract <0x…> [options]

Records the Bitcoin transaction that publishes keystone K. PopFinality keeps every valid publication, so this works
whatever was recorded before. Without --btc-txid the transaction is found through Esplora (known PoP miners'
transactions, then a scan of Bitcoin blocks from K's time); Esplora only supplies the hint, and only outputs whose
76 bytes equal the keystone rebuilt from Hemi RPC are offered. A --btc-txid whose 76 bytes differ from it is
refused (it would not be Hemi PoP finality) unless --allow-inexact. Every candidate is checked by eth_call
(checkPublication) and the contract decides. recordPublication is sent when the publication is not stored yet, or
when it is stored and would become K's best (which restores a best that stopped verifying); then the publication
fact file is written (docs/SCHEMA.md). K is checkpointed in the same transaction if it is not yet.

  --keystone <K>         the keystone
  --btc-txid <hex>       the PoP transaction (display order); --vout defaults to its PoP output, read from 0x42
  --vout <n>             the PoP output index
  --allow-inexact        record a --btc-txid whose 76 bytes differ from the canonical keystone
${ESPLORA_HELP}
  --miner <btc address>  PoP miner addresses to read first (repeatable; default on mainnet: the known one)
  --scan-blocks <n>      Bitcoin blocks to scan from K's time (default 18)
  --out <file.json>      write the fact file here (default: print it)
${KEY_HELP}
${COMMON_HELP}`,
  verify: `usage: hbf finality verify <file.json> --rpc <url> --contract <0x…>
       hbf finality verify --keystone <K> [--btc-txid <hex> --vout <n>] --rpc <url> --contract <0x…>

Needs nothing else: no key, no Esplora, no environment. Re-reads the file's own stored publication (K, txid, vout)
and K's checkpoint and compares every field, recomputes the id, checks the code at --contract is this SDK's
PopFinality, that the recording transaction succeeded, that the contract emitted the matching event in it (sent
directly or through another contract) and that it sits in a canonical block. Reports its Hemi stage, whether it is
K's best, the live isBtcFinalVia of block K through it, and whether its 76 bytes equal the keystone rebuilt from
Hemi RPC (two more reads; the contract checks K and the block hash prefix only): only an exact match makes
isBtcFinalVia Hemi PoP finality. With --keystone alone it verifies K's best publication.
Prints "valid" or "invalid: <reason>"; exit 0 or 1.

  --skip-exact           do not rebuild the canonical keystone
${COMMON_HELP}`,
  status: `usage: hbf finality status --block <N> [--keystone <K>] [--btc-txid <hex> [--vout <n>]] --rpc <url> --contract <0x…> [options]

Block N's Bitcoin finality through PopFinality, two ways, by eth_call:
  Hemi PoP   isBtcFinalVia(N, K, txid, vout) through one publication whose 76 bytes equal the canonical keystone:
             the one given by --btc-txid, else the one the receipts SDK reader finds (it matches all 76 bytes), else
             K's best if it matches. This is Hemi PoP finality.
  anchored   isBtcAnchored(N, K) through K's best publication (default K: N's covering keystone, or the first later
             keystone with a publication among the next --search). It means K's number and hash prefix are on
             Bitcoin; a forged keystone satisfies it for one Bitcoin fee.
Beside them, the receipts SDK's PoP finality reader for the same block (Esplora and Hemi RPC), and whether it
agrees with isBtcFinalVia on "final" (${BTC_FINAL_CONFIRMATIONS} or more confirmations). Exit 0 if the Hemi PoP reading is final.

  --block <N>            the Hemi block
  --keystone <K>         a keystone at or after N's covering keystone
  --btc-txid <hex>       the exact-matched publication to ask about (of --keystone, or N's covering keystone)
  --vout <n>             its output (default: its PoP output, read from 0x42)
  --search <n>           later keystones to try when the covering one has no publication (default 12)
  --skip-reader          do not run the receipts SDK reader
  --code-override        place the compiled PopFinality at --contract for the calls (state override); --contract
                         defaults to its CREATE2 address then
  --state-override <f>   a JSON file with an eth_call state override ({"0xaddr": {"code", "stateDiff"}}), merged
                         in, e.g. to set a checkpoint and a publication on a contract that is not deployed
  Under --code-override or --state-override the contract's answers are simulated: the output says
  "simulated" (JSON: simulated: true), and final and the exit code follow the simulated answer.
${COMMON_HELP}`,
  watch: `usage: hbf finality watch --rpc <url> --contract <0x…> [options]

A loop. Every --interval seconds: checkpoint each keystone cut since the last pass (checked by eth_call first);
scan each new Bitcoin block once through Esplora for PoP outputs (again if a reorg replaced it), and record each one
whose 76 bytes equal the canonical keystone once it has --min-confirmations (hVM sees a transaction after about
three) and the contract accepts it (it is recorded whether or not it becomes K's best). One hVM cannot read yet
(NotFound, NoBitcoinView, NoConfirmations) is retried on later passes until it has 12 more confirmations (at least
20). A failed request ends that pass only. An output whose request or send keeps failing is tried again after 1, 2,
4, … up to 32 passes, and given up only after 5 failures in a row once past that window; a failing checkpoint keeps
its place until its keystone leaves the 8,191-block window. Hemi requests stay
under 4 a second, Esplora under 1 a second. Sends transactions, so it needs a key (or --dry-run) and, on mainnet,
--allow-mainnet.

  --from-keystone <K>    start with this keystone (default: the newest already cut)
${ESPLORA_HELP}
  --backfill-blocks <n>  Bitcoin blocks to scan back at start (default 3)
  --min-confirmations <n>  before offering a PoP transaction to the contract (default ${HVM_VISIBLE_CONFIRMATIONS})
  --interval <s>         seconds between passes (default 60)
  --iterations <n>       stop after n passes (default: run until interrupted)
  --dry-run              send nothing, need no key: print what would be sent
${KEY_HELP}
${COMMON_HELP}`,
};

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${GROUP_USAGE}\n`);
    return command ? 0 : 2;
  }
  const help = HELP[command];
  if (!help) throw new UsageError(`unknown command "finality ${command}"\n${GROUP_USAGE}`);
  let parsed: Parsed;
  try {
    parsed = parse(rest);
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${help}`);
  }
  if (parsed.values.help) {
    process.stdout.write(`${help}\n`);
    return 0;
  }
  switch (command) {
    case "checkpoint":
      return checkpoint(parsed);
    case "record":
      return record(parsed);
    case "verify":
      return verify(parsed);
    case "status":
      return status(parsed);
    case "watch":
      return watchCommand(parsed);
  }
  return 2;
}

function parse(args: string[]) {
  return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
}
type Parsed = ReturnType<typeof parse>;

// ---------------------------------------------------------------------------------------------

async function connection(p: Parsed): Promise<Connection> {
  // With --chain-id every URL must serve it (the first may then be down); without, the first URL sets the chain.
  const want = p.values["chain-id"] === undefined ? undefined : requireUint(p.values["chain-id"], "--chain-id");
  return connect(p.values.rpc ?? [], want);
}

function requireKeystone(value: string | undefined, flag = "--keystone"): number {
  const k = requireUint(value, flag, 0xffffffff);
  if (!isKeystone(k)) throw new UsageError(`${flag} must be a positive multiple of ${KEYSTONE_PERIOD} below 2^32 (got ${k})`);
  return k;
}

function noPositionals(p: Parsed): void {
  if (p.positionals.length) throw new UsageError(`unexpected argument "${p.positionals[0]}"`);
}

function esploraUrls(p: Parsed, chainId: number): string[] {
  return p.values.esplora?.length ? p.values.esplora : chainId === HEMI_MAINNET_CHAIN_ID ? DEFAULT_ESPLORA_MAINNET : [];
}

/**
 * No code at the contract, or code that is not this SDK's PopFinality: says so and returns false (pre-mainnet review R-2). A command
 * that sends needs this build exactly; the list of known runtimes is for reading (N-4).
 */
function hasCode(conn: Connection, contract: Address, sends: boolean): Promise<boolean> {
  return hasKnownCode(conn, contract, sends ? [POP_FINALITY_RUNTIME] : POP_FINALITY_RUNTIMES, "PopFinality");
}

// ---------------------------------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------------------------------

async function checkpoint(p: Parsed): Promise<number> {
  noPositionals(p);
  const contract = requireAddress(p.values.contract, "--contract");
  const k = requireKeystone(p.values.keystone);
  const conn = await connection(p);
  // The mainnet guard comes before anything that could lead to a send, the key-file read included.
  assertWriteAllowed(conn.chainId, p.values["allow-mainnet"]);
  if (!(await hasCode(conn, contract, true))) return 1;
  const c = await checkCheckpoint(conn.client, contract, k);
  if (c.verdict !== "Ok") {
    process.stderr.write(`not checkpointed: keystone ${k}: ${c.verdict} (${VERDICT_MEANING[c.verdict]}); nothing was sent\n`);
    return 1;
  }
  if (c.stored) {
    const s = await readCheckpoint(conn.client, contract, k);
    const out = { keystone: k, blockHashPrefix: c.blockHashPrefix, created: false, hemiBlock: s?.hemiBlock };
    if (p.values.json) process.stdout.write(`${toJson(out)}\n`);
    else process.stdout.write(`already checkpointed: keystone ${k} ${c.blockHashPrefix} (Hemi block ${s?.hemiBlock}); nothing was sent\n`);
    return 0;
  }
  const account = await loadSigner({ keyFile: p.values["key-file"] });
  const r = await sendCheckpoint(conn.client, walletFor(conn, account), account, contract, k);
  if (p.values.json) process.stdout.write(`${toJson(r)}\n`);
  else process.stdout.write(`checkpointed keystone ${k}: ${r.blockHashPrefix} in Hemi tx ${r.txHash} (block ${r.hemiBlock})\n`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------------------------

function showCheck(c: PublicationCheck): string {
  const k = c.keystone;
  return [
    `verdict        ${c.verdict}${c.verdict === "Ok" ? "" : ` (${VERDICT_MEANING[c.verdict]})`}`,
    ...(c.abrev !== "0x"
      ? [
          `keystone       L2 ${k.l2}, L1 origin ${k.l1}, version ${k.version}`,
          `block hash     ${k.blockHashPrefix}… (checkpoint ${c.checkpoint}${c.checkpointStored ? ", stored" : c.checkpoint === `0x${"0".repeat(24)}` ? "" : ", read now"})`,
        ]
      : []),
    ...(c.verdict === "Ok" ? [`confirmations  ${c.confirmations}${c.recorded ? " (stored already)" : ""}`] : []),
    ...(c.currentBest ? [`K's best       ${c.currentBest.btcTxid}:${c.currentBest.vout}, ${c.currentBest.confirmations} confirmations now`] : []),
  ].join("\n");
}

async function record(p: Parsed): Promise<number> {
  noPositionals(p);
  const contract = requireAddress(p.values.contract, "--contract");
  const k = requireKeystone(p.values.keystone);
  const txid = p.values["btc-txid"] === undefined ? undefined : requireBytes32(p.values["btc-txid"], "--btc-txid");
  if (txid === undefined && p.values.vout !== undefined) throw new UsageError("--vout needs --btc-txid");
  const vout = p.values.vout === undefined ? undefined : requireUint(p.values.vout, "--vout", 0xffff);
  const conn = await connection(p);
  assertWriteAllowed(conn.chainId, p.values["allow-mainnet"]);
  if (!(await hasCode(conn, contract, true))) return 1;
  const log = (s: string) => process.stderr.write(`${s}\n`);

  // Candidates: the one given (its 76 bytes compared with the canonical keystone), or Esplora's exact-match hints.
  let candidates: { btcTxid: Hex; vout: number }[];
  const matchByVout = new Map<number, ExactMatch>();
  if (txid !== undefined) {
    // Every output for K is compared (one canonical rebuild for all): an inexact one at a lower vout must not hide the
    // canonical one (pre-mainnet audit L-5). Exact matches go first; inexact ones only with --allow-inexact.
    const { ranked, usable } = await recordCandidates(conn.client, k, txid, { vout, allowInexact: p.values["allow-inexact"] });
    if (ranked.length === 0 && vout === undefined) {
      process.stderr.write(`0x42 lists no PoP output for keystone ${k} in ${txid}; give --vout to check one anyway. Nothing was sent\n`);
      return 1;
    }
    if (ranked.length > 0 && usable.length === 0) {
      const shown = ranked.map((m) => `${txid}:${m.out.vout} (${m.match.detail})`).join("; ");
      process.stderr.write(
        `not recorded: no output is the canonical keystone ${k}: ${shown}. It would be stored, but it is not Hemi PoP finality; --allow-inexact records it anyway. Nothing was sent\n`,
      );
      return 1;
    }
    for (const m of usable) matchByVout.set(m.out.vout, m.match);
    const nullMatch = usable.find((m) => m.match.exact === null);
    if (nullMatch) log(`note: ${nullMatch.match.detail}; the contract alone decides`);
    candidates = vout !== undefined ? [{ btcTxid: txid, vout }] : usable.map((m) => ({ btcTxid: txid, vout: m.out.vout }));
  } else {
    const urls = esploraUrls(p, conn.chainId);
    if (urls.length === 0) throw new UsageError(`chain ${conn.chainId} has no default Esplora: give --btc-txid, or --esplora <url>`);
    const esplora = esploraClient(urls);
    const hints = await findPopHints(conn.client, esplora, k, {
      miners: p.values.miner?.length ? p.values.miner : defaultMiners(conn.chainId),
      scanBlocks: p.values["scan-blocks"] === undefined ? undefined : requireUint(p.values["scan-blocks"], "--scan-blocks", 1000),
      log,
    });
    if (hints.length === 0) {
      process.stderr.write(`no publication of keystone ${k} found through Esplora (${urls.map(redactUrl).join(", ")}); nothing was sent\n`);
      return 1;
    }
    for (const h of hints) log(`Esplora: ${h.btcTxid}:${h.vout} carries keystone ${k} (${h.height === null ? "unconfirmed" : `Bitcoin block ${h.height}`})`);
    candidates = hints;
  }

  // The contract decides: the Ok candidate with the most confirmations.
  const checks = [];
  for (const c of candidates) checks.push({ ...c, check: await checkPublication(conn.client, contract, k, c.btcTxid, c.vout) });
  const ok = checks.filter((c) => c.check.verdict === "Ok").sort((a, b) => b.check.confirmations - a.check.confirmations);
  const pick = ok[0];
  if (!pick) {
    for (const c of checks) process.stderr.write(`${c.btcTxid}:${c.vout}\n${showCheck(c.check)}\n`);
    const v = checks[0]!.check.verdict;
    process.stderr.write(`not recorded: verdict ${v} (${VERDICT_MEANING[v]}); nothing was sent\n`);
    return 1;
  }

  let result: PublicationRecordResult;
  try {
    // Stored already and not becoming the best: nothing to send, so no key is asked for.
    const needsSend = !pick.check.recorded || pick.check.becomesBest;
    const account = needsSend ? await loadSigner({ keyFile: p.values["key-file"] }) : undefined;
    result = await sendPublication(
      conn.client,
      account ? walletFor(conn, account) : undefined,
      account,
      conn.chainId,
      contract,
      k,
      pick.btcTxid,
      pick.vout,
      { check: pick.check },
    );
  } catch (error) {
    if (error instanceof NotRecordableError) {
      process.stderr.write(`not recorded: verdict ${error.verdict} (${VERDICT_MEANING[error.verdict]}); nothing was sent\n`);
      return 1;
    }
    throw error;
  }
  const { file, created, best } = result;
  if (p.values.out) writePublicationFile(p.values.out, file);
  const where = `in Hemi tx ${file.recording.txHash} (block ${file.recording.blockNumber})`;
  const bestText = best
    ? `K's best${result.previousBest ? ` (it was ${result.previousBest.btcTxid}:${result.previousBest.vout})` : ""}`
    : `not K's best (${pick.check.currentBest?.btcTxid}:${pick.check.currentBest?.vout} has ${pick.check.currentBest?.confirmations} confirmations now)`;
  const summary = created
    ? `recorded the publication of keystone ${k}: ${file.fact.btcTxid}:${file.fact.vout}, ${file.fact.confirmations} confirmations, ${where}; ${bestText}`
    : result.sentTxHash
      ? `already recorded: keystone ${k}'s publication ${file.fact.btcTxid}:${file.fact.vout} ${where}; re-submitted in ${result.sentTxHash}: now ${bestText}`
      : `already recorded: keystone ${k}'s publication ${file.fact.btcTxid}:${file.fact.vout} ${where}; ${bestText}; nothing was sent`;
  if (p.values.json) {
    process.stdout.write(
      `${toJson({ created, best, sentTxHash: result.sentTxHash, previousBest: result.previousBest, exactMatch: matchByVout.get(pick.vout), out: p.values.out, file: publicationFileJson(file) })}\n`,
    );
  } else if (p.values.out) {
    process.stdout.write(`${summary}\nwrote ${p.values.out}\n`);
  } else {
    process.stderr.write(`${summary}\n`);
    process.stdout.write(serializePublicationFile(file));
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------------------------

function showPublication(file: PublicationFactFile, x: VerifyExtras, exact?: ExactMatch): string {
  const a = parseAbrev(file.fact.abrev);
  const lines = [
    `  keystone       ${file.fact.keystone} (L1 origin ${a.l1}, block hash ${a.blockHashPrefix}…)`,
    `  publication    Bitcoin tx ${file.fact.btcTxid}:${file.fact.vout}; ${x.best ? "K's best" : "not K's best"}`,
    `  confirmations  ${file.fact.confirmations} at recording; now ${x.now.verdict === "Ok" ? x.now.confirmations : `${x.now.verdict} (${VERDICT_MEANING[x.now.verdict]})`}${x.now.final ? " (isBtcFinalVia: final)" : ""}`,
    `  as of          Bitcoin block ${file.asOf.btcHeight} ${file.asOf.btcBlockHash}`,
    `  recorded       Hemi tx ${file.recording.txHash}, block ${file.recording.blockNumber} ${file.recording.blockHash}`,
    `  contract       ${file.contract} (chain ${file.chainId})`,
    `  hemi stage     ${x.stage}`,
  ];
  if (exact) {
    lines.push(
      `  exact match    ${exact.exact === null ? "not checked" : exact.exact ? "yes: isBtcFinalVia on it is Hemi PoP finality" : "NO: isBtcFinalVia on it is not Hemi PoP finality"}; ${exact.detail}`,
    );
  }
  return lines.join("\n");
}

async function verify(p: Parsed): Promise<number> {
  const contract = requireAddress(p.values.contract, "--contract");
  const path = p.positionals[0];
  if (p.positionals.length > 1) throw new UsageError(`unexpected argument "${p.positionals[1]}"`);
  if ((path === undefined) === (p.values.keystone === undefined)) throw new UsageError("give a fact file or --keystone <K>, not both");
  if (path !== undefined && p.values["btc-txid"] !== undefined) throw new UsageError("--btc-txid goes with --keystone, not with a fact file");
  if ((p.values["btc-txid"] === undefined) !== (p.values.vout === undefined)) throw new UsageError("give --btc-txid and --vout together");
  let input: unknown;
  if (path !== undefined) {
    try {
      input = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      process.stdout.write(`invalid: malformed fact file: ${(error as Error).message}\n`);
      return 1;
    }
  }
  const k = p.values.keystone === undefined ? undefined : requireKeystone(p.values.keystone);
  const which =
    p.values["btc-txid"] === undefined
      ? undefined
      : { btcTxid: requireBytes32(p.values["btc-txid"], "--btc-txid"), vout: requireUint(p.values.vout, "--vout", 0xffff) };
  const conn = await connection(p);
  const result =
    k !== undefined ? await verifyPublicationKeystone(conn.client, contract, k, which) : await verifyPublicationFile(conn.client, contract, input);
  const exact = result.valid && !p.values["skip-exact"] ? await exactMatch(conn.client, result.file.fact.keystone, result.file.fact.abrev) : undefined;
  if (p.values.json) {
    process.stdout.write(
      `${toJson(
        result.valid
          ? { valid: true, stage: result.stage, best: result.best, now: result.now, exact, file: publicationFileJson(result.file) }
          : { valid: false, code: result.code, reason: result.reason },
      )}\n`,
    );
  } else if (result.valid) {
    process.stdout.write(`valid\n${showPublication(result.file, result, exact)}\n`);
  } else {
    process.stdout.write(`invalid: ${result.reason}\n`);
  }
  return result.valid ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------

const showConf = (c: ConfirmationsResult): string =>
  c.verdict === "Ok" ? `${c.confirmations} Bitcoin confirmations` : `${c.verdict} (${VERDICT_MEANING[c.verdict]})`;

async function status(p: Parsed): Promise<number> {
  noPositionals(p);
  if (p.values["skip-exact"]) {
    throw new UsageError("--skip-exact applies to finality verify; status always checks the exact match (without it nothing is final)");
  }
  const overrideCode = p.values["code-override"] === true;
  const contract: Address =
    overrideCode && p.values.contract === undefined ? popFinalityCreate2Address() : requireAddress(p.values.contract, "--contract");
  const block = BigInt(requireUint(p.values.block, "--block"));
  const k = p.values.keystone === undefined ? undefined : requireKeystone(p.values.keystone);
  if (k !== undefined && BigInt(k) < block) {
    throw new UsageError(`keystone ${k} is before block ${block}; its covering keystone is ${coveringKeystone(block)}`);
  }
  const txid = p.values["btc-txid"] === undefined ? undefined : requireBytes32(p.values["btc-txid"], "--btc-txid");
  if (txid === undefined && p.values.vout !== undefined) throw new UsageError("--vout needs --btc-txid");
  const vout = p.values.vout === undefined ? undefined : requireUint(p.values.vout, "--vout", 0xffff);
  const exactKeystone = k ?? Number(coveringKeystone(block));
  let stateOverride;
  if (p.values["state-override"] !== undefined) {
    try {
      stateOverride = parseStateOverride(JSON.parse(readFileSync(p.values["state-override"], "utf8")));
    } catch (error) {
      throw new UsageError(`--state-override: ${(error as Error).message}`);
    }
  }
  const conn = await connection(p);
  const codeInOverride = stateOverride?.some((o) => o.address.toLowerCase() === contract.toLowerCase() && o.code !== undefined) ?? false;
  if (!overrideCode && !codeInOverride && !(await hasCode(conn, contract, false))) return 1;
  const s = await finalityStatus(conn.client, contract, block, {
    ...(k !== undefined ? { keystone: k } : {}),
    search: p.values.search === undefined ? 12 : requireUint(p.values.search, "--search", 1000),
    ...(p.values["skip-reader"] ? { reader: null } : {}),
    chainId: conn.chainId,
    call: { codeOverride: overrideCode, ...(stateOverride ? { stateOverride } : {}) },
    ...(txid !== undefined ? { exact: { keystone: exactKeystone, btcTxid: txid, ...(vout !== undefined ? { vout } : {}) } } : {}),
  });
  // Under an override the contract's answers are a simulation, not the deployed chain's state: say so
  // (audit-fixes review R-6). The 76-byte check still reads the real chain.
  const simulated = overrideCode || stateOverride !== undefined;
  if (simulated) {
    s.notes.push("simulated: the contract was read with --code-override or --state-override, so isBtcFinalVia, isBtcAnchored and final reflect that override, not the deployed chain");
  }
  if (p.values.json) {
    process.stdout.write(`${toJson({ ...s, simulated })}\n`);
    return s.final ? 0 : 1;
  }
  const lines = [`block          ${s.block} (covering keystone ${s.coveringKeystone})`];
  if (simulated) lines.push(`simulated      yes: the contract's answers come from an override, not the deployed chain`);
  if (s.exact) {
    const e = s.exact;
    lines.push(
      `Hemi PoP       isBtcFinalVia ${e.contract.final}: keystone ${e.keystone}, publication ${e.btcTxid}:${e.vout} (${e.source}): ${showConf(e.contract)}`,
      `               exact match ${e.match.exact === null ? "not checked" : e.match.exact ? "yes" : "NO"}: ${e.match.detail}`,
    );
  } else {
    lines.push(`Hemi PoP       no exact-matched publication found; give --btc-txid to name one`);
  }
  lines.push(
    `anchored       isBtcAnchored ${s.anchored.final}: keystone ${s.keystone}'s best publication: ${showConf(s.anchored)}${
      s.best ? ` (${s.best.btcTxid}:${s.best.vout})` : ""
    }`,
    `               anchored means block ${s.keystone}'s number and hash prefix are on Bitcoin; a forged keystone satisfies it`,
  );
  if (s.reader) {
    const r = s.reader;
    lines.push(
      `receipts SDK   ${r.source}${r.btcConfirmations !== undefined ? `: ${r.btcConfirmations} confirmations` : ""}${
        r.viaKeystone !== undefined ? ` via keystone ${r.viaKeystone}` : ""
      }${r.popTxid ? ` (tx ${r.popTxid})` : ""}; final ${s.readerFinal ?? "n/a"}`,
    );
    if (r.detail) lines.push(`               ${r.detail}`);
  }
  lines.push(`agree          ${s.agree === null ? "n/a" : s.agree ? "yes" : "NO"} (the receipts reader and isBtcFinalVia)`);
  lines.push(
    `final          ${s.final ? "yes: Hemi PoP final through a publication that matches the canonical keystone in all 76 bytes" : "no: not shown Hemi-PoP-final (needs an exact match checked, and isBtcFinalVia true)"}`,
  );
  for (const n of s.notes) lines.push(`note           ${n}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return s.final ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------------------------

async function watchCommand(p: Parsed): Promise<number> {
  noPositionals(p);
  const contract = requireAddress(p.values.contract, "--contract");
  const from = p.values["from-keystone"] === undefined ? undefined : requireKeystone(p.values["from-keystone"], "--from-keystone");
  const iterations = p.values.iterations === undefined ? undefined : requireUint(p.values.iterations, "--iterations");
  const interval = p.values.interval === undefined ? 60 : requireUint(p.values.interval, "--interval", 86_400);
  const conn = await connection(p);
  const dry = p.values["dry-run"] === true;
  if (!dry) assertWriteAllowed(conn.chainId, p.values["allow-mainnet"]);
  if (!(await hasCode(conn, contract, true))) return 1;
  const urls = esploraUrls(p, conn.chainId);
  const account = dry ? undefined : await loadSigner({ keyFile: p.values["key-file"] });
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      controller.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
  // With --json, stdout carries only the summary; the log goes to stderr.
  const log = (s: string) => (p.values.json ? process.stderr : process.stdout).write(`${new Date().toISOString()} ${s}\n`);
  log(
    `watching ${contract} on chain ${conn.chainId}${urls.length ? `; Esplora ${urls.map(redactUrl).join(", ")}` : "; no Esplora: checkpoints only"}${dry ? "; dry run: nothing is sent" : ""}`,
  );
  const stats = await watch({
    client: conn.client,
    contract,
    chainId: conn.chainId,
    ...(account ? { send: { wallet: walletFor(conn, account), account } } : {}),
    ...(urls.length ? { esplora: esploraClient(urls) } : {}),
    ...(from !== undefined ? { fromKeystone: from } : {}),
    ...(p.values["backfill-blocks"] !== undefined ? { backfillBlocks: requireUint(p.values["backfill-blocks"], "--backfill-blocks", 1000) } : {}),
    ...(p.values["min-confirmations"] !== undefined ? { minConfirmations: requireUint(p.values["min-confirmations"], "--min-confirmations", 1000) } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    intervalSeconds: interval,
    signal: controller.signal,
    sleep,
    log,
  });
  const summary = {
    iterations: stats.iterations,
    checkpointed: stats.checkpointed,
    recorded: stats.recorded,
    wouldSend: stats.wouldSend,
    totals: stats.totals,
    scannedBlocks: stats.scannedBlocks,
    skippedInexact: stats.skippedInexact,
    retried: stats.retried,
    rescannedBlocks: stats.rescannedBlocks,
    errors: stats.errors,
  };
  if (p.values.json) process.stdout.write(`${toJson(summary)}\n`);
  else {
    log(
      `done: ${stats.iterations} pass(es), ${stats.totals.checkpointed} checkpoint(s), ${stats.totals.recorded} publication(s) recorded, ${stats.scannedBlocks} Bitcoin block(s) scanned${stats.errors ? `, ${stats.errors} pass(es) stopped by an error` : ""}`,
    );
  }
  // A run in which every pass failed did nothing: exit 1.
  return stats.errors > 0 && stats.errors === stats.iterations ? 1 : 0;
}
