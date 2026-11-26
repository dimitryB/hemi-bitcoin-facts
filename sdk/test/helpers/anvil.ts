/**
 * End-to-end test harness: an anvil fork of Hemi mainnet with MockHvm etched at 0x40–0x49.
 *
 * - The fork keeps mainnet state (the CREATE2 deployer at 0x4e59…956C included) but runs with chain id
 *   31337, so nothing here can be mistaken for a mainnet write and the CLI's mainnet guard stays out of the way.
 * - Set HBF_E2E_NO_FORK=1 to run on a plain anvil chain (offline); the deployer is then installed by setCode.
 * - Contracts come from `forge build` artifacts in contracts/out (built on first use).
 * - Keys are anvil's public development keys, written to a temporary `.secrets/` directory so the CLI's
 *   `--key-file` rule (must live under .secrets/) is exercised as in real use.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getContractAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../../..");
export const CONTRACTS = join(REPO, "contracts");
export const SDK = join(REPO, "sdk");

export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
/** Runtime code of the deterministic-deployment-proxy (Arachnid), as deployed at CREATE2_DEPLOYER. */
const CREATE2_DEPLOYER_CODE: Hex =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

/** anvil's first development key (public; never use outside a local chain). */
export const ANVIL_KEY_0: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const ANVIL_KEY_1: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export const MOCK_HVM_ADMIN: Address = `0x${keccak256(toHex("hemi-bitcoin-facts.mock-hvm.admin")).slice(-40)}`;

export const mockHvmAdminAbi = parseAbi([
  "function setRaw(bytes input, bytes response)",
  "function setAny(bytes response)",
  "function clearAny()",
  "function setFail(bool on)",
  "function setFailInput(bytes input)",
  "function setBalance(string btcAddress, uint64 sats)",
  "function setBlock(bytes32 txid, bytes32 blockHash)",
  "function setConfirmations(bytes32 txid, uint32 count)",
  "function setTip(bytes header)",
  "function setHeader(uint32 height, bytes header)",
  "function setScript(string btcAddress, bytes script)",
  "function setInput(bytes32 txid, uint16 index, uint16 witnessCount, uint64 prevSats, bytes32 prevTxid, uint16 prevVout, uint32 sequence, bytes scriptSig)",
  "function setOutput(bytes32 txid, uint16 index, uint64 sats, bytes script, uint8 flag)",
  "function setWitness(bytes32 txid, uint16 inputIndex, uint16 witnessIndex, bytes item)",
]);

export interface Anvil {
  url: string;
  chainId: number;
  client: PublicClient;
  wallet: WalletClient;
  account: Address;
  /** A `.secrets/` key file holding ANVIL_KEY_0, for `--key-file`. */
  keyFile: string;
  stop(): Promise<void>;
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  mine(blocks?: number): Promise<void>;
}

let nextPort = 18_545 + Math.floor(Math.random() * 1000);

