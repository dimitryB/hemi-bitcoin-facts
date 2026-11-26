# Security

## Status

This is experimental software. The three contracts are live on Hemi mainnet, and they have recorded a handful of
facts and one 20,000-sat bond ([`mainnet/`](mainnet/README.md)).

[docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md) records every review and audit done before deployment, each finding,
and what was done about it:

- The internal reviews were done by AI agents with fresh context. Treat them as careful reads, not as a third-party
  audit.
- Two audits added findings, every one fixed or documented: the independent audit and the pre-mainnet audit.

Use it with keys and amounts you can afford to lose.

## Reporting a vulnerability

Please report privately, not in a public issue: use **Report a vulnerability** under this repository's Security tab
(GitHub private vulnerability reporting). Say what is affected, how to reproduce it, and what an attacker gains. This
is a small project, so a reply can take a few days. There is no bug bounty.

## In scope

- **The contracts on Hemi mainnet** (chain 43111): `BitcoinFacts` at `0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC`,
  `PopFinality` at `0x0706C1582E7C27c09953803384396efd4fa62486` and `FidelityBonds` at
  `0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e`, and the `Hvm.sol` library they share. They are ownerless and not
  upgradeable, and they hold no funds. In scope is anything that:
  - records a fact hVM did not give;
  - reports an output spent, or a bond live, when it is not;
  - makes `isBtcFinalVia` true without a matching Proof-of-Proof publication;
  - lets a bond name an agent that its funding transaction does not tag.
- **The SDK and the `hbf` CLI** (`sdk/`). Above all, anything that:
  - makes `verify` call a fact valid when it is not;
  - makes `finality status` report a block final when it is not;
  - makes `bond create` or `bond redeem` build a transaction that loses funds;
  - puts a key or an RPC credential in output or logs.
- **A secret committed to this repository.**

## Out of scope here

- **Hemi itself:** its consensus, hVM and op-geth, its RPCs, and the Bitcoin Esplora APIs the SDK reads. Report those
  to their maintainers. So are bugs in the vendored code (`sdk/src/vendor/`) that also exist upstream: see its
  `VENDOR.md` files.
- **Documented limits:** the ones in the README's first section and in "Limits", unless you can show they are worse
  than described. That covers `isBtcAnchored`, which a forged keystone can satisfy for one Bitcoin fee.
- **Development keys and passwords:**
  - The keys in the tests and test helpers are anvil's published development keys, and the `forge-std` ones are its
    own test vectors.
  - The regtest RPC password in `regtest/` (`hbf-regtest-only`) is used only on a local bitcoind.

## Keys

The CLI reads a signing key only from a file inside a `.secrets/` directory, which git ignores (`--key-file`,
`--btc-key-file`). It never takes one from arguments, the environment or a prompt (docs/DECISIONS.md D-029), and never
prints one.

Sending a transaction on Hemi mainnet needs `--allow-mainnet`. Deploying needs `CONFIRM_MAINNET_DEPLOY=yes`.

A bond's key is the bond: whoever holds it can spend the BTC after the locktime.
