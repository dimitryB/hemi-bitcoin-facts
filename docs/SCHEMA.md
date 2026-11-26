# Fact files

A fact file is what `hbf … record` writes and what `hbf … verify` checks. It is a convenience copy of
something stored on Hemi: `verify` never trusts the file, it re-reads the contract and compares. This
document defines the files byte for byte.

## Encoding

- UTF-8 JSON, keys in exactly the order shown below, two-space indent, `\n` line endings, one trailing `\n`.
  `hbf` writes files with `JSON.stringify(value, null, 2) + "\n"` after building the object in this order.
- Every integer is a JSON **string** of decimal digits with no sign, no leading zeros (`"0"` for zero) and no
  exponent, so values above 2^53 survive every JSON parser.
- Every byte string (hashes, txids, scripts, addresses) is a JSON string of `0x` followed by lowercase hex.
  EVM addresses are lowercase too (not checksummed).
- Bitcoin txids and block hashes are in **display order** (as explorers print them and as the hVM
  precompiles take them).
- Booleans are JSON `true` / `false`. No `null`s: an absent value is an absent key, and only keys marked
  optional may be absent.

## Envelope (all kinds)

```json
{
  "schema": "hemi-bitcoin-facts/v1",
  "kind": "<output | balance | publication | bond>",
  "chainId": "43111",
  "contract": "0x…",
  "id": "0x…",
  "fact": { },
  "asOf": {
    "btcHeight": "975240",
    "btcBlockHash": "0x…"
  },
  "recording": {
    "txHash": "0x…",
    "blockNumber": "5734801",
    "blockHash": "0x…"
  }
}
```

| Key | Meaning |
| --- | --- |
| `schema` | Always `hemi-bitcoin-facts/v1`. |
| `kind` | Which contract and record type. |
| `chainId` | Hemi chain id of the recording transaction (`43111` mainnet). |
| `contract` | The contract that stores the fact. |
| `id` | The fact's id as the contract computes it (per kind, below). `verify` recomputes it. |
| `fact` | Kind-specific stored fields (below), exactly as the contract stores and emits them. |
| `asOf` | The Bitcoin header hVM had indexed when the fact was recorded (`0x44` in the same transaction). |
| `recording` | The Hemi transaction that recorded the fact and the block it landed in. |

## Kinds

Each stream defines its kinds' `fact` object and id here.

### `output` and `balance` (BitcoinFacts)

**Ids.** All three inputs are 32 bytes; hashing is keccak256.

| | `kind` (bytes32) | `subject` (bytes32) |
| --- | --- | --- |
| `output` | `KIND_OUTPUT = keccak256("hemi-bitcoin-facts/output")` | `keccak256(txid ‖ vout)`: the 32-byte txid in display order, then `vout` as 2 big-endian bytes (34 bytes hashed; Solidity `abi.encodePacked(bytes32, uint16)`) |
| `balance` | `KIND_BALANCE = keccak256("hemi-bitcoin-facts/balance")` | `keccak256(scriptPubKey)`, the script `0x46` gives for the address, so every spelling of one address (for example upper- and lower-case bech32) has one subject |

`id = keccak256(abi.encode(kind, subject, asOf.btcBlockHash))`, 96 bytes hashed. Recording the same subject at the
same Bitcoin tip gives the same id, and the second recording changes nothing (no event, no revert). A new Bitcoin
tip gives a new id. The contract exposes `factId`, `outputSubject`, `outputId(txid, vout, btcBlockHash)` and
`balanceId(scriptHash, btcBlockHash)`; for the two examples below they return the ids shown.

**`fact` for `output`**, keys in this order:

| Key | Type | Meaning |
| --- | --- | --- |
| `txid` | 32 bytes | The Bitcoin transaction, display order. |
| `vout` | integer, 0–65535 | The output index. |
| `sats` | integer, 0–2^64−1 | The output's value. |
| `scriptHash` | 32 bytes | keccak256 of the complete scriptPubKey. |
| `scriptLength` | integer, 0–65535 | Its length in bytes. |
| `spent` | boolean | `false`: the output was in hVM's UTXO set (`0x48` answered) as of `asOf`. `true`: it was spent as of `asOf`: `0x48` had no answer and `0x42` listed the transaction with that output, its complete script and UTXO byte `0x00`, and the script is spendable (DECISIONS.md D-014). No other answer is ever recorded as spent. |
| `confirmations` | integer, 0–2^32−1 | `0x43`'s count when the fact was recorded: Bitcoin's own count (offset 0, D-005), counted against hVM's upstream tip, which is about two blocks ahead of `asOf`. It grows afterwards; the stored value does not. |
| `script` | bytes | The complete scriptPubKey. Emitted in the event, **not stored**; `verify` checks it against `scriptHash`, `scriptLength` and the event. |

