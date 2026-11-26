/** Smoke test of the shared e2e harness: fork, MockHvm at 0x44, CREATE2 deployer, CLI runner. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { keccak256, toHex } from "viem";
import { encodeHeader, hbf, installMockHvm, mockHvm, precompileAddress, startAnvil, type Anvil } from "./helpers/anvil.js";

let anvil: Anvil;

before(async () => {
  anvil = await startAnvil();
  await installMockHvm(anvil);
});

after(async () => {
  await anvil?.stop();
});

test("MockHvm answers 0x44 with raw bytes on the fork", async () => {
  const header = encodeHeader({ height: 975_300, hash: keccak256(toHex("tip")) });
  await mockHvm(anvil, 0x44, "setTip", [header]);
  const ret = await anvil.rpc<string>("eth_call", [{ to: precompileAddress(0x44), data: "0x" }, "latest"]);
  assert.equal(ret, header);
});

test("the CREATE2 deployer is present", async () => {
  const code = await anvil.client.getCode({ address: "0x4e59b44847b379578588920cA78FbF26c0B4956C" });
  assert.ok(code && code.length > 2);
});

test("hbf runs and reports usage", () => {
  const r = hbf([]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /usage: hbf/);
});
