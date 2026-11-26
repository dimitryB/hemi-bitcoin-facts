/**
 * `hbf bond`: create a bond on Bitcoin, record it on Hemi, show and verify it, refresh it, redeem it.
 *
 * A bond is proof of locked funds, not collateral: nothing can slash it, and the registry does not score it.
 *
 * Two chains, two guards: `create` and `redeem` send Bitcoin transactions and their `--allow-mainnet` means Bitcoin
 * mainnet (plus the amount and duration caps there); `record` and `refresh` send Hemi transactions and their
 * `--allow-mainnet` means Hemi mainnet. Each command touches one chain only.
 *
 * Exit codes: 0 success (status: valid), 1 refused / invalid / failed, 2 usage error.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getAddress, isHex, type Address, type Hex } from "viem";
import {
  assertWriteAllowed,
  COMMON_OPTIONS,
  connect,
  loadSigner,
  redactUrl,
  requireAddress,
  requireBytes32,
  requireUint,
  toJson,
  UsageError,
  hasKnownCode,
  sameCode,
  walletFor,
  type Connection,
} from "../common.js";
import {
  BOND_STATUS_MEANING,
  BOND_VERDICT_MEANING,
  bondFactFileJson,
  bondId,
  BondNotRecordable,
  checkBond,
  endedEvent,
  fidelityBondsCreate2Address,
  liveBond,
  readStoredBond,
  recordBond,
  previewRefresh,
  refreshBond,
  type RefreshResult,
  serializeBondFactFile,
  verifyBondFile,
  verifyBondId,
  writeBondFactFile,
  type BondFactFile,
  type BondRef,
  type BondVerifyResult,
  type LiveBond,
  FIDELITY_BONDS_RUNTIME,
} from "../bonds.js";
import { backendFor, BroadcastRejected } from "../btc/backend.js";
import {
  assertCreateAllowed,
  assertRedeemAllowed,
  bare,
  bondFileJson,
  createBond,
  iso,
  NotYetRedeemable,
  readBondFile,
  redeemBond,
  writeBondFile,
  type BondFile,
} from "../btc/bond.js";
import { loadBtcKey, type AddressType } from "../btc/keys.js";
import { BTC_PARAMS, btcNetForChain, isBtcNet, type BtcNet } from "../btc/networks.js";
import { assertCompressedKey } from "../btc/script.js";
import { DEFAULT_MAX_FEE_RATE } from "../btc/tx.js";
import { Address as BtcAddress } from "@scure/btc-signer";

const OPTIONS = {
  ...COMMON_OPTIONS,
  // Bitcoin side
  "btc-network": { type: "string" },
  "btc-rpc": { type: "string" },
  esplora: { type: "string", multiple: true },
  "btc-key-file": { type: "string" },
  "address-type": { type: "string" },
  "bond-pubkey": { type: "string" },
  "fee-rate": { type: "string" },
  "max-fee-rate": { type: "string" },
  "override-caps": { type: "boolean" },
  "no-registry-check": { type: "boolean" },
  "dry-run": { type: "boolean" },
  "skip-locktime-check": { type: "boolean" },
  agent: { type: "string" },
  sats: { type: "string" },
  locktime: { type: "string" },
  "lock-for": { type: "string" },
  to: { type: "string" },
  // Hemi side
  "bond-file": { type: "string" },
  txid: { type: "string" },
  "bond-vout": { type: "string" },
  "tag-vout": { type: "string" },
  "witness-script": { type: "string" },
  id: { type: "string" },
  out: { type: "string" },
} as const;

const GROUP_USAGE = `usage: hbf bond <create|record|status|refresh|redeem> [options]

  create   lock BTC on Bitcoin in a bond tagged for an agent (a Bitcoin transaction; needs a Bitcoin key)
  record   record a bond with 6+ confirmations on Hemi (a Hemi transaction; needs a Hemi key)
  status   verify a bond fact file and show what the bond is now (RPC and contract address only)
  refresh  mark a recorded bond ended once hVM sees it spent (a Hemi transaction)
  redeem   spend the bond back after its locktime (a Bitcoin transaction; needs the bond's key)

A bond is proof of locked funds, not collateral: nothing can slash it. Run "hbf bond <command> --help".`;

const BTC_HELP = `  --btc-network <net>      mainnet | testnet | regtest (fixed by the Hemi chain for 43111 and 743111)
  --btc-rpc <url>          a bitcoind JSON-RPC, http://user:password@host:port (required for regtest)
  --esplora <url>          Esplora base URL (repeat to rotate); default mempool.space, then blockstream.info
  --btc-key-file <path>    a file under a .secrets/ directory with the key as WIF or hex (required to sign; no prompt)
  --fee-rate <sat/vB>      default: the backend's estimate (bitcoind without data: 2)
  --max-fee-rate <sat/vB>  refuse a higher rate (default ${DEFAULT_MAX_FEE_RATE})
  --dry-run                build and sign, print, broadcast nothing
  --json                   machine-readable output`;

const HEMI_HELP = `  --rpc <url>              Hemi JSON-RPC URL (repeat for fallbacks; each must serve the same chain). Required.
  --contract <0x…>         the FidelityBonds contract
  --chain-id <n>           expected chain id (checked against the RPC)
  --json                   machine-readable output`;

const HELP: Record<string, string> = {
  create: `usage: hbf bond create --agent <0x…> --sats <n> (--locktime <t> | --lock-for <d>) (--chain-id <n> | --rpc <url>) [options]

Builds, signs and broadcasts the funding transaction: output 0 is the bond, P2WSH of
  <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG
and output 1 is the tag, OP_RETURN "HFB1" ‖ chain id ‖ contract ‖ agent, which binds the bond to the agent. Change
goes back to the funding address. The bond file (txid, bond address, witness script: public data, no key) is written
before broadcasting, so redeem can always be run later.

  --agent <0x…>            the EVM address the bond is named for
  --sats <n>               the bond's value (at least 10000, FidelityBonds.MIN_SATS)
  --locktime <t>           Unix seconds or an ISO 8601 time; or --lock-for <d> (e.g. 90m, 2h, 1d) from now
  --rpc <url>              a Hemi RPC: the tag names its chain, and the FidelityBonds at --contract is checked there
                           (its code must be this SDK's FidelityBonds) before any key is read or BTC is locked
  --chain-id <n>           the Hemi chain the tag names, without --rpc; then --no-registry-check is required
  --contract <0x…>         the FidelityBonds the tag names (default: its CREATE2 address from this SDK's code)
  --no-registry-check      lock BTC for a registry that is not checked (e.g. one you will deploy later at exactly
                           that address); a bond tagged for an address without the contract cannot be recorded
  --address-type <t>       p2wpkh (default) | p2tr: the funding address of the key
  --bond-pubkey <hex>      lock to this compressed key instead of the funding key's
  --out <file.json>        the bond file (default bond-<txid prefix>.json)
  --allow-mainnet          required to broadcast on Bitcoin mainnet (Hemi's guard is on record/refresh)
  --override-caps          lift the Bitcoin mainnet caps: at most 20000 sats, at most 24 hours ahead
${BTC_HELP}`,
  redeem: `usage: hbf bond redeem --bond-file <file.json> --to <btc address> [options]

Spends the bond back once Bitcoin accepts it: nLockTime = the locktime, sequence 0xfffffffe, witness
[signature, witness script], all of it to --to. Bitcoin compares a timestamp locktime with the median time past of
the last 11 blocks, which runs about an hour behind the clock, so this works about an hour after the locktime. Until
then it is refused here, before anything is sent; --skip-locktime-check broadcasts anyway (the node refuses it as
non-final).

  --bond-file <file.json>  what bond create wrote
  --to <address>           where the bond's sats go, less the fee
  --allow-mainnet          required to broadcast on Bitcoin mainnet
  --skip-locktime-check    broadcast even before the median time past passes the locktime
${BTC_HELP}`,
  record: `usage: hbf bond record --rpc <url> --contract <0x…> (--bond-file <f> | --txid <hex> --bond-vout <n> --tag-vout <n> --witness-script <hex>) [options]

Checks by eth_call, then sends recordBond, waits for it and writes the bond fact file (docs/SCHEMA.md). Nothing is
sent unless checkBond says Ok, and a bond already recorded is not sent again. hVM sees a Bitcoin transaction about
two blocks after it is mined; the bond needs 6 confirmations.

  --bond-file <f>          what bond create wrote (its chain and contract must be this RPC's and --contract)
  --key-file <path>        a file under a .secrets/ directory with the Hemi key (required to sign; no prompt)
  --allow-mainnet          required to send on Hemi mainnet (43111)
  --out <file.json>        write the fact file here (default: print it)
${HEMI_HELP}`,
  status: `usage: hbf bond status <bond-fact.json> --rpc <url> --contract <0x…>
       hbf bond status (--id <0x…> | --bond-file <f> | --txid <hex> --bond-vout <n>) --rpc <url> --contract <0x…>

Needs nothing else: no key, no Esplora. Verifies the fact file (or the bond stored under the id) against the
contract field by field, recomputes the id, checks the recording transaction and its event and that its block is
canonical, then shows what liveBond says now: Live, Expired, Ended or Unknown, re-read from hVM in this call.
Prints "valid" or "invalid: <reason>" and the status; exit 0 if valid, 1 otherwise.

${HEMI_HELP}`,
  refresh: `usage: hbf bond refresh --rpc <url> --contract <0x…> (--id <0x…> | --bond-file <f>) [options]

Marks a recorded bond ended once hVM shows its output spent (Hvm.spendStatus Spent). Simulated by eth_call first:
nothing is sent while it is unspent or hVM cannot say (Unknown), or when it is already marked ended, and then no key
is asked for. A --bond-file must name this chain and --contract; give --id or --bond-file, not both.

  --key-file <path>        a file under a .secrets/ directory with the Hemi key (required to sign; no prompt)
  --allow-mainnet          required to send on Hemi mainnet (43111)
${HEMI_HELP}`,
};

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${GROUP_USAGE}\n`);
    return command ? 0 : 2;
  }
  const help = HELP[command];
  if (!help) throw new UsageError(`unknown command "bond ${command}"\n${GROUP_USAGE}`);
  let parsed: Parsed;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${help}`);
  }
  if (parsed.values.help) {
    process.stdout.write(`${help}\n`);
    return 0;
  }
  switch (command) {
    case "create":
      return create(parsed);
    case "redeem":
      return redeem(parsed);
    case "record":
      return record(parsed);
    case "status":
      return status(parsed);
    case "refresh":
      return refresh(parsed);
  }
  return 2;
}

type Parsed = ReturnType<typeof parseArgs<{ args: string[]; options: typeof OPTIONS; allowPositionals: true; strict: true }>>;

// ---------------------------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------------------------

function noPositionals(p: Parsed): void {
  if (p.positionals.length) throw new UsageError(`unexpected argument "${p.positionals[0]}"`);
}

function sats(value: string | undefined): bigint {
  if (value === undefined || !/^\d+$/.test(value)) throw new UsageError("--sats <integer> is required");
  return BigInt(value);
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/** --locktime (Unix seconds or ISO 8601) or --lock-for (90m, 2h, 1d, 3600s) from now. */
export function locktimeOf(locktime: string | undefined, lockFor: string | undefined, now = Math.floor(Date.now() / 1000)): number {
  if ((locktime === undefined) === (lockFor === undefined)) throw new UsageError("give --locktime <unix|ISO> or --lock-for <duration>");
  if (lockFor !== undefined) {
    const m = /^(\d+)([smhd])$/.exec(lockFor);
    if (!m) throw new UsageError("--lock-for takes a number and a unit: 90m, 2h, 1d, 3600s");
    return now + Number(m[1]) * UNITS[m[2]!]!;
  }
  if (/^\d+$/.test(locktime!)) return Number(locktime);
  const t = Date.parse(locktime!);
  if (Number.isNaN(t)) throw new UsageError("--locktime takes Unix seconds or an ISO 8601 time");
  return Math.floor(t / 1000);
}

