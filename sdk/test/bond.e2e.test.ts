/**
 * End to end on the anvil fork of Hemi mainnet (sdk/test/helpers/anvil.ts): FidelityBonds deployed through the real
 * CREATE2 deployer, MockHvm answering with the exact outputs of the funding transaction that bitcoind accepted in
 * the regtest gate (test/fixtures/regtest-bond.json; its tag names this CREATE2 address and chain 31337), and every
 * step through the `hbf bond` CLI: record, status (verify + live), the output spent, refresh, status Ended.
 * HBF_E2E_NO_FORK=1 runs the same on a plain local chain.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import { BITCOIN_FACTS_INIT_CODE, BITCOIN_FACTS_SALT } from "../src/facts.js";
import {
  bondId,
  FIDELITY_BONDS_INIT_CODE,
  FIDELITY_BONDS_RUNTIME,
  FIDELITY_BONDS_SALT,
  fidelityBondsAbi,
  fidelityBondsCreate2Address,
  parseBondFactFile,
  serializeBondFactFile,
  type BondFactFile,
} from "../src/bonds.js";
import {
  deployCreate2,
  encodeHeader,
  hbf,
  installForwarder,
  installMockHvm,
  MOCK_HVM_ADMIN,
  mockHvmAdminAbi,
  precompileAddress,
  SDK,
  sendVia,
  startAnvil,
  type Anvil,
} from "./helpers/anvil.js";

const FIXTURE = JSON.parse(readFileSync(join(SDK, "test/fixtures/regtest-bond.json"), "utf8")) as {
  bondFile: Record<string, string>;
  outputs: { sats: string; script: Hex }[];
};
const BOND = FIXTURE.bondFile;
const TXID = BOND.txid as Hex;
const LOCKTIME = Number(BOND.locktime);
const SATS = BigInt(BOND.sats!);
const TIP = { height: 976_900, hash: keccak256(toHex("bond-e2e-tip")) };

let anvil: Anvil;
let contract: Address;
let other: Address; // a second FidelityBonds deployment
let facts: Address; // a BitcoinFacts: code that is not a FidelityBonds
let dir: string;
let bondFile: string;
let factFile: string;
const gas: Record<string, bigint> = {};

const rpcArgs = () => ["--rpc", anvil.url, "--contract", contract];
const read = (path: string): BondFactFile => {
  const p = parseBondFactFile(JSON.parse(readFileSync(path, "utf8")));
  if (!p.ok) throw new Error(p.errors.join("; "));
  return p.file;
};
function tamper(name: string, edit: (o: Record<string, any>) => void): string {
  const o = JSON.parse(readFileSync(factFile, "utf8")) as Record<string, any>;
  edit(o);
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(o, null, 2)}\n`);
  return path;
}
/**
 * The harness's mockHvm() without viem's 4-second receipt polling. Anvil answers eth_sendTransaction a moment before
 * it has mined the block, and on a fork it forwards a receipt it does not have yet to the upstream RPC, so polling
 * the receipt would spend the public RPC's request budget. This waits on eth_blockNumber, which anvil answers
 * locally, and reads the receipt once the block is there.
 */
