# Brief C — Bitcoin facts on Hemi

Build three small ownerless contracts on Hemi that read Bitcoin through the hVM precompiles and record what they find: outputs and balances, Hemi's own Bitcoin finality, and time-locked BTC bonds for agents. Deliverable: the contracts on Hemi mainnet with verified source, a TypeScript SDK and CLI that check, record and verify from an RPC alone, and one live bond created, recorded and redeemed.

## Scope

This is the first milestone of BTC-bonded agent identity, and it stands alone. It ships a library and three contracts, in this order:

1. `Hvm.sol`: a bounds-checked Solidity library over precompiles `0x40`–`0x49`, with none of hBK's caps.
2. `BitcoinFacts`: records what a Bitcoin output holds and what an address holds, as of a named Bitcoin block.
3. `PopFinality`: records that a Hemi keystone's hash sits in a Bitcoin transaction, so a contract can ask whether a Hemi block is Bitcoin-final.
4. `FidelityBonds`: records BTC that is time-locked on Bitcoin and named for an agent's EVM address.

**Out of scope:** a paid relayer or x402 paywall; an MCP server; migrating `X402BtcSettler` to the library; citing facts from receipts; slashing, escrow or any scoring of bonds; proving control of an existing Bitcoin address; Ordinals, Runes or BRC-20. The Later section lists the follow-ups.

A bond here is proof of locked funds, not collateral. Nothing can be slashed, and the README must say so in its first screen.

## What is already known

Five findings fix the design. The first four come from source and from the two built repos; none was re-measured for this brief, so the spike confirms them.

