# Vendored: x402facilitator `btc/src/`

Source: https://github.com/dimitryB/x402facilitator, `btc/src/`, commit
`4a26ad72fdee6b32198c7b77d3378017036a4bfc` (main, HEAD on 2026-11-21).

The brief (docs/BRIEF.md "Bitcoin side") says to reuse `btc/src/wallet.ts` and its Esplora client. That package is
not on npm, so the files are copied here. x402facilitator is licensed under the Apache License 2.0, Copyright 2026
Dimitry B and Neva Technologies Inc; `LICENSE` in this directory is its license text, and these three files keep that
license. `NOTICE` carries the attribution from x402facilitator's own NOTICE at that commit, as section 4(d) asks. As section 4(b) asks, every modified file starts with a `MODIFIED by hemi-bitcoin-facts` comment, and every
edit is listed below.

| File | Source SHA-256 | State |
| --- | --- | --- |
| `networks.ts` | `9815ab5ac54b2a24bddc3a12c5cc351f2e71e73ee904bf5669238b4e6cfd5ce2` | byte-for-byte copy |
| `wallet.ts` | `7580a29ef66a1c6071bbbdb6d408f6d0d5fe60d0e33d3bc8a9bdced4bf4b1e7b` | modified (below) |
| `derive.ts` | `c7773c11dfcdd6bc85b601600021130cfbd9861a4b1c3381ce41fa3e52dbdc60` | modified (below) |

Check the unmodified file, and see the edits, with:

```bash
cd ../x402facilitator && git show 4a26ad72:btc/src/networks.ts | cmp - ../hemi-bitcoin-facts/sdk/src/vendor/x402-btc/networks.ts
git show 4a26ad72:btc/src/wallet.ts | diff - ../hemi-bitcoin-facts/sdk/src/vendor/x402-btc/wallet.ts
git show 4a26ad72:btc/src/derive.ts | diff - ../hemi-bitcoin-facts/sdk/src/vendor/x402-btc/derive.ts
```

## Edits

`wallet.ts`

1. Added the two-line `MODIFIED` header.
2. Removed the imports of `@scure/bip32` (`HDKey`) and `@scure/bip39` (`mnemonicToSeedSync`, `validateMnemonic`,
   `wordlist`) and the method that used them, `BtcWallet.fromMnemonic`. This project takes a single key from a
   `.secrets/` file, and does not declare those two packages.
3. Replaced `import type { BtcOutputRef, BtcPayer, PayBtcContext } from "./client.js"` with local definitions of the
   three types. `client.ts` imports `@x402/core/types`, which this project does not depend on. `BtcOutputRef` and
   `BtcPayer` are as in `client.ts`; `PayBtcContext` is cut to its `network` field, the only one `wallet.ts` reads.
4. `EsploraClient.feeRate`: `estimates[String(keys[0])]` became `estimates[String(keys[0])]!`. This project compiles
   with `noUncheckedIndexedAccess`. The key comes from the object's own keys, so the behaviour is unchanged.

`derive.ts`

1. Added the two-line `MODIFIED` header.
2. Removed `parseAccountXpub` and `derivePaymentAddress` (x402's xpub-derived payment addresses), the
   `@scure/bip32` import they needed, and `SLIP132_PREFIXES` from the `./networks.js` import. What remains
   (`AddressType`, `isAddressType`, `scriptForPubkey`, the payment-id helpers) is unchanged.

`networks.ts`: no edits.

## What this project uses

- `wallet.ts`: `EsploraClient` (UTXOs, fee estimates, tx status, tip height, broadcast), `selectLargestFirst`
  (coin selection), `VSIZE` and `DUST` (fee estimation and dust limits), and the signing pattern of
  `buildPaymentFrom`. `BtcWallet` itself is not used: `sdk/src/btc/tx.ts` builds the two-output funding
  transaction (bond and tag) that `buildPaymentFrom`, a one-payment builder, cannot.
- `derive.ts`: `AddressType` and `isAddressType`.

The rest of the bond tooling (scripts, the redeem transaction, the bitcoind backend, Esplora rotation and pacing) is
this project's own code in `sdk/src/btc/`.
