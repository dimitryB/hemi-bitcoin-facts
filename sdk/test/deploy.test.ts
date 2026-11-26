/**
 * The SDK, the deploy script and the README name the same build: the init code the SDK commits hashes to the value
 * Deploy.s.sol pins (docs/DECISIONS.md D-024), and the CREATE2 addresses the SDK computes are the ones the README lists.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { keccak256 } from "viem";
import { BITCOIN_FACTS_INIT_CODE } from "../src/abi/BitcoinFacts.js";
import { FIDELITY_BONDS_INIT_CODE } from "../src/abi/FidelityBonds.js";
import { POP_FINALITY_INIT_CODE } from "../src/abi/PopFinality.js";
import { fidelityBondsCreate2Address } from "../src/bonds.js";
import { bitcoinFactsCreate2Address } from "../src/facts.js";
import { popFinalityCreate2Address } from "../src/finality.js";
import { REPO } from "./helpers/anvil.js";

const deploy = readFileSync(join(REPO, "contracts/script/Deploy.s.sol"), "utf8");
const readme = readFileSync(join(REPO, "README.md"), "utf8");

function pinned(name: string): string {
  const m = new RegExp(`${name}_INITCODE_HASH =\\s*(0x[0-9a-f]{64});`).exec(deploy);
  assert.ok(m, `${name}_INITCODE_HASH not found in Deploy.s.sol`);
  return m[1]!;
}

const cases = [
  ["BitcoinFacts", "BITCOIN_FACTS", BITCOIN_FACTS_INIT_CODE, bitcoinFactsCreate2Address],
  ["PopFinality", "POP_FINALITY", POP_FINALITY_INIT_CODE, popFinalityCreate2Address],
  ["FidelityBonds", "FIDELITY_BONDS", FIDELITY_BONDS_INIT_CODE, fidelityBondsCreate2Address],
] as const;

for (const [name, constant, initCode, address] of cases) {
  test(`${name}: the SDK's init code is the build Deploy.s.sol pins, at the address the README lists`, () => {
    assert.equal(keccak256(initCode), pinned(constant));
    // The README's deployment table: | `Name` | [`0x…`](explorer link) | block |
    assert.match(readme, new RegExp(`\\| \`${name}\` \\| \\[\`${address()}\`\\]\\(https://explorer\\.hemi\\.xyz/address/${address()}\\?tab=contract\\) \\|`));
  });
}