- **A read counts only when a transaction made it.** The precompiles query the node's live embedded Bitcoin node. The per-block result cache is marked dead in [Hemi's op-geth](https://github.com/hemilabs/op-geth) (`core/vm/contracts.go`, branch `hemi`, commit `67f25b90`). An `eth_call` pinned to an old block therefore appears to return today's Bitcoin view. Check by call, record by transaction, as `X402BtcSettler` does.
- **In a block, the answers are consensus.** The node runs with `AutoIndex=false`. Its indexers are driven only to a lagging consensus target, never the live P2P tip (`TBCIndexToHeader`), and the tip that `0x43` counts against is set in the same step.
- **hBK's caps are not hVM's.** The 32-output and 64-byte limits, and the reverting `getUTXOsForBitcoinAddress` and `getHeaderN`, belong to the hBK contract ([phase 2 notes](https://github.com/dimitryB/x402facilitator/blob/main/docs/phase2/contracts.md)). Precompile `0x48` takes a caller-chosen output index and script length.
- **Raw calls are cheap.** `0x48` costs 15,000 gas against about 134,000 for hBK's `getSpecificTxOutput`.
- **Nothing proves a fact to a light client.** [ETHBEAT (formerly L2BEAT)](https://ethbeat.org/layer2s/projects/hemi) lists no live fault proofs, a whitelisted proposer and instant upgrades by a 3-of-8 multisig. A recorded fact is what Hemi's full nodes recomputed, and no more.

Two timing facts follow from Hemi's design. hVM trails the Bitcoin tip by two blocks on purpose, so a transaction becomes readable after about three confirmations; the live payment took 28 minutes ([D-040](https://github.com/dimitryB/x402facilitator/blob/main/DECISIONS.md)). Mainnet PoP publication is intermittent, with a payout on 22 of 120 sampled days, so Bitcoin finality has no upper time bound ([D-4](https://github.com/dimitryB/hemi-agent-receipts/blob/main/docs/DECISIONS.md)).

## Verified context

Every value below was read on chain by the facilitator or receipts sessions; the entry named holds the command and output. Re-read anything a deployment depends on.

| Item | Value | Entry |
| --- | --- | --- |
| Hemi mainnet | chain 43111; `https://rpc.hemi.network/rpc` (about 300 requests a minute); fallback `https://hemi.drpc.org` | receipts D-6 |
| Hemi testnet | chain 743111; `https://testnet.rpc.hemi.network/rpc`. dRPC testnet is about 2.66 million blocks stale: do not use it | receipts D-6 |
| Block time | Hemi blocks are 12 s apart; the safe head trailed latest by at most 22 blocks | receipts D-4 |
| hBK contract | mainnet `0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12`; testnet `0xeC9fa5daC1118963933e1A675a4EEA0009b7f215` has another ABI and reverts | facilitator D-012, D-036 |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C`, present on both networks | facilitator D-003 |
| `X402BtcSettler` | mainnet `0x9Df0B4752D00dF65Fb4f7FfdFe0545543f08ab9f` | facilitator D-039 |
| `ReceiptRegistry` | mainnet `0x95127A8aCa9B5c235C56A2dfd315a567Ef545A40`; testnet `0xef9Bb805581c0E947DEA54052Ad360485c3F73Fe` | receipts D-14, D-10 |
| Keystone | one every 25 Hemi blocks; published as `6a4c50` + `"HEMI"` + a 76-byte abbreviated keystone; final at 9 Bitcoin confirmations | receipts D-4 |
| Abbreviated keystone | `[0]` version `0x01`, `[1:5]` L1 number, `[5:9]` L2 number, `[9:20]` parent hash prefix, `[20:32]` previous keystone hash prefix, `[32:64]` state root, `[64:76]` block hash prefix | receipts `sdk/src/keystone.ts` |
| Testnet PoP | none: nobody publishes testnet keystones, so `PopFinality` is provable on mainnet only | receipts D-4 |
| Source verification | Hardhat's verifier gets 403; Blockscout's v2 API takes solc standard-JSON input | receipts D-10 |
| Mainnet explorer | `explorer.hemi.xyz` was unreachable by `curl` from the build machine; a browser worked | facilitator D-034 |

**Fixtures for the spike and the live check**

| Fixture | Value |
| --- | --- |
| Unspent payment output | txid `43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4`, vout 0, 1,000 sats, script `0x001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831`, Bitcoin block 975240. Confirm it is still unspent before relying on it |
| Spent output | txid `95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e`, vout 1, 83,050,000 sats |
| PoP transaction | `d4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e`, Bitcoin block 973746, carries keystone 5620225 |
| PoP transaction | `c6835b0e6675122e8ccf103d361af4ef1c7d4883d46e48c1be91a858e66c6a23`, Bitcoin block 975836, carries keystone 5734725 |

## hVM precompiles

Ten precompiles sit at `0x40`–`0x49`. Inputs and outputs are raw bytes, not ABI-encoded; integers are big-endian; txids and block hashes are in display order. Layouts are from `core/vm/contracts.go` and gas from `params/protocol_params.go` at commit `67f25b90`. Read the source again at the commit mainnet runs.

| Address | Name | Input | Output | Gas |
| --- | --- | --- | --- | --- |
| `0x40` | `btcBalAddr` | address as ASCII, at least 24 bytes | sats (8 bytes) | 50,000 |
| `0x41` | `btcUtxosAddrList` | ASCII address + page (3 bytes) + page size (1 byte; 0 means 10) | count (1 byte), then per UTXO: txid (32) + vout (2) + sats (8) | 100,000 |
| `0x42` | `btcTxByTxid` | txid and 4 bytes of bitflags; take the order and layout from source | the selected parts of the transaction | 25,000 |
| `0x43` | `btcTxConfirmations` | txid (32) | count (4 bytes) | 5,000 |
| `0x44` | `btcLastHeader` | empty | height (4) + hash (32) + version (4) + previous hash (32) + merkle root (32) + time (4) + bits (4) + nonce (4) | 5,000 |
| `0x45` | `btcHeaderN` | height (4 bytes) | the same layout as `0x44` | 6,000 |
| `0x46` | `btcAddrToScript` | address as ASCII | the scriptPubKey | 25,000 |
| `0x47` | `btcInputByTxid` | txid + input index (2) + max scriptSig bytes (2) | witness count (2) + prevout sats (8) + previous txid (32) + previous vout (2) + scriptSig length (2) + scriptSig + sequence (4) | 15,000 |
| `0x48` | `btcOutputByTxid` | txid + output index (2) + max script bytes (2) | sats (8) + full script length (2) + script cut to the max + spent flag (1) | 15,000 |
| `0x49` | `btcTxGetInputWitness` | txid + input index (2) + witness index (2) + max bytes (2) | full length (2) + the item cut to the max | 15,000 |

Four behaviours shape the library:

- **Two tips.** `0x44` returns the header hVM's indexers have reached. Balances, UTXO lists and spent flags are as of that header. `0x43` counts against the upstream tip, two blocks ahead, and returns Bitcoin's own count.
- **An empty return is "no answer", never zero.** Bad input and most lookup failures come back as a successful call with no data. A balance of zero is eight zero bytes.
- **`0x43` fails for an unknown txid, and a failed precompile call burns all the gas it was given.** Cap the gas on every call.
- **`0x45` answers only for headers in hVM's own index.** Expect nothing for the two newest Bitcoin blocks.

## Spike (before any contract code)

Ten read-only checks on mainnet decide what ships. They send no transaction and need no key. Write each result to `DECISIONS.md` with the command and its output, then apply the fallback in the last column without asking.

| # | Check | Expected | If not |
| --- | --- | --- | --- |
| S1 | Raw `0x40` for two addresses each of P2PKH, P2SH, P2WPKH, P2WSH and P2TR, against Esplora at the height `0x44` reports | Equal balances | Drop balance facts for the failing type |
| S2 | Raw `0x48` on the unspent fixture, on an output at index 32 or higher, and on a script longer than 64 bytes | Value, full script and length all correct | Stop: the library has no base |
| S3 | Raw `0x48` on the OP\_RETURN output of PoP transaction `d4ed6ec2…845e`, max length 100 | 83 bytes: `6a4c5048454d49` then the keystone for 5620225 | Move `PopFinality` to Later |
| S4 | The spent flag from `0x48` on the spent fixture and on the unspent one | Two different values; record which means spent | Stop `FidelityBonds`: it cannot ship on an unclear flag |
| S5 | `0x43` on both fixtures against Esplora; then on a made-up txid, with and without a gas cap | Bitcoin's count; a failed call for the made-up txid | Record the measured offset and build it in as a constant |
| S6 | `0x45` at the Bitcoin tip, tip − 1, tip − 2 and tip − 10 | Answers only at or below the height `0x44` reports | Leave header facts out |
| S7 | The same `0x40` and `0x43` calls at `latest`, 100 blocks back and 7,200 blocks back | The same answer at all three, because reads are live | Good news: historical reads are pinned; rewrite the README's trust section |
| S8 | Can a contract read the hash of a block 300 or more back? Is the EIP-2935 history contract `0x0000F90827F1C53a10cb7A02335B175320002935` live? | `blockhash` reaches 256 blocks, about 51 minutes | With EIP-2935, read up to 8,191 blocks and drop `checkpoint` |
| S9 | Gas for each library call through a probe contract placed by state override, and the L1 data fee of one record transaction | Close to the gas column above; under a cent per record | Record the real figures |
| S10 | Raw `0x40`, `0x43` and `0x48` on testnet; how far `0x44` trails Bitcoin testnet, and which testnet it follows | Answers, but hours or days behind | Mainnet and forks only, which is the plan anyway |

S2 and S4 are gates. Everything else has a fallback that keeps the session moving.

## Architecture

The contracts are the only code that touches hVM. Every other party, on chain or off, reads the contracts.

&#91;embedded content: architecture · a library, three contracts and a CLI built here; three consumers later\]

Each `record…` call ends in a transaction, so what it stores is an answer every Hemi full node recomputed. The SDK may ask Esplora where a transaction is, never what it says.

## Contract rules

All four pieces are ownerless, non-upgradeable, hold no funds and refuse ETH. Build with Foundry, Solidity 0.8.28, `evm_version = "cancun"` and 200 optimizer runs, as the settler was. Deploy by CREATE2 through `0x4e59…956C`.

Three rules apply to every contract:

- Each `check…` function is a `view` that never reverts. It returns a verdict enum and the data, as `X402BtcSettler.verify` does.
- Each `record…` function runs the same check in its own transaction, stores one slot per fact and emits every stored field. Recording is permissionless and idempotent.
- Every fact carries the Bitcoin height and hash it is "as of", taken from `0x44` in the same transaction.

**`Hvm.sol`**

- One function per precompile: a `staticcall` with raw bytes and an explicit gas cap.
- Each returns `ok` first. `ok` is false for a failed call, an empty return or a length that does not fit the layout.
- It parses by offset with bounds checks and never ABI-decodes a precompile's output. Requested script length is capped at 10,000 bytes.

**`BitcoinFacts`**

- `checkOutput(txid, vout)` returns sats, `keccak256(script)`, script length, the spent flag and the confirmation count.
- `checkBalance(address)` returns sats. Its subject is `keccak256(scriptPubKey)`, with the script from `0x46`, so two spellings of one address give one subject.
- A fact id is `keccak256` of the kind, the subject and the Bitcoin block hash. Recording twice at one Bitcoin tip changes nothing.
- It marks nothing as consumed. That stays the settler's job.

**`PopFinality`**

- `checkpoint(K)` requires `K % 25 == 0` and stores the first 12 bytes of `blockhash(K)`. S8 decides whether it is needed. If it is, a keystone must be checkpointed within 256 blocks of being cut, about 51 minutes. The watch command does that for each new keystone, at under a dollar a day. A later keystone anchors every earlier block, so a missed checkpoint only delays the answer.
- `recordPublication(K, btcTxid, vout)` reads `0x48` with a max of 83 bytes. It requires length 83, the prefix `6a4c5048454d49`, version `0x01`, bytes `[5:9]` equal to K and bytes `[64:76]` equal to the checkpoint.
- It keeps one txid per keystone: the one with more confirmations when both are read in the same transaction.
- `btcConfirmations(block, K)` requires K to be at or after the block's covering keystone, then reads `0x43` live. `isBtcFinal(block, K)` is that count at 9 or more.
- It attests that block K's number and hash prefix sit under N Bitcoin confirmations. It does not check the keystone's other fields, so it is looser than bfgd's exact-match rule. The README says so.
- Decide in `DECISIONS.md` whether `checkpoint` should also take block K's RLP header, to pin the state root and parent prefix.

**`FidelityBonds`**

- A bond is one Bitcoin output paying P2WSH of `<locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG`. This is the script JoinMarket uses for fidelity bonds.
- The same transaction carries a tag output: `OP_RETURN` and 48 bytes, `"HFB1"` + chain id (4) + this contract's address (20) + the agent's address (20).
- The tag binds one bond to one agent when it is created. Nobody else can claim it, and no signature is parsed on chain. A tunnel deposit's OP\_RETURN, which holds an EVM address as ASCII hex, cannot pass for it.
- `checkBond(txid, bondVout, tagVout, witnessScript)` requires the bond script to equal `0x0020` + `sha256(witnessScript)`. The witness script must match the 42-byte template exactly: `04` + locktime (4 bytes, little-endian) + `b1 75 21` + a 33-byte key + `ac`.
- It also requires a timestamp locktime (500,000,000 or more), a value at or above a floor constant, 6 or more confirmations, an unspent output and a tag for this chain, this contract and this agent.
- `recordBond` stores the agent, sats, locktime, txid, vout and the Bitcoin height it was seen at. One bond per output.
- `refresh(bondId)` re-reads the spent flag and marks the bond ended. `liveBond(bondId)` re-reads it inside the caller's own transaction, so a consumer never acts on a stale flag.
- The registry reports facts. It does not score or rank bonds, and it reports an unspent bond past its locktime as expired.

## Tooling and tests

The CLI is how a person, and the critic, exercises every claim. It is TypeScript on viem and Node 22, like both sibling projects.

**SDK and CLI**

- Commands: `facts check | record | verify | status`, `finality checkpoint | record | status | watch`, `bond create | record | status | refresh | redeem`.
- `verify` needs an RPC URL and the contract address, nothing else. It re-reads the stored fact, recomputes its id, confirms the recording transaction is canonical and reports the Hemi finality stage.
- Reuse `keystone.ts`, `finality.ts`, `bitcoin.ts` and `client.ts` from the receipts SDK. That SDK is not on npm, so vendor the files and note the source commit.
- `finality watch` finds a keystone's PoP txid through Esplora and submits it. Esplora only supplies the hint; the contract decides.
- Fact files are JSON, defined byte for byte in `docs/SCHEMA.md`.

**Bitcoin side**

- Reuse `btc/src/wallet.ts` and its Esplora client from x402facilitator, built on `@scure/btc-signer`.
- `bond create` builds the funding transaction with the bond output and the tag output. `bond redeem` spends it after the locktime: `nLockTime` at or past the locktime, a non-final sequence, and a witness of signature then witness script.
- A timestamp locktime compares against median time past, which runs about an hour behind. Expect redemption about an hour after the locktime.
- Gate: `create` then `redeem` must pass on regtest, with bitcoind in Docker and the same code, before any real sats are locked.

**Tests**

- Foundry unit tests with mock precompiles etched at `0x40`–`0x49` that take raw calldata. Cover every verdict, every malformed return, idempotent records, and a fuzzed `check…` that never reverts.
- Forge cannot run hVM precompiles, so the live check uses `cast`. `check-live.sh mainnet` runs each `check…` by `eth_call`, with the compiled code placed by state override, against the fixtures. It sends nothing.
- One end-to-end test on an anvil fork with the mocks: record an output fact, a balance fact, a publication and a bond, then verify each with the CLI.
- Every chain call retries with backoff and stays under 4 requests a second, as the receipts client does.

## Definition of done

A fresh-context critic passes all of these from the README alone. The last four each wait for their own go.

- [ ] `DECISIONS.md` holds S1 to S10 with commands and outputs, and says what each fallback changed
- [ ] `forge test` passes: unit, fuzz and fork tests for the library and for each contract that survived the spike
- [ ] `check-live.sh mainnet` passes read-only: the unspent fixture reads 1,000 sats and the right script hash, the spent fixture reads as spent, and, with its checkpoint slot set by state override, the PoP fixture passes every `PopFinality` check
- [ ] `facts verify` returns valid for a recorded fact, and invalid with a reason for a changed value, a wrong contract address and a recording transaction that does not exist
- [ ] `verify` runs with only an RPC URL and the contract address, shown by a test
- [ ] On regtest, `bond create` then `bond redeem` succeed, and bitcoind refuses a redeem before the locktime
- [ ] The README opens with what a fact proves and what it does not: trust in Hemi's consensus, the two-block lag, no time bound on Bitcoin finality, and bonds that are not collateral
- [ ] An internal security review of the contracts is recorded before any mainnet deployment, as the settler's was (facilitator D-038)
- [ ] On a go: the contracts are deployed on Hemi mainnet by CREATE2, with verified source and addresses in the README
- [ ] On a go: one output fact and one balance fact are recorded on mainnet and verified with the CLI, and an `eth_call` one block earlier agrees with each
- [ ] On a go: one keystone is checkpointed and its publication recorded, and `isBtcFinal` agrees with the receipts SDK's reader for the same block
- [ ] On a go: one bond of at most 20,000 sats is locked for at most 24 hours, recorded, redeemed after expiry and shown as ended after `refresh`

## How to run the session

New repo `hemi-bitcoin-facts`, created locally, branch `feat/facts-mvp`. Commit as `Dimitry B <dimitryB@users.noreply.github.com>`. Push nothing until asked. Save this brief unchanged as `docs/BRIEF.md` in the first commit.

**Read first**

- [x402facilitator](https://github.com/dimitryB/x402facilitator): `contracts/src/btc/X402BtcSettler.sol`, `contracts/test/mocks/MockBitcoinKit.sol`, `contracts/check-btc-live.sh`, `contracts/script/DeployBtcSettler.s.sol`, `docs/phase2/contracts.md`, `btc/src/wallet.ts`, and `DECISIONS.md` D-036 to D-040.
- [hemi-agent-receipts](https://github.com/dimitryB/hemi-agent-receipts): `sdk/src/keystone.ts`, `sdk/src/finality.ts`, `sdk/src/client.ts`, `docs/research/STATUS_RESOLUTION.md`, and `docs/DECISIONS.md` D-4, D-6 and D-10.
- [hemilabs/op-geth](https://github.com/hemilabs/op-geth), branch `hemi`: `core/vm/contracts.go`, `core/vm/evm.go` (`runPrecompileGuarded`) and `params/protocol_params.go`.

**Order**

1. The spike, by one sub-agent. Report the ten results and what each fallback changed, then keep going.
2. `Hvm.sol` and its mocks, by the lead. The three streams build on it.
3. Three streams in parallel, each on its own branch with notes in `docs/streams/<name>.md`: A, `BitcoinFacts` with the SDK and `facts` commands; B, `PopFinality` with the `finality` commands; C, `FidelityBonds` with the Bitcoin tooling and regtest.
4. Integration by the lead: merge, run every suite, run `check-live.sh mainnet`, write the README.
5. A fresh-context critic runs the Definition of done from the README alone. Loop until it passes twice in a row.

**Rules**

- Read-only calls to any network are unrestricted. Testnets and regtest are unrestricted.
- No transaction on Hemi mainnet or Bitcoin mainnet without an explicit go from Dimitry. Each go covers one named action.
- Never read or print `.env` or a key file. Keys live in `.secrets/`, gitignored, or go in at a hidden prompt.
- `DECISIONS.md` entries are numbered `D-001` onward and carry the command and its output. A failed check is a finding, not a blocker.
- Stop and ask only for a mainnet action, a failed gate (S2 or S4), or a finding this brief has no fallback for.

## Later (not now)

- **Settler v2** on `Hvm.sol`, which lifts the 32-output and 64-byte limits. A pull request to x402facilitator.
- **Receipts** read their Bitcoin stages from `PopFinality`, so no Esplora answer is trusted. Schema v2 lets a tool call cite a fact id, checked as the D-17 spend check is. A pull request to hemi-agent-receipts.
- **A relayer** behind the x402 paywall, so an agent with no ETH can record a fact, and an MCP wrapper over the CLI.
- **Control facts:** bind an existing Bitcoin address to an EVM address by a spend, using `0x47` then `0x48`, with the sighash type checked through `0x49`.
- **UTXO-set facts** from `0x41`.
- **Bonded identity proper:** what a bond buys in an agent registry, and slashable collateral through hemiBTC.

## Sources

- [hemilabs/op-geth](https://github.com/hemilabs/op-geth), branch `hemi`, commit `67f25b90` (2026-11-09): precompile code and gas
- [x402facilitator: phase 2 design](https://github.com/dimitryB/x402facilitator/blob/main/docs/phase2/DESIGN.md), [contract notes](https://github.com/dimitryB/x402facilitator/blob/main/docs/phase2/contracts.md) and [decisions](https://github.com/dimitryB/x402facilitator/blob/main/DECISIONS.md)
- [hemi-agent-receipts: decisions](https://github.com/dimitryB/hemi-agent-receipts/blob/main/docs/DECISIONS.md) and [status resolution research](https://github.com/dimitryB/hemi-agent-receipts/blob/main/docs/research/STATUS_RESOLUTION.md)
- [Hemi docs: hVM feature summary](https://docs.hemi.xyz/building-bitcoin-apps/hemi-virtual-machine-hvm/feature-summary) and [hBK smart contract](https://docs.hemi.xyz/building-bitcoin-apps/hemi-bitcoin-kit-hbk/hbk-smart-contract)
- [Hemi docs: PoP consensus and Bitcoin finality](https://docs.hemi.xyz/foundational-topics/the-architecture/proof-of-proof/pop-consensus-and-bitcoin-finality)
- [Hemi developer AMA recap](https://hemi.xyz/?p=1791): the two-block lag is deliberate; ZK light clients are planned
- [ETHBEAT (formerly L2BEAT): Hemi](https://ethbeat.org/layer2s/projects/hemi)