function feeRate(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!(n > 0) || !Number.isFinite(n)) throw new UsageError(`${flag} <sat/vB> must be a positive number`);
  return n;
}

function addressType(value: string | undefined): AddressType {
  if (value === undefined) return "p2wpkh";
  if (value !== "p2wpkh" && value !== "p2tr") throw new UsageError('--address-type must be "p2wpkh" or "p2tr"');
  return value;
}

function btcAddressFor(address: string | undefined, network: BtcNet, flag: string): string {
  if (!address) throw new UsageError(`${flag} <bitcoin address> is required`);
  try {
    BtcAddress(BTC_PARAMS[network]).decode(address);
  } catch {
    throw new UsageError(`${flag} ${address} is not a Bitcoin ${network} address`);
  }
  return address;
}

async function connection(p: Parsed): Promise<Connection> {
  // With --chain-id every URL must serve it (the first may then be down); without, the first URL sets the chain.
  const want = p.values["chain-id"] === undefined ? undefined : requireUint(p.values["chain-id"], "--chain-id");
  return connect(p.values.rpc ?? [], want);
}

function out(p: Parsed, value: unknown, human: () => string): void {
  process.stdout.write(`${p.values.json ? toJson(value) : human()}\n`);
}

// ---------------------------------------------------------------------------------------------
// create (Bitcoin)
// ---------------------------------------------------------------------------------------------