Every key but `script` is stored on chain (`outputFact(id)`), with `asOf.btcHeight`, `asOf.btcBlockHash` and
`recording.blockNumber` (stored as `hemiBlock`).

**`fact` for `balance`**, keys in this order:

| Key | Type | Meaning |
| --- | --- | --- |
| `scriptHash` | 32 bytes | The subject: keccak256 of the scriptPubKey `0x46` returned for the address. |
| `sats` | integer, 0–2^64−1 | `0x40`'s confirmed balance of the address as of `asOf`. Zero is a valid balance. |
| `scriptLength` | integer, 0–65535 | The script's length in bytes. |
| `script` | bytes | The scriptPubKey. Emitted, **not stored**; checked as for `output`. |

The address string itself is neither stored nor emitted (the script is what the fact is about); `hbf` prints the
address it derives from the script for standard types.

Example `output` file: the unspent payment fixture as hVM showed it at Bitcoin block 976833 (DECISIONS.md D-007).
The `recording` values are placeholders, and `contract` is the CREATE2 address of the current code; nothing is
recorded on mainnet yet.

```json
{
  "schema": "hemi-bitcoin-facts/v1",
  "kind": "output",
  "chainId": "43111",
  "contract": "0xaecbc8f5f6bb401c7d8a7625f53fe2225b730ffc",
  "id": "0x5c7f60897e18b23a4c7d6570671f5839f997c18491134654624ae386a00f683a",
  "fact": {
    "txid": "0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4",
    "vout": "0",
    "sats": "1000",
    "scriptHash": "0x805b1e6b4410cab90f524f41bbbebd2302fc9628a3b56a344b6d16a994c2791e",
    "scriptLength": "22",
    "spent": false,
    "confirmations": "1596",
    "script": "0x001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831"
  },
  "asOf": {
    "btcHeight": "976833",
    "btcBlockHash": "0x000000000000000000019ada2495c08b2f353705b20f8d653ad2fe492b51249a"
  },
  "recording": {
    "txHash": "0x1111111111111111111111111111111111111111111111111111111111111111",
    "blockNumber": "5780440",
    "blockHash": "0x2222222222222222222222222222222222222222222222222222222222222222"
  }
}
```

Example `balance` file: P2PKH `18DqQBT9CKb3RJ94H1d2JJbnHWp25uRmjm` at the same block (D-001), placeholders as above.

```json
{
  "schema": "hemi-bitcoin-facts/v1",
  "kind": "balance",
  "chainId": "43111",
  "contract": "0xaecbc8f5f6bb401c7d8a7625f53fe2225b730ffc",
  "id": "0xec31ca3396707a7e550791a4eb5b2c39c81a2174a362ccc2f8ad50a760e5156e",
  "fact": {
    "scriptHash": "0x31ec3c1ecdc17cf2b5d112964860a503ad137d21027df9d3e57c3c79d2ce6bb8",
    "sats": "108217",
    "scriptLength": "25",
    "script": "0x76a9144f364626b44b11929dd604d3cc592c4b8d887d1c88ac"
  },
  "asOf": {
    "btcHeight": "976833",
    "btcBlockHash": "0x000000000000000000019ada2495c08b2f353705b20f8d653ad2fe492b51249a"
  },
  "recording": {
    "txHash": "0x3333333333333333333333333333333333333333333333333333333333333333",
    "blockNumber": "5780441",
    "blockHash": "0x4444444444444444444444444444444444444444444444444444444444444444"
  }
}
```

`sdk/test/facts.test.ts` parses both examples, re-serializes them byte for byte and recomputes their ids.

