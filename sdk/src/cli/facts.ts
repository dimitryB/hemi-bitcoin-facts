/**
 * `hbf facts`: check, record, verify and show BitcoinFacts output and balance facts.
 *
 * Exit codes: 0 success (check: verdict Ok; verify: valid), 1 not Ok / invalid / failed, 2 usage error.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Address } from "viem";
import {
  assertWriteAllowed,
  COMMON_OPTIONS,
  connect,
  loadSigner,
  print,
  requireAddress,
  requireBytes32,
  requireUint,
  toJson,
  UsageError,
  hasKnownCode,
  walletFor,
  type Connection,
} from "../common.js";
import {
  bitcoinFactsCreate2Address,
  btcAddressScript,
  btcNetworkFor,
  checkBalance,
  checkOutput,
  factFileJson,
  factStatus,
  NotRecordableError,
  recordFact,
  scriptAddress,
  serializeFactFile,
  VERDICT_MEANING,
  verifyFactFile,
  verifyFactId,
  writeFactFile,
  type BalanceCheck,
  type BtcNetwork,
  type FactFile,
  type HemiStage,
  type OutputCheck,
  type Subject,
  BITCOIN_FACTS_RUNTIME,
  BITCOIN_FACTS_RUNTIMES,
} from "../facts.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  txid: { type: "string" },
  vout: { type: "string" },
  address: { type: "string" },
  id: { type: "string" },
  out: { type: "string" },
  "code-override": { type: "boolean" },
  "btc-network": { type: "string" },
} as const;

const GROUP_USAGE = `usage: hbf facts <check|record|verify|status> [options]

  check   what hVM says now about an output or an address (eth_call; sends nothing)
  record  record that as a fact on Hemi (a transaction; needs a key)
  verify  check a fact file, or a fact id, against the contract (RPC and contract address only)
  status  show a stored fact, its recording and its Hemi finality stage

Run "hbf facts <command> --help" for its options.`;

const COMMON_HELP = `  --rpc <url>            Hemi JSON-RPC URL (repeat for fallbacks; each must serve the same chain). Required.
  --contract <0x…>       the BitcoinFacts contract
  --chain-id <n>         expected chain id (checked against the RPC)
  --json                 machine-readable output`;

const SUBJECT_HELP = `  --txid <hex> --vout <n>   an output (txid in display order, as explorers print it)
  --address <btc address>   an address (balance fact); must be for the Bitcoin network this chain reads
  --btc-network <net>       mainnet | testnet, for a local chain only (Hemi 43111 = mainnet, 743111 = testnet)`;

const HELP: Record<string, string> = {
  check: `usage: hbf facts check --rpc <url> --contract <0x…> (--txid <hex> --vout <n> | --address <a>) [options]

Runs checkOutput or checkBalance by eth_call and prints the verdict and the fact. Reads are live: an eth_call
shows hVM's Bitcoin view now, whatever block it is pinned to. Exit 0 if the verdict is Ok, 1 otherwise.

${SUBJECT_HELP}
  --code-override           place the compiled BitcoinFacts at --contract for the call (state override), for a
                            contract that is not deployed; --contract defaults to its CREATE2 address then
${COMMON_HELP}`,
  record: `usage: hbf facts record --rpc <url> --contract <0x…> (--txid <hex> --vout <n> | --address <a>) [options]

Checks by eth_call, then sends recordOutput / recordBalance, waits for it, reads back what the contract stored
and writes the fact file (docs/SCHEMA.md). A fact already stored at this Bitcoin tip is not sent again.

${SUBJECT_HELP}
  --key-file <path>         a file under a .secrets/ directory holding the 0x private key (required to sign; no prompt)
  --allow-mainnet           required to send on Hemi mainnet (43111)
  --out <file.json>         write the fact file here (default: print it)
${COMMON_HELP}`,
  verify: `usage: hbf facts verify <file.json> --rpc <url> --contract <0x…>
       hbf facts verify --id <0x…> --rpc <url> --contract <0x…>

Needs nothing else: no key, no Esplora, no environment. Re-reads the stored fact and compares every field,
recomputes the id, checks the code at --contract is this SDK's BitcoinFacts, that the recording transaction
succeeded, that the contract emitted the matching event in it (sent directly or through another contract) and that
it sits in a canonical block, and reports that block's Hemi stage (latest, safe or finalized).
Prints "valid" or "invalid: <reason>"; exit 0 or 1.

${COMMON_HELP}`,
  status: `usage: hbf facts status --id <0x…> --rpc <url> --contract <0x…>

Shows the fact stored under the id, its recording transaction, the Hemi stage of its block and, for an output,
what checkOutput says now.

${COMMON_HELP}`,
};

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${GROUP_USAGE}\n`);
    return command ? 0 : 2;
  }
  const help = HELP[command];
  if (!help) throw new UsageError(`unknown command "facts ${command}"\n${GROUP_USAGE}`);
  let parsed: ReturnType<typeof parse>;
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
    case "check":
      return check(parsed);
    case "record":
      return record(parsed);
    case "verify":
      return verify(parsed);
    case "status":
      return status(parsed);
  }
  return 2;
}

function parse(args: string[]) {
  return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
}
type Parsed = ReturnType<typeof parse>;

// ---------------------------------------------------------------------------------------------

/** Connects and confirms the RPC's chain id (and --chain-id, if given). One eth_chainId request. */
async function connection(p: Parsed): Promise<Connection> {
  // With --chain-id every URL must serve it (the first may then be down); without, the first URL sets the chain.
  const want = p.values["chain-id"] === undefined ? undefined : requireUint(p.values["chain-id"], "--chain-id");
  return connect(p.values.rpc ?? [], want);
}

