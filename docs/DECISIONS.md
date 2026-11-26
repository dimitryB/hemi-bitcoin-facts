# Decisions

The design decisions behind hemi-bitcoin-facts (three Solidity contracts on Hemi that read Bitcoin through hVM precompiles, plus a TypeScript SDK and the `hbf` CLI), and the facts about Hemi and hVM they rest on, each with the command that checked it and its output. Outputs are trimmed but real. Entries are numbered `D-nnn` and never renumbered.

**The spike: D-001 to D-010.** These are the ten read-only checks S1 to S10 of [BRIEF.md](BRIEF.md) ("the spike"), made on Hemi mainnet before the contracts were written. Each entry names its check, for example "(check S4)". They ran on 2026-11-21 between 03:10Z and 03:40Z against Hemi mainnet (chain 43111, `https://rpc.hemi.network/rpc`), Hemi testnet (chain 743111) and Esplora (blockstream.info and mempool.space). Nothing was sent, signed or deployed, and no key was used. Every call is an `eth_call`, `eth_estimateGas`, `eth_getCode`, `eth_getBlockByNumber` or an Esplora `GET`. D-011 records the precompile layouts and failure modes from source, and D-012 the other findings.

The scripts that produced every number are in `docs/research/spike/`. Each prints the `cast` command before its raw answer, and the full outputs are in `docs/research/spike/out/`. Shared helpers: `docs/research/spike/hvmlib.py` (Python, paced at 2.5 requests a second with backoff) and `docs/research/spike/lib.sh`. Contracts measured by state override come from `docs/research/spike/probe/src/Probe.sol` (solc 0.8.28, cancun, 200 runs, no metadata; runtime in `docs/research/spike/out/probe-runtime.hex`), placed at `0x51ce000000000000000000000000000000000001` for the call only.

Bitcoin view at spike time: `0x44` reported height **976830**, hash `00000000000000000001247e03d1ce6e03f87144e7701c401eba0d7177bbfb4c`, with Esplora's tip at 976832; later 976831 (`…01fa1553bcdb6adec75005a2e1e54dc8282e886241cfe5`) and 976833 (`…019ada2495c08b2f353705b20f8d653ad2fe492b51249a`).

**Other dates.** The measurements in D-013 to D-024 were made on 2026-11-21 and 2026-11-22. Those on mainnet are read-only (`eth_call`, `eth_estimateGas`); the rest ran on local forks and on regtest. D-025 to D-028 record the mainnet deployment and the first records, from 2026-11-22 to 2026-11-25. D-029 is from 2026-11-25.

**Names in the deployed source.** Comments in `contracts/src` cite documents by the names they had at deployment. `docs/streams/a-facts.md`, `b-finality.md` and `c-bonds.md` (decisions A-n, B-n, C-n) are now D-019 to D-021 and D-023 here. `docs/security-review.md` and the other review documents are now [SECURITY-AUDIT.md](SECURITY-AUDIT.md).

| Entry | Topic |
| --- | --- |
| D-001 | S1: `0x40` balances for all five address types |
| D-002 | S2: `0x48` outputs, high indexes, long scripts |
| D-003 | S3: the PoP OP_RETURN through `0x48` and `0x42` |
| D-004 | S4: the spent flag (`0x48` has none) |
| D-005 | S5: `0x43` confirmations, and an unknown txid |
| D-006 | S6: `0x45` never answers |
| D-007 | S7: hVM reads are live, not pinned |
| D-008 | S8: block hashes, EIP-2935, Prague/Isthmus |
| D-009 | S9: precompile gas, and the cost of one record |
| D-010 | S10: hVM on Hemi testnet |
| D-011 | Precompile layouts and failure modes from source; the commit mainnet runs |
| D-012 | Other findings |
| D-013 | What the spike changed in scope |
| D-014 | The spend rule: `Hvm.spendStatus` |
| D-015 | Gas caps |
| D-016 | Tooling |
| D-017 | `FidelityBonds` on `Hvm.spendStatus` |
| D-018 | `PopFinality` on `0x42`; `checkpoint` through EIP-2935 |
| D-019 | BitcoinFacts design (A-n) |
| D-020 | PopFinality design (B-1 to B-17) |
| D-021 | FidelityBonds and the Bitcoin side (C-n) |
| D-022 | Integration: the three contracts, the public RPC's rate limit, the test suites |
| D-023 | `PopFinality` keeps every valid publication (B-18 to B-25) |
| D-024 | The build is pinned; addresses |
| D-025 | Mainnet deployment and source verification |
| D-026 | First output and balance facts on mainnet |
| D-027 | First keystone checkpoint and publication on mainnet |
| D-028 | A mainnet bond: created, recorded, redeemed, ended |
| D-029 | The CLI takes keys only from files |

---

## D-001. `0x40` balances for P2PKH, P2SH, P2WPKH, P2WSH and P2TR (check S1)

**Check.** Raw `0x40 btcBalAddr` for two addresses of each type against Esplora at the height `0x44` reports. The addresses were picked by `docs/research/spike/s1_find_addresses.py 976686` from blocks 976686 down (Esplora `GET`s only): a positive balance, at most five transactions, nothing in the mempool and the newest confirmed transaction at or below 976686, 147 blocks under `0x44`. So Esplora's `chain_stats` funded − spent equals the balance at any later height. As a second Esplora figure, `docs/research/spike/s1_balances.py` replays each address's full confirmed history up to `0x44`'s height. `0x46` was called on each address too, because `BitcoinFacts.checkBalance` takes its subject from it.

```
python3 -I docs/research/spike/s1_find_addresses.py 976686 > docs/research/spike/out/s1-addresses.json
python3 -I docs/research/spike/s1_balances.py docs/research/spike/out/s1-addresses.json > docs/research/spike/out/s1-balances.txt
# one row, by hand:
cast call 0x0000000000000000000000000000000000000040 $(cast from-utf8 18DqQBT9CKb3RJ94H1d2JJbnHWp25uRmjm) --rpc-url https://rpc.hemi.network/rpc
0x000000000001a6b9
cast call 0x0000000000000000000000000000000000000046 $(cast from-utf8 18DqQBT9CKb3RJ94H1d2JJbnHWp25uRmjm) --rpc-url https://rpc.hemi.network/rpc
0x76a9144f364626b44b11929dd604d3cc592c4b8d887d1c88ac
curl -s https://blockstream.info/api/address/18DqQBT9CKb3RJ94H1d2JJbnHWp25uRmjm | jq '.chain_stats.funded_txo_sum - .chain_stats.spent_txo_sum, .mempool_stats.tx_count'
```

Output (`docs/research/spike/out/s1-balances.txt`; `0x44` height 976833 for the run, Esplora tip 976835):

| Type | Address | `0x40` raw | sats | Esplora funded − spent | Esplora replay to 976833 | Mempool txs | Newest tx | `0x46` = Esplora script | Result |
|---|---|---|---|---|---|---|---|---|---|
| P2PKH | `18DqQBT9CKb3RJ94H1d2JJbnHWp25uRmjm` | `0x000000000001a6b9` | 108217 | 108217 | 108217 | 0 | 976686 | yes | match |
| P2PKH | `15KjySW9HahRVbHg8tDmJmr1aA54JQznPJ` | `0x00000000000031be` | 12734 | 12734 | 12734 | 0 | 976685 | yes | match |
| P2SH | `34zF3mWjUUE8rWkJycrWHGEFsopCHS6sY3` | `0x0000000000018daf` | 101807 | 101807 | 101807 | 0 | 976685 | yes | match |
| P2SH | `3NNqaZseYABgVuBQa1Fxr6d9a1F9pgiB9m` | `0x0000000000005912` | 22802 | 22802 | 22802 | 0 | 976685 | yes | match |
| P2WPKH | `bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkv` | `0x00000000000a8c75` | 691317 | 691317 | 691317 | 0 | 976686 | yes | match |
| P2WPKH | `bc1qapp8s0fje79uv44342u4v0t45tlwhesk6xs3nl` | `0x0000000000028890` | 166032 | 166032 | 166032 | 0 | 976686 | yes | match |
| P2WSH | `bc1qdgmr8c9qpxg5qf5pjncj6eplztucv9j7upzveftmcxamd7g9xhzq03v89z` | `0x0000000000005fc2` | 24514 | 24514 | 24514 | 0 | 976686 | yes | match |
| P2WSH | `bc1qz6mlqaqqp5q6938pmqde0jxp4mp3hyun25j5h8ev8wef07mqzj2stx7zw7` | `0x0000000000012b08` | 76552 | 76552 | 76552 | 0 | 976685 | yes | match |
| P2TR | `bc1pd0stas9vawgcf20uk799z2d8rmw66xfj3xayv75lr7qjw5suxwnsrfaena` | `0x000000000001bd1f` | 113951 | 113951 | 113951 | 0 | 976685 | yes | match |
| P2TR | `bc1p3ak4etu04ug6ce3vntrfu4pnewzsvklw5cs5tvr88as2gk50murqu6s0zg` | `0x000000000000a82f` | 43055 | 43055 | 43055 | 0 | 976684 | yes | match |

Extra cases, same file:

```
fully spent P2WSH bc1qlaj2gectshprauuj5klq7rl5p4qzfh3z848hyskhqac5k38qztzqyxh9w0 (Esplora 71 funded, 71 spent)
  0x40 -> 0x0000000000000000            (zero is eight zero bytes)
upper-case BC1Q64MN3PVWZRVTTVAWSQZ8EWMH2RSZ3DHJP4CNKV
  0x40 -> 0x00000000000a8c75            (same as lower case)
  0x46 -> 0x0014d57738858e10d8b5b3ae80047cbb7750e028b6f2   (same script, so the same subject)
bad checksum bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkq
  0x40 -> 0x                            (empty: no answer)
  0x46 -> error code -32000 invalid checksum (expected (bech32=p4cnkv, bech32m=p4cnkv5fglnw), got p4cnkq)
23 bytes "11111111111111111111111"
  0x40 -> 0x ; 0x46 -> 0x               (below the 24-byte minimum: empty)
testnet tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx on mainnet
  0x40 -> 0x0000000000000000 ; 0x46 -> 0x0014751e76e8199196d454941c45d1b3a323f1433bd6   (accepted: see D-012)
```

**Result.** All ten balances equal both Esplora figures, and every `0x46` script equals Esplora's `scriptpubkey`.

**Used in the design.** Balance facts cover all five types. An undecodable address makes `0x40` return empty but makes `0x46` fail the call and burn its whole gas cap (D-011), so `checkBalance` calls `0x46` first, under a cap (D-015). A `tb1…` string is accepted on mainnet and maps to the mainnet script with the same program (D-012 item 4). That is harmless for a script-keyed subject, but the CLI refuses a wrong-network address (D-019 A-18).

## D-002. `0x48` on the fixture, at index 32 or higher, and on scripts over 64 bytes (check S2)

**Check.** Raw `0x48 btcOutputByTxid` (txid ‖ vout u16 ‖ max u16) against Esplora's value, full script length and script bytes, in four groups:

- the unspent fixture with four max lengths;
- the 948-output Bitcoin whitepaper transaction `54e48e5f…e713` (945 bare-multisig outputs of 201 bytes) at vouts 0 to 947 and with truncation;
- 37 outputs at indexes 30 to 54 of two recent batch transactions (`6ac09b11…075b`, 55 outputs, block 976790; `3ba6a454…2a46`, 42 outputs, block 976800), covering all five address types and an OP_RETURN;
- the 67-byte P2PK coinbase output of block 1.

The unspent fixture was first confirmed unspent: `curl -s https://blockstream.info/api/tx/43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4/outspends` → `[{"spent":false},{"spent":false}]`.

```
python3 -I docs/research/spike/s2_outputs.py > docs/research/spike/out/s2-outputs.txt
cast call 0x0000000000000000000000000000000000000048 0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea400000064 --rpc-url https://rpc.hemi.network/rpc
0x00000000000003e80016001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec83101
#  sats 0x3e8 = 1000 | full length 0x0016 = 22 | 001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831 | flag 0x01
cast call 0x0000000000000000000000000000000000000048 0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea40000000a --rpc-url https://rpc.hemi.network/rpc
0x00000000000003e80016001466991504b673fa2d01          # max 10: full length still 22, 10 bytes returned
cast call 0x0000000000000000000000000000000000000048 0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea400000000 --rpc-url https://rpc.hemi.network/rpc
0x00000000000003e8001601                              # max 0
cast call 0x0000000000000000000000000000000000000048 0x54e48e5f5c656b26c3bca14a8c95aa583d07ebe84dde3b7dd4a78f4e4186e7130020012c --rpc-url https://rpc.hemi.network/rpc
0x000000000000000100c951412dc7869d094423…5cdf2353ae01   # 212 bytes: vout 32, 1 sat, full length 0x00c9 = 201, script 51 41… 53 ae (1-of-3 bare multisig), flag 01
cast call 0x0000000000000000000000000000000000000048 0x54e48e5f5c656b26c3bca14a8c95aa583d07ebe84dde3b7dd4a78f4e4186e71300200040 --rpc-url https://rpc.hemi.network/rpc
0x000000000000000100c951412dc7869d09442322ea354c71f7145027a184dc13f914441aa8f093845ebb2acf35a02e185de3143b3b4c01565a76aa99293e6d374ad2e448f579c10035eb01   # max 64: 64 bytes, length field 201
cast call 0x0000000000000000000000000000000000000048 0x0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd51209800000064 --rpc-url https://rpc.hemi.network/rpc
0x000000012a05f2000043410496b538e853519c726a2c91e61ec11600ae1390813a627c66fb8be7947be63c52da7589379515d4e0a604f8141781e62294721166bf621e73a82cbf2342c858eeac01   # 50 BTC, 67-byte P2PK
```