export async function startAnvil(options: { fork?: boolean } = {}): Promise<Anvil> {
  const fork = options.fork ?? process.env.HBF_E2E_NO_FORK !== "1";
  const port = nextPort++;
  const args = ["--port", String(port), "--chain-id", "31337", "--silent"];
  // ~60 compute units a second keeps the fork's lazy state fetches under 4 requests a second (the public RPC
  // allows about 300 a minute).
  if (fork) {
    args.push("--fork-url", process.env.HBF_FORK_URL ?? "https://rpc.hemi.network/rpc");
    args.push("--compute-units-per-second", "60", "--fork-retry-backoff", "1000", "--retries", "8");
  }
  const proc: ChildProcess = spawn("anvil", args, { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;

  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  };

  const deadline = Date.now() + 180_000; // a fork can be slow to start while the public RPC is busy
  for (;;) {
    try {
      await rpc("eth_chainId");
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const chain = { ...foundry, rpcUrls: { default: { http: [url] } } };
  const client = createPublicClient({ chain, transport: http(url), cacheTime: 0 }) as PublicClient;
  const account = privateKeyToAccount(ANVIL_KEY_0);
  const wallet = createWalletClient({ account, chain, transport: http(url) });

  if (!fork || (await client.getCode({ address: CREATE2_DEPLOYER })) === undefined) {
    await rpc("anvil_setCode", [CREATE2_DEPLOYER, CREATE2_DEPLOYER_CODE]);
  }

  const secrets = join(mkdtempSync(join(tmpdir(), "hbf-e2e-")), ".secrets");
  mkdirSync(secrets);
  const keyFile = join(secrets, "anvil-0.key");
  writeFileSync(keyFile, `${ANVIL_KEY_0}\n`, { mode: 0o600 });

  return {
    url,
    chainId: 31337,
    client,
    wallet,
    account: account.address,
    keyFile,
    rpc,
    async mine(blocks = 1) {
      await rpc("anvil_mine", [toHex(blocks)]);
    },
    async stop() {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 100));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Artifacts and deployment
// ---------------------------------------------------------------------------------------------

let built = false;

export function forgeBuild(): void {
  if (built) return;
  execFileSync("forge", ["build"], { cwd: CONTRACTS, stdio: "ignore" });
  built = true;
}

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
}

/** Reads contracts/out/<file>/<name>.json, building first if needed. */
export function artifact(name: string, file = `${name}.sol`): Artifact {
  const path = join(CONTRACTS, "out", file, `${name}.json`);
  if (!existsSync(path)) forgeBuild();
  const json = JSON.parse(readFileSync(path, "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
    deployedBytecode: { object: Hex };
  };
  return { abi: json.abi, bytecode: json.bytecode.object, deployedBytecode: json.deployedBytecode.object };
}

/** Etches MockHvm's runtime code at 0x40–0x49. */
export async function installMockHvm(anvil: Anvil): Promise<void> {
  const code = artifact("MockHvm").deployedBytecode;
  for (let a = 0x40; a <= 0x49; a++) {
    await anvil.rpc("anvil_setCode", [precompileAddress(a), code]);
  }
  await anvil.rpc("anvil_setBalance", [MOCK_HVM_ADMIN, toHex(10n ** 20n)]);
  await anvil.rpc("anvil_impersonateAccount", [MOCK_HVM_ADMIN]);
}

export function precompileAddress(n: number): Address {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

/** Calls a MockHvm admin function on one precompile address, as MOCK_HVM_ADMIN. */
export async function mockHvm<F extends (typeof mockHvmAdminAbi)[number]["name"]>(
  anvil: Anvil,
  precompile: number,
  functionName: F,
  args: readonly unknown[],
): Promise<void> {
  const data = encodeFunctionData({ abi: mockHvmAdminAbi, functionName, args } as never);
  const hash = await anvil.rpc<Hex>("eth_sendTransaction", [
    { from: MOCK_HVM_ADMIN, to: precompileAddress(precompile), data, gas: toHex(15_000_000) },
  ]);
  const receipt = await anvil.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`mock ${functionName} on 0x${precompile.toString(16)} failed`);
}

/** Encodes a 116-byte hVM header (the 0x44/0x45 layout). */
export function encodeHeader(h: {
  height: number;
  hash: Hex;
  version?: number;
  prevHash?: Hex;
  merkleRoot?: Hex;
  time?: number;
  bits?: number;
  nonce?: number;
}): Hex {
  const u32 = (n: number) => toHex(n, { size: 4 });
  return concat([
    u32(h.height),
    h.hash,
    u32(h.version ?? 0x20000000),
    h.prevHash ?? toHex(0, { size: 32 }),
    h.merkleRoot ?? toHex(0, { size: 32 }),
    u32(h.time ?? 1_763_000_000),
    u32(h.bits ?? 0x17034219),
    u32(h.nonce ?? 0),
  ]);
}

/** Deploys init code through the CREATE2 deployer (as production does) and returns the address. */
export async function deployCreate2(anvil: Anvil, initCode: Hex, salt: Hex = toHex(0, { size: 32 })): Promise<Address> {
  const address = getContractAddress({ from: CREATE2_DEPLOYER, salt, bytecode: initCode, opcode: "CREATE2" });
  if ((await anvil.client.getCode({ address })) !== undefined) return address;
  const hash = await anvil.wallet.sendTransaction({
    account: anvil.wallet.account!,
    chain: anvil.wallet.chain,
    to: CREATE2_DEPLOYER,
    data: concat([salt, initCode]),
    gas: 15_000_000n,
  });
  const receipt = await anvil.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || (await anvil.client.getCode({ address })) === undefined) {
    throw new Error("CREATE2 deployment failed");
  }
  return address;
}

/**
 * A forwarder, standing in for a Safe, a smart account, a multicall or a front-runner's one-line wrapper (pre-mainnet
 * audit M-1). Its calldata is the target (32 bytes, left-padded) followed by the call to make; it calls the target
 * with the rest and reverts if that call fails:
 *   calldatacopy(0, 32, calldatasize - 32); call(gas, calldataload(0), 0, 0, calldatasize - 32, 0, 0) or revert
 */
export const FORWARDER_RUNTIME: Hex = "0x6020360360206000376000600060203603600060006000355af160225760006000fd5b00";
export const FORWARDER: Address = "0x00000000000000000000000000000000f0f0f0f0";

export async function installForwarder(anvil: Anvil): Promise<Address> {
  await anvil.rpc("anvil_setCode", [FORWARDER, FORWARDER_RUNTIME]);
  return FORWARDER;
}

/** Sends `data` to `target` through the forwarder, from the harness account; returns the transaction hash. */
export async function sendVia(anvil: Anvil, target: Address, data: Hex): Promise<Hex> {
  return anvil.wallet.sendTransaction({
    account: anvil.wallet.account!,
    chain: anvil.wallet.chain,
    to: FORWARDER,
    data: concat([pad(target, { size: 32 }), data]),
    gas: 3_000_000n,
  });
}

/** Runs the CLI (`node sdk/bin/hbf.mjs …`) and returns exit code, stdout and stderr. */
export function hbf(args: string[], env: NodeJS.ProcessEnv = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [join(SDK, "bin/hbf.mjs"), ...args], {
      cwd: SDK,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