function subjectOf(p: Parsed, network: BtcNetwork): Subject {
  const { txid, vout, address } = p.values;
  if (address !== undefined && (txid !== undefined || vout !== undefined)) {
    throw new UsageError("give either --txid and --vout, or --address");
  }
  if (address !== undefined) {
    btcAddressScript(address, network); // refuses a wrong-network or undecodable address before any call
    return { kind: "balance", address };
  }
  if (txid === undefined && vout === undefined) throw new UsageError("--txid <hex> --vout <n>, or --address <a>, is required");
  return { kind: "output", txid: requireBytes32(txid, "--txid"), vout: requireUint(vout, "--vout", 0xffff) };
}

function noPositionals(p: Parsed): void {
  if (p.positionals.length) throw new UsageError(`unexpected argument "${p.positionals[0]}"`);
}

// ---------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------

async function check(p: Parsed): Promise<number> {
  noPositionals(p);
  const overrideCode = p.values["code-override"] === true;
  const contract: Address =
    overrideCode && p.values.contract === undefined ? bitcoinFactsCreate2Address() : requireAddress(p.values.contract, "--contract");
  const conn = await connection(p);
  const network = btcNetworkFor(conn.chainId, p.values["btc-network"]);
  const subject = subjectOf(p, network);
  if (!overrideCode && !(await hasKnownCode(conn, contract, BITCOIN_FACTS_RUNTIMES, "BitcoinFacts", "; --code-override runs the compiled BitcoinFacts there"))) {
    return 1;
  }
  const result =
    subject.kind === "output"
      ? await checkOutput(conn.client, contract, subject.txid, subject.vout, { codeOverride: overrideCode })
      : await checkBalance(conn.client, contract, subject.address, { codeOverride: overrideCode });
  print({ contract, codeOverride: overrideCode, ...result }, p.values.json, () => showCheck(result, contract, network, overrideCode, subject));
  return result.verdict === "Ok" ? 0 : 1;
}