**Verification of these kinds**, in the order `hbf facts verify` runs it (the first failure is the reason):
the file parses (`malformed fact file`); `chainId` is the RPC's (`wrong chain`); `contract` is the one given
(`wrong contract`); `script` hashes to `scriptHash` and has `scriptLength` bytes (`changed value`); the id
recomputes from the file's fields (`id does not recompute`); there is code at the contract (`no contract code`),
byte for byte the runtime of this SDK's BitcoinFacts, and it answers as BitcoinFacts (`not a BitcoinFacts
contract`); a fact is stored under the id (`not recorded`) and its fields recompute the id; every stored field equals
the file's, `hemiBlock` included (`changed value`); the block at `recording.blockNumber` is still
`recording.blockHash` (`recording block is not canonical`); the transaction exists (`recording transaction does not
exist`), succeeded (`recording transaction failed`) and is in that block (`recording transaction is in another
block`); `contract` itself emitted the kind's event for the id in it (`no matching event`), whether the transaction
was sent to `contract` or to another contract that called it, with every stored field and the file's `script`
(`event does not match`, `changed value`). `verify --id` does the same from the
stored fact, finding the event with one `eth_getLogs` over the stored Hemi block.

### `publication` (PopFinality)

A `publication` fact says: the Bitcoin output `btcTxid:vout` is stored in PopFinality as a publication of Hemi
keystone `keystone` (K): when it was recorded, hVM read it as an 83-byte PoP script (`6a4c50` + `"HEMI"` + the 76-byte
`abrev`) whose L2 number is K and whose block hash prefix equals block K's, with `confirmations` Bitcoin
confirmations. The contract checks those two keystone fields only; the L1 origin number, parent hash prefix, previous
keystone hash prefix and state root are carried in `abrev` but not checked on chain. `hbf finality verify` compares
all 76 bytes with the keystone it rebuilds from Hemi RPC and reports the result separately.

**What can be asked of it, and what that means.** The contract stores **every** valid publication of K, each once,
under (K, `btcTxid`, `vout`), and keeps one of them as K's **best**: re-chosen on every submission, a valid candidate replaces it if it has strictly
more confirmations or if the best no longer verifies (so after a Bitcoin reorg the best can briefly be a
less-confirmed publication until a better one is re-submitted).
- `isBtcFinalVia(block, K, btcTxid, vout)` / `btcConfirmationsVia` ask about this publication. When its 76 bytes are
  an exact match for the canonical keystone (bfgd's rule, checked off chain: `verify` reports it), that is **Hemi PoP
  finality** of every block up to K.
- `isBtcAnchored(block, K)` / `anchorConfirmations` ask about K's best publication. That means only that block K's number and
  hash prefix are **anchored on Bitcoin**. Anyone who knows block K's hash can satisfy it with a forged keystone for
  one Bitcoin fee, and a forgery mined before the real publication stays the best. It is not Hemi PoP finality
  ([SECURITY-AUDIT.md](SECURITY-AUDIT.md), internal review finding 1).

**Id.** All three inputs are 32 bytes; hashing is keccak256.

| | value |
| --- | --- |
| `kind` (bytes32) | `KIND_PUBLICATION = keccak256("hemi-bitcoin-facts/publication")` = `0xaca80b04…40b901` |
| `subject` (bytes32) | `keccak256(K ‖ btcTxid ‖ vout)`: K as 4 big-endian bytes, the 32-byte txid in display order, `vout` as 2 big-endian bytes (38 bytes hashed; Solidity `abi.encodePacked(uint32, bytes32, uint16)`) |

`id = keccak256(abi.encode(kind, subject, asOf.btcBlockHash))`, as for the other kinds. The contract exposes
`publicationSubject(K, btcTxid, vout)` and `publicationId(K, btcTxid, vout, btcBlockHash)`; for the example below
they return `0x2948946b…35512` and the id shown. The subject is also the storage key.

Recording a stored publication again writes no new entry. It re-runs the choice of K's best, which changes only if the
best now fails the check (for example its Bitcoin block was reorged away) or has strictly fewer confirmations. A fact
file stays valid when its publication is not, or no longer, K's best.

**`fact`**, keys in this order:

| Key | Type | Meaning |
| --- | --- | --- |
| `keystone` | integer, a positive multiple of 25 below 2^32 | K: the Hemi block whose number and hash prefix the publication carries. |
| `btcTxid` | 32 bytes | The Bitcoin PoP transaction, display order. |
| `vout` | integer, 0–65535 | Its PoP output (read through `0x42`, which lists OP_RETURNs; `0x48` never answers for one, D-003). |
| `confirmations` | integer, 0–2^32−1 | `0x43`'s count when it was recorded: Bitcoin's own count (offset 0, D-005). It grows afterwards; the stored value does not. `btcConfirmationsVia(block, K, btcTxid, vout)` reads it live. |
| `abrev` | 76 bytes | The abbreviated keystone: `[0]` version `0x01`, `[1:5]` L1 origin, `[5:9]` K, `[9:20]` parent hash prefix, `[20:32]` previous keystone (block K − 25) hash prefix, `[32:64]` state root, `[64:76]` block K's hash prefix. Emitted in the event, **not stored**; `verify` checks it against the event, K and the stored checkpoint, and compares it with the canonical keystone. |

Stored on chain: `publicationOf(K, btcTxid, vout)` holds `btcTxid`, `vout`, `confirmations`, `asOf.btcHeight`,
`asOf.btcBlockHash` and `recording.blockNumber` (as `hemiBlock`); `checkpointOf(K).blockHashPrefix` holds block K's
hash prefix, which equals `abrev[64:76]`. `bestPublicationOf(K)` returns K's best publication's entry.

Example: the first PoP fixture, as hVM showed it with `0x44` at Bitcoin block 976833 (D-003, D-005: two blocks
behind the upstream tip 976835, so 976835 − 973746 + 1 = 3090 confirmations). Its 76 bytes are the canonical
keystone 5620225 (D-003). The `recording` values are placeholders, and `contract` is the CREATE2 address of the
current code; nothing is recorded on mainnet yet.

```json
{
  "schema": "hemi-bitcoin-facts/v1",
  "kind": "publication",
  "chainId": "43111",
  "contract": "0x0706c1582e7c27c09953803384396efd4fa62486",
  "id": "0x8f4f2caf3b437a371175137bb1efc6b3b4b00dc6d74b7ad9e3d4508b2ff73699",
  "fact": {
    "keystone": "5620225",
    "btcTxid": "0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e",
    "vout": "1",
    "confirmations": "3090",
    "abrev": "0x01019152a20055c20104ddfaf81653745406b60e74126bbe37be01ec07b3019776d53d3594a18254de5647f184ff8941746bf20761dd1045552e1af1c0cb793360d1b3e5d6c873e1408ddef4"
  },
  "asOf": {
    "btcHeight": "976833",
    "btcBlockHash": "0x000000000000000000019ada2495c08b2f353705b20f8d653ad2fe492b51249a"
  },
  "recording": {
    "txHash": "0x5555555555555555555555555555555555555555555555555555555555555555",
    "blockNumber": "5780442",
    "blockHash": "0x6666666666666666666666666666666666666666666666666666666666666666"
  }
}
```

`sdk/test/finality.test.ts` parses this example, re-serializes it byte for byte and recomputes its id.

**Verification of this kind**, in the order `hbf finality verify` runs it (the first failure is the reason): the
file parses (`malformed fact file`); `chainId` is the RPC's (`wrong chain`); `contract` is the one given (`wrong
contract`); `abrev` has version 1 and carries `keystone` (`changed value`); the id recomputes from the file's fields
(`id does not recompute`); there is code at the contract (`no contract code`), byte for byte the runtime of this
SDK's PopFinality, and it answers as PopFinality (`not a PopFinality contract`); the file's own publication (K, `btcTxid`, `vout`) is stored (`not recorded`); every stored
field equals the file's, `hemiBlock` included (`changed value`); the stored fields recompute the id (`id does not
recompute`); K's checkpoint is stored and equals `abrev[64:76]` (`changed value`); the block at
`recording.blockNumber` is still `recording.blockHash` (`recording block is not canonical`); the transaction exists
(`recording transaction does not exist`), succeeded (`recording transaction failed`) and is in that block
(`recording transaction is in another block`); `contract` itself emitted `PublicationRecorded` for the id in it (`no
matching event`), directly or through another contract's call, with every stored field (`event does not match`) and
the file's `abrev` (`changed value`). Whether the publication is K's best does not affect validity. A
valid result also reports the Hemi stage, whether it is K's best, the live `btcConfirmationsVia`/`isBtcFinalVia` of
block K through it, and whether `abrev` is an exact match for the keystone rebuilt from Hemi RPC: only with an exact
match is `isBtcFinalVia` Hemi PoP finality. `verify --keystone K [--btc-txid T --vout N]` does the same for a stored
publication (K's best without `--btc-txid`), finding its event with one `eth_getLogs` over the stored Hemi block.

### `bond` (FidelityBonds)

A bond fact says that a Bitcoin output was a bond for an agent when it was recorded: a P2WSH output of the 42-byte
witness script `04 <locktime: 4 bytes LE> b1 75 21 <33-byte compressed key> ac` (`<locktime> OP_CHECKLOCKTIMEVERIFY
OP_DROP <pubkey> OP_CHECKSIG`), unspent, at least 10,000 sats, with 6 or more confirmations, in a transaction whose
only `"HFB1"` tag (of any chain, contract or agent) is the 50-byte `OP_RETURN` `6a 30 "HFB1" <chain id: 4 BE>
<contract: 20> <agent: 20>` naming this chain and contract. It is proof of locked funds, not collateral. Whether the bond is still live is not part of the file:
`hbf bond status` asks `liveBond` each time.

**Id.** `KIND_BOND = keccak256("hemi-bitcoin-facts/bond")`; `subject = keccak256(txid ‖ vout)`, the 32-byte txid in
display order then `vout` as 2 big-endian bytes (34 bytes hashed, Solidity `abi.encodePacked(bytes32, uint16)`, the
same subject as an `output` fact); `id = keccak256(abi.encode(KIND_BOND, subject))`, 64 bytes hashed. No block hash:
one bond per output, ever. Recording the same output again changes nothing. The contract exposes `bondSubject` and
`bondId(txid, vout)`; `bondId(0x43cb9bdc…cea4, 0)` is `0xc0cc984bb9d0a5ee009b84a036bbdff3aa543eabcace67aeebbf4af34f818a39`.

**`fact` for `bond`**, keys in this order:

| Key | Type | Meaning |
| --- | --- | --- |
| `agent` | EVM address | The agent the tag names. |
| `txid` | 32 bytes | The funding transaction, display order. |
| `vout` | integer, 0–65535 | The bond output. |
| `tagVout` | integer, 0–65535 | The tag output. |
| `sats` | integer, 0–2^64−1 | The bond's value: `0x42`'s listing, which `0x48` matched when it answered for the output (so unspent). |
| `locktime` | integer, 500000000–2147483647 | The witness script's CLTV value, a Unix time. Bitcoin lets the owner spend once the median time past of the last 11 blocks is after it, about an hour after this time. |
| `witnessProgram` | 32 bytes | `sha256(witnessScript)`: the P2WSH program; the output script is `0x0020 ‖ witnessProgram`. |
| `confirmations` | integer, 0–2^32−1 | `0x43`'s count when the bond was recorded (6 or more). |
| `witnessScript` | bytes | The 42-byte witness script. Emitted in `BondRecorded`, **not stored**; `verify` checks it against `witnessProgram`, `locktime` and the event. |

Every key but `witnessScript` is stored on chain (`bond(id)`), with `asOf.btcHeight`, `asOf.btcBlockHash` and
`recording.blockNumber` (stored as `hemiBlock`). The stored bond also has `endedBtcHeight` and `endedHemiBlock`, zero
until `refresh` sees the output spent; they are not in the file, because they change after recording. `BondEnded(id,
agent, btcHeight, btcBlockHash, hemiBlock)` records that moment.

Example: the funding transaction bitcoind accepted in the regtest gate (`sdk/test/fixtures/regtest-bond.json`), for
the e2e anvil chain 31337 and the CREATE2 address of the current code, as `hbf bond record` writes it against MockHvm
in `sdk/test/bond.e2e.test.ts`. `asOf` is that test's mock header; the `recording` values are placeholders.

```json
{
  "schema": "hemi-bitcoin-facts/v1",
  "kind": "bond",
  "chainId": "31337",
  "contract": "0xc527edfeee8972797d74252aa9111a05ea2c9a4e",
  "id": "0x6a90e2e0567a260b6f6c1c84f72780607555498ff7aad09e59ab5ece69c94e1f",
  "fact": {
    "agent": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "txid": "0x0000961d7ad9fcfa91b853a23d3f063c44a5e4a04569e477969adc837e397fb3",
    "vout": "0",
    "tagVout": "1",
    "sats": "50000",
    "locktime": "2000000000",
    "witnessProgram": "0x6acb6883ada8a3c0d48d930daef2168a8488dfc7ba40378aa377b25f050625bb",
    "confirmations": "6",
    "witnessScript": "0x0400943577b17521025b5abceeada865ea5a2167385ee655e2e0f97a127d334c87e3b27a48913b339bac"
  },
  "asOf": {
    "btcHeight": "976900",
    "btcBlockHash": "0xf874bf9fda110326091d4b4077c4d36f487a0fed005d0c06d0b349f44e138544"
  },
  "recording": {
    "txHash": "0x5555555555555555555555555555555555555555555555555555555555555555",
    "blockNumber": "25",
    "blockHash": "0x6666666666666666666666666666666666666666666666666666666666666666"
  }
}
```

`sdk/test/bonds.test.ts` parses it, re-serializes it byte for byte, recomputes its id and program, and checks it
against the regtest fixture; `sdk/test/bond.e2e.test.ts` records the same bond and gets the same `fact` and `asOf`.

**Verification of a bond**, in the order `hbf bond status <file>` runs it (the first failure is the reason): the file
parses (`malformed fact file`); `chainId` is the RPC's (`wrong chain`); `contract` is the one given (`wrong
contract`); `witnessScript` matches the template, hashes to `witnessProgram` and carries `locktime` (`changed value`);
the id recomputes from `txid` and `vout` (`id does not recompute`); there is code at the contract (`no contract code`),
byte for byte the runtime of this SDK's FidelityBonds, and it answers `bond(bytes32)` (`not a FidelityBonds
contract`); a bond is stored under the id (`not recorded`) and its
`txid` and `vout` recompute the id; every stored field equals the file's, `hemiBlock` included (`changed value`); the
recording block is canonical, the transaction exists, succeeded and sits in that block (the same reasons as for
`output`); `contract` itself emitted `BondRecorded` for the id in it, directly or through another contract's call (`no
matching event`), with every stored field and a
witness script that hashes to the program (`event does not match`) and equals the file's (`changed value`). Then it
reports the Hemi stage and what `liveBond` says now: `Live`, `Expired` (unspent, and the `0x44` header's time or Hemi's
`block.timestamp` is at or past the locktime), `Ended` (spent: marked by `refresh`, or seen spent in this call) or `Unknown` (hVM cannot say;
never live). `--id`, `--bond-file` and `--txid … --bond-vout …` verify the stored bond the same way, finding the event
with one `eth_getLogs` over the stored Hemi block.

**The bond file** is not a fact file: it is what `hbf bond create` writes before broadcasting, so `bond redeem` and
`bond record` can run later. It holds public data only (no key): `schema` (`hemi-bitcoin-facts/bond-file/v1`),
`network`, `chainId`, `contract`, `agent`, `txid`, `bondVout`, `tagVout`, `sats`, `locktime`, `locktimeIso`, `pubkey`,
`witnessScript`, `bondScript`, `bondAddress`, `tagScript`, `fundingAddress`, `fee`, `feeRate` and `hex` (the signed
funding transaction), with the same string encodings. `hbf` refuses a bond file whose scripts, address or locktime do
not recompute from its other fields, whose `sats` (at least 1) or `fee` is not an unsigned decimal, or whose `hex` is
not the transaction `txid` names, paying `sats` to `bondScript` at `bondVout` and 0 to `tagScript` at `tagVout`.

## Verification

`verify` takes a fact file (or an id), an RPC URL and the contract address, and nothing else. It first checks that
the code at the address is byte for byte this SDK's build of the contract: none of the three has immutables or
metadata, so every genuine deployment has exactly that code, and a look-alike at an address copied from an
untrusted file could emit matching events without reading hVM. Then it:

1. re-reads the stored fact from the contract by its id and compares every field with the file;
2. recomputes the id from the stored fields;
3. fetches the recording transaction's receipt, checks it succeeded and that `contract` emitted the fact's event
   in it with the same fields (sent to `contract` directly, or to a Safe, a smart account or a multicall that called
   it: the event's emitter is what counts), and that its block is still the canonical block at that height;
4. reports the Hemi finality stage of the recording block (`latest`, `safe` or `finalized` by Hemi's own
   tags) and, where the kind supports it, the Bitcoin finality from `PopFinality`.

It prints `valid` or `invalid: <reason>` and exits 0 or 1.
