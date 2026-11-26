# Contributing

Issues and pull requests are welcome. This is a small, experimental project ([what it proves and its
limits](README.md)), so a reply can take a few days.

- **Security vulnerabilities:** do not open an issue. Report them privately, as [SECURITY.md](SECURITY.md) describes.
- **Bugs in the vendored code** (`sdk/src/vendor/`): if a bug is also in the upstream project at the vendored commit,
  it belongs there. Each directory's `VENDOR.md` names the source and commit.

## Setup

You need:
- Node 22.18 or newer;
- [Foundry](https://getfoundry.sh) (`forge`, `cast`, `anvil`);
- `jq` and `curl`;
- Docker, for the regtest gate.

Nothing below needs a key, an account or funds.

```sh
(cd contracts && forge build && forge test --no-match-contract ForkTest)  # unit, fuzz, review and audit suites, offline
(cd sdk && npm ci && npx tsc --noEmit -p . && HBF_E2E_NO_FORK=1 npm test)  # SDK and CLI; e2e on a local anvil
regtest/run.sh                                                    # bond create and redeem on bitcoind regtest (Docker)
```

These read Hemi mainnet through its public RPC, which allows about 300 requests a minute, so run them one at a time:

```sh
(cd contracts && forge test --match-contract ForkTest -j 1)  # the fork suites
(cd sdk && npm test)                                         # the e2e tests on an anvil fork of Hemi mainnet
./check-live.sh mainnet                                      # every contract against mainnet's hVM, by eth_call
```

`sdk/package-lock.json` pins every package, so `npm ci` installs exactly what CI tests (docs/DECISIONS.md D-016).

## CI

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the first block on every pull request and on every push to `main`. The
three jobs are contracts, sdk and regtest.

The second block runs weekly and when started by hand, not on pull requests, because the public RPC's limit is
shared. If your change touches what it covers, run it locally and say so in the pull request.

## Rules for a change

- **No live-network transactions in tests, or in scripts that run by default.** Tests use anvil, with its published
  development keys, and bitcoind regtest. Anything that can send to Hemi mainnet stays behind an explicit switch, as
  it is today: `--allow-mainnet` for the CLI and `CONFIRM_MAINNET_DEPLOY=yes` for the deploy script.
- **No secrets in the repository.** Keys go only in files under a `.secrets/` directory, which git ignores, and the
  CLI reads them only from there.
- **Contracts:** `contracts/src` and `contracts/script/Deploy.s.sol` are the source of the deployed contracts.
  - Their init-code hashes are pinned (docs/DECISIONS.md D-024), and their addresses move with any byte. A change there
    means a new deployment at new addresses, so open an issue first.
  - The Solidity files keep their `SPDX-License-Identifier: MIT` headers.
- **Vendored code** is not edited here:
  - `sdk/src/vendor/receipts` is a byte-for-byte copy of its upstream.
  - `sdk/src/vendor/x402-btc` lists its few edits in its `VENDOR.md`.
  - `contracts/lib/forge-std` is third-party.
- **Behaviour changes come with their documentation:**
  - the README;
  - [docs/SCHEMA.md](docs/SCHEMA.md) where fact files change;
  - for larger design choices, a dated entry in [docs/DECISIONS.md](docs/DECISIONS.md) with the commands that were run and
    what they printed.
- Say in the pull request how you checked the change.

## Licence of contributions

Unless you say otherwise, anything you submit for inclusion is licensed under the [MIT License](LICENSE), without
additional terms. The vendored directories keep their own licences (README, "License").
