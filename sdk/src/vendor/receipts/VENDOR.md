# Vendored: hemi-agent-receipts SDK

Source: https://github.com/dimitryB/hemi-agent-receipts, `sdk/src/`, commit
`7221887ae560658b5164a01efd3da3c5f52e1187` (main, 2026-11-19).

Every `.ts` file here is a byte-for-byte copy of that commit's `sdk/src/` (the whole directory, so the
transitive imports of `keystone.ts`, `finality.ts`, `bitcoin.ts` and `client.ts` resolve unchanged).
That SDK is not published on npm, which is why it is vendored. Do not edit these files; wrap them
from `sdk/src/` instead. `LICENSE` is hemi-agent-receipts' MIT licence at the same commit, which MIT asks to keep
with the copy. Check with:

```bash
for f in sdk/src/vendor/receipts/*.ts; do git -C ../hemi-agent-receipts show 7221887:sdk/src/$(basename $f) | cmp - $f; done
```

What this project uses:

- `client.ts`: `createHemiPublicClient` (fallback RPCs, retry with backoff, 4 requests a second token bucket),
  `withRetry`, `pollTransactionReceipt`.
- `chains.ts`: Hemi mainnet and testnet definitions, `chainFor` for anvil.
- `keystone.ts`: keystone period, abbreviated keystone layout, PoP OP_RETURN encode/decode.
- `finality.ts`: the Esplora client and the receipts SDK's PoP finality reader (the reference that
  `PopFinality.isBtcFinal` is compared against).
- `bitcoin.ts`: raw-block helpers used by `finality.ts`.