Results (`docs/research/spike/out/s2-outputs.txt`, 61 cases, `0x44` 976830 throughout):

- Unspent fixture vout 0: 1000 sats, length 22, script `0x001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831`, as the brief says. Max 22, 10 and 0 return that many bytes with the length field still 22. Vout 1 (859 sats change) matches; vout 2 (none) is empty.
- Whitepaper tx: vouts 0, 31, 32, 33, 255, 256, 500, 944, 945 (37-byte script) and 946 (P2PKH) match exactly. Max 64, 200, 201 and 65535 on vout 32 return 64, 200, 201 and 201 bytes, the length field 201 each time. Vout 947, spent per Esplora, and vout 948, which does not exist, are empty.
- Batch txs, indexes 30 to 54: every unspent output matches value, length and bytes (P2SH 23, P2WPKH 22, P2WSH 34, P2TR 34 bytes). The two P2PKH outputs in that range were spent; an unspent P2PKH is covered by whitepaper vout 946. Every output Esplora shows spent (seven of them), and the 38-byte OP_RETURN at vout 54, are empty.
- Block 1 coinbase vout 0 (67-byte P2PK, 5,000,000,000 sats): matches.
- Malformed input (35 bytes, 37 bytes, txid in internal byte order) is empty.
- Tally: **61 match, 0 mismatch.** The flag byte is `0x01` in every answer.

**Result.** Value, full script length and script bytes are correct for every output `0x48` answers, at indexes up to 946 and for scripts up to 201 bytes, and truncation keeps the true length. The limit: `0x48` answers **only for outputs in the UTXO set**. A spent output and an OP_RETURN come back empty, as source predicts (D-004, D-011), so the 83-byte PoP OP_RETURN in the brief's example cannot be read this way (D-003).

**Used in the design.** For a spent output `0x48` gives no value or script, so `BitcoinFacts.checkOutput` reads them from `0x42` (vout below 128, script cut at 128 bytes; D-011, D-014).

## D-003. The PoP OP_RETURN through `0x48` (and `0x42`) (check S3)

**Check.** `0x48` with max 100 (and 83) on the OP_RETURN output of PoP tx `d4ed6ec2…845e`. Esplora puts it at vout 1, 83 bytes. Then the same for the second fixture `c6835b0e…6a23`, also vout 1. Because `0x48` came back empty, the same outputs were read through `0x42 btcTxByTxid` with flags `00 3c 07 03` (outputs, scripts, unspendable outputs, the per-output UTXO byte; up to 128 outputs, scripts cut at 128 bytes). The keystone was rebuilt from Hemi RPC as `sdk/src/keystone.ts` does it (blocks K and K−25 by `eth_getBlockByNumber`).

```
python3 -I docs/research/spike/s3_s4_pop_spent.py > docs/research/spike/out/s3-s4.txt
cast call 0x0000000000000000000000000000000000000048 0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e00010064 --rpc-url https://rpc.hemi.network/rpc
0x
cast call 0x0000000000000000000000000000000000000048 0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e00010053 --rpc-url https://rpc.hemi.network/rpc
0x
cast call 0x0000000000000000000000000000000000000042 0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e003c0703 --rpc-url https://rpc.hemi.network/rpc
0x0002 0000000000004510 0019 76a91444a2eab624146b6f8185a6af19645460e9f5f9a488ac 00
       0000000000000000 0053 6a4c5048454d4901019152a20055c20104ddfaf81653745406b60e74126bbe37be01ec07b3019776d53d3594a18254de5647f184ff8941746bf20761dd1045552e1af1c0cb793360d1b3e5d6c873e1408ddef4 00
       (spaces added: count 2 | vout 0: 17680 sats, 25-byte P2PKH, 0x00 | vout 1: 0 sats, 83-byte script, 0x00)
cast block 5620225 --field hash --rpc-url https://rpc.hemi.network/rpc
0x60d1b3e5d6c873e1408ddef4f2b6736366484b781f704d45c501f883e85cc4d4
cast call 0x0000000000000000000000000000000000000042 0xc6835b0e6675122e8ccf103d361af4ef1c7d4883d46e48c1be91a858e66c6a23003c0703 --rpc-url https://rpc.hemi.network/rpc
0x00020000000000006dca001976a91444a2eab624146b6f8185a6af19645460e9f5f9a488ac00000000000000000000536a4c5048454d49010193107000578145bafef2e72dafe581470b89f044fc1222471baa496ca1c2ba645ee626c1fa5b66f2bebcb60c08d627533446263043bfd39c965c66b011ffaba3a4a528a1d75f06c9401800
cast block 5734725 --field hash --rpc-url https://rpc.hemi.network/rpc
0xaba3a4a528a1d75f06c9401803c6cc67cc79fb2f28549856c65bfbc42f624743
```

| Fixture | `0x48` max 100 / 83 | `0x42` script | length 83 | prefix `6a4c5048454d49` | version `0x01` | `[5:9]` | `[64:76]` = block hash `[0:12]` | all 76 bytes = rebuilt keystone |
|---|---|---|---|---|---|---|---|---|
| `d4ed6ec2…845e` vout 1 | empty / empty | as above | yes | yes | yes | `0055c201` = 5620225 | `60d1b3e5d6c873e1408ddef4` = yes | yes (L1 origin 26301090) |
| `c6835b0e…6a23` vout 1 | empty / empty | as above | yes | yes | yes | `00578145` = 5734725 | `aba3a4a528a1d75f06c94018` = yes | yes (L1 origin 26415216) |

Both `0x42` scripts also equal Esplora's `scriptpubkey` byte for byte.

**Result.** `0x48` gives nothing for the PoP output: an OP_RETURN never enters the UTXO set, and `0x48` returns nothing for an outpoint that is not in it (D-004, D-011). `0x42` returns the script in full, and it passes every check `recordPublication` needs for both fixtures.

**Used in the design.** `PopFinality` reads the PoP output through `0x42` (D-018, D-020 B-1). It checks that the listed output at `vout` has length 83, the prefix, the version, `[5:9]` = K and `[64:76]` = block K's hash prefix. That costs 25,000 gas instead of `0x48`'s 15,000.

## D-004. The spent flag (check S4)

**Check.** The flag byte from `0x48` on the spent fixture `95bca029…367e` vout 1 (83,050,000 sats; Esplora: spent by `2a02fa36…5712` in block 975330) and on the unspent fixture `43cb9bdc…cea4` vout 0. Cross-checked with `0x42`'s per-output byte, with `0x43` (to show the transaction itself is indexed) and with source.

```
python3 -I docs/research/spike/s3_s4_pop_spent.py > docs/research/spike/out/s3-s4.txt
cast call 0x0000000000000000000000000000000000000048 0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea400000064 --rpc-url https://rpc.hemi.network/rpc
0x00000000000003e80016001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec83101          # unspent: last byte 0x01
cast call 0x0000000000000000000000000000000000000048 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e00010064 --rpc-url https://rpc.hemi.network/rpc
0x                                                                              # spent: no answer at all
cast call 0x0000000000000000000000000000000000000048 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e00000064 --rpc-url https://rpc.hemi.network/rpc
0x                                                                              # its vout 0, also spent
cast call 0x0000000000000000000000000000000000000043 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e --gas-limit 500000 --rpc-url https://rpc.hemi.network/rpc
0x0000066c                                                                      # the tx is indexed: 1644 confirmations
cast call 0x0000000000000000000000000000000000000042 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e003c0703 --rpc-url https://rpc.hemi.network/rpc
0x0002000000001b8430890022512068d343ef205a6afa4ae74508ab4aefb92dd46549e30d5eecf63acf3155c0798e000000000004f33e1000220020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c400
       # vout 0: 461648009 sats, UTXO byte 0x00 | vout 1: 0x04f33e10 = 83050000 sats, P2WSH, UTXO byte 0x00
cast call 0x0000000000000000000000000000000000000042 0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4003c0703 --rpc-url https://rpc.hemi.network/rpc
0x000200000000000003e80016001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec83101000000000000035b00160014208fa508568396937efe008cbae70b4fe8a1ae4501
       # both unspent outputs: UTXO byte 0x01
```