async function mockHvm<F extends (typeof mockHvmAdminAbi)[number]["name"]>(
  a: Anvil,
  precompile: number,
  functionName: F,
  args: readonly unknown[],
): Promise<void> {
  const data = encodeFunctionData({ abi: mockHvmAdminAbi, functionName, args } as never);
  const before = BigInt(await a.rpc<Hex>("eth_blockNumber"));
  const hash = await a.rpc<Hex>("eth_sendTransaction", [{ from: MOCK_HVM_ADMIN, to: precompileAddress(precompile), data, gas: toHex(15_000_000) }]);
  for (let i = 0; i < 1000 && BigInt(await a.rpc<Hex>("eth_blockNumber")) <= before; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  // the receipt can trail the block number by a moment; a miss is forwarded upstream, so retry slowly and rarely
  for (let i = 0; i < 20; i++) {
    const receipt = await a.rpc<{ status: Hex } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`mock ${functionName} on 0x${precompile.toString(16)} failed`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`mock ${functionName} on 0x${precompile.toString(16)}: no receipt`);
}
async function setTip(time: number, height = TIP.height, hash = TIP.hash): Promise<void> {
  await mockHvm(anvil, 0x44, "setTip", [encodeHeader({ height, hash, time })]);
}
/** The funding transaction's outputs as mainnet's hVM shows them: unspent outputs in 0x48 and 0x42, the tag in 0x42. */
async function setOutputs(bondSpent: boolean): Promise<void> {
  for (const [i, o] of FIXTURE.outputs.entries()) {
    const unspent = o.script.startsWith("0x6a") ? false : i === Number(BOND.bondVout) ? !bondSpent : true;
    for (const p of [0x48, 0x42]) await mockHvm(anvil, p, "setOutput", [TXID, i, BigInt(o.sats), o.script, unspent ? 1 : 0]);
  }
}
async function estimate(functionName: "recordBond" | "liveBond" | "refresh", args: readonly unknown[]): Promise<bigint> {
  return anvil.client.estimateGas({
    account: anvil.account,
    to: contract,
    data: encodeFunctionData({ abi: fidelityBondsAbi, functionName, args } as never),
  });
}

before(async () => {
  anvil = await startAnvil();
  await installMockHvm(anvil);
  await setTip(LOCKTIME - 7200);
  await setOutputs(false);
  await mockHvm(anvil, 0x43, "setConfirmations", [TXID, 5]);
  contract = await deployCreate2(anvil, FIDELITY_BONDS_INIT_CODE, FIDELITY_BONDS_SALT);
  other = await deployCreate2(anvil, FIDELITY_BONDS_INIT_CODE, toHex(1, { size: 32 }));
  facts = await deployCreate2(anvil, BITCOIN_FACTS_INIT_CODE, BITCOIN_FACTS_SALT);
  dir = mkdtempSync(join(tmpdir(), "hbf-bond-"));
  bondFile = join(dir, "bond.json");
  writeFileSync(bondFile, `${JSON.stringify(BOND, null, 2)}\n`);
  factFile = join(dir, "bond-fact.json");
});

after(async () => {
  await anvil?.stop();
  if (Object.keys(gas).length) {
    process.stdout.write(`# gas (eth_estimateGas on anvil with MockHvm): ${Object.entries(gas).map(([k, v]) => `${k} ${v}`).join(", ")}\n`);
  }
});

test("the regtest funding transaction names this CREATE2 address and chain (else: npm run test:regtest -- --update-fixture)", () => {
  assert.equal(contract, fidelityBondsCreate2Address());
  assert.equal(BOND.contract, contract.toLowerCase(), "contract code changed since the fixture was made: rerun the regtest gate with --update-fixture");
  assert.equal(Number(BOND.chainId), anvil.chainId);
});

test("bond create checks the registry on the Hemi RPC before any key is read (independent audit, finding 2)", () => {
  const base = [
    "bond", "create", "--rpc", anvil.url, "--agent", String(BOND.agent), "--sats", "20000", "--lock-for", "1h",
    "--btc-network", "regtest", "--btc-rpc", "http://u:p@127.0.0.1:9", "--btc-key-file", "/nonexistent/.secrets/none.key",
  ];
  // the deployed FidelityBonds: the check passes, and the next step (the key) fails
  let r = hbf([...base, "--contract", contract]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /ENOENT|no such file/);
  // no contract at the address: refused, nothing read or locked
  r = hbf([...base, "--contract", "0x000000000000000000000000000000000000dEaD"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no contract at 0x000000000000000000000000000000000000dEaD on chain 31337/);
  // another contract's code (BitcoinFacts): refused
  r = hbf([...base, "--contract", facts]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /is not this SDK's FidelityBonds/);
  // --no-registry-check skips it, with a warning
  r = hbf([...base, "--contract", "0x000000000000000000000000000000000000dEaD", "--no-registry-check"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /warning: --no-registry-check/);
});

test("bond create asks every --rpc URL on its own: one without the contract is refused (audit-fixes review R-5)", async () => {
  const second = await startAnvil({ fork: false });
  try {
    const r = hbf([
      "bond", "create", "--rpc", anvil.url, "--rpc", second.url, "--contract", contract, "--agent", String(BOND.agent),
      "--sats", "20000", "--lock-for", "1h", "--btc-network", "regtest", "--btc-rpc", "http://u:p@127.0.0.1:9",
      "--btc-key-file", "/nonexistent/.secrets/none.key",
    ]);
    assert.equal(r.code, 2, r.stderr);
    const host = new URL(second.url).host.replace(/\./g, "\\.");
    assert.match(r.stderr, new RegExp(`no contract at ${contract} on chain 31337 \\(http://${host}\\)`));
  } finally {
    await second.stop();
  }
});

describe("pre-mainnet audit", () => {
  /** Runs `body` and puts the chain (and so MockHvm's answers) back as it was. */
  async function isolated(body: () => Promise<void>): Promise<void> {
    const snapshot = await anvil.rpc<Hex>("evm_snapshot");
    try {
      await body();
    } finally {
      await anvil.rpc("evm_revert", [snapshot]);
    }
  }

  test("M-1: a bond recorded through another contract (a wrapper that front-runs it) is valid, by fact file, --id and --bond-file", () =>
    isolated(async () => {
      await mockHvm(anvil, 0x43, "setConfirmations", [TXID, 6]);
      await installForwarder(anvil);
      const data = encodeFunctionData({
        abi: fidelityBondsAbi,
        functionName: "recordBond",
        args: [TXID, Number(BOND.bondVout), Number(BOND.tagVout), BOND.witnessScript as Hex],
      });
      const via = await sendVia(anvil, contract, data);
      const receipt = await anvil.client.waitForTransactionReceipt({ hash: via });
      assert.equal(receipt.status, "success");
      assert.notEqual(receipt.to?.toLowerCase(), contract.toLowerCase());
      let r = hbf(["bond", "status", "--id", bondId(TXID, 0), ...rpcArgs(), "--json"]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const j = JSON.parse(r.stdout);
      assert.equal(j.valid, true);
      assert.equal(j.live.status, "Live");
      assert.equal(j.file.recording.txHash, via);
      const path = join(dir, "bond-via-forwarder.json");
      writeFileSync(path, `${JSON.stringify(j.file, null, 2)}\n`);
      r = hbf(["bond", "status", path, ...rpcArgs()]);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /^valid\n/);
      r = hbf(["bond", "status", "--bond-file", bondFile, ...rpcArgs()]);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /status now\s+Live/);
    }));

  test("I-3: status refuses a contract whose code is not this SDK's FidelityBonds", () =>
    isolated(async () => {
      const lookalike: Address = "0x00000000000000000000000000000000000b0a75";
      await anvil.rpc("anvil_setCode", [lookalike, `${FIDELITY_BONDS_RUNTIME}00`]);
      const r = hbf(["bond", "status", "--id", bondId(TXID, 0), "--rpc", anvil.url, "--contract", lookalike]);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /^invalid: not a FidelityBonds contract: the code at 0x[0-9a-fA-F]{40} is not this SDK's FidelityBonds/);
      // record and refresh refuse it too (pre-mainnet review R-2); bond create's registry check already did
      for (const args of [
        ["bond", "record", "--txid", TXID, "--bond-vout", "0", "--tag-vout", "1", "--witness-script", BOND.witnessScript!, "--key-file", anvil.keyFile],
        ["bond", "refresh", "--id", bondId(TXID, 0), "--key-file", anvil.keyFile],
      ]) {
        const s = hbf([...args, "--rpc", anvil.url, "--contract", lookalike]);
        assert.equal(s.code, 1, `${args.join(" ")}: ${s.stderr}`);
        assert.match(s.stderr, /is not this SDK's FidelityBonds .*refusing to use it/, args.join(" "));
      }
    }));

  test("I-5: bond create refuses the zero agent before any request", () => {
    const r = hbf([
      "bond", "create", "--rpc", "http://127.0.0.1:9", "--contract", contract, "--agent", `0x${"0".repeat(40)}`, "--sats", "20000",
      "--lock-for", "1h", "--btc-network", "regtest", "--btc-rpc", "http://u:p@127.0.0.1:9", "--btc-key-file", "/nonexistent/.secrets/none.key",
    ]);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /--agent must be a nonzero EVM address/);
  });

  test("I-5: bond refresh takes --bond-file or --id, checks the file's chain and contract, and needs no key to send nothing", () =>
    isolated(async () => {
      let r = hbf(["bond", "refresh", ...rpcArgs(), "--bond-file", bondFile, "--id", bondId(TXID, 0)]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /give --bond-file or --id, not both/);
      r = hbf(["bond", "refresh", "--rpc", anvil.url, "--contract", other, "--bond-file", bondFile]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /the bond file names 0x[0-9a-fA-F]{40}, not --contract/);
      // Recorded and Live: nothing to send, so no key file is needed.
      await mockHvm(anvil, 0x43, "setConfirmations", [TXID, 6]);
      assert.equal(hbf(["bond", "record", ...rpcArgs(), "--bond-file", bondFile, "--key-file", anvil.keyFile]).code, 0);
      r = hbf(["bond", "refresh", ...rpcArgs(), "--bond-file", bondFile]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^not ended: liveBond says Live/);
      // Spent: now there is something to send, and the key file is required (there is no prompt, D-029).
      await setOutputs(true);
      r = hbf(["bond", "refresh", ...rpcArgs(), "--bond-file", bondFile]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /--key-file <path> is required to sign: .*never at a prompt/);
      r = hbf(["bond", "refresh", ...rpcArgs(), "--bond-file", bondFile, "--key-file", anvil.keyFile]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^ended: bond 0x[0-9a-f]{64} marked ended/);
      // Ended already: nothing to send, no key.
      r = hbf(["bond", "refresh", ...rpcArgs(), "--id", bondId(TXID, 0)]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^already ended/);
    }));
});

describe("record", () => {
  test("5 confirmations: FewConfirmations, nothing sent", () => {
    const r = hbf(["bond", "record", ...rpcArgs(), "--bond-file", bondFile, "--key-file", anvil.keyFile]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not recorded: verdict FewConfirmations \(fewer than 6 Bitcoin confirmations\); nothing was sent/);
    assert.match(r.stderr, /5 confirmations so far/);
  });

  test("status of the bond file before it is recorded: not recorded, and checkBond says FewConfirmations", () => {
    const r = hbf(["bond", "status", "--bond-file", bondFile, ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: not recorded/);
    assert.match(r.stdout, /checkBond now\s+FewConfirmations/);
  });

  test("6 confirmations: recorded, and the fact file holds what the contract stored", async () => {
    await mockHvm(anvil, 0x43, "setConfirmations", [TXID, 6]);
    gas.recordBond = await estimate("recordBond", [TXID, Number(BOND.bondVout), Number(BOND.tagVout), BOND.witnessScript]);
    const r = hbf(["bond", "record", ...rpcArgs(), "--bond-file", bondFile, "--key-file", anvil.keyFile, "--out", factFile]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^recorded bond 0x[0-9a-f]{64} for agent 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 in Hemi tx/);
    const text = readFileSync(factFile, "utf8");
    const f = read(factFile);
    assert.equal(serializeBondFactFile(f), text, "canonical form");
    assert.equal(f.id, bondId(TXID, 0));
    assert.equal(f.chainId, anvil.chainId);
    assert.equal(f.contract, contract.toLowerCase());
    assert.equal(f.fact.agent, BOND.agent);
    assert.equal(f.fact.txid, TXID);
    assert.equal(f.fact.sats, SATS);
    assert.equal(f.fact.locktime, LOCKTIME);
    assert.equal(f.fact.witnessScript, BOND.witnessScript);
    assert.equal(`0x0020${f.fact.witnessProgram.slice(2)}`, BOND.bondScript);
    assert.equal(f.fact.confirmations, 6);
    assert.equal(f.asOf.btcHeight, TIP.height);
    assert.equal(f.asOf.btcBlockHash, TIP.hash);
    // docs/SCHEMA.md's example is this bond: the same file but for the recording's placeholders
    const doc = readFileSync(join(SDK, "../docs/SCHEMA.md"), "utf8");
    const section = doc.slice(doc.indexOf("### `bond` (FidelityBonds)"));
    const example = JSON.parse(/```json\n([\s\S]*?)```/.exec(section)![1]!) as Record<string, unknown>;
    const mine = JSON.parse(text) as Record<string, unknown>;
    for (const k of ["schema", "kind", "chainId", "contract", "id", "fact", "asOf"]) assert.deepEqual(mine[k], example[k], `SCHEMA.md example: ${k}`);
  });

  test("again: already recorded, nothing sent, same file", () => {
    const r = hbf(["bond", "record", ...rpcArgs(), "--bond-file", bondFile, "--key-file", anvil.keyFile, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.created, false);
    assert.equal(j.sentTxHash, undefined);
    assert.equal(`${JSON.stringify(j.file, null, 2)}\n`, readFileSync(factFile, "utf8"));
  });

  test("against another FidelityBonds: WrongContract, nothing sent (by --txid flags; the bond file names its contract)", () => {
    const r = hbf([
      "bond", "record", "--rpc", anvil.url, "--contract", other, "--key-file", anvil.keyFile,
      "--txid", TXID, "--bond-vout", BOND.bondVout!, "--tag-vout", BOND.tagVout!, "--witness-script", BOND.witnessScript!,
    ]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not recorded: verdict WrongContract/);
    const mismatch = hbf(["bond", "record", "--rpc", anvil.url, "--contract", other, "--bond-file", bondFile, "--key-file", anvil.keyFile]);
    assert.equal(mismatch.code, 2);
    assert.match(mismatch.stderr, /the bond's tag names contract 0x[0-9a-fA-F]{40}, not --contract/);
  });

  test("the tag output read as the bond, and the change output: NotABond", () => {
    for (const vout of ["1", "2"]) {
      const r = hbf(["bond", "record", ...rpcArgs(), "--key-file", anvil.keyFile, "--txid", TXID, "--bond-vout", vout, "--tag-vout", "1", "--witness-script", BOND.witnessScript!]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /verdict NotABond/);
    }
  });
});

describe("status: verify and live", () => {
  test("the fact file is valid and the bond is Live", () => {
    const r = hbf(["bond", "status", factFile, ...rpcArgs()]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^valid\n/);
    assert.match(r.stdout, /hemi stage\s+(latest|safe|finalized)/);
    assert.match(r.stdout, /status now\s+Live/);
  });

  test("--id, --bond-file and --txid give the same, and --id rebuilds the file byte for byte", async () => {
    gas.liveBond = await estimate("liveBond", [bondId(TXID, 0)]);
    const byId = hbf(["bond", "status", "--id", bondId(TXID, 0), ...rpcArgs(), "--json"]);
    assert.equal(byId.code, 0, byId.stdout + byId.stderr);
    const j = JSON.parse(byId.stdout);
    assert.equal(j.valid, true);
    assert.equal(j.live.status, "Live");
    assert.equal(j.live.agent.toLowerCase(), BOND.agent);
    assert.equal(`${JSON.stringify(j.file, null, 2)}\n`, readFileSync(factFile, "utf8"));
    for (const args of [["--bond-file", bondFile], ["--txid", TXID, "--bond-vout", "0"]]) {
      const r = hbf(["bond", "status", ...args, ...rpcArgs(), "--json"]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(JSON.parse(r.stdout).file.id, j.file.id);
    }
  });

  test("with only --rpc and --contract: no key, empty HOME, nothing else in the environment", () => {
    const home = mkdtempSync(join(tmpdir(), "hbf-empty-home-"));
    let stdout: string;
    try {
      stdout = execFileSync(process.execPath, [join(SDK, "bin/hbf.mjs"), "bond", "status", factFile, "--rpc", anvil.url, "--contract", contract], {
        cwd: home,
        env: { HOME: home },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      assert.fail(`status failed: ${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
    assert.match(stdout, /^valid\n/);
  });

  test("Expired once the hVM header's time reaches the locktime", async () => {
    try {
      await setTip(LOCKTIME);
      const r = hbf(["bond", "status", factFile, ...rpcArgs()]);
      assert.match(r.stdout, /status now\s+Expired/, r.stdout + r.stderr);
    } finally {
      await setTip(LOCKTIME - 1);
    }
    const r = hbf(["bond", "status", factFile, ...rpcArgs()]);
    assert.match(r.stdout, /status now\s+Live/, r.stdout + r.stderr);
  });

  test("Unknown when hVM cannot say (0x48 and 0x42 silent): never Live", async () => {
    try {
      for (const p of [0x48, 0x42]) await mockHvm(anvil, p, "setFail", [true]);
      assert.match(hbf(["bond", "status", factFile, ...rpcArgs()]).stdout, /status now\s+Unknown/);
      const r = hbf(["bond", "refresh", ...rpcArgs(), "--id", bondId(TXID, 0), "--key-file", anvil.keyFile]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^not ended: liveBond says Unknown .* nothing was sent/);
    } finally {
      for (const p of [0x48, 0x42]) await mockHvm(anvil, p, "setFail", [false]);
    }
  });
});

describe("status: invalid, with a reason", () => {
  test("a changed value", () => {
    const cases: [string, (o: Record<string, any>) => void, RegExp][] = [
      ["sats", (o) => (o.fact.sats = String(SATS + 1n)), /^invalid: changed value: fact\.sats is \d+ in the file but \d+ on chain/],
      ["agent", (o) => (o.fact.agent = "0x000000000000000000000000000000000000beef"), /^invalid: changed value: fact\.agent/],
      ["confirmations", (o) => (o.fact.confirmations = "7"), /^invalid: changed value: fact\.confirmations/],
      ["height", (o) => (o.asOf.btcHeight = String(TIP.height - 1)), /^invalid: changed value: asOf\.btcHeight/],
      ["locktime", (o) => (o.fact.locktime = String(LOCKTIME + 1)), /^invalid: changed value: fact\.locktime is \d+, the witness script says \d+/],
      [
        "script",
        (o) => (o.fact.witnessScript = `${o.fact.witnessScript.slice(0, 4)}${(o.fact.witnessScript.slice(4, 6) === "00" ? "01" : "00")}${o.fact.witnessScript.slice(6)}`),
        /^invalid: changed value: fact\.witnessScript does not hash/,
      ],
      ["template", (o) => (o.fact.witnessScript = `0x05${o.fact.witnessScript.slice(4)}`), /^invalid: changed value: fact\.witnessScript: not a bond witness script/],
    ];
    for (const [name, edit, want] of cases) {
      const r = hbf(["bond", "status", tamper(`changed-${name}.json`, edit), ...rpcArgs()]);
      assert.equal(r.code, 1, name);
      assert.match(r.stdout, want, name);
    }
  });

  test("a wrong contract address", () => {
    let r = hbf(["bond", "status", factFile, "--rpc", anvil.url, "--contract", other]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: wrong contract: the file names 0x[0-9a-f]{40}, verifying against 0x/);
    r = hbf(["bond", "status", tamper("other.json", (o) => (o.contract = other.toLowerCase())), "--rpc", anvil.url, "--contract", other]);
    assert.match(r.stdout, /^invalid: not recorded: no bond with id/);
    r = hbf(["bond", "status", tamper("facts.json", (o) => (o.contract = facts.toLowerCase())), "--rpc", anvil.url, "--contract", facts]);
    assert.match(r.stdout, /^invalid: not a FidelityBonds contract/);
    const nobody = "0x000000000000000000000000000000000000dead";
    r = hbf(["bond", "status", tamper("nobody.json", (o) => (o.contract = nobody)), "--rpc", anvil.url, "--contract", nobody]);
    assert.match(r.stdout, /^invalid: no contract code/);
  });

  test("a recording transaction that does not exist", () => {
    const r = hbf(["bond", "status", tamper("no-tx.json", (o) => (o.recording.txHash = `0x${"ab".repeat(32)}`)), ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: recording transaction does not exist: no transaction 0xabab/);
  });

  test("an id that does not recompute, another chain, a malformed file", () => {
    assert.match(hbf(["bond", "status", tamper("id.json", (o) => (o.id = `0x${"77".repeat(32)}`)), ...rpcArgs()]).stdout, /^invalid: id does not recompute/);
    assert.match(hbf(["bond", "status", tamper("vout.json", (o) => (o.fact.vout = "2")), ...rpcArgs()]).stdout, /^invalid: id does not recompute/);
    assert.match(hbf(["bond", "status", tamper("chain.json", (o) => (o.chainId = "43111")), ...rpcArgs()]).stdout, /^invalid: wrong chain: the file is for chain 43111/);
    assert.match(hbf(["bond", "status", tamper("kind.json", (o) => (o.kind = "output")), ...rpcArgs()]).stdout, /^invalid: malformed fact file: file\.kind must be "bond"/);
    assert.match(hbf(["bond", "status", tamper("extra.json", (o) => (o.fact.pubkey = "0x02")), ...rpcArgs()]).stdout, /^invalid: malformed fact file: file\.fact\.pubkey is not a known key/);
  });

  test("an unknown id", () => {
    const r = hbf(["bond", "status", "--id", `0x${"77".repeat(32)}`, ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: not recorded/);
  });
});

describe("the bond output spent: refresh, Ended", () => {
  test("refresh while unspent sends nothing", () => {
    const r = hbf(["bond", "refresh", ...rpcArgs(), "--bond-file", bondFile, "--key-file", anvil.keyFile]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^not ended: liveBond says Live/);
  });

  test("spent on Bitcoin: status reads Ended at once, before any refresh", async () => {
    await setOutputs(true);
    const r = hbf(["bond", "status", factFile, ...rpcArgs()]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /status now\s+Ended/);
    assert.match(r.stdout, /not yet marked on chain \(hbf bond refresh marks it\)/);
    gas.refresh = await estimate("refresh", [bondId(TXID, 0)]);
  });

  test("refresh marks it ended, with the Bitcoin header it was seen at", async () => {
    await setTip(LOCKTIME + 4000, TIP.height + 9, keccak256(toHex("bond-e2e-tip-2")));
    const r = hbf(["bond", "refresh", ...rpcArgs(), "--id", bondId(TXID, 0), "--key-file", anvil.keyFile, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ended, true);
    assert.equal(j.already, false);
    assert.equal(j.event.btcHeight, TIP.height + 9);
    assert.match(j.sentTxHash, /^0x[0-9a-f]{64}$/);
    const again = hbf(["bond", "refresh", ...rpcArgs(), "--id", bondId(TXID, 0), "--key-file", anvil.keyFile]);
    assert.match(again.stdout, /^already ended/);
  });

  test("status: still a valid recording, and Ended at that height", () => {
    const r = hbf(["bond", "status", factFile, ...rpcArgs()]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^valid\n/);
    assert.match(r.stdout, /status now\s+Ended/);
    assert.match(r.stdout, new RegExp(`ended\\s+seen spent at Bitcoin block ${TIP.height + 9} 0x[0-9a-f]{64}, Hemi block \\d+`));
    const j = JSON.parse(hbf(["bond", "status", factFile, ...rpcArgs(), "--json"]).stdout);
    assert.equal(j.live.status, "Ended");
    assert.equal(j.ended.btcHeight, TIP.height + 9);
  });

  test("recording it again now is refused: Spent", () => {
    const r = hbf(["bond", "record", ...rpcArgs(), "--bond-file", bondFile, "--key-file", anvil.keyFile]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not recorded: verdict Spent/);
  });
});