/**
 * Refuses to lock BTC for a registry that is not this SDK's FidelityBonds at `contract` on the tag's chain: the tag
 * binds the bond to that address for good, and a bond tagged for an address without the contract can never be
 * recorded. Needs --rpc; --no-registry-check skips it, with a warning.
 */
async function checkRegistry(p: Parsed, contract: Address, chainId: number, rpcUrls: readonly string[]): Promise<void> {
  if (p.values["no-registry-check"]) {
    process.stderr.write(`warning: --no-registry-check: the tag names ${contract} on chain ${chainId}, which was not checked\n`);
    return;
  }
  if (!p.values.rpc?.length) {
    throw new UsageError(
      `bond create needs --rpc <hemi rpc> to check that FidelityBonds is deployed at ${contract} on chain ${chainId} before BTC is locked for it (or --no-registry-check)`,
    );
  }
  // Every --rpc URL the connection kept (one that did not answer was left out, with a warning) is asked on its own,
  // not through the fallback transport, and each must serve the tag's chain and this SDK's FidelityBonds at the
  // address (audit-fixes review R-5). An RPC you point this at is trusted to tell the truth about its chain; that is
  // the same trust every other command places in it.
  for (const url of rpcUrls) {
    const one = await connect([url]);
    const shown = redactUrl(url);
    if (one.chainId !== chainId) {
      throw new UsageError(`--rpc ${shown} serves chain ${one.chainId}, but the tag names chain ${chainId}; refusing to lock BTC`);
    }
    const code = await one.client.getCode({ address: contract });
    if (code === undefined || code === "0x") {
      throw new UsageError(
        `no contract at ${contract} on chain ${chainId} (${shown}): a bond tagged for it could not be recorded. Deploy FidelityBonds first, or pass --no-registry-check`,
      );
    }
    // BTC is locked for this build exactly, not any known one (N-4).
    if (!sameCode(code, [FIDELITY_BONDS_RUNTIME])) {
      throw new UsageError(`the code at ${contract} on chain ${chainId} (${shown}) is not this SDK's FidelityBonds; refusing to lock BTC for it`);
    }
  }
}

