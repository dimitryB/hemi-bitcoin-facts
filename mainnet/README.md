# Live records on Hemi mainnet

The first records made with the deployed contracts. Every file is public chain data, in the formats of
[docs/SCHEMA.md](../docs/SCHEMA.md); none holds a key. The [README's Quickstart](../README.md#quickstart) verifies
them from a Hemi RPC alone.

| File | What it records | Recording transaction (Hemi) |
| --- | --- | --- |
| `output-fact.json` | Output `0x43cb…cea4:0`: 1,000 sats to `bc1qv6v32p9kw0az6lv6mz62famwf5acajp3wyntsa`, unspent, as of Bitcoin block 977,125 | [`0xd70c81f3…b9ac`](https://explorer.hemi.xyz/tx/0xd70c81f3115deaf6df01248678b55950dd62d960636f7ebe958f04ac9e09b9ac), block 5,794,075 |
| `balance-fact.json` | That address's balance at the same Bitcoin block: 1,000 sats | [`0x0f099b76…bbe1`](https://explorer.hemi.xyz/tx/0x0f099b76ace7f8a159b1a9154fd3bf2a5597d866376ce97fdf2af88fa6f2bbe1), block 5,794,076 |
| `publication-fact.json` | Keystone 5,793,025, checkpointed, and its PoP publication in Bitcoin transaction `0x2852…eb3a`:1 (Bitcoin block 977,107), both in one transaction | [`0x79d4c682…1a38`](https://explorer.hemi.xyz/tx/0x79d4c6822e757d0446d31a933690e402788374fd58fdfd69a8339f9a16a41a38), block 5,794,231 |
| `bond-live.json` | The bond as `hbf bond create` wrote it: funding transaction, bond address, witness script, tag. Public data, no key | none (a Bitcoin transaction) |
| `bond-live.fact.json` | That bond, recorded: 20,000 sats for agent `0xaa3b…383f`, locktime 2026-11-25T00:37:46Z | [`0xe3c74949…543b`](https://explorer.hemi.xyz/tx/0xe3c74949cfef057d7771f11e257086a84fec32db7f45425239c6357f76b7543b), block 5,801,699 |

The bond went through its whole life on mainnet:
1. It was funded in Bitcoin transaction
   [`2703bb4e…dd91`](https://mempool.space/tx/2703bb4e3db81770451b30bfe162903489044de78d9db734e630e59e82cfdd91), in
   block 977,305.
2. It was recorded once hVM showed 6 confirmations.
3. It was redeemed to its owner in
   [`0ac004ec…7a92`](https://mempool.space/tx/0ac004ec5f399d400f6415652b800fef1abdba06a236d3235d4851d8b0af7a92), in
   block 977,450, once Bitcoin's median time past had passed the locktime.
4. It was marked ended by `refresh` in Hemi block 5,808,907.

`hbf bond status mainnet/bond-live.fact.json` reports it `Ended (spent)`. [docs/DECISIONS.md](../docs/DECISIONS.md)
D-026 to D-028 have what each record cost and what was checked.