function showCheck(
  c: OutputCheck | BalanceCheck,
  contract: Address,
  network: BtcNetwork,
  overrideCode: boolean,
  subject: Subject,
): string {
  const lines = [`verdict        ${c.verdict}${c.verdict === "Ok" ? "" : ` (${VERDICT_MEANING[c.verdict]})`}`];
  if (c.note) lines.push(`note           ${c.note}`);
  if (c.kind === "output") {
    lines.push(`output         ${c.fact.txid}:${c.fact.vout}`);
  } else if (subject.kind === "balance") {
    lines.push(`address        ${subject.address}`);
  }
  if (c.verdict === "Ok") {
    lines.push(`sats           ${c.fact.sats}`);
    if (c.kind === "output") lines.push(`spent          ${c.fact.spent ? "yes (spent as of the block below)" : "no (in hVM's UTXO set)"}`);
    if (c.kind === "output") lines.push(`confirmations  ${c.fact.confirmations}`);
    const addr = scriptAddress(c.fact.script, network);
    lines.push(`script         ${c.fact.script} (${c.fact.scriptLength} bytes${addr ? `, ${addr}` : ""})`);
    lines.push(`scriptHash     ${c.fact.scriptHash}`);
  }
  if (c.asOf.btcHeight || c.asOf.btcBlockHash !== `0x${"0".repeat(64)}`) {
    lines.push(`as of          Bitcoin block ${c.asOf.btcHeight} ${c.asOf.btcBlockHash}`);
  }
  if (c.id !== `0x${"0".repeat(64)}`) lines.push(`fact id        ${c.id}${c.recorded ? " (recorded)" : " (not recorded)"}`);
  lines.push(`contract       ${contract}${overrideCode ? " (compiled code placed by state override)" : ""}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------------------------

async function record(p: Parsed): Promise<number> {
  noPositionals(p);
  const contract = requireAddress(p.values.contract, "--contract");
  const conn = await connection(p);
  // The mainnet guard comes before anything else that could lead to a send, the key-file read included.
  assertWriteAllowed(conn.chainId, p.values["allow-mainnet"]);
  const network = btcNetworkFor(conn.chainId, p.values["btc-network"]);
  const subject = subjectOf(p, network);
  // A write needs this build exactly: the list of known runtimes is for reading (review N-4).
  if (!(await hasKnownCode(conn, contract, [BITCOIN_FACTS_RUNTIME], "BitcoinFacts"))) return 1;
  const account = await loadSigner({ keyFile: p.values["key-file"] });
  const wallet = walletFor(conn, account);
  let result;
  try {
    result = await recordFact(conn.client, wallet, account, conn.chainId, contract, subject);
  } catch (error) {
    if (error instanceof NotRecordableError) {
      process.stderr.write(`not recorded: verdict ${error.verdict} (${VERDICT_MEANING[error.verdict]}); nothing was sent\n`);
      return 1;
    }
    throw error;
  }
  const { file, created } = result;
  if (p.values.out) writeFactFile(p.values.out, file);
  const summary = created
    ? `recorded ${file.kind} fact ${file.id} in Hemi tx ${file.recording.txHash} (block ${file.recording.blockNumber})`
    : `already recorded: ${file.kind} fact ${file.id} in Hemi tx ${file.recording.txHash} (block ${file.recording.blockNumber})${
        result.sentTxHash ? `; this run's transaction ${result.sentTxHash} changed nothing` : "; nothing was sent"
      }`;
  if (p.values.json) {
    process.stdout.write(`${toJson({ created, sentTxHash: result.sentTxHash, out: p.values.out, file: factFileJson(file) })}\n`);
  } else if (p.values.out) {
    process.stdout.write(`${summary}\nwrote ${p.values.out}\n`);
  } else {
    process.stderr.write(`${summary}\n`);
    process.stdout.write(serializeFactFile(file));
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------------------------

async function verify(p: Parsed): Promise<number> {
  const contract = requireAddress(p.values.contract, "--contract");
  const path = p.positionals[0];
  if (p.positionals.length > 1) throw new UsageError(`unexpected argument "${p.positionals[1]}"`);
  if ((path === undefined) === (p.values.id === undefined)) throw new UsageError("give a fact file or --id <0x…>, not both");
  let input: unknown;
  if (path !== undefined) {
    try {
      input = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      process.stdout.write(`invalid: malformed fact file: ${(error as Error).message}\n`);
      return 1;
    }
  }
  const id = p.values.id === undefined ? undefined : requireBytes32(p.values.id, "--id");
  const conn = await connection(p);
  const result = id ? await verifyFactId(conn.client, contract, id) : await verifyFactFile(conn.client, contract, input);
  if (p.values.json) {
    process.stdout.write(
      `${toJson(result.valid ? { valid: true, stage: result.stage, file: factFileJson(result.file) } : { valid: false, code: result.code, reason: result.reason })}\n`,
    );
  } else if (result.valid) {
    process.stdout.write(`valid\n${showFact(result.file, result.stage)}\n`);
  } else {
    process.stdout.write(`invalid: ${result.reason}\n`);
  }
  return result.valid ? 0 : 1;
}

function showFact(file: FactFile, stage: HemiStage | undefined): string {
  const network: BtcNetwork = file.chainId === 743_111 ? "testnet" : "mainnet";
  const lines = [`  kind           ${file.kind}`, `  id             ${file.id}`];
  if (file.kind === "output") {
    lines.push(`  output         ${file.fact.txid}:${file.fact.vout}`);
    lines.push(`  sats           ${file.fact.sats}`);
    lines.push(`  spent          ${file.fact.spent ? "yes" : "no"}`);
    lines.push(`  confirmations  ${file.fact.confirmations} (at recording)`);
  } else {
    lines.push(`  sats           ${file.fact.sats}`);
  }
  const addr = scriptAddress(file.fact.script, network);
  lines.push(`  script         ${file.fact.script}${addr ? ` (${addr})` : ""}`);
  lines.push(`  as of          Bitcoin block ${file.asOf.btcHeight} ${file.asOf.btcBlockHash}`);
  lines.push(`  recorded       Hemi tx ${file.recording.txHash}, block ${file.recording.blockNumber} ${file.recording.blockHash}`);
  lines.push(`  contract       ${file.contract} (chain ${file.chainId})`);
  if (stage) lines.push(`  hemi stage     ${stage}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------

async function status(p: Parsed): Promise<number> {
  noPositionals(p);
  const contract = requireAddress(p.values.contract, "--contract");
  const id = requireBytes32(p.values.id, "--id");
  const conn = await connection(p);
  if (!(await hasKnownCode(conn, contract, BITCOIN_FACTS_RUNTIMES, "BitcoinFacts"))) return 1;
  const s = await factStatus(conn.client, contract, id);
  if (p.values.json) {
    process.stdout.write(`${toJson({ ...s, file: s.file ? factFileJson(s.file) : undefined })}\n`);
    return s.recorded ? 0 : 1;
  }
  if (!s.recorded) {
    process.stdout.write(`not recorded: no fact with id ${id} at ${contract}\n`);
    return 1;
  }
  const lines = ["recorded"];
  if (s.file) lines.push(showFact(s.file, s.stage));
  else lines.push("  (its event was not found in the stored Hemi block)");
  if (s.now) {
    const n = s.now;
    lines.push(
      n.verdict === "Ok"
        ? `  now            ${n.fact.spent ? "spent" : "unspent"}, ${n.fact.sats} sats, ${n.fact.confirmations} confirmations, as of Bitcoin block ${n.asOf.btcHeight}${n.recorded ? " (recorded at this tip too)" : ""}`
        : `  now            ${n.verdict} (${VERDICT_MEANING[n.verdict]})`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