async function create(p: Parsed): Promise<number> {
  noPositionals(p);
  const v = p.values;
  const agent = getAddress(requireAddress(v.agent, "--agent"));
  // Before the chain id is asked for: no request for a bond that could never be recorded (pre-mainnet audit I-5).
  if (BigInt(agent) === 0n) throw new UsageError("--agent must be a nonzero EVM address: a bond tagged for the zero agent can never be recorded");
  const amount = sats(v.sats);
  const locktime = locktimeOf(v.locktime, v["lock-for"]);
  let chainId: number;
  let rpcUrls: readonly string[] = [];
  if (v.rpc?.length) {
    const conn = await connection(p); // reads the chain id only; create sends nothing to Hemi
    chainId = conn.chainId;
    rpcUrls = conn.rpcUrls;
  } else {
    if (v["chain-id"] === undefined) throw new UsageError("--chain-id <n> (the Hemi chain the tag names) or --rpc <url> is required");
    chainId = requireUint(v["chain-id"], "--chain-id", 0xffffffff);
  }
  const contract: Address = v.contract === undefined ? fidelityBondsCreate2Address() : getAddress(requireAddress(v.contract, "--contract"));
  const network = btcNetForChain(chainId, v["btc-network"]);
  const params = {
    network,
    chainId,
    contract,
    agent,
    sats: amount,
    locktime,
    allowMainnet: v["allow-mainnet"],
    overrideCaps: v["override-caps"],
    dryRun: v["dry-run"],
  };
  // Every refusal that needs no key and no network comes first, the Bitcoin mainnet guard included.
  assertCreateAllowed(params);
  // Then the registry the tag will name, still before any key is read (independent audit, finding 2).
  await checkRegistry(p, contract, chainId, rpcUrls);
  const type = addressType(v["address-type"]);
  let bondPubkey: Uint8Array | undefined;
  if (v["bond-pubkey"] !== undefined) {
    const h = v["bond-pubkey"].replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{66}$/.test(h)) throw new UsageError("--bond-pubkey must be 33 bytes of hex (a compressed key)");
    bondPubkey = Uint8Array.from(Buffer.from(h, "hex"));
    try {
      assertCompressedKey(bondPubkey);
    } catch (error) {
      throw new UsageError(`--bond-pubkey: ${(error as Error).message}`);
    }
  }
  const rate = feeRate(v["fee-rate"], "--fee-rate");
  const maxRate = feeRate(v["max-fee-rate"], "--max-fee-rate");
  const backend = backendFor({ network, btcRpc: v["btc-rpc"], esplora: v.esplora });
  const key = await loadBtcKey({ keyFile: v["btc-key-file"], network, addressType: type });
  let path = v.out;
  const result = await createBond({
    ...params,
    backend,
    key,
    bondPubkey,
    feeRate: rate,
    maxFeeRate: maxRate,
    beforeBroadcast(file) {
      path ??= `bond-${bare(file.txid).slice(0, 16)}.json`;
      writeBondFile(path, file);
    },
  }).catch((error: unknown) => {
    if (error instanceof BroadcastRejected) {
      process.stderr.write(`${error.message}\nthe bond file was written to ${path}, but nothing is on chain\n`);
      return undefined;
    }
    throw error;
  });
  if (!result) return 1;
  const { file, tx, broadcast } = result;
  out(p, { broadcast, out: path, backend: backend.name, vsize: tx.vsize, changeVout: tx.changeVout, file: bondFileJson(file) }, () =>
    [
      broadcast ? `bond created: broadcast through ${backend.name}` : "bond built and signed (dry run: nothing was broadcast)",
      `  txid           ${bare(file.txid)}`,
      `  bond           ${bare(file.txid)}:${file.bondVout}, ${file.sats} sats to ${file.bondAddress} (P2WSH)`,
      `  tag            ${bare(file.txid)}:${file.tagVout}, OP_RETURN for agent ${file.agent} (Hemi chain ${file.chainId}, contract ${file.contract})`,
      ...(tx.changeVout === undefined ? [] : [`  change         ${bare(file.txid)}:${tx.changeVout}, ${tx.change} sats to ${file.fundingAddress}`]),
      `  locktime       ${file.locktime} (${iso(file.locktime)}); redeemable once Bitcoin's median time past is after it, about an hour later`,
      `  witness script ${file.witnessScript}`,
      `  fee            ${file.fee} sats (${file.feeRate} sat/vB, ${tx.vsize} vB)`,
      `  bond file      ${path}`,
      ...(broadcast
        ? [
            "next: after 6 Bitcoin confirmations (hVM sees a block about two blocks after it is mined),",
            `  hbf bond record --bond-file ${path} --rpc <hemi rpc> --contract ${file.contract}`,
          ]
        : []),
    ].join("\n"),
  );
  return 0;
}

