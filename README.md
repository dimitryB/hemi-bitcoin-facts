# hemi-bitcoin-facts

[![CI](https://github.com/dimitryB/hemi-bitcoin-facts/actions/workflows/ci.yml/badge.svg)](https://github.com/dimitryB/hemi-bitcoin-facts/actions/workflows/ci.yml)

Three small contracts on [Hemi](https://hemi.xyz) that read Bitcoin through hVM's precompiles and record what they find, and a TypeScript SDK and CLI (`hbf`) that check, record and verify those records from a Hemi RPC alone.

- **`BitcoinFacts`** records what a Bitcoin output holds, or what an address holds, as of a named Bitcoin block.
- **`PopFinality`** records Hemi keystones and their Proof-of-Proof publications on Bitcoin, so a contract can ask whether a Hemi block is final on Bitcoin.
- **`FidelityBonds`** records BTC that is time-locked on Bitcoin and named for an agent's EVM address.
- **Anyone** verifies a recorded fact with `hbf … verify`, given only an RPC URL and the contract address: no key, no service.

**Try it:** the [Quickstart](#quickstart) verifies the live mainnet records in `mainnet/` in a few commands, with no key and no funds.

## What a fact proves, and what it does not

**A recorded fact proves only that Hemi's full nodes, executing the recording transaction, got that answer from
hVM.** Every node runs the same precompile against its own embedded Bitcoin node, at a Bitcoin height fixed by
consensus, so within a block the answer is agreed. Read it as "Hemi says Bitcoin said this", never as a Bitcoin
proof:

- **You trust Hemi's consensus and operators.** Nothing proves a fact to a light client. ETHBEAT (formerly L2BEAT)
  lists no live fault proofs for Hemi, a whitelisted proposer, and instant upgrades by a 3-of-8 multisig. A
  recorded fact is what Hemi's full nodes recomputed, and no more.
- **hVM trails Bitcoin by about two blocks, sometimes more** (four has been seen). A Bitcoin transaction becomes
  readable after about three confirmations. Balances and spent status are as of the Bitcoin header hVM reports
  (`0x44`); confirmation counts are against a tip about two blocks ahead of it.
- **Only a transaction pins a read.** An `eth_call` pinned to an old Hemi block still returns *today's* Bitcoin
  view ([DECISIONS](docs/DECISIONS.md) D-007). `check` commands are previews; only `record` makes a fact, with the
  Bitcoin height and hash it is "as of".
- **Bitcoin finality has no time bound.** Hemi's Proof-of-Proof publication on mainnet is intermittent (payouts
  on 22 of 120 sampled days), so a Hemi block can stay not-yet-final on Bitcoin for as long as nobody publishes.
  `PopFinality` attests that a keystone's block number and hash prefix sit in a Bitcoin transaction under N
  confirmations. It cannot check every keystone field, so it is looser than Hemi's own (bfgd) rule, and its
  `isBtcAnchored(block, K)`, which names no publication, can be satisfied by a forgery for one Bitcoin fee. Hemi
  PoP finality is `isBtcFinalVia` with a publication matched in full off chain, which the SDK does.
- **A bond is proof of locked funds, not collateral.** `FidelityBonds` records that some BTC is time-locked on
  Bitcoin and named for an agent's EVM address. Nothing can be slashed, escrowed or seized; whoever holds the
  bond's key can spend it after the locktime; a bond says nothing about how the agent behaves.
- **"Spent" is said only on a positive answer.** hVM gives no answer at all for a spent output (D-004). These
  contracts report an output as spent only when hVM lists the transaction with that output, value and script and
  marks it out of the UTXO set; any other silence is "unknown", never "spent".

**Status.** Deployed on Hemi mainnet on 2026-11-22, with source verified on Blockscout. The contracts are ownerless
and not upgradeable, hold no funds and refuse ETH.

| Contract (Hemi mainnet, chain 43111) | Address | Deployed in block |
| --- | --- | --- |
| `BitcoinFacts` | [`0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC`](https://explorer.hemi.xyz/address/0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC?tab=contract) | 5,793,795 |
| `PopFinality` | [`0x0706C1582E7C27c09953803384396efd4fa62486`](https://explorer.hemi.xyz/address/0x0706C1582E7C27c09953803384396efd4fa62486?tab=contract) | 5,793,796 |
| `FidelityBonds` | [`0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e`](https://explorer.hemi.xyz/address/0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e?tab=contract) | 5,793,797 |

They were deployed by CREATE2 from the build pinned in `contracts/script/Deploy.s.sol`, so their addresses follow
from the source (D-024, D-025). Blockscout calls the verification a partial match, the best it gives code built
without metadata; plain solc 0.8.28 compiles `contracts/verify/*.standard-input.json` to the deployed code byte for
byte.

The first records on mainnet are kept in [`mainnet/`](mainnet/README.md):

| File | What it is |
| --- | --- |
| `output-fact.json` | A 1,000-sat output, recorded as unspent at Bitcoin block 977,125 (D-026) |
| `balance-fact.json` | The balance of that output's address at the same block (D-026) |
| `publication-fact.json` | Keystone 5,793,025 checkpointed and its PoP publication recorded; final on Bitcoin (D-027) |
| `bond-live.json`, `bond-live.fact.json` | A 20,000-sat bond: created, recorded, redeemed after its locktime and marked ended (D-028) |

| Path | What it is |
| --- | --- |
| [`contracts/`](contracts/) | `Hvm.sol` (a library over precompiles `0x40`–`0x49`), the three contracts, the CREATE2 deploy script; unit, fuzz, fork and security-review tests (Foundry) |
| [`sdk/`](sdk/) | The TypeScript SDK and the `hbf` CLI (viem, Node ≥ 22.18), including the Bitcoin side of bonds (`@scure/btc-signer`) |
| [`regtest/`](regtest/) | bitcoind regtest in Docker, and the test that creates and redeems a bond on it |
| [`check-live.sh`](check-live.sh) | A read-only check of every contract against mainnet's real hVM, by `eth_call` with the compiled code placed by state override |
| [`mainnet/`](mainnet/README.md) | The live records listed above |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | The fact files, byte for byte |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | The design decisions, and the facts about hVM they rest on, with the commands and outputs that checked them |
| [`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md) | Every security review and audit of the contracts and the SDK, and what was done about each finding |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Deploying, verifying source, and recording facts and bonds on mainnet |
| [`docs/BRIEF.md`](docs/BRIEF.md) | The specification the project was built to |
| [`docs/research/spike/`](docs/research/spike/) | The read-only scripts that measured hVM on mainnet before the contracts were written, and their outputs (D-001 to D-012) |

The SDK and the CLI are **not published to npm**: use them from a clone of this repository.

## Quickstart

Verify the live mainnet records. This needs Node 22.18 or later and network access to Hemi's public RPC; no key,
no funds, nothing is sent.

```bash
git clone https://github.com/dimitryB/hemi-bitcoin-facts && cd hemi-bitcoin-facts
(cd sdk && npm ci)
alias hbf="node $PWD/sdk/bin/hbf.mjs"
RPC=https://rpc.hemi.network/rpc
FACTS=0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC POP=0x0706C1582E7C27c09953803384396efd4fa62486 BONDS=0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e

hbf facts verify mainnet/output-fact.json --rpc $RPC --contract $FACTS          # valid, exit 0
hbf facts verify mainnet/balance-fact.json --rpc $RPC --contract $FACTS         # valid
hbf finality verify mainnet/publication-fact.json --rpc $RPC --contract $POP    # valid; exact match yes
hbf bond status mainnet/bond-live.fact.json --rpc $RPC --contract $BONDS        # valid; status now Ended (spent)
```

Each prints `valid` and every field it checked: the stored fact, the recording transaction and its block, and the
block's Hemi stage. Change one value and verification fails with the reason:

```bash
jq '.fact.sats = "999"' mainnet/output-fact.json > tampered.json
hbf facts verify tampered.json --rpc $RPC --contract $FACTS
# invalid: changed value: fact.sats is 999 in the file but 1000 on chain   (exit 1)
```

`check` asks hVM what it says now, by `eth_call`, and sends nothing:

```bash
hbf facts check --rpc $RPC --contract $FACTS \
  --txid 0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4 --vout 0
```

`hbf <group> --help` and `hbf <group> <command> --help` document every option.

## Tests

The tests also need [Foundry](https://getfoundry.sh) (`forge`, `cast`, `anvil`), `jq`, `curl`, and Docker for the
regtest bond test. Nothing here needs a key or funds.

```bash
(cd contracts && forge build && forge test --no-match-contract ForkTest)       # unit, fuzz, review and audit suites
(cd sdk && npx tsc --noEmit -p . && HBF_E2E_NO_FORK=1 npm test)                 # SDK and CLI; e2e on a local anvil
regtest/run.sh                                                                  # bond create and redeem on regtest
```

These read Hemi mainnet through its public RPC, which allows about 300 requests a minute, so run them one at a time:

```bash
(cd contracts && forge test --match-contract ForkTest -j 1)   # fork tests: MockHvm over a fork of mainnet
(cd sdk && npm test)                                          # e2e on an anvil fork of Hemi mainnet
./check-live.sh mainnet                                       # every contract against mainnet's real hVM
```

Forge cannot run hVM's precompiles, so the fork tests lay `MockHvm` over a fork of Hemi mainnet, fed with raw bytes
captured from mainnet; the real precompiles are checked by `check-live.sh`.

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the first block on every pull request
and every push to `main`. The second block runs weekly and on a manual run, since the public RPC's limit is shared.
No job sends a transaction to Hemi or Bitcoin mainnet.

## Your own deployment

The contracts have no constructor arguments and no owner, so a CREATE2 deployment of the same build lands at the
same addresses on any chain with Arachnid's deterministic deployer; another build lands elsewhere, since the
addresses move with any byte of the contracts or `Hvm.sol`. [docs/RUNBOOK.md](docs/RUNBOOK.md) has the deploy steps,
the fee flags Hemi needs, source verification, and how to record facts and bonds on mainnet. Every command that
sends on Hemi mainnet needs `--allow-mainnet`, and the deploy script needs `CONFIRM_MAINNET_DEPLOY=yes`.

## Checking each claim yourself

Each item states something the project does and how to check it.

1. **The contracts on mainnet are this source.** For each address above, `cast code <address> --rpc-url
   https://rpc.hemi.network/rpc` equals `forge inspect <Contract> deployedBytecode` from a default-profile build in
   `contracts/`, and its Contract tab on explorer.hemi.xyz shows the source as verified.
2. **The live records verify from an RPC and an address alone.** The [Quickstart](#quickstart) commands print
   `valid` for all four files, and `invalid` with a reason for a changed one. The SDK's tests run `verify` with no
   key, an empty `HOME` and nothing else in the environment (`with only --rpc and --contract`, in
   `sdk/test/facts.e2e.test.ts`, `finality.e2e.test.ts` and `bond.e2e.test.ts`).
3. **Every check matches mainnet's real hVM.** `./check-live.sh mainnet` runs each contract's checks against the
   real precompiles by `eth_call`, read-only: an unspent fixture of 1,000 sats with the right script hash, a spent
   fixture reported spent, and PoP publications that pass every `PopFinality` check. It ends with `OK: every check
   passed (bonds facts finality).`
4. **`verify` rejects what it should.** `sdk/test/*.e2e.test.ts` show `invalid` with a reason for a changed value, a
   wrong contract address and a recording transaction that does not exist, for facts, publications and bonds.
5. **A bond can be redeemed only after its locktime.** `regtest/run.sh` creates a bond on bitcoind regtest, shows
   bitcoind refusing a redeem before the locktime (`non-final`, RPC code -26), then redeems it with the CLI. The
   mainnet bond in `mainnet/` went through the same steps (D-028).
6. **`hbf finality status` reports Hemi PoP finality only on an exact match.** It exits 0 only when a publication
   matches the canonical keystone in all 76 bytes and `isBtcFinalVia` is true through it:
   `hbf finality status --block 5793006 --rpc $RPC --contract $POP` prints `agree yes` and `final yes`.
7. **The contracts were reviewed before deployment.** [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md) records every
   review and audit, each finding and what was done about it; the suites under `contracts/test/review/` and
   `contracts/test/audit/` pin them.

## How it works

Each `check…` is a `view` that never reverts and returns a verdict and the data. Each `record…` runs the same check
in its own transaction, stores the fact once (recording again is a no-op) and emits every stored field. Anyone may
record. Every fact carries the Bitcoin height and hash it is "as of", read from `0x44` in the same transaction.

### `Hvm.sol`

One function per precompile (`balance`, `utxos`, `txByTxid`/`containingBlock`/`txOutputs`, `confirmations`,
`lastHeader`, `headerAt`, `addressScript`, `input`, `output`/`outputFull`, `witness`). Each is a `staticcall` with
raw bytes and a gas cap of twice the precompile's fixed cost, because a failed hVM call burns all the gas it is
given (an unknown txid on `0x43`, an undecodable address on `0x46`). Each returns `ok` first: false for a failed
call, an empty answer ("no answer", never zero) or a length that does not fit the layout. Requested scripts are
capped at 10,000 bytes. Txids and block hashes are in display order. It has none of the caps of Hemi's Bitcoin Kit
contract (hBK), such as its 32-output and 64-byte limits.

What mainnet's hVM does, as measured ([DECISIONS](docs/DECISIONS.md) D-001 to D-012):

- `0x48` answers only for an output still in the UTXO set (flag `0x01`); a spent output, an OP_RETURN and an
  unknown txid all give the same empty answer. `0x42` lists a transaction's outputs with a UTXO byte (`0x00` for
  spent or unspendable), up to 128 outputs and 128-byte scripts. `spendStatus(txid, vout, sats, scriptHash)`
  combines them: **Unspent** if `0x48` answers with that value and script, **Spent** if `0x48` is silent and `0x42`
  lists that exact output with byte `0x00`, **Unknown** otherwise (D-014).
- `0x45` (header by height) gives no answer at any height today, and witnesses are stripped (`0x49` never answers).
- Mainnet runs op-geth `539f4e33`; the precompile layouts and gas are those of hemilabs/op-geth `67f25b90` (D-011).

### `BitcoinFacts`

| Function | |
| --- | --- |
| `checkOutput(txid, vout)` → `OutputCheck` | Verdict, sats, `keccak256(script)`, script length, spent, Bitcoin confirmations, as-of height and hash, the id and whether it is recorded. |
| `recordOutput(txid, vout)` → `id` | Same check in a transaction; reverts `NotRecordable(verdict)` unless Ok; stores the fact and emits `OutputRecorded`. |
| `checkBalance(address)` / `recordBalance(address)` | Sats of the address's scriptPubKey (from `0x46`), so every spelling of one address is one subject. |
| `outputFact(id)`, `balanceFact(id)`, `kindOf(id)`, `outputId`, `balanceId` | Reads for consumer contracts. |

Verdicts: `Ok`, `NoBitcoinView`, `NotFound`, `VoutTooHigh`, `Unspendable` (OP_RETURN and other unspendable
scripts, never "spent"), `ScriptTooLong`, `Inconsistent`, `NoConfirmations`, `BadAddress`, `NoBalance`. A fact id is
`keccak256(abi.encode(kind, subject, btcBlockHash))`, so recording twice at one Bitcoin tip changes nothing and a
new tip makes a new fact. It marks nothing as consumed. Recording costs about 151k gas (unspent output), 182k
(spent output) or 181k (balance): about $0.001.

### `PopFinality`

| Function | |
| --- | --- |
| `checkpoint(K)` | K a multiple of 25 (a keystone): stores the first 12 bytes of block K's hash, from `blockhash` (256 blocks) or the EIP-2935 history contract (8,191 blocks, about 27 hours). |
| `recordPublication(K, btcTxid, vout)` → `(created, best)` | Reads the output through `0x42` (`0x48` never answers for OP_RETURNs). Requires 83 bytes: `6a4c5048454d49` (`OP_RETURN OP_PUSHDATA1 80 "HEMI"`), version `0x01`, bytes `[5:9]` = K and bytes `[64:76]` = the checkpoint. **Every valid publication is stored** (once each), so no publication can block another. K's *best* is a pointer re-chosen on every submission: a valid candidate replaces it with strictly more confirmations, or when the best no longer verifies. |
| `btcConfirmationsVia(block, K, btcTxid, vout)`, `isBtcFinalVia(…)` | **Hemi PoP finality**, for a publication whose 76 bytes the caller matched against Hemi's canonical keystone off chain (the SDK does): K at or after the block's covering keystone, that publication stored, Bitcoin confirmations read live from `0x43`, final at 9 or more. |
| `anchorConfirmations(block, K)`, `isBtcAnchored(block, K)` | The same through K's best publication: **"anchored on Bitcoin"**, not PoP finality. A forged keystone satisfies it for one Bitcoin fee (below). |
| `checkCheckpoint`, `checkPublication`, `checkpointOf`, `publicationOf(K, txid, vout)`, `bestPublicationOf(K)`, `coveringKeystone` | Views. All views never revert; `false` means "not shown final", not "not final". |

The contract checks a publication's version, K and the 12-byte hash prefix of block K. It cannot check the other
keystone fields (the L1 origin is not in any Hemi header), so it is looser than bfgd's exact-match rule: anyone can
pay one Bitcoin fee for a transaction carrying a canonical block's prefix with junk elsewhere, which Hemi's
consensus ignores but `isBtcAnchored` counts. That is why every valid publication is kept and why the SDK reads
finality through `isBtcFinalVia` with the publication that matches all 76 bytes (`hbf finality status`, `verify`,
`record` and `watch` all do; D-018, D-023). A checkpoint costs about 47–52k gas and a first publication about 171k:
under a cent each, and `finality watch` costs about $0.14–$0.33 a day.

### `FidelityBonds`

A bond is one Bitcoin output paying P2WSH of `<locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG` (the
JoinMarket fidelity-bond script; the 42-byte witness script is `04` + locktime LE + `b1 75 21` + 33-byte key +
`ac`, with a timestamp locktime in [500,000,000, 2^31)). The same transaction carries a 50-byte tag output:
`OP_RETURN` (`0x6a`), a 48-byte push (`0x30`), then `"HFB1"` + chain id (4) + this contract's address (20) + the
agent's address (20). The tag binds the bond to one agent when it is created; nobody else can claim it, and no
signature is parsed on chain.

| Function | |
| --- | --- |
| `checkBond(txid, bondVout, tagVout, witnessScript)` | Template, locktime, script = `0x0020` + sha256(witness script), Unspent by `spendStatus`, a valid tag for this chain and contract and no other `"HFB1"` tag of any kind, value ≥ 10,000 sats, 6+ confirmations. Returns the agent and an `expired` flag. |
| `recordBond(…)` | Stores agent, sats, locktime, txid, vout and the Bitcoin height; one bond per output. |
| `refresh(bondId)` | Marks the bond ended only when `spendStatus` says Spent; Unspent and Unknown change nothing. |
| `liveBond(bondId)` → (status, agent, sats, locktime) | Re-reads hVM in the caller's own transaction: `Live`, `Expired` (unspent, and the `0x44` header's time or Hemi's `block.timestamp` ≥ locktime), `Ended`, `Unknown` (never Live) or `NotRecorded`. |
| `bond(id)`, `bondId`, `readTag`, `tagScript`, `bondScript`, `witnessScriptFor` | Views. |

It reports facts; it does not score, rank, escrow or slash. A timestamp locktime is enforced by Bitcoin against
median time past, about an hour behind, so a bond becomes redeemable about an hour after its locktime.

### The CLI

```bash
hbf facts    check | record | verify | status
hbf finality checkpoint | record | verify | status | watch
hbf bond     create | record | status | refresh | redeem
```

- **`verify` needs only an RPC URL and the contract address**: `hbf facts verify fact.json --rpc <url> --contract
  <addr>`, `hbf finality verify …`, `hbf bond status bond-fact.json …`. It checks that the code at the address is this
  SDK's build of the contract, re-reads the stored fact and compares every field, recomputes the id, checks that the
  recording transaction succeeded, that the contract emitted the matching event in it (sent directly or through a
  Safe, smart account or multicall) and that it sits in a canonical block, and reports the block's Hemi stage
  (latest, safe, finalized). It prints `valid` or `invalid: <reason>` and exits 0 or 1. The SDK may ask Esplora
  where a transaction is, never what it says.
- **`hbf finality status` exits 0 only on Hemi PoP finality**: a publication checked to match the canonical keystone
  in all 76 bytes, with `isBtcFinalVia` true through it. When the check cannot run (the keystone cannot be rebuilt,
  as on a local chain, or `0x42` gives nothing to compare) it reports `final: false`, whatever the contract says.
- **`hbf bond create` checks the registry first**: with `--rpc`, the code at the FidelityBonds address the tag will
  name must be this SDK's FidelityBonds, before any key is read; without `--rpc` it refuses unless
  `--no-registry-check`.
- **Writes need a key and, on mainnet, a flag.** Keys come only from a file under a `.secrets/` directory
  (`--key-file`, `--btc-key-file`) and are never printed; there is no key prompt (D-029). A Hemi mainnet transaction
  needs `--allow-mainnet`; a Bitcoin mainnet broadcast needs the bond commands' own `--allow-mainnet`, and `bond
  create` on Bitcoin mainnet refuses more than 20,000 sats or a locktime more than 24 hours ahead without
  `--override-caps`. `record`, `checkpoint` and `refresh` simulate by `eth_call` first and send nothing unless the
  verdict is Ok and the fact is new; `refresh` asks for the key only when there is something to send.
- **Every `--rpc` URL must serve the same chain**: each is asked for its chain id at the start; one that serves
  another chain stops the command, and a fallback that does not answer is left out of that run with a warning. The
  first URL sets the chain, so it must answer, unless `--chain-id` names the chain. Messages print RPC and Esplora
  URLs as scheme and host only.
- **Every CLI command checks the contract's code**: the code at `--contract` must be byte for byte this SDK's build
  of that contract (none of the three has immutables or metadata, so every genuine deployment matches), or the
  command refuses it, `verify` and `status` included. The SDK's library functions leave the address to their caller,
  except `verify`, which checks.
- Every chain call retries with backoff, paced by a token bucket at 4 requests a second sustained (bursts of up to
  8), under the public RPC's ~300 a minute.

Fact files (`output`, `balance`, `publication`, `bond`) are defined byte for byte in [docs/SCHEMA.md](docs/SCHEMA.md).

## Known limits

- A fact is only as good as Hemi's consensus (see the first section).
- `0x42`'s window: an output past index 127, or a spent output whose script is over 128 bytes, cannot be shown
  spent (`VoutTooHigh`, `ScriptTooLong`, Unknown). A PoP output or bond tag past index 127 cannot be read.
- A keystone must be checkpointed within 8,191 blocks (about 27 hours) of being cut, or recorded with its
  publication within that window; a later keystone anchors every earlier block, so a missed one only delays.
- `PopFinality` is looser than bfgd (above): `isBtcAnchored` means "anchored", and a forged keystone satisfies it for
  one Bitcoin fee; use `isBtcFinalVia` with an exact-matched publication. `false` is never "not final".
- The genesis coinbase is reported `Unspendable`: hVM lists its 50 BTC in the UTXO set, but Bitcoin has never let
  it be spent. The genesis address's balance fact still includes it, as Esplora's does.
- A bond's tag binds only if every funding input signs SIGHASH_ALL (or taproot's DEFAULT); `hbf bond create` does.
  With NONE or SINGLE a relayer could add a second tag (the bond is then `AmbiguousTag` for good). One output can be
  a bond in only one registry: any second `"HFB1"` tag, for any chain or contract, makes it ambiguous.
- A bond's key must be 02/03 with x below the field prime; whether it is on the curve is not checked on chain (the
  SDK checks). A bond to an off-curve key can never be redeemed and, after its locktime, reads `Expired`.
- A bond's `Expired` comes from either of two clocks: the hVM header's time or Hemi's own `block.timestamp`. Hemi's
  clock normally runs 1–2 hours ahead of Bitcoin's median time past, which is what enforces the locktime, so normally
  a stale Bitcoin view in hVM does not keep a redeemable bond `Live`. Two cases break that: Hemi's clock lagging real
  time (catch-up blocks after a sequencer halt) and Bitcoin's median time running ahead of it. Keep a margin before
  the locktime. `Ended` is permanent: once `refresh` has seen the output spent, a Bitcoin reorg that undoes the spend
  does not revive the bond (make a new one).
- The confirmation thresholds (6 for a bond, 9 for finality) count against hVM's upstream tip, about two blocks
  ahead of its indexed view, and "Live" means unspent as of that view. A consumer should keep a margin before a
  bond's locktime.
- Gas a consumer should budget: `liveBond` about 60k, up to about 310k for a spent bond whose funding transaction
  lists 128 outputs of long scripts (it runs out of gas rather than answer wrongly; use try/catch and treat a failure
  as not live). `checkOutput` stays near 300k at worst.
- The contracts are frozen to today's hVM: gas caps at twice today's charges and today's byte meanings. Most
  upstream changes fail safe (no answer); a repricing above 2x needs a redeploy at new addresses, and existing bonds,
  whose tags name the old address, stay with the old registry.
- `verify` checks the recording block is canonical and reports Hemi's own safe/finalized tags; it does not wait
  for Bitcoin finality of that Hemi block (use `hbf finality status`).
- The public RPC allows about 300 requests a minute; the fork tests are paced for one run at a time.

## Security

Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes, not in a public issue. The reviews and
audits done before deployment, and what each found, are in [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md). None of
the internal reviews is a third-party audit; use the contracts with amounts you can afford to lose.

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE), Copyright (c) 2026 Dimitry B and Neva Technologies Inc. Every Solidity file carries
`SPDX-License-Identifier: MIT`. The vendored code keeps its own licence, included with it:

| Directory | Source | Licence |
| --- | --- | --- |
| `sdk/src/vendor/receipts/` | [hemi-agent-receipts](https://github.com/dimitryB/hemi-agent-receipts) `sdk/src` at `7221887`, unchanged | MIT ([LICENSE](sdk/src/vendor/receipts/LICENSE)) |
| `sdk/src/vendor/x402-btc/` | three files from [x402facilitator](https://github.com/dimitryB/x402facilitator) at `4a26ad72`, every edit listed in its `VENDOR.md` | Apache-2.0 ([LICENSE](sdk/src/vendor/x402-btc/LICENSE), [NOTICE](sdk/src/vendor/x402-btc/NOTICE)) |
| `contracts/lib/forge-std/` | forge-std v1.17.0 | MIT or Apache-2.0 ([LICENSE-MIT](contracts/lib/forge-std/LICENSE-MIT), [LICENSE-APACHE](contracts/lib/forge-std/LICENSE-APACHE)) |

The contracts are built with Foundry and Solidity 0.8.28, `evm_version = "cancun"`, 200 optimizer runs and no CBOR
metadata; the init-code hashes are pinned in `contracts/script/Deploy.s.sol`.