**Source (mainnet's op-geth `539f4e33`, D-011; heminetwork `44781989923a`).** `0x48` calls `TBCFullNode.ScriptHashAvailableToSpend(txid, vout)`. That function returns `true` when the outpoint is in the UTXO table (heminetwork `service/tbc/tbc.go`: "Found it, therefore is unspent"). For an outpoint not in the table it calls `ldb.ScriptHashByOutpoint`, which wraps leveldb's not-found as an **error** (`database/tbcd/level/level.go`). `0x48` turns `true` into byte `1` and returns `(nil, nil)` on any error. So the byte is always `0x01`, and a spent output gives an empty answer. `0x42` swallows the same error (`spentBool = false`) and writes `0x00`. Its source comment, "Could not look up Outpoint in UTXO table, therefore spent", is attached to the wrong branch: the code writes `1` for an outpoint that *was* found.

**Result.** `0x48` never gives two different flag values. Unspent is `0x01`, and spent is **no answer**: the same empty answer as "no such transaction", "no such vout" and "OP_RETURN". The values that exist are:

- `0x48`: `0x01` = in the UTXO set, unspent. `0x00` never occurs. Empty = not in the UTXO set (spent, unspendable, or no such tx or vout).
- `0x42` UTXO byte: `0x01` = unspent; `0x00` = spent, or unspendable, or a lookup error.

**Used in the design.** An empty `0x48` answer is never read as spent. Paired with `0x42` the flag is not ambiguous: spent needs a positive `0x42` listing of that output with UTXO byte `0x00`, for a script that is spendable. That is the spend rule `Hvm.spendStatus` applies (D-014). `FidelityBonds` is built on it (D-017), and so is `BitcoinFacts`' spent flag (D-019 A-2). A Bitcoin reorg that drops the funding transaction then reads as Unknown, not as spent.

## D-005. `0x43` confirmations against Esplora, and a made-up txid (check S5)

**Check.** `0x43 btcTxConfirmations` on both fixtures (and the first PoP tx) in three rounds, against Esplora's `tip − block_height + 1` and against `0x44`'s height. Then a made-up txid (`deadbeef` × 8) raw, with and without a gas cap, and through the probe contract to see how much gas a failed call burns.

```
python3 -I docs/research/spike/s5_s6_s7.py > docs/research/spike/out/s5-s6-s7.txt      # S5, S6 and S7
cast call 0x0000000000000000000000000000000000000043 0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4 --rpc-url https://rpc.hemi.network/rpc
0x0000063a
cast call 0x0000000000000000000000000000000000000043 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef --rpc-url https://rpc.hemi.network/rpc
Error: server returned an error response: error code -32000: tx not found: deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef
cast call 0x0000000000000000000000000000000000000043 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef --gas-limit 30000 --rpc-url https://rpc.hemi.network/rpc
Error: server returned an error response: error code -32000: tx not found: deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef
cast estimate 0x0000000000000000000000000000000000000043 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef --rpc-url https://rpc.hemi.network/rpc
error code -32000: tx not found: deadbeef…deadbeef
# through the probe (docs/research/spike/probe/src/Probe.sol, probe(address,bytes,uint256) = staticcall{gas: cap}, gas by gasleft()):
P=0x51ce000000000000000000000000000000000001
cast call $P 'probe(address,bytes,uint256)(bool,uint256,bytes)' 0x0000000000000000000000000000000000000043 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef 30000 \
  --override-code "$P:$(cat docs/research/spike/out/probe-runtime.hex)" --rpc-url https://rpc.hemi.network/rpc
false / 30317 / 0x
```

| Round | `0x44` | Esplora tip | Tx (block) | `0x43` | Esplora count | Offset vs Esplora | Offset vs `0x44` |
|---|---|---|---|---|---|---|---|
| pre-run | 976830 | 976832 | unspent fixture (975240) | `0x00000639` = 1593 | 1593 | 0 | +2 |
| 1–3 | 976831 | 976833 | unspent fixture (975240) | `0x0000063a` = 1594 | 1594 | 0 | +2 |
| 1–3 | 976831 | 976833 | spent fixture (975189) | `0x0000066d` = 1645 | 1645 | 0 | +2 |
| 1–3 | 976831 | 976833 | PoP 5620225 (973746) | `0x00000c10` = 3088 | 3088 | 0 | +2 |

Made-up txid through the probe (`docs/research/spike/out/s5-s6-s7.txt`, `docs/research/spike/out/s5-s6-extra.txt`):

| Gas forwarded | ok | gas used by the staticcall | returned |
|---|---|---|---|
| cap 6,000 | false | 6,317 | empty |
| cap 30,000 | false | 30,317 | empty |
| cap 100,000 | false | 100,317 | empty |
| cap 1,000,000 | false | 1,000,317 | empty |
| no cap, 1,000,000-gas `eth_call` (63/64 forwarded) | false | 961,653 | empty |
| no cap, 10,000,000-gas `eth_call` | false | 9,821,028 | empty |
| fixture, cap 5,000 (= its charge) | true | 5,386 | `0x0000063a` |
| fixture, cap 4,999 | false | 5,316 | empty |
| 31-byte input, cap 30,000 | true | 5,317 | empty (malformed input is an empty success, charged 5,000) |

**Result.** `0x43` returns Bitcoin's own count: offset 0 against Esplora's tip and +2 against `0x44`'s height. That matches the brief, x402facilitator's D-036 and D-040, and hemi-agent-receipts' D-4. An unknown txid **fails the call**. Raw, the RPC reports JSON-RPC error `-32000` with the message `tx not found: <txid>`, with or without `--gas-limit`; it is not reported as `execution reverted`. Inside a contract the `staticcall` returns `false` with no data and **burns all the gas forwarded**: the cap plus about 317, or 63/64 of the remaining gas if uncapped.

**Used in the design.** Confirmations count against Bitcoin, offset 0, as in x402facilitator's `X402BtcSettler`. Every `0x43` call is capped (D-015), so an unknown txid costs a bounded amount instead of everything. The contracts call `0x43` last, so a check that fails earlier never pays for it (D-019 A-4).

## D-006. `0x45` around the tip (check S6)

**Check.** `0x45 btcHeaderN` (height as u32) at Esplora's tip, tip−1, tip−2, tip−3, tip−10, at `0x44`'s height and height + 1, at heights 1 and 0, and with a 3-byte input. Then the same on testnet.

```
cast call 0x0000000000000000000000000000000000000045 0x000ee7bf --rpc-url https://rpc.hemi.network/rpc     # 976831 = 0x44's own height at that moment
0x
cast call 0x0000000000000000000000000000000000000045 0x000ee7b9 --rpc-url https://rpc.hemi.network/rpc     # 976825 = tip-10
0x
cast call 0x0000000000000000000000000000000000000045 0x00000001 --rpc-url https://rpc.hemi.network/rpc
0x
cast call 0x0000000000000000000000000000000000000045 0x0051f964 --rpc-url https://testnet.rpc.hemi.network/rpc   # testnet 0x44 height − 10
0x
```

`0x44` was at 976831 and Esplora's tip at 976835 for this run. **Every call returned empty:** 976835, 976834, 976833, 976832, 976825, 976831 (= `0x44`), 976832 (= `0x44` + 1), 1 and 0 on mainnet, and testnet's `0x44` height, −10, −1000 and 1 (`docs/research/spike/out/s5-s6-s7.txt`, `docs/research/spike/out/s5-s6-extra.txt`). Gas: 6,000 charged per call (D-009).

**Why, from source.** `0x45` takes the headers at the height and keeps the one for which `TBCFullNode.BlockInTxIndex(hash)` is true. In heminetwork's leveldb (`database/tbcd/level/level.go`, the same code at `22552f1a` for testnet and `44781989923a` for mainnet), `BlockTxUpdate` writes the block marker as a 33-byte key, `'b'` ‖ hash. `BlockInTxIndex` iterates that prefix and calls `chainhash.NewHash(it.Key()[33:])` on the empty remainder. That returns an error for every block that *is* indexed, so `0x45` logs it, finds no canonical header and returns `(nil, nil)`. This also explains why hBK's `getHeaderN` reverts (brief, "What is already known").

**Result.** `0x45` never answers, not even at or below `0x44`'s height, where the brief expected answers.

**Used in the design.** There are no header facts. `Hvm.headerAt` wraps `0x45` and returns `ok = false` on the empty answer, but nothing depends on it. Facts take their "as of" height and hash from `0x44`, which works.

## D-007. Live or pinned reads (check S7)

**Check.** The same `0x40` and `0x43` calls, plus `0x44`, by `eth_call` at `latest` (Hemi block 5780432), 100 blocks back (5780332) and 7,200 blocks back (5773232, timestamp exactly 86,400 s earlier). `0x40` was read for the fixture address and for `bc1qfa74uetqzr3r0zu2ezm3vzz5mv8k7y3p77fefe`, a busy address (401 txs) with transactions at Bitcoin heights 976790, 976767, 976760 and 976703, all inside those 24 hours.

```
cast call 0x0000000000000000000000000000000000000044 0x --block 5773232 --rpc-url https://rpc.hemi.network/rpc
cast call 0x0000000000000000000000000000000000000043 0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4 --block 5773232 --rpc-url https://rpc.hemi.network/rpc
cast call 0x0000000000000000000000000000000000000040 $(cast from-utf8 bc1qfa74uetqzr3r0zu2ezm3vzz5mv8k7y3p77fefe) --block 5773232 --rpc-url https://rpc.hemi.network/rpc
```

| Read | `latest` (5780432) | −100 (5780332) | −7,200 (5773232, 24 h earlier) |
|---|---|---|---|
| `0x44` height / hash | 976833 / `…019ada2495c0…249a` | 976833 / same | 976833 / same |
| `0x43` unspent fixture | `0x0000063c` = 1596 | 1596 | 1596 |
| `0x43` spent fixture | `0x0000066f` = 1647 | 1647 | 1647 |
| `0x40` fixture address | `0x00000000000003e8` = 1000 | 1000 | 1000 |
| `0x40` bc1qfa74…fefe | `0x000000000018cb5c` = 1624924 | 1624924 | 1624924 |

**Result.** Reads are live, as expected. A pinned read 24 hours back would have shown a header about 144 blocks lower and confirmation counts about 144 smaller. Instead it gives today's header, today's counts and today's balance. The public RPC serves `eth_call` 7,200 blocks back, so it keeps that much state.

**Used in the design.** Historical reads are *not* pinned. The rule throughout is: check by call, record by transaction. A recorded fact carries the Bitcoin height and hash it is "as of", read from `0x44` in the same transaction.

## D-008. Block hashes 300 or more blocks back, EIP-2935, Prague/Isthmus (check S8)

**Check.** The probe's `hashes(uint256[],uint256[])` read `blockhash(number − d)` for d = 1, 255, 256, 257 and 300. It also read the EIP-2935 history contract `0x0000F90827F1C53a10cb7A02335B175320002935` (32-byte block number in, hash out) for d = 1, 1000, 8000, 8191 and 8192. The call was pinned to block 5780380 and compared with `eth_getBlockByNumber`. Fork flags came from the GasPriceOracle, the newest header and a Prague precompile.

```
bash docs/research/spike/s8_blockhash.sh > docs/research/spike/out/s8-blockhash.txt
cast code 0x0000F90827F1C53a10cb7A02335B175320002935 --rpc-url https://rpc.hemi.network/rpc
0x3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500
P=0x51ce000000000000000000000000000000000001
cast call $P 'hashes(uint256[],uint256[])(uint256,bytes32[],bool[],bytes32[])' '[1,255,256,257,300]' '[1,1000,8000,8191,8192]' \
  --block 5780380 --override-code "$P:$(cat docs/research/spike/out/probe-runtime.hex)" --rpc-url https://rpc.hemi.network/rpc
cast call 0x0000F90827F1C53a10cb7A02335B175320002935 $(cast to-uint256 5779380) --block 5780380 --rpc-url https://rpc.hemi.network/rpc
0x4f2195db3519a816a8a6dded0c4247c52766fea71f46794979508ac9afe8ce66
cast call 0x420000000000000000000000000000000000000F 'isIsthmus()(bool)' --rpc-url https://rpc.hemi.network/rpc
true
```

| Depth | `blockhash()` | EIP-2935 `get()` | `eth_getBlockByNumber` |
|---|---|---|---|
| 1 (5780379) | `0x092f6954…24de` | `0x092f6954…24de` | `0x092f6954…24de` |
| 255 | `0x8eb70108…c136` | — | `0x8eb70108…c136` |
| 256 (5780124) | `0x75adcdae…c84a` | — | `0x75adcdae…c84a` |
| 257 | `0x0000…0000` | — | `0x59b47969…5015` |
| 300 | `0x0000…0000` | — | `0x51254f78…b45d` |
| 1000 (5779380) | — | `0x4f2195db…ce66` | `0x4f2195db…ce66` |
| 8000 (5772380) | — | `0xdfcda535…864a` | `0xdfcda535…864a` |
| 8191 (5772189) | — | `0x9b0364b0…768e` | `0x9b0364b0…768e` |
| 8192 | — | reverts (ok = false) | `0x39d33631…1821` |

Forks: GasPriceOracle version `1.4.0`, `isEcotone` true, `isFjord` true, `isIsthmus` true, `isJovian()` reverts (not in this version, so Jovian is not active). The newest header carries `requestsHash = 0xe3b0c442…b855` (the empty-requests hash) and its L1-info deposit uses the Isthmus selector `0x098999be`. The BLS12-381 precompile `0x0b` (Prague, EIP-2537) answers `invalid input length` to empty input, so it exists. Prague's EVM changes are live through Isthmus.

**Result.** A contract's `blockhash` reaches 256 blocks (about 51 minutes); 257 and 300 give zero. **EIP-2935 is live** and returns correct hashes up to 8,191 blocks back (about 27.3 hours at 12 s); 8,192 reverts.

**Used in the design.** `PopFinality.checkpoint` reads `blockhash` within 256 blocks and the EIP-2935 contract beyond, so a keystone can be checkpointed up to 8,191 blocks after it is cut (D-018, D-020 B-2). A publication recorded later than that, with no checkpoint stored, cannot be matched against the block hash. A later keystone that is recorded in time still covers the earlier blocks.

## D-009. Gas of each precompile call, and the cost of one record (check S9)

**Check.** For each precompile, the probe's `probe(target, input, cap)` measured `gasleft()` around one `staticcall{gas: cap}` with a valid input. The same was measured as the second call in one frame (`probeTwice`), at cap = the brief's figure and at one less. The fee came from the OP-stack GasPriceOracle and the latest block; the ETH price from two public spot APIs.

```
python3 -I docs/research/spike/s9_gas.py > docs/research/spike/out/s9-gas.txt
P=0x51ce000000000000000000000000000000000001
cast call $P 'probe(address,bytes,uint256)(bool,uint256,bytes)' 0x0000000000000000000000000000000000000048 \
  0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea400000064 15000 \
  --override-code "$P:$(cat docs/research/spike/out/probe-runtime.hex)" --rpc-url https://rpc.hemi.network/rpc
true / 15395 / 0x00000000000003e80016001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec83101
cast call 0x420000000000000000000000000000000000000F 'getL1Fee(bytes)(uint256)' 0x<200 bytes> --rpc-url https://rpc.hemi.network/rpc
cast call 0x420000000000000000000000000000000000000F 'getL1FeeUpperBound(uint256)(uint256)' 200 --rpc-url https://rpc.hemi.network/rpc
curl -s https://api.coinbase.com/v2/prices/ETH-USD/spot
```

Overhead: a `0x43` call with a 31-byte input (charged 5,000, returns nothing) measured 5,317, so the probe's fixed overhead is **317 gas**. That covers the warm `STATICCALL` (100) and stack and memory work; larger answers add memory and copy costs. The hVM precompiles are **warm** (100). Upstream precompiles are **cold**: identity `0x04` with empty input measured 2,826 (2,600 + 15 + …), close to a code-less address's 2,811.

| Precompile | Input | Brief gas | ok | Bytes back | Measured | Measured − 317 | 2nd call | Cap = brief gas | Cap = brief − 1 |
|---|---|---|---|---|---|---|---|---|---|
| `0x40` | fixture address (42 B) | 50,000 | yes | 8 | 50,392 | 50,075 | 50,392 | ok | fails, 50,322 |
| `0x41` | address + `000000` + `0a` | 100,000 | yes | 43 | 100,395 | 100,078 | 100,398 | ok | fails, 100,322 |
| `0x42` | fixture + `003c0703` | 25,000 | yes | 68 | 25,401 | 25,084 | 25,404 | ok | fails, 25,322 |
| `0x43` | fixture txid | 5,000 | yes | 4 | 5,386 | 5,069 | 5,389 | ok | fails, 5,316 |
| `0x44` | empty | 5,000 | yes | 116 | 5,401 | 5,084 | 5,404 | ok | fails, 5,310 |
| `0x45` | height 976823 | 6,000 | yes | 0 (D-006) | 6,317 | 6,000 | 6,314 | ok | fails, 6,316 |
| `0x46` | fixture address | 25,000 | yes | 22 | 25,392 | 25,075 | 25,392 | ok | fails, 25,322 |
| `0x47` | fixture, input 0, max 100 | 15,000 | yes | 50 | 15,395 | 15,078 | 15,398 | ok | fails, 15,322 |
| `0x48` | fixture, vout 0, max 100 | 15,000 | yes | 33 | 15,395 | 15,078 | 15,398 | ok | fails, 15,322 |
| `0x49` | fixture, input 0, witness 0, max 100 | 15,000 | yes | 0 (D-011) | 15,323 | 15,006 | 15,317 | ok | fails, 15,322 |

Each precompile's charge is exactly the brief's figure, fixed whatever the input or answer size, plus 317 to about 400 gas of call overhead. A cap equal to the charge always suffices; one gas less fails and burns the cap.

**Fee of one record** (latest block 5780436):

```
baseFeePerGas 258 wei; eth_gasPrice 1000258 wei; eth_maxPriorityFeePerGas 1000000 wei
getL1Fee(200 incompressible bytes)  = 0x70c0eb3ff8 = 484272979960 wei
getL1FeeUpperBound(200)             = 0x75c9027758 = 505883555672 wei
l1BaseFee 161465748, blobBaseFee 8053348, baseFeeScalar 1000000, blobBaseFeeScalar 0, decimals 6
getOperatorFee(120000) = 0; L1Block operatorFeeScalar = 0, operatorFeeConstant = 0
L2 execution: 120000 gas x 1000258 wei = 120030960000 wei
ETH/USD: Coinbase spot 1572.625, Kraken last trade 1567.01   (fetched 2026-11-21 ~03:35Z)
per record: 484272979960 + 120030960000 = 604303939960 wei = 0.000000604 ETH = $0.00095   (upper bound: $0.00098)
```

**Result.** Gas matches the brief's column exactly. A record costs about **$0.001**, a tenth of a cent, at $1,572.63/ETH (Coinbase spot). Most of that is the L1 data fee: about 80% for a 200-byte transaction.

**Used in the design.** These are the figures the contracts are built on. `Hvm.sol` caps each call at twice its charge (D-015), which leaves room for a reprice and bounds the cost of a failing call.

## D-010. hVM on Hemi testnet (check S10)

**Check.** On Hemi testnet (chain 743111): `0x44`, compared by hash with testnet3, testnet4 and signet Esplora at the same height. Then `0x43`, `0x48` and `0x40` on a transaction six blocks below `0x44` on the matching network, `0x40` against that address's exact balance replayed to `0x44`'s height, and a made-up txid.

```
python3 -I docs/research/spike/s10_testnet.py > docs/research/spike/out/s10-testnet.txt
cast rpc web3_clientVersion --rpc-url https://testnet.rpc.hemi.network/rpc
"Geth/v0.1.0-untagged-c1771608-20261005/linux-amd64/go1.24.2"
cast call 0x0000000000000000000000000000000000000044 0x --rpc-url https://testnet.rpc.hemi.network/rpc
0x0051f96d00000000000000ee0b901065dccca540d91aa26f6ff4b2444155127ce5d45060…   # height 5372269
curl -s https://mempool.space/testnet/api/block-height/5372269
00000000000000ee0b901065dccca540d91aa26f6ff4b2444155127ce5d45060
cast call 0x0000000000000000000000000000000000000043 0xeee10fe6c3aff3111cdded461943350bb310239f85254f1bbc92e06e8a19d5bd --gas-limit 30000 --rpc-url https://testnet.rpc.hemi.network/rpc
0x00000009
cast call 0x0000000000000000000000000000000000000048 0xeee10fe6c3aff3111cdded461943350bb310239f85254f1bbc92e06e8a19d5bd00000064 --rpc-url https://testnet.rpc.hemi.network/rpc
0x0000000000001388001976a914dd53201bb20d1b50c206f558f39366f4ec10d10c88ac01
cast call 0x0000000000000000000000000000000000000040 $(cast from-utf8 n1hDD6zeYAhvsT2tkPVQCzjfgLNZDBgZQL) --rpc-url https://testnet.rpc.hemi.network/rpc
0x00000000001c7c04
```

Results (2026-11-21T03:32Z, Hemi testnet block 7260097):

- `0x44`: height 5372269, hash `00000000000000ee0b90…5060`. **testnet3 matches**, with its tip at 5372271: **2 blocks behind**. testnet4 (tip 162523) and signet (tip 331802) have no block at that height, so neither matches.
- `0x43` on `eee10fe6…d5bd` (testnet3 block 5372263) = 9 = testnet3's own count: offset 0 against the tip, +2 against `0x44`, as on mainnet.
- `0x48` vout 0: 5000 sats, 25-byte P2PKH, flag `0x01`; matches Esplora.
- `0x40` `n1hDD6zeYAhvsT2tkPVQCzjfgLNZDBgZQL` = 1,866,756 sats = Esplora's balance replayed over its 457 transactions to height 5372269.
- Made-up txid: `error code -32000: tx not found: deadbeef…` as on mainnet. `0x45` is empty on testnet too (D-006).

**Result.** Hemi testnet's hVM follows **testnet3** and is current, two blocks behind like mainnet. The brief expected it hours or days behind.

**Used in the design.** Testnet can rehearse output and balance facts and bonds with testnet3 coins; chain 743111 reads testnet3 (D-019 A-18). `PopFinality` is mainnet-only, because nobody publishes testnet keystones (hemi-agent-receipts D-4). Testnet runs op-geth `c1771608` on branch `hemi`, not mainnet's `539f4e33` (D-011). Its layouts are the same, but it lacks mainnet's address-length cap and witness stripping.

## D-011. Precompile layouts and failure modes from source; the commit mainnet runs

**Mainnet runs a commit that is not on branch `hemi`.** `web3_clientVersion` on `https://rpc.hemi.network/rpc` is `Geth/v0.1.0-untagged-539f4e33-20260901/linux-amd64/go1.24.2` (`docs/research/spike/out/s0-context.txt`; dRPC answers `Geth/v10.0.0/drpc`, which hides the version). hemilabs/op-geth commit `539f4e33c02028c8a4207621cd04fa8102e372a0` (2026-09-01, "Additional robustivity and hardening improvements") is not an ancestor of `67f25b90`. Both descend from `6ceee9fc3` ("Robustivity Improvements (#89)"):

- On `hemi`, `67f25b90` adds `c1771608` (#111, Glamsterdam L1 headers) and itself (#112, testnet miner throttle). Neither touches `core/vm` or `params`.
- `539f4e33` adds core/vm changes over the base: `core/vm/contracts.go` +78 −6, `errors.go` +8, a new `tbc_witness.go`, `tbc_merkle.go`, decode bounds in `eth/protocols/eth`, and heminetwork moved from `v1.6.4-0.20250716150413-22552f1a5442` to `…20260831165532-44781989923a`.
- Gas (`params/protocol_params.go`) and `core/vm/evm.go` are identical.
- The `core/vm` diff is in `docs/research/spike/out/mainnet-539f4e33-core-vm-diff.patch`. It was fetched with `gh api repos/hemilabs/op-geth/compare/6ceee9fc3344204415d70f783202f175dae40d79...539f4e33c02028c8a4207621cd04fa8102e372a0`.

Testnet runs `c1771608` (2026-10-05), the parent of `67f25b90`, whose `core/vm` is `67f25b90`'s.

What `539f4e33` changes in behaviour (the byte layouts are unchanged):

1. Addresses over 200 bytes: `0x40` and `0x41` return empty; `0x46` fails the call (`ErrBTCAddressTooLong`, deliberately not the empty-success sentinel).
2. The embedded node must run with `MempoolEnabled=false`.
3. `0x42`, `0x47`, `0x48` and `0x49` read transactions through `txByIdNoWitness`, which strips every input witness ("In the current version of op-geth+tbc, witness data is not used and should never be stored/used"). Measured on mainnet (`docs/research/spike/out/s11-layouts.txt`): `0x47` reports witness count 0 for a P2WPKH input with 2 witness items and a P2TR input with 1; `0x49` is empty for every witness item; `0x42`'s size equals its stripped size (113 for a 223-byte segwit tx).

**Common rules** (`core/vm/evm.go` `runPrecompile` / `runPrecompileGuarded`, identical in both commits):

- Gas below the fixed charge means out of gas: the call fails and burns everything forwarded.
- `ErrHVMInvalidPrecompileInput` and any panic inside an hVM precompile (caught by the recover boundary) become an **empty successful return** charged the fixed gas only.
- Any other error a precompile returns **fails the call and burns all forwarded gas**. From `eth_call` the RPC shows it as JSON-RPC `-32000` with the error text.
- Integers are big-endian. Txids and block hashes are in display order (reversed internally). The per-block result cache is dead (`isValidBlock` is always false), so every call reads the live node.

**Failure modes, per precompile:**

| Addr | Input | Empty success (fixed gas only) | Call fails (all forwarded gas burned) | Measured |
|---|---|---|---|---|
| `0x40` | ASCII address, ≥ 24 B (≤ 200 B on mainnet) | < 24 B; > 200 B; undecodable address; DB error; panic | none | bad checksum → `0x`, 50,000 charged |
| `0x41` | address ‖ start (3 B) ‖ count (1 B, 0 = 10); ≥ 28 B | < 28 B; address > 200 B; undecodable; DB error | none | |
| `0x42` | txid ‖ 4 flag bytes, exactly 36 B | ≠ 36 B; tx not indexed; its block not found; with inputs requested, any input's source tx not indexed (so **every coinbase**); prevout index out of range | none | coinbase + `04000000` → `0x` |
| `0x43` | txid, exactly 32 B | ≠ 32 B | **unknown or unindexed txid** (`tx not found`); header lookups fail | D-005 |
| `0x44` | ignored | UTXO-index position unreadable | header at the index position unreadable | |
| `0x45` | height, exactly 4 B | ≠ 4 B; no header; header not in tx index (**today: always**, D-006) | none | D-006 |
| `0x46` | ASCII address, ≥ 24 B | < 24 B | **undecodable address**; > 200 B (mainnet); `PayToAddrScript` error | bad checksum → `-32000 invalid checksum…`; cap 30,000 → all 30,000 burned |
| `0x47` | txid ‖ input (2) ‖ max scriptSig (2), exactly 36 B | ≠ 36 B; tx not indexed; input out of range; source tx not indexed (**coinbase input**); prevout out of range | none | block-1 coinbase → `0x` |
| `0x48` | txid ‖ vout (2) ‖ max script (2), exactly 36 B | ≠ 36 B; tx not indexed; vout out of range; **outpoint not in the UTXO set (spent, OP_RETURN, other unspendable)**; DB error | none | D-002, D-004 |
| `0x49` | txid ‖ input (2) ‖ witness (2) ‖ max (2), exactly 38 B | ≠ 38 B; tx not indexed; input out of range; no witness (**mainnet: always**); witness index out of range | none | always `0x` on mainnet |

**`0x44` / `0x45` answer**, 116 bytes: height (4) ‖ hash (32) ‖ version (4, the int32 as big-endian) ‖ previous hash (32) ‖ merkle root (32) ‖ time (4) ‖ bits (4) ‖ nonce (4). `0x44`'s hash equals Esplora's block at the same height (`bash docs/research/spike/s0_context.sh`: 976833 → `000000000000000000019ada2495c08b2f353705b20f8d653ad2fe492b51249a` on both, `docs/research/spike/out/s0-context.txt`).

**`0x41` answer:** count (1 byte, `len & 0xFF`), then per UTXO txid (32) ‖ vout (2) ‖ sats (8). The 3-byte field the brief calls "page" is a **start offset counted in UTXOs**. heminetwork's `UtxosByScriptHash` skips that many entries. On the genesis address, "page 1, size 3" started at entry 1 of "page 0, size 3", not at entry 3. Order is leveldb key order, not height order.

**`0x42` btcTxByTxid** (`contracts.go` `btcTxByTxid.Run`). Input: txid (32) ‖ f1 ‖ f2 ‖ f3 ‖ f4, exactly 36 bytes.

| Byte | Bit | Selects |
|---|---|---|
| f1 | 7 | unused |
| f1 | 6 (`0x40`) | containing block hash (32), **and also** a witness count (2) per input: the source tests f1 bit 6 for `includeWitnessArraySize`, so f2 bit 6 does nothing. On mainnet the count is always 0 |
| f1 | 5 (`0x20`) | version (4) |
| f1 | 4 (`0x10`) | size (4) ‖ stripped size (4); on mainnet both are the stripped size |
| f1 | 3 (`0x08`) | locktime (4) |
| f1 | 2 (`0x04`) | inputs |
| f1 | 1 (`0x02`) | per input: previous txid (32) ‖ previous vout (**4**) |
| f1 | 0 (`0x01`) | per input: scriptSig full length (2) ‖ scriptSig cut to the scriptSig max |
| f2 | 7 (`0x80`) | per input: sequence (4) |
| f2 | 6 | unused (see f1 bit 6) |
| f2 | 5 (`0x20`) | outputs |
| f2 | 4 (`0x10`) | per output: script full length (2) ‖ script cut to the script max |
| f2 | 3 (`0x08`) | include unspendable outputs (`txscript.IsUnspendable`: OP_RETURN, or a script over 10,000 bytes). Without it they are left out of both the count and the list, and list positions are not vouts |
| f2 | 2 (`0x04`) | per output: UTXO byte (1): `0x01` = in the UTXO set (unspent), `0x00` = not (spent, unspendable or lookup error) |
| f2 | 1–0 | unused |
| f3 | 5–3 | max inputs = 2^x (1 to 128) |
| f3 | 2–0 | max outputs = 2^x (1 to 128) |
| f3 | 7–6 | unused |
| f4 | 3–2 | max scriptSig = 2^(4+x) bytes (16, 32, 64, 128) |
| f4 | 1–0 | max output script = 2^(4+x) bytes (16, 32, 64, 128) |
| f4 | 7–4 | unused |

Answer, in this order, each part present only if selected:

- block hash (32) ‖ version (4) ‖ size (4) ‖ stripped size (4) ‖ locktime (4);
- inputs: count (2, the true count, clamped at 65,535), then for the first min(count, max inputs): [witness count (2)] ‖ prevout sats (8, **always**, which costs a source-tx lookup) ‖ [prev txid (32) ‖ prev vout (4)] ‖ [scriptSig length (2) ‖ scriptSig] ‖ [sequence (4)];
- outputs: count (2, spendable outputs only unless f2 bit 3, clamped), then for the first min(count, max outputs) listed outputs: sats (8) ‖ [script length (2) ‖ script] ‖ [UTXO byte (1)].

A caller detects truncation by comparing the count with what it got. The gas is a fixed 25,000 however much is returned. Verified live with flags `7fbc3f0f` on three transactions against Esplora (`docs/research/spike/out/s11-layouts.txt`): block hash, version, locktime, prevout values, scriptSig and sequence all agree. With `003c0000` on the 948-output transaction it returns count 948 and one output with 16 script bytes. The contracts read outputs with `003c0703` (`Hvm.TX_FLAGS_OUTPUTS`: outputs, scripts, unspendable outputs, UTXO byte; up to 128 outputs, scripts cut at 128 bytes).

**`0x47` btcInputByTxid.** Input: txid (32) ‖ input index (2) ‖ max scriptSig bytes (2), exactly 36 bytes. Answer: witness count (2; **always 0 on mainnet**) ‖ prevout sats (8) ‖ previous txid (32) ‖ previous vout (**2**, clamped at 65,535; `0x42` gives 4) ‖ scriptSig full length (2, clamped) ‖ scriptSig cut to the max ‖ sequence (4). It was verified against Esplora on three inputs. One case: the PoP tx's 107-byte P2PKH scriptSig, also cut to 10 bytes with the length field still 107.

**`0x49` btcTxGetInputWitness.** Input: txid (32) ‖ input index (2) ‖ witness item index (2) ‖ max bytes (2), exactly 38 bytes. Answer: full item length (2, clamped) ‖ item cut to the max. **On mainnet it never answers**: witness data is never fetched by the embedded node and is stripped if present.

**Gas** (`params/protocol_params.go`, same at both commits, measured in D-009): `BtcAddrBal` 50,000; `BtcUtxosAddrList` 100,000; `BtcTxByTxid` 25,000; `BtcTxConf` 5,000; `BtcLastHeader` 5,000; `BtcHeaderN` 6,000; `BtcAddrToScript` 25,000; `BtcInputByTxid` 15,000; `BtcOutputByTxid` 15,000; `BtcTxGetInputWitness` 15,000.

**Where this contradicts the brief's precompile table:**

- `0x48`'s "spent flag" is an *unspent* flag that is always `0x01`; spent and OP_RETURN outputs come back empty (D-002, D-004).
- `0x45` never answers, not only for the two newest blocks (D-006).
- `0x41`'s "page" is an offset in UTXOs.
- `0x47`'s witness count is always 0 and `0x49` is always empty on mainnet, so the brief's control facts (its section "Later (not now)"), which check a spend's sighash type through `0x49`, cannot work on today's mainnet.
- Not every failure is an empty success: `0x43`, `0x44` and `0x46` fail the call and burn the gas they are given.
- `0x40` and `0x46` take at most 200 bytes on mainnet.
- `0x43` can wrap: if the tx index were ever ahead of the upstream tip, `uint32(heightBest − height + 1)` underflows (a source comment keeps this for consensus compatibility). The contracts treat a count above `0x44`'s height + 1,000 as no answer.

## D-012. Other findings

1. **The spike's outputs are committed.** The repo's `.gitignore` has `out/`, which would match `docs/research/spike/out/` (and `docs/research/spike/probe/out/`), so it carries an exception for `docs/research/spike/out/`.
2. **The two-block lag is not a constant.** `0x44` trailed Esplora's tip by 2 in every comparison but one. During S6 it was at 976831 while both Esplora instances showed 976835, a lag of 4, after two Bitcoin blocks came in quick succession. By S7 it had caught up to 976833 at tip 976835. Code and README say "about two blocks, sometimes more", not exactly two.
3. **hVM precompiles are warm, upstream precompiles are cold.** `ActivePrecompiles` appends the hVM addresses to an OP-stack fork list that is deliberately empty (`contracts.go`, init comment). So a call to `0x40`–`0x49` pays 100 for access, while upstream precompiles pay 2,600 the first time (measured on identity `0x04`, D-009; the source comment says the same for all of them).
4. **A testnet `tb1…` address is accepted on mainnet.** `btcutil.DecodeAddress` accepts any registered segwit HRP and TBC never checks `IsForNet`. So `0x46` maps `tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx` to the mainnet script `0x0014751e76e8199196d454941c45d1b3a323f1433bd6`, and `0x40` returns that script's mainnet balance (D-001). Base58 testnet addresses are rejected (wrong version byte). A script-keyed subject stays correct. The CLI still rejects an address for the wrong network, so a user never "checks" a testnet address on mainnet (D-019 A-18).
5. **An unknown txid at the RPC is a JSON-RPC error, not a revert.** A raw `eth_call` to `0x43` answers `{"code":-32000,"message":"tx not found: <txid>"}`, and so does `eth_estimateGas`. The SDK treats that error as "not found", not as a transport failure to retry. The same goes for `0x46` (`invalid checksum…`, `invalid character not part of charset…`) (D-019 A-19).
6. **`0x48` and `0x42`'s spent wording in source is inverted.** The variable is `spentBool`, the byte `spent`, and `0x42`'s comment says "Could not look up Outpoint in UTXO table, therefore spent" on the branch where the lookup succeeded. The values are the opposite of the names (D-004). `Hvm.sol` names the field `inUtxoSet`.
7. **Esplora `outspends` counts mempool spends**, so "spent" in Esplora can be ahead of hVM by the mempool plus the two-block lag. In S2 every output Esplora showed spent was also absent from hVM, so none of those spends was that recent. A live check that compares the two must allow for this.
8. **mempool.space throttled this client** to about 75 s per request after the S1 address scan (about 120 address lookups at 2 a second). The scan was rerun on `blockstream.info`, which kept answering in under a second. The SDK's Esplora client rotates between instances and treats a long stall like a 429.
9. **Early history is indexed.** The block-1 coinbase (2009) and the 2013 whitepaper transaction read correctly through `0x48` and `0x42`. hVM's index reaches back to genesis, not to a recent checkpoint.
10. **The Bitcoin whitepaper transaction `54e48e5f…e713` is a good permanent fixture** for tests: 948 outputs, 945 of them 201-byte bare multisig, nearly all unspendable in practice and so unspent forever (947 of 948 unspent today). It covers vout ≥ 32, scripts over 64 bytes, truncation and the 65,535 clamp paths without depending on anyone's wallet.

## D-013. What the spike changed in scope

The checks changed what the contracts are built on, and in places what they do:

- **`BitcoinFacts`** has balance facts for all five address types (S1) and a confirmation offset of 0 (S5). Its spent flag uses the rule in D-014, because `0x48` alone cannot say "spent" (S4).
- **`PopFinality`** reads the PoP output through `0x42`, because `0x48` cannot read an OP_RETURN (S3; D-018).
- **`FidelityBonds`** is built on the D-014 spend rule (S4; D-017).
- **`checkpoint`** reads block hashes through EIP-2935 beyond 256 blocks (S8), and does not take an RLP header (D-020 B-3).
- **No header facts** (S6). `Hvm.headerAt` stays in the library, documented as never answering on mainnet today.
- **No witness checks.** `0x49` never answers on mainnet and `0x47`'s witness count is always 0 (D-011), so nothing reads a signature's sighash type.
- **Testnet** rehearses output facts, balance facts and bonds on testnet3; `PopFinality` is mainnet-only (S10).

## D-014. The spend rule: `Hvm.spendStatus`

`0x48` answers only for outputs in the UTXO set, and gives the same empty answer for spent, unspendable and unknown (D-004). An empty answer must never be read as "spent". `Hvm.spendStatus(txid, vout, sats, scriptHash)` returns `Unspent`, `Spent` or `Unknown`, and only positive answers count:

- **Unspent:** `0x48` answers with flag 0x01 and the expected value and complete script.
- **Spent:** `0x48` gives no answer **and** `0x42` (flags `003c0703`) lists the transaction with that vout, the same value, the complete script (128 bytes or fewer) and UTXO byte 0x00. Callers ask only about spendable scripts, because 0x00 also means "unspendable".
- **Unknown:** anything else.

A looser pairing, an empty `0x48` plus a `0x43` answer for the txid and a vout that exists, would also tell spent from unknown. Matching value and script on the `0x42` path also rules out a lookup error on a different output. Checked live on 2026-11-21 through `HvmHarness` placed by state override:

```
RT=$(cd contracts && forge inspect test/Hvm.t.sol:HvmHarness deployedBytecode); H=0x00000000000000000000000000000000000c0ffe
cast rpc eth_call '{"to":"'$H'","data":"'$(cast calldata 'spendStatus(bytes32,uint16,uint64,bytes32)' 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e 1 83050000 $(cast keccak 0x0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4))'","gas":"0x989680"}' latest '{"'$H'":{"code":"'$RT'"}}' --rpc-url https://rpc.hemi.network/rpc
  -> 2 (Spent)
  same for 0x43cb9bdc…cea4 vout 0, 1000 sats, keccak(0x001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831) -> 1 (Unspent)
  same for txid 0x1111…1111                                                                       -> 0 (Unknown)
txOutputs(0xd4ed6ec2…845e) -> true, 2, [(17680, 25, 0x76a914…88ac, false), (0, 83, 0x6a4c5048454d4901019152a2…ddef4, false)]
```

The internal review confirmed from heminetwork's source that the rule means what it says ([SECURITY-AUDIT.md](SECURITY-AUDIT.md)).

Limits: an output past index 127, or a spent output with a script over 128 bytes, is `Unknown` on the spent path.

## D-015. Gas caps

`Hvm.sol` passes each precompile twice its RequiredGas (`GAS_CAP_FACTOR = 2`). S9 shows a cap equal to RequiredGas always succeeds and one less fails, with about 317–400 gas of call overhead in the caller (D-009). Twice leaves room for a reprice of up to 2x in a non-upgradeable contract. A failed call (`0x43` unknown txid, `0x46` bad address) then burns at most twice the fixed cost: 10,000 gas for `0x43`, 50,000 for `0x46`. Checked live: `eth_estimateGas` of `HvmHarness.confirmations(0x1111…1111)` is 33,113 in total.

## D-016. Tooling

- **Node.** `sdk/package.json` declares `engines >= 22.18` and uses nothing newer than Node 22.
- **npm.** `sdk/package-lock.json` is committed and resolved against registry.npmjs.org, and `package.json` pins every direct dependency exactly (`viem` 2.57.5, `@scure/btc-signer` 1.8.1, `@noble/curves` 1.9.1, `@noble/hashes` 1.8.0; dev: `typescript` 6.0.3, `tsx` 4.23.15, `@types/node` 22.20.5). Every entry in the lockfile comes from the public registry:

  ```
  $ grep -o '"resolved": "https://[^/]*' sdk/package-lock.json | sort | uniq -c
    47 "resolved": "https://registry.npmjs.org
  ```

- **forge-std** v1.17.0, vendored in `contracts/lib/forge-std`.
- **op-geth** for reading source: hemilabs/op-geth branch `hemi` at `67f25b90`. Mainnet runs `539f4e33` and testnet `c1771608` (D-011). heminetwork at `44781989923a` (mainnet's pin) and `22552f1a` (testnet's).

## D-017. `FidelityBonds` is built on `Hvm.spendStatus` (check S4)

S4 showed that `0x48` has no spent value (D-004). `FidelityBonds` uses the rule in D-014 instead: `checkBond` requires `Unspent`; `refresh` marks a bond ended only on `Spent`; `Unknown` changes nothing, and `liveBond` treats it as not live. Because the bond's tag is an OP_RETURN, which `0x48` never answers for, the tag is read through `0x42` (`Hvm.txOutputs`). The Bitcoin side is tested end to end on a regtest node: create, a redeem bitcoind refuses before the locktime, and a redeem it accepts after (`regtest/run.sh`; D-021, D-022).

## D-018. `PopFinality` is built on `0x42`, and `checkpoint` reads EIP-2935 (checks S3 and S8)

S3 showed that `0x48` cannot read the PoP OP_RETURN and that `0x42` returns it in full (D-003, and the `txOutputs` line in D-014's live check). `PopFinality` reads the PoP output through `0x42`. `checkpoint(K)` reads block K's hash through `blockhash` while it reaches, and through EIP-2935 after that (S8, D-008). That gives about 8,191 blocks (27 hours) to checkpoint a keystone instead of 256 (51 minutes). The `hbf finality` commands use it (D-020).

## D-019. BitcoinFacts design

The decisions that shape `BitcoinFacts` and `hbf facts`, with their IDs (A-n) as the deployed source and tests cite them. IDs not listed here were notes on tests and tooling and are not carried over.

- **A-1. One verdict enum for both kinds, ten values; only `Ok` is an answer.** `Ok`, `NoBitcoinView`, `NotFound`, `VoutTooHigh`, `Unspendable`, `ScriptTooLong`, `Inconsistent`, `NoConfirmations`, `BadAddress`, `NoBalance`. The verdict is the first failing step. Fields are filled as far as the checks got, and only `Ok` makes them a fact. One enum keeps one custom error (`NotRecordable(Verdict)`) and one SDK decoder.
- **A-2. Spent needs a positive `0x42` listing and a spendable script.** `0x48` answering is "unspent" (in the UTXO set). With no `0x48` answer, `0x42` (`003c0703`) must list the transaction, have `vout` below its count, show UTXO byte `0x00`, and carry the complete script (128 bytes or fewer). Because `0x00` also means "unspendable", the script must also pass btcd's `txscript.IsUnspendable` in full: not OP_RETURN first, not over 10,000 bytes, and it must parse. An unspendable script is the `Unspendable` verdict on both paths, so even a `0x48` answer for an OP_RETURN is never "unspent". This is D-014 with the caller's "ask only about spendable scripts" duty taken into the contract. The genesis coinbases of Bitcoin mainnet and testnet4, which hVM lists as unspent but which can never be spent, are `Unspendable` too (internal and delta reviews, [SECURITY-AUDIT.md](SECURITY-AUDIT.md)).
- **A-3. Contradictions are their own verdict.** `0x42` UTXO byte `0x01` with no `0x48` answer is `Inconsistent`. A malformed `0x48` answer is treated as no answer and the output is judged by `0x42` alone, so a format change would show as `Inconsistent`, never as spent. `vout` ≥ 128 with no `0x48` answer is `VoutTooHigh`; `vout` at or past the count is `NotFound`.
- **A-4. Confirmations are checked for plausibility, and `0x43` is called last.** A count of 0, or above the `0x44` height + 1,000 (the underflow in D-011), is `NoConfirmations`. `0x43` is called only once the output was found, so an unknown txid never burns its cap. The stored count is the one at the first recording; it is not part of the id.
- **A-5. Ids.** `id = keccak256(abi.encode(kind, subject, btcBlockHash))`, with kinds `keccak256("hemi-bitcoin-facts/output")` and `keccak256("hemi-bitcoin-facts/balance")`. The output subject is `keccak256(txid ‖ uint16 vout)`, the balance subject `keccak256(scriptPubKey from 0x46)`.
- **A-6. "One slot per fact" is one mapping entry per id, holding a packed struct a consumer contract can read directly:** four slots for an output, three for a balance. A single commitment slot would save about 44,000–66,000 gas (about $0.0001) but make every consumer pass every field and make the stored fact unreadable without the event.
- **A-7. Events carry every stored field plus the script.** The script is emitted, not stored. The address string is neither stored nor emitted: two spellings are one fact.
- **A-8. A repeat record runs the check and then does nothing.** It still reverts on a non-`Ok` verdict.
- **A-9. Address strings shorter than 24 or longer than 200 bytes are `BadAddress` without a call** (200 is mainnet's cap, D-011), so a too-long string does not burn `0x46`'s cap.
- **A-11. Deployment.** CREATE2 salt `keccak256("hemi-bitcoin-facts/BitcoinFacts/v1")`. `Deploy.s.sol`'s `targets()` lists the three contracts, and a broadcast on Hemi mainnet needs `CONFIRM_MAINNET_DEPLOY=yes`, among the guards in D-024.
- **A-16. `facts record` checks by `eth_call` first.** It sends nothing unless the verdict is `Ok` and the fact is new; for a fact already stored it writes the file from the existing recording. After the receipt it reads the stored fact and the event at the receipt's block, with retries, because a load-balanced RPC can answer from a node that has not seen the block yet.
- **A-17. The mainnet guard cannot be talked out of.** `record` takes the chain id from the RPC, and a `--chain-id` that disagrees is a usage error, so `--chain-id 31337` against a mainnet RPC cannot skip the guard. The guard runs before any key is read.
- **A-18. The Bitcoin network follows the chain.** Chain 43111 reads Bitcoin mainnet and 743111 testnet3 (D-010); other chains take `--btc-network`. Addresses for the wrong Bitcoin network, or undecodable ones, are refused before any call (D-012 item 4).
- **A-19. `-32000` from hVM is a verdict, never a retry.** `tx not found` maps to `NotFound` and address-decoding messages to `BadAddress`; other `-32000` errors are rethrown. Inside a contract the precompile call just fails (D-005), so this is defence in depth (D-012 item 5).

Measured on mainnet by `eth_estimateGas` on 2026-11-21 (nothing sent): `recordOutput` 150,971 gas for an unspent output, 181,668 for a spent one; `recordBalance` 181,385. That is about $0.001 a record at D-009 prices. The first mainnet records used 149,422 and 178,935 gas (D-026).

## D-020. PopFinality design

The decisions that shape `PopFinality` and `hbf finality`, with their IDs (B-n). B-18 to B-25 are in D-023. The anchored views were first named `btcConfirmations(block, K)` and `isBtcFinal(block, K)`. They were renamed `anchorConfirmations` and `isBtcAnchored` before deployment, after the independent audit ([SECURITY-AUDIT.md](SECURITY-AUDIT.md)); the rename changed nothing else. This file uses the deployed names.

- **B-1. The PoP output is read through `0x42` (`Hvm.txOutputs`), never `0x48`** (D-003, D-018). Each failure has its own verdict: the vout below the output count (`NotFound`) and inside `0x42`'s 128-output window (`VoutTooHigh`), a complete script of exactly 83 bytes (`WrongLength`), the prefix `6a4c5048454d49` (`WrongPrefix`), UTXO byte `0x00` (`Inconsistent` otherwise), version `0x01` (`WrongVersion`), `[5:9]` = K (`WrongKeystone`), `[64:76]` = the checkpoint (`WrongBlockHash`), then a plausible `0x43` count (`NoConfirmations`).
- **B-2. `checkpoint(K)` reads `blockhash` first, then the EIP-2935 history contract.** The history call checks for code, has a 10,000-gas cap and copies back at most 32 bytes. A revert, a short answer or a zero hash is "no hash" (`OutsideWindow`). The window is 1 to 8,191 blocks, as the history contract's own bytecode checks it; the tests run against that exact bytecode on a fork. A stored checkpoint outlives the window.
- **B-3. No RLP-header option.** The brief asked whether `checkpoint` should also take block K's RLP header, to pin more keystone fields. A header is easy to verify: 621 bytes for block 5620225, and its keccak256 equals the block hash. But the keystone's L1-origin field `[1:5]` is not in the header. It is in block K's first transaction (the L1-info deposit), reachable only through a Merkle-Patricia proof. The canonical keystone is public, so a forger copies all 76 bytes and changes only `[1:5]`, which passes a header-pinned check as easily as the prefix check, while Hemi's bfgd (exact match) ignores it. So the header would add no security and cost about 5× the checkpoint's L1 fee, which today sits on the 100-byte floor. The contract attests only K's number and hash prefix, and its NatSpec says so. The SDK applies bfgd's full 76-byte match off chain: `hbf finality record` offers only Esplora candidates whose 76 bytes equal the keystone rebuilt from Hemi RPC, and `verify` reports the exact-match result.
- **B-4. `recordPublication` checkpoints K itself** when no checkpoint is stored and block K's hash is still readable (one more slot and a `Checkpointed` event, about 22,000 gas). `watch` still checkpoints every keystone as it is cut, because PoP can be late by days.
- **B-5. One publication per keystone, decided by reading both in the same transaction.** Replaced by B-18 and B-19 (D-023): every valid publication is now kept, and B-5's rule chooses K's best.
- **B-6. One verdict enum, sixteen values; the first failing step decides.** As in A-1. The script is parsed before the checkpoint comparison, so a check returns the parsed keystone even when the checkpoint is missing or wrong; `0x43` is called last (A-4).
- **B-7. Ids.** `id = keccak256(abi.encode(KIND_PUBLICATION, keccak256(uint32 K ‖ txid ‖ uint16 vout), asOfHash))`, with `KIND_PUBLICATION = keccak256("hemi-bitcoin-facts/publication")`. Since B-18 the subject is also the storage key.
- **B-8. Storage and events.** A checkpoint takes 1 slot (`bytes12` prefix, `uint64` Hemi block), a publication 3. The 76-byte abbreviated keystone is emitted, not stored.
- **B-9. The finality views never revert, and they guard against an underflowed count.** They return `(verdict, confirmations)` and a bool, zero or false on anything but `Ok`. K counts if it is a keystone at or after the block's covering keystone; for a multiple of 25 that is exactly K ≥ block. The count is read live from `0x43` and must be at least 1 and at most the `0x44` height + 1,000 (D-011). Final means 9 or more (`BTC_FINAL_CONFIRMATIONS`, from Hemi's docs and bfgd). `false` means "not shown final through K", never "not final". `coveringKeystone(0)` is 25, and above `MAX_KEYSTONE` (4,294,967,275) it is 0, so every nonzero answer is a keystone the views accept (pre-mainnet audit, [SECURITY-AUDIT.md](SECURITY-AUDIT.md)).
- **B-11. Esplora supplies only hints; the contract decides.** `record` without `--btc-txid` reads known PoP miners' address histories, then scans raw Bitcoin blocks from the keystone's time. Every candidate goes through `checkPublication` by `eth_call`. Esplora order is mempool.space then blockstream.info (D-012 item 8).
- **B-12. `watch` scans each Bitcoin block once** rather than polling addresses, records at 3 or more confirmations (hVM sees a transaction after about three, D-012), finds publications by any miner, and has `--dry-run`. It records exact matches only (B-22).
- **B-13. What `watch` costs.** Both transactions are under the OP-stack Fjord minimum size, so each pays the floor L1 fee of 1,600 × l1BaseFee: `getL1Fee` on an unsigned `checkpoint` tx of 81 bytes and a `recordPublication` tx of 146 bytes both returned 526,200,428,800 wei at l1BaseFee 328,875,268 on 2026-11-21. At D-009's prices that is about $0.0005 a checkpoint and $0.0006 a record. A keystone every 25 blocks is 288 a day: about $0.14 a day for checkpoints, $0.32 if every keystone is also recorded (B-23 updates this to $0.33).
- **B-16. Deployment.** Salt `keccak256("hemi-bitcoin-facts/PopFinality/v1")`, `targets()[1]` after BitcoinFacts.

Measured on mainnet by `eth_estimateGas` on 2026-11-21, before B-18 (nothing sent): `checkpoint` 46,918 gas via `blockhash`, 51,986 via EIP-2935; `recordPublication` 144,721; `isBtcAnchored` 37,224. The figures after B-18 are in D-023.

## D-021. FidelityBonds and the Bitcoin side

The decisions that shape `FidelityBonds`, the Bitcoin tooling and `hbf bond`, with their IDs (C-n). IDs not listed here were notes on tests and tooling and are not carried over.

- **C-1. The floor is 10,000 sats (`MIN_SATS`).** High enough that a bond is not dust-sized and costs its creator more than the fees of creating and redeeming it at ordinary rates (about 650 sats at 2 sat/vB). Low enough that a live test bond of at most 20,000 sats qualifies with room. The CLI refuses less on every network.
- **C-2. Bond id** `keccak256(abi.encode(keccak256("hemi-bitcoin-facts/bond"), keccak256(txid ‖ uint16 vout)))`: one per output, ever, with no block hash, because a bond is a standing claim about one output, not a reading at one tip.
- **C-3. Expiry.** A bond reads `Expired` once the `0x44` header's time or Hemi's `block.timestamp` reaches the locktime (`_expired`). Bitcoin accepts the redeem only once the median time past of the last 11 blocks is greater than the locktime (BIP113), and a block's median time past is never above its own time. So whenever a spend would be valid on top of hVM's header, `liveBond` already says `Expired`. In practice it says so 1–2 hours before the owner can spend, because the median time past runs that far behind the clock (D-028 saw about an hour). This errs toward the consumer. Hemi's clock was added after the independent audit ([SECURITY-AUDIT.md](SECURITY-AUDIT.md)): with the header's time alone, a stale hVM view kept a bond `Live` after its owner could redeem it. The guarantee holds while Hemi's clock is at or ahead of Bitcoin's median time past; it can fail after a sequencer halt, or when a median time past runs ahead of real time, so a consumer should keep a margin.
- **C-4. Check order (and enum order): template, locktime, header, `0x42` listing, bond script, spend status, tag, floor, confirmations.** The verdict names the most basic property that fails: a real non-bond output reads `NotABond`, a real spent bond `Spent`. The template and locktime need no hVM call, so a malformed script costs nothing; `0x43` runs last (A-4).
- **C-5. The value comes from `0x42`, and `spendStatus` requires `0x48` to agree,** so the recorded value is `0x48`'s with one `0x48` call.
- **C-6. Exactly one tag, and at most 128 outputs.** A second `"HFB1"` tag in the funding transaction, for any chain or contract, makes the bond `AmbiguousTag`, so the binding never depends on who records first (since the internal review; [SECURITY-AUDIT.md](SECURITY-AUDIT.md)). To see every output `0x42` must list them all, so more than 128 is `TooManyOutputs`.
- **C-7. The tag** is exactly 50 bytes: `6a 30`, `"HFB1"`, chain id (4 bytes), contract, agent. An `OP_PUSHDATA1` spelling, another length or the zero agent is `BadTag`.
- **C-8. The witness script** is exactly 42 bytes, with a locktime in [500,000,000, 2^31): a timestamp, positive as a 4-byte script number, and so always a minimal push. The contract refuses a key whose x is at or above the field prime, but cannot cheaply check that the key is on the curve; the SDK does.
- **C-9. `checkBond` returns an `expired` flag rather than refusing an expired bond.**
- **C-10. Storage is 5 slots.** `endedHemiBlock != 0` marks an ended bond, and ended is final: a later "unspent" answer does not revive it.
- **C-11. `liveBond(id)` returns `(status, agent, sats, locktime)`.** It says `Ended` as soon as hVM shows the output spent, before anyone calls `refresh`. `Unknown` is never `Live`.
- **C-12. `refresh` changes nothing on `Unspent` or `Unknown`, without reverting,** so a keeper can call it blindly. `hbf bond refresh` simulates it and sends only when it would end the bond.
- **C-13. `readTag(txid, tagVout)`** exposes the tag rule on its own.
- **C-14. The regtest image is `bitcoin/bitcoin:32.1`,** pinned by digest `sha256:d2454aaf2ff4ce1ebbc49f4aa05ed044c907b849a80a3f4c0ad23e488e50bbe0`. What the regtest test checks (CLTV, BIP113's median-time rule, the `non-final` rejection) is consensus and long-standing policy.
- **C-15. CLI guards, all before any key is read or any request is made.** On Bitcoin mainnet `create` refuses more than 20,000 sats or a locktime more than 24 hours ahead without `--override-caps`. `create` and `redeem` need a Bitcoin `--allow-mainnet`, `record` and `refresh` the Hemi one. Everywhere the locktime must be in the future, the value at least `MIN_SATS` and the fee rate at most 50 sat/vB.
- **C-16. The bond file is written before broadcast** and holds public data only, so a crash after the broadcast never loses what redeem needs.
- **C-17. Redeem.** nLockTime = locktime, sequence `0xfffffffe`, low-S SIGHASH_ALL, witness `[signature, witness script]`. The CLI refuses until the median time past is greater than the locktime, unless `--skip-locktime-check` (the regtest test uses it to show bitcoind's own refusal).
- **C-18. Funding.** The bond at vout 0, the tag at 1, change at 2.
- **C-19. Esplora's `/tx/:txid/status` says `{"confirmed":false}` for any txid,** so existence comes from `/tx/:txid`.
- **C-20. Keys** come from `--btc-key-file`, which must be inside a `.secrets/` directory (D-029). Error messages never echo the input.
- **C-22. Vendoring.** Three files from x402facilitator's `btc/src` at `4a26ad72`. Every edit is listed in `sdk/src/vendor/x402-btc/VENDOR.md`.

Measured on mainnet by `eth_estimateGas` on 2026-11-21: `checkBond` 69,353 (stops at `NotABond`), `liveBond` 58,290 (`Live`) and 80,663 (`Ended`), `refresh` 92,564. `recordBond` cannot be estimated on mainnet without a bond there; on anvil with the mocks it is 217,829. The first mainnet bond used 212,464 to record and 93,215 to refresh (D-028).

## D-022. Integration: the three contracts, the public RPC's rate limit, the test suites

- **Together.** `Deploy.s.sol`'s `targets()` deploys `BitcoinFacts`, `PopFinality` and `FidelityBonds`, in that order. They share `Hvm.sol` and nothing else. CREATE2 addresses move with any byte of a contract or of `Hvm.sol`, so they are pinned with the build (D-024).
- **The public RPC's rate limit.** rpc.hemi.network allows about 300 requests a minute. On a fork, anvil forwards upstream every request it cannot answer locally, including a receipt it does not have yet. A test helper that polled receipts every 20 ms put the RPC into HTTP 429 (`-32005 rate limit exceeded`) for one run; all traffic was read-only. So the test helpers wait on the local block number; forge's `hemi` endpoint retries with backoff at 80 compute units a second (`contracts/foundry.toml`); the SDK's anvil harness forks at 60 compute units a second with a 180 s start deadline; and `npm test` runs files one at a time (807 requests in 171 s, about 4.7 a second).
- **Mocks and the real precompiles.** Forge tests run against `MockHvm`. What a mock cannot show (fixed-cost gas, unset vouts, the genesis and BIP30 cases) is covered by `check-live.sh` and `contracts/test/review/live-review.sh`, which call the real precompiles on mainnet, read-only.
- **The suites.**
  - `cd contracts && forge test`: the contracts, with fuzzers and fork tests.
  - `cd sdk && npm test`: the SDK and CLI, on a Hemi mainnet fork.
  - `regtest/run.sh`: the Bitcoin side on bitcoind regtest. bitcoind refuses the early redeem with `non-final (RPC code -26)` and accepts it once the median time past has passed the locktime.
  - `./check-live.sh mainnet`: read-only checks of bonds, facts and finality against mainnet. At integration on 2026-11-21, 107 checks passed at Hemi block 5781236.

## D-023. `PopFinality` keeps every valid publication

The internal review found that `PopFinality` checks only K and the 12-byte hash prefix, so a forged keystone, for one Bitcoin fee, made the anchored view true. Under B-5's one-publication rule, a forgery mined first also kept the real publication out for good ([SECURITY-AUDIT.md](SECURITY-AUDIT.md), internal review finding 1). Every valid publication is now kept, and an exact-match path is added. This departs from the brief's "keeps one txid per keystone". The decisions, with their IDs:

- **B-18. Every valid publication is stored,** once, keyed by its subject `keccak256(uint32 K ‖ txid ‖ uint16 vout)`: one mapping, three slots per entry. Recording a stored one again writes nothing new. A forgery recorded first can no longer keep the real publication out, and nothing is ever removed. There is no iteration over entries, so many entries for one K (a forger paying a Bitcoin fee and Hemi gas for each) cost nobody else anything.
- **B-19. K's "best" is a one-slot pointer, chosen by B-5's rule and re-run on every submission.** A submission becomes the best if K has none, or if, read in the same transaction, the best now fails the check or has strictly fewer confirmations; a tie keeps the best. So after the best stops verifying, the next valid submission becomes the best whatever its count (delta review finding 3). If the best's Bitcoin transaction is reorged away, re-submitting any other stored publication makes a valid one the best again, and that transaction writes only the pointer (internal review finding 9). A pointer costs one slot instead of three. `BestPublicationChanged` carries the new target, its count and the previous best; `PublicationRecorded` is emitted only for a new entry. A starved re-read of the best leaves at most 1/64 of the gas, less than the 2,900 that rewriting the pointer costs, so it cannot flip the outcome.
- **B-20. `recordPublication` returns `(created, best)`.** It never reverts because a candidate loses. It reverts `NotRecordable(verdict)` whenever the check is not `Ok`, a re-submission included, so a stored publication that no longer verifies cannot be pushed back to the best.
- **B-21. Two readings, named for what they mean.** `btcConfirmationsVia(block, K, txid, vout)` and `isBtcFinalVia(…)` answer about one stored publication the caller names, with nothing that depends on the best. That is the Hemi PoP finality question, provided the caller has matched the publication's 76 bytes with the canonical keystone off chain; the contract does not check that match. `anchorConfirmations(block, K)` and `isBtcAnchored(block, K)` read K's best and mean only "block K's number and hash prefix are anchored on Bitcoin under N confirmations". A forged keystone satisfies them for one Bitcoin fee. Getters: `publicationOf(K, txid, vout)` and `bestPublicationOf(K)`; there is no one-argument `publicationOf(K)`.
- **B-22. The SDK and CLI read finality through the exact-match path.** `status` names the publication that matches all 76 bytes (or the one the receipts SDK reader found), labels the anchored view as forgeable, and exits 0 only on exact-match finality. `verify` checks a fact file against its own entry, never against the best. `record` refuses an inexact `--btc-txid` without `--allow-inexact`. `watch` records exact matches only.
- **B-23. Gas on mainnet** (`eth_estimateGas` from `./check-live.sh mainnet finality`, contract and storage by state override, 2026-11-21):

  | Call | Before B-18 | After |
  | --- | --- | --- |
  | `checkpoint(K)`, blockhash | 46,918 | 46,908 |
  | `checkpoint(K)`, EIP-2935 | 51,986 | 51,976 |
  | `recordPublication`, first of K, checkpoint stored | 144,721 | 171,031 (one more slot: the best pointer) |
  | `isBtcAnchored(block, K)` | 37,224 | 39,460 |
  | `isBtcFinalVia(block, K, txid, vout)` | — | 38,326 |
  | `checkPublication`, the best itself | 77,111 | 77,293 |

  At D-009 prices `watch` then costs about $0.33 a day: $0.14 for checkpoints, $0.19 for records.
- **B-24. The live check asks the exact-match question on mainnet.** `./check-live.sh mainnet finality` passes 70 checks: `isBtcFinalVia` is true for both mainnet fixtures (blocks 5620209 and 5734701) and agrees with the receipts SDK, which matches all 76 bytes.
- **B-25. The review's `PopFinality` tests now assert the fixed behaviour** (`contracts/test/review/ReviewPopFinality.t.sol`).

## D-024. The build is pinned; addresses

`Deployments` pins each contract's init-code hash, and `Deploy.s.sol` refuses to simulate or broadcast any other build:

```
FOUNDRY_PROFILE=verify forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:18799
  Error: script failed: Deploy: init code of BitcoinFacts is not the pinned build (default profile?)
```

The `verify` profile used there added CBOR metadata. It has since been removed from `contracts/foundry.toml`: the default profile has no metadata, so the bytecode, and so the CREATE2 address, depends on source only, and Blockscout source verification must use these same settings (D-025).

The deployed builds:

| Contract | Init-code hash | CREATE2 address |
| --- | --- | --- |
| BitcoinFacts | `0x6b9a239be1b8d8ecd1fdad96ba73d03dd6bf5f13b89891b6713fac57b9a1234c` | `0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC` |
| PopFinality | `0x205b751f96b0a815e61940a2e10f9161e07837d826bb55e00cc0245de296c6bd` | `0x0706C1582E7C27c09953803384396efd4fa62486` |
| FidelityBonds | `0x2197004a2e44e2c65c00e439b04f9fa8e3072fca49cf36eccb9941cbca74b9b9` | `0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e` |

The pins changed with each round of fixes before deployment ([SECURITY-AUDIT.md](SECURITY-AUDIT.md)); these are the deployed ones. Any change to a contract or to `Hvm.sol` changes its hash and address. `test_review_initCodeIsPinned` and `test_review_predictedAddressesMatchTheDocs` then fail until the pins, the README and the SDK are updated.

The deploy script's guards, as deployed (they came out of the delta review and the review of its fixes):

- Every broadcast goes through `_guardBroadcast()`: the pin check; the RPC's `eth_chainId` must equal `block.chainid`, so forge's `--chain` or `FOUNDRY_CHAIN_ID` cannot fake the chain; and on Hemi mainnet `CONFIRM_MAINNET_DEPLOY=yes`.
- The chain-id check runs in every script run, dry runs included, so no unchecked sequence can be recorded for a later `forge script --resume`, which never runs the script.
- `run()` simulates. `plan()` prints whether each hash is the pinned one and whether code is present. An address that already has code is skipped.
- A preview with `--sig 'deployAll(bool)' true` and no `--broadcast` leaves a dry-run sequence that a later `--resume` would send without asking again, so delete `contracts/broadcast/Deploy.s.sol/43111/dry-run/` after previewing.

## D-025. Mainnet deployment and source verification (2026-11-22)

The three contracts were deployed by CREATE2 through the deterministic deployer, from `0x0c9aCd4F85946587fC15CA55Ea9A1c48Aaee162f` (a hemi-agent-receipts relayer account). The sender has no role in these contracts, which have no owner. A preview (`deployAll(true)` with `--sender` and no broadcast) showed chain 43111, the three addresses of D-024 and about 8.5M gas estimated, and all three addresses were empty.

| Contract | Address | Transaction | Block | Nonce | Gas used | L2 fee (wei) | L1 fee (wei) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BitcoinFacts | `0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC` | `0x56dd5481ddbfde00c147bb098d16a4f8f995c3e47e7358e223678c9a99781cf9` | 5793795 | 1 | 1,811,869 | 1,812,325,590,988 | 9,742,590,145,544 |
| PopFinality | `0x0706C1582E7C27c09953803384396efd4fa62486` | `0x0ab78f26dced4dc4be5175a62b8b4813390ac8ceee30bad32e7450e4695ff476` | 5793796 | 2 | 1,906,713 | 1,907,193,491,676 | 10,438,714,775,459 |
| FidelityBonds | `0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e` | `0xbb38c050b74bd4370e7bcc5c2f4a65e0a72690188d78d30f9c6fcf29e274c782` | 5793797 | 3 | 2,335,573 | 2,336,161,564,396 | 11,603,637,143,225 |

Total paid: 37,840,622,711,288 wei, or 0.0000378 ETH (about $0.06): 0.0000061 ETH of L2 fee at an effective 1,000,252 wei per gas, plus 0.0000318 ETH of L1 data fee. The pre-deploy estimate was 0.000033 ETH (0.000047 at the L1 fee oracle's upper bound). The sender's balance fell by exactly that total, from 0.001999672911572141 to 0.001961832288860853 ETH. Gas used per contract equals a rehearsal on a local fork.

**Fees on Hemi: give forge both flags.** Forge's own fee choice does not work here:

1. With `--priority-gas-price 1000000` alone, forge stopped before signing anything: its estimated max fee (505 wei) was below that tip, `maxPriorityFeePerGas (1000000) cannot be higher than maxFeePerGas (505)`.
2. With forge's own fees (tip 1 wei, max fee 505 wei; base fee 252 wei), the first transaction, `0x8ad5da42…408f` (nonce 1), sat unmined for about 20 minutes while blocks went on. The node's `eth_maxPriorityFeePerGas` is 1,000,000 wei, and a transaction tipping 1 wei is not picked up. With `--slow`, forge waited on it and sent nothing else. A second run could not start until the first was stopped, because the first held forge's recovery-state lock (`cache/Deploy.s.sol/43111/run-latest.json.recovery.json`).
3. The same deployment again at nonce 1, with `--sender-nonce 1 --with-gas-price 2000000 --priority-gas-price 1000000 --slow`, replaced the stuck transaction (the node no longer knows it: "tx not found"). All three were mined, as in the table.

So for any forge deploy on Hemi, pass `--with-gas-price` and `--priority-gas-price` together, with the tip at least the node's `eth_maxPriorityFeePerGas`. The SDK's own writes are not affected: they use viem's `writeContract` with no fee override, and viem's estimate reads `eth_maxPriorityFeePerGas`. Read on the same day, it gives a 1,000,000 wei tip and a 1,000,302 wei max fee.

**Checked after:**

- `cast code` at each address equals `forge inspect <C> deployedBytecode`, byte for byte (BitcoinFacts 8,115 bytes, keccak `0x91ae61ee…000d1`; PopFinality 8,552 bytes, `0xefca12cb…b99d7`; FidelityBonds 10,534 bytes, `0x04a7537d…90d39`).
- `plan()` reports each target `pinned` with code present.
- `./check-live.sh mainnet` used all three deployed contracts ("deployed, using it") and printed `OK: every check passed (bonds facts finality).`, exit 0.
- The SDK accepts the deployed code. `hbf facts check` on the README's fixture, against the deployed BitcoinFacts with no code override: `Ok`, 1,000 sats, unspent, scriptHash `0x805b1e6b…791e`. `hbf finality status --block 5620209` against the deployed PopFinality reads `NotRecorded` and exits 1, as expected on a fresh contract; the receipts SDK side reads 3,380 confirmations.

**Source verification on Blockscout (the same day).**

- **Inputs.** `forge verify-contract … --show-standard-json-input` wrote one solc standard-JSON input per contract to `contracts/verify/`: `BitcoinFacts` (46,638 bytes), `PopFinality` (58,628) and `FidelityBonds` (53,757). Each holds only its own source file and `src/Hvm.sol`, with optimizer 200, `cancun` and metadata `{appendCBOR: false, bytecodeHash: "none"}`. Before anything was submitted, plain solc 0.8.28 (`--standard-json`) compiled each input to the deployed code byte for byte.
- **Submission.** Each file went to its address's `contract-verification` page on `explorer.hemi.xyz`: method "Solidity (Standard JSON input)", compiler `v0.8.28+commit.7893614a`, license MIT. Another contract's file on BitcoinFacts' page was refused, "No contract could be verified with provided data", as it should be.
- **Check.** Blockscout's bytecode database, queried with each address's deployed code (`POST https://eth-bytecode-db.services.blockscout.com/api/v2/bytecodes/sources:search`, `bytecodeType: DEPLOYED_BYTECODE`), returns exactly one source for each: the right contract name, `v0.8.28+commit.7893614a`, the settings above, and source files identical to the repository's. Its match type is `PARTIAL`. Blockscout gives a full match only when the metadata hash embedded in the code matches, and these contracts embed none (D-024), so partial is the best they can get. Every byte of the code matches.

## D-026. First output and balance facts on mainnet (2026-11-22)

Sent from the same account as D-025. The facts are the README's fixture output and the address that holds it:

- output `0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4:0`: 1,000 sats, unspent, 1,888 confirmations, P2WPKH script `0x0014669915…c831`, scriptHash `0x805b1e6b…791e`;
- balance of `bc1qv6v32p9kw0az6lv6mz62famwf5acajp3wyntsa` (the same script): 1,000 sats.

Both are as of Bitcoin block 977,125 (`0x…15a1229b…be4f`). `hbf facts check` gave `Ok` for both, read-only, before anything was sent.

| Fact | Id | Transaction | Block | Gas used | Paid (wei) |
| --- | --- | --- | --- | --- | --- |
| output | `0x5a76b9ef62061ed8d227d642f4b8dc97c49487ee1ed2df45ee24a3c72b1c0113` | `0xd70c81f3115deaf6df01248678b55950dd62d960636f7ebe958f04ac9e09b9ac` | 5794075 | 149,422 | 334,063,151,944 |
| balance | `0xf55d6f08d62e7206bf78867b9fb696e054e03845fae79ef07e97136c54bcb89f` | `0x0f099b76ace7f8a159b1a9154fd3bf2a5597d866376ce97fdf2af88fa6f2bbe1` | 5794076 | 178,935 | 377,363,787,577 |

Total 0.00000071 ETH (about $0.001), roughly half of it L1 data fee. With the SDK's fees (tip 1,000,000 wei) each was mined in the next block. The fact files are `mainnet/output-fact.json` and `mainnet/balance-fact.json`.

**Checked:**

- `hbf facts verify` prints `valid` for both: stored fields, id, the code at the contract, the recording transaction and its event, the canonical block; Hemi stage `latest`.
- `checkOutput` and `checkBalance` by `eth_call` one block before each recording (5,794,074 and 5,794,075) return the same verdict (`Ok`), id and every fact field as the file, with `recorded: false`, so neither fact was stored before its transaction. hVM's Bitcoin height was still 977,125 when this was checked. hVM reads are live whatever block a call is pinned to (D-007), so this agreement does not separate a pinned read from a live one.

## D-027. First keystone checkpoint and publication on mainnet (2026-11-22)

Sent from the same account as D-025, with its key read by the CLI from `.secrets/hemi.key` (`--key-file`).

**Keystone.** 5,793,025, chosen read-only from a block about four hours old: `hbf finality status --block 5793006` on the deployed PopFinality read `NotRecorded`. The receipts SDK found the publication: Bitcoin tx `0x2852bddd3ed0755cd60cfb66509e54f1a4608f87050f0efe40d23161e978eb3a`, output 1, in Bitcoin block 977,107, with 23 confirmations. All 76 bytes equal the keystone rebuilt from Hemi RPC. K was 1,181 blocks old, well inside the 8,191-block window for checkpointing.

**Sent.** One transaction:

```
hbf finality record --keystone 5793025 --btc-txid 0x2852…eb3a --key-file ../.secrets/hemi.key --allow-mainnet
```

- Hemi tx `0x79d4c6822e757d0446d31a933690e402788374fd58fdfd69a8339f9a16a41a38`, block 5,794,231, status 1, three logs.
- 196,027 gas, 0.00000036 ETH in total (364,902,990,804 wei).
- The README planned two transactions, a checkpoint (~52k gas) and a record (~171k). `recordPublication` checkpoints K itself when it is not stored yet (B-4), so one transaction did both.
- The publication fact is `mainnet/publication-fact.json`: id `0xbf89e5edf092b54c02aaddd4d40a524e227ed70def4215dba37634caadb17b30`, as of Bitcoin block 977,127, K's best.

**Checked:**

- `checkpoint(5793025)` is `0x186a67426e76de6ab635c57c`, the first 12 bytes of block 5,793,025's hash.
- `hbf finality verify` prints `valid`: exact match in all 76 bytes, K's best, 23 confirmations at recording and now, `isBtcFinalVia` final.
- `hbf finality status --block 5793006` gives `isBtcFinalVia` true and `isBtcAnchored` true, both with 23 confirmations. The receipts SDK says 23 confirmations via keystone 5,793,025 and the same tx, final true: `agree yes`, `final yes`. Block 5,793,025, K itself, gives the same.
- Block 5,793,026 belongs to keystone 5,793,050, which is not recorded. It stays `NotRecorded`, `final no`, as it should.

## D-028. A mainnet bond: created, recorded, redeemed and ended (2026-11-24 to 2026-11-25)

The code used here passed `regtest/run.sh` 7/7 first: `bond create` and `bond redeem` confirmed, and bitcoind refused a redeem before the locktime.

**Keys and addresses.**

- Bitcoin key: a new one in `.secrets/btc-mainnet.key`, funding address `bc1q99uhslpa4lkq0dxrqgays3keyexnaecud25c5r`.
- Hemi signer: the account of D-025, by `--key-file ../.secrets/hemi.key` (D-027).
- Agent: `0xaA3B6FF39AcB56D96dbE1F8458eF907D4FeE383F`, the hemi-agent-receipts mainnet agent.
- Payout: `bc1qfjsv4mrdv326npv7z3fv7x0gc3cujhax4ehznu`.

**The bond.** 20,000 sats in P2WSH `bc1qefk32n4xx7rwfydlwlftpa7t8lvdwc7g7a3ggcu83vutw930u8msl92u05` (output 0), the tag naming the contract and the agent (output 1), and 5,452 sats change to the funding address (output 2). Locktime 1,795,567,066 (2026-11-25T00:37:46Z), 22.9 hours after the create's block. Bond id `0x35bd78a79e524f8f544badf8ddfa2a4fcd236b09897c20d092d142969b0780c4`. The bond file `mainnet/bond-live.json` is public data: pubkey, witness script, the signed create; no key. The fact file is `mainnet/bond-live.fact.json`.

**Sent,** in order:

| Step | Chain | Transaction | Block | Size | Paid |
| --- | --- | --- | --- | --- | --- |
| create | Bitcoin | `2703bb4e3db81770451b30bfe162903489044de78d9db734e630e59e82cfdd91` | 977,305 | 212 vB | 424 sats (2 sat/vB) |
| record | Hemi | `0xe3c74949cfef057d7771f11e257086a84fec32db7f45425239c6357f76b7543b` | 5,801,699 | 212,464 gas | 638,655,456,498 wei |
| redeem | Bitcoin | `0ac004ec5f399d400f6415652b800fef1abdba06a236d3235d4851d8b0af7a92` | 977,450 | 112 vB | 224 sats (2 sat/vB) |
| refresh | Hemi | `0xb717d315cda5e3263330dd79c7ff1f0c25db020e4135fe1d033163d6b24c9880` | 5,808,907 | 93,215 gas | 198,877,054,980 wei |

In total, 648 sats in Bitcoin fees and 0.00000084 ETH on Hemi (837,532,511,478 wei, about $0.0013). The README's estimate was ~650 sats and ~$0.002.

**Timing.**

- **Record.** `checkBond` needs 6 confirmations in hVM's view, and hVM runs about two blocks behind Bitcoin (D-012 item 2). A first `bond record` stopped at `FewConfirmations`. It was sent once hVM reached 977,310, 8 confirmations by Bitcoin's count.
- **Redeem.** Bitcoin compares the locktime with the median time past, not the clock (C-3). The CLI refused twice, with 1,356 and then 12 more minutes of median time to go. The redeem was broadcast at a median time past of 2026-11-25T00:50:01Z, with the clock about an hour later, and confirmed in block 977,450 at 01:42:58Z. The fee estimate was 1 sat/vB, but the mempool held 28.7 MvB, so the redeem paid 2 sat/vB.
- **Refresh.** Sent after 3 confirmations. `bond status` already said `Ended (spent)` per hVM and "not yet marked on chain" (C-11). The refresh simulated, then sent one transaction with one log.

**Checked:**

- `hbf bond status mainnet/bond-live.fact.json` prints `valid`, status `Ended (spent)`, seen spent at Bitcoin block 977,450 (`0x…01c26db673a3fb4b9708060b4835322f5df07da757d63c`), Hemi block 5,808,907.
- The payout address holds `0ac004ec…7a92:0`, 19,776 sats, in block 977,450 (mempool.space).
- The create's change, `2703bb4e…dd91:2` (5,452 sats), stays at the funding address.

## D-029. The CLI takes keys only from files (2026-11-25)

**Why.** A hidden terminal prompt was seen to show a pasted private key in plain text in one terminal, on the line after each `Hemi private key:` prompt. The cause was not found. In a pseudo-terminal, `promptHidden` echoed nothing for input typed or pasted after the prompt, bracketed paste included. Input that arrives before the prompt switches the terminal to raw mode is echoed by the terminal itself, on a line above the prompt, which is not what was seen. A prompt that can show a key in some terminals is not worth keeping, so keys are read only from files under a `.secrets/` directory. The mainnet transactions in D-027 and D-028 were already signed that way.

**What changed.**

- `promptHidden` is deleted from `sdk/src/common.ts`, along with its `node:readline` import.
- `loadSigner` requires `--key-file`, and `loadBtcKey` requires `--btc-key-file`. Without one, they throw a `UsageError` (exit 2): "`--key-file <path>` is required to sign: a file under a .secrets/ directory holding …; keys are read only from files, never at a prompt". This happens whether or not stdin is a terminal.
- The key file must be inside a directory named `.secrets` (`readSecretPath`); a plain file of that name does not pass (pre-mainnet audit, [SECURITY-AUDIT.md](SECURITY-AUDIT.md)).
- The key is still loaded only when something will be signed. A command that sends nothing still runs without a key file: `bond refresh` on a live bond, or `finality record` on a stored keystone. The mainnet guard still comes first.
- The help text of `facts record`, `finality`, and `bond create | redeem | record | refresh` says "(required to sign; no prompt)". The README and `sdk/src/vendor/x402-btc/VENDOR.md` say the same.

**Tests.**

- `sdk/test/common.test.ts`: with `process.stdin.isTTY` set to true, both loaders reject at once with that message, and `promptHidden` is no longer exported.
- `sdk/test/bond.e2e.test.ts`: a refresh that has something to send and no `--key-file` exits 2 with the new message.

**Not changed:** the contracts and everything deployed. This touches the CLI only.