// ---------------------------------------------------------------------------------------------
// redeem (Bitcoin)
// ---------------------------------------------------------------------------------------------

async function redeem(p: Parsed): Promise<number> {
  noPositionals(p);
  const v = p.values;
  if (!v["bond-file"]) throw new UsageError("--bond-file <file.json> is required");
  const file = readBondFile(v["bond-file"]);
  if (v["btc-network"] !== undefined && (!isBtcNet(v["btc-network"]) || v["btc-network"] !== file.network)) {
    throw new UsageError(`the bond is on Bitcoin ${file.network}; --btc-network ${v["btc-network"]} does not apply`);
  }
  const to = btcAddressFor(v.to, file.network, "--to");
  assertRedeemAllowed(file.network, v["allow-mainnet"], v["dry-run"]);
  const rate = feeRate(v["fee-rate"], "--fee-rate");
  const maxRate = feeRate(v["max-fee-rate"], "--max-fee-rate");
  const backend = backendFor({ network: file.network, btcRpc: v["btc-rpc"], esplora: v.esplora });
  const key = await loadBtcKey({ keyFile: v["btc-key-file"], network: file.network });
  let result;
  try {
    result = await redeemBond({
      backend,
      key,
      bond: file,
      to,
      feeRate: rate,
      maxFeeRate: maxRate,
      allowMainnet: v["allow-mainnet"],
      skipLocktimeCheck: v["skip-locktime-check"],
      dryRun: v["dry-run"],
    });
  } catch (error) {
    if (error instanceof NotYetRedeemable) {
      process.stderr.write(`${error.message}; nothing was sent\n`);
      return 1;
    }
    if (error instanceof BroadcastRejected) {
      process.stderr.write(`redeem refused: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const { tx, broadcast, medianTime } = result;
  out(p, { broadcast, backend: backend.name, medianTime, ...tx }, () =>
    [
      broadcast ? `bond redeemed: broadcast through ${backend.name}` : "redeem built and signed (dry run: nothing was broadcast)",
      `  txid           ${tx.txid}`,
      `  spends         ${bare(file.txid)}:${file.bondVout} (${file.sats} sats)`,
      `  pays           ${tx.outputSats} sats to ${to}`,
      `  fee            ${tx.fee} sats (${tx.feeRate} sat/vB, ${tx.vsize} vB)`,
      `  nLockTime      ${tx.lockTime} (${iso(tx.lockTime)}), sequence 0x${tx.sequence.toString(16)}`,
      `  median time    ${iso(medianTime)} at the node's tip`,
      ...(broadcast ? ["next: once hVM sees the spend, hbf bond refresh marks the bond ended on Hemi"] : []),
    ].join("\n"),
  );
  return 0;
}

// ---------------------------------------------------------------------------------------------
// record (Hemi)
// ---------------------------------------------------------------------------------------------

function refOf(p: Parsed, conn: { chainId: number } | undefined, contract: Address): { ref: BondRef; file?: BondFile } {
  const v = p.values;
  if (v["bond-file"] !== undefined) {
    if (v.txid !== undefined || v["witness-script"] !== undefined) throw new UsageError("give --bond-file or --txid …, not both");
    const file = readBondFile(v["bond-file"]);
    if (conn && file.chainId !== conn.chainId) {
      throw new UsageError(`the bond's tag names Hemi chain ${file.chainId}; the RPC serves chain ${conn.chainId}`);
    }
    if (file.contract.toLowerCase() !== contract.toLowerCase()) {
      throw new UsageError(`the bond's tag names contract ${file.contract}, not --contract ${contract}`);
    }
    return { ref: { txid: file.txid, bondVout: file.bondVout, tagVout: file.tagVout, witnessScript: file.witnessScript }, file };
  }
  const ws = v["witness-script"];
  if (ws === undefined || !isHex(ws.startsWith("0x") ? ws : `0x${ws}`)) throw new UsageError("--witness-script <hex> is required (or --bond-file)");
  return {
    ref: {
      txid: requireBytes32(v.txid, "--txid"),
      bondVout: requireUint(v["bond-vout"], "--bond-vout", 0xffff),
      tagVout: requireUint(v["tag-vout"], "--tag-vout", 0xffff),
      witnessScript: (ws.startsWith("0x") ? ws : `0x${ws}`).toLowerCase() as Hex,
    },
  };
}

async function record(p: Parsed): Promise<number> {
  noPositionals(p);
  const contract = getAddress(requireAddress(p.values.contract, "--contract"));
  const conn = await connection(p);
  // The Hemi mainnet guard comes before anything else that could lead to a send, the key-file read included.
  assertWriteAllowed(conn.chainId, p.values["allow-mainnet"]);
  const { ref } = refOf(p, conn, contract);
  if (!(await hasKnownCode(conn, contract, [FIDELITY_BONDS_RUNTIME], "FidelityBonds"))) return 1;
  const account = await loadSigner({ keyFile: p.values["key-file"] });
  const wallet = walletFor(conn, account);
  let result;
  try {
    result = await recordBond(conn.client, wallet, account, conn.chainId, contract, ref);
  } catch (error) {
    if (error instanceof BondNotRecordable) {
      process.stderr.write(`not recorded: verdict ${error.verdict} (${BOND_VERDICT_MEANING[error.verdict]}); nothing was sent\n`);
      if (error.verdict === "FewConfirmations") process.stderr.write(`  ${error.check.confirmations} confirmations so far; 6 are needed\n`);
      return 1;
    }
    throw error;
  }
  const { file, created, check } = result;
  if (p.values.out) writeBondFactFile(p.values.out, file);
  const summary = created
    ? `recorded bond ${file.id} for agent ${file.fact.agent} in Hemi tx ${file.recording.txHash} (block ${file.recording.blockNumber})`
    : `already recorded: bond ${file.id} in Hemi tx ${file.recording.txHash} (block ${file.recording.blockNumber}); nothing was sent`;
  const warning = check.expired ? "note: the hVM Bitcoin header's time or Hemi's clock is already at or past the locktime: liveBond reports it Expired" : undefined;
  if (p.values.json) {
    process.stdout.write(`${toJson({ created, sentTxHash: result.sentTxHash, gasUsed: result.gasUsed, out: p.values.out, file: bondFactFileJson(file) })}\n`);
  } else if (p.values.out) {
    process.stdout.write(`${summary}\n${warning ? `${warning}\n` : ""}wrote ${p.values.out}\n`);
  } else {
    process.stderr.write(`${summary}\n${warning ? `${warning}\n` : ""}`);
    process.stdout.write(serializeBondFactFile(file));
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// status (Hemi, reads only)
// ---------------------------------------------------------------------------------------------

function showFile(f: BondFactFile): string[] {
  return [
    `  bond id        ${f.id}`,
    `  agent          ${f.fact.agent}`,
    `  output         ${bare(f.fact.txid)}:${f.fact.vout} (tag at :${f.fact.tagVout})`,
    `  sats           ${f.fact.sats}`,
    `  locktime       ${f.fact.locktime} (${iso(f.fact.locktime)})`,
    `  confirmations  ${f.fact.confirmations} (at recording)`,
    `  as of          Bitcoin block ${f.asOf.btcHeight} ${f.asOf.btcBlockHash}`,
    `  recorded       Hemi tx ${f.recording.txHash}, block ${f.recording.blockNumber} ${f.recording.blockHash}`,
    `  contract       ${f.contract} (chain ${f.chainId})`,
  ];
}

async function status(p: Parsed): Promise<number> {
  const v = p.values;
  const contract = getAddress(requireAddress(v.contract, "--contract"));
  if (p.positionals.length > 1) throw new UsageError(`unexpected argument "${p.positionals[1]}"`);
  const path = p.positionals[0];
  const given = [path !== undefined, v.id !== undefined, v["bond-file"] !== undefined, v.txid !== undefined].filter(Boolean).length;
  if (given !== 1) throw new UsageError("give one of: a bond fact file, --id <0x…>, --bond-file <f>, or --txid <hex> --bond-vout <n>");
  let input: unknown;
  if (path !== undefined) {
    try {
      input = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      process.stdout.write(`invalid: malformed fact file: ${(error as Error).message}\n`);
      return 1;
    }
  }
  let bondFile: BondFile | undefined;
  let id: Hex | undefined;
  if (v.id !== undefined) id = requireBytes32(v.id, "--id");
  if (v["bond-file"] !== undefined) {
    bondFile = readBondFile(v["bond-file"]);
    id = bondId(bondFile.txid, bondFile.bondVout);
  }
  if (v.txid !== undefined) id = bondId(requireBytes32(v.txid, "--txid"), requireUint(v["bond-vout"], "--bond-vout", 0xffff));
  const conn = await connection(p);
  const result: BondVerifyResult = id === undefined ? await verifyBondFile(conn.client, contract, input) : await verifyBondId(conn.client, contract, id);

  if (!result.valid) {
    // Not recorded yet: say what checkBond would answer, when the bond file says where to look.
    let check;
    if (result.code === "not-recorded" && bondFile) {
      check = await checkBond(conn.client, contract, { txid: bondFile.txid, bondVout: bondFile.bondVout, tagVout: bondFile.tagVout, witnessScript: bondFile.witnessScript });
    }
    if (v.json) {
      process.stdout.write(`${toJson({ valid: false, code: result.code, reason: result.reason, ...(check ? { check } : {}) })}\n`);
    } else {
      process.stdout.write(`invalid: ${result.reason}\n`);
      if (check) {
        process.stdout.write(
          `  checkBond now  ${check.verdict}${check.verdict === "Ok" ? " (hbf bond record would record it)" : ` (${BOND_VERDICT_MEANING[check.verdict]})`}\n`,
        );
      }
    }
    return 1;
  }
  const live: LiveBond = await liveBond(conn.client, contract, result.file.id);
  const stored = (await readStoredBond(conn.client, contract, result.file.id)) ?? result.stored;
  const ended = await endedEvent(conn.client, contract, result.file.id, stored);
  if (v.json) {
    process.stdout.write(
      `${toJson({ valid: true, stage: result.stage, live, ended: ended ?? (stored.endedHemiBlock ? { btcHeight: stored.endedBtcHeight, hemiBlock: stored.endedHemiBlock } : null), file: bondFactFileJson(result.file) })}\n`,
    );
    return 0;
  }
  const lines = ["valid", ...showFile(result.file), `  hemi stage     ${result.stage}`];
  lines.push(`  status now     ${live.status} (${BOND_STATUS_MEANING[live.status]})`);
  if (stored.endedHemiBlock !== 0n) {
    lines.push(`  ended          seen spent at Bitcoin block ${stored.endedBtcHeight}${ended ? ` ${ended.btcBlockHash}` : ""}, Hemi block ${stored.endedHemiBlock}`);
  } else if (live.status === "Ended") {
    lines.push("  ended          spent per hVM now; not yet marked on chain (hbf bond refresh marks it)");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// refresh (Hemi)
// ---------------------------------------------------------------------------------------------

async function refresh(p: Parsed): Promise<number> {
  noPositionals(p);
  const v = p.values;
  const contract = getAddress(requireAddress(v.contract, "--contract"));
  if (v["bond-file"] !== undefined && v.id !== undefined) throw new UsageError("give --bond-file or --id, not both");
  // The bond file is read and checked before any request (pre-mainnet audit I-5).
  const file = v["bond-file"] === undefined ? undefined : readBondFile(v["bond-file"]);
  const id: Hex = file ? bondId(file.txid, file.bondVout) : requireBytes32(v.id, "--id");
  const conn = await connection(p);
  assertWriteAllowed(conn.chainId, v["allow-mainnet"]);
  if (file && file.chainId !== conn.chainId) throw new UsageError(`the bond file is for chain ${file.chainId}, but the RPC serves chain ${conn.chainId}`);
  if (file && file.contract.toLowerCase() !== contract.toLowerCase()) throw new UsageError(`the bond file names ${file.contract}, not --contract ${contract}`);
  if (!(await hasKnownCode(conn, contract, [FIDELITY_BONDS_RUNTIME], "FidelityBonds"))) return 1;
  if (!(await readStoredBond(conn.client, contract, id))) {
    process.stderr.write(`not recorded: no bond with id ${id} at ${contract}; nothing was sent\n`);
    return 1;
  }
  // Only a refresh that would mark the bond ended needs a key.
  const preview = await previewRefresh(conn.client, contract, id);
  let r: RefreshResult;
  if (preview.already || !preview.wouldEnd) r = { ended: preview.already, already: preview.already, live: preview.live };
  else {
    const account = await loadSigner({ keyFile: v["key-file"] });
    r = await refreshBond(conn.client, walletFor(conn, account), account, contract, id);
  }
  out(p, { id, ...r }, () => {
    if (r.already) return `already ended: bond ${id} was marked ended before; nothing was sent`;
    if (!r.ended) return `not ended: liveBond says ${r.live.status} (${BOND_STATUS_MEANING[r.live.status]}); nothing was sent`;
    return [
      `ended: bond ${id} marked ended in Hemi tx ${r.sentTxHash}`,
      ...(r.event ? [`  seen spent at  Bitcoin block ${r.event.btcHeight} ${r.event.btcBlockHash}, Hemi block ${r.event.hemiBlock}`] : []),
    ].join("\n");
  });
  return 0;
}
