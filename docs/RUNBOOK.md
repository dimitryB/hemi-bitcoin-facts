# Runbook

Deploying the contracts, verifying their source, and recording facts and bonds on Hemi mainnet. The contracts are
already deployed at the addresses in the [README](../README.md); this is what was run, and what to run for a
deployment of your own.

Nothing here is needed to verify a fact: `hbf … verify` needs only an RPC URL and a contract address.

## 1. Keys

Keys live in files under a `.secrets/` directory, which git ignores. The CLI reads them only from there
(`--key-file` for Hemi, `--btc-key-file` for Bitcoin), never from arguments, the environment or a prompt, and never
prints them (D-029). Create them without echoing them:

```bash
mkdir -m 700 -p .secrets
(umask 077 && cast wallet new --json > .secrets/hemi.json)
(umask 077 && jq -r '.. | .private_key? // empty' .secrets/hemi.json > .secrets/hemi.key)   # 0x + 64 hex
jq -r '.. | .address? // empty' .secrets/hemi.json                                          # its address, to fund
```

A Bitcoin key file holds the key as WIF or hex. A Hemi key needs only gas: recording a fact costs about $0.001. The
key that funds a bond controls it: whoever holds the bond key can spend the bond after its locktime.

## 2. Deploy

The contracts have no constructor and no owner. `contracts/script/Deploy.s.sol` deploys each by CREATE2 through
Arachnid's deterministic deployer, and pins each contract's init-code hash (D-024). So the same build lands at the
same addresses on any chain that has the deployer, and another build lands elsewhere: the addresses move with any
byte of the contracts or `Hvm.sol`. Build with the default profile (no CBOR metadata), or the hashes will not match.

These are the steps, as run for mainnet. Only the last command sends anything. On the deployed addresses `plan()`
shows code present, and a rerun skips all three.

```bash
cd contracts
forge script script/Deploy.s.sol --sig 'plan()' --rpc-url https://rpc.hemi.network/rpc    # addresses; each build "pinned"
forge script script/Deploy.s.sol --rpc-url https://rpc.hemi.network/rpc                   # simulation, nothing sent
CONFIRM_MAINNET_DEPLOY=yes forge script script/Deploy.s.sol --sig 'deployAll(bool)' true \
  --rpc-url https://rpc.hemi.network/rpc --sender <deployer>                              # preview: transactions and gas, nothing sent
CONFIRM_MAINNET_DEPLOY=yes forge script script/Deploy.s.sol --rpc-url https://rpc.hemi.network/rpc --broadcast --slow \
  --with-gas-price 2000000 --priority-gas-price 1000000 <signer flags>
```

**Pass the fee flags on Hemi.** Forge's own estimate there is a 1 wei tip, and a transaction priced that way sat
unmined for 20 minutes (D-025). The node's `eth_maxPriorityFeePerGas` is 1,000,000 wei (0.001 gwei).
`--priority-gas-price` alone fails, because forge's estimated max fee (about 505 wei) is lower than the tip.

**The guard.** Every run that can record or send deployments (a dry run of `deployAll(true)`, or a broadcast)
checks three things:
- that the build is the pinned one;
- that `block.chainid` is the RPC's own chain id, so `--chain` or `FOUNDRY_CHAIN_ID` cannot skip the confirmation;
- on Hemi mainnet, that `CONFIRM_MAINNET_DEPLOY=yes` is set.

**`forge script --resume` does not run the script.** It sends whatever sequence an earlier run recorded, to the RPC
that run used. The preview step records one under `contracts/broadcast/Deploy.s.sol/43111/dry-run/`, so delete that
directory after previewing, unless you mean to send exactly that sequence:

```bash
rm -rf contracts/broadcast/Deploy.s.sol/43111/dry-run
```

The mainnet deployment used 1,811,869, 1,906,713 and 2,335,573 gas, in blocks 5,793,795 to 5,793,797. It cost
0.0000378 ETH (about $0.06), mostly the L1 data fee (D-025).

## 3. Verify the source on Blockscout

`contracts/verify/` holds one solc standard-JSON input per contract, written by `forge verify-contract …
--show-standard-json-input`. Each holds only its own source file and `src/Hvm.sol`, with optimizer 200, `cancun`
and metadata `{appendCBOR: false, bytecodeHash: "none"}`. Before submitting, check that plain solc 0.8.28 compiles
each one to the deployed code byte for byte:

```bash
solc --standard-json contracts/verify/BitcoinFacts.standard-input.json | jq -r '.contracts."src/BitcoinFacts.sol".BitcoinFacts.evm.deployedBytecode.object'
cast code 0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC --rpc-url https://rpc.hemi.network/rpc   # the same hex, with 0x
```

Submit each file on its address's `contract-verification` page on explorer.hemi.xyz:
- method "Solidity (Standard JSON input)";
- compiler `v0.8.28+commit.7893614a`;
- license MIT.

Blockscout reports a partial match. That is the best it gives code with no embedded metadata hash, and every byte of
the code matches. Blockscout's bytecode database confirms it: `POST
https://eth-bytecode-db.services.blockscout.com/api/v2/bytecodes/sources:search` with the deployed code returns
exactly one source per contract.

## 4. Record facts and keystones

Every command below simulates by `eth_call` first, and sends nothing unless the contract would accept the record and
it is new. Each needs `--allow-mainnet` on Hemi mainnet, and a key file.

```bash
RPC=https://rpc.hemi.network/rpc
FACTS=0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC POP=0x0706C1582E7C27c09953803384396efd4fa62486

hbf facts check  --rpc $RPC --contract $FACTS --txid <txid> --vout <n>                      # preview, sends nothing
hbf facts record --rpc $RPC --contract $FACTS --txid <txid> --vout <n> \
  --key-file .secrets/hemi.key --allow-mainnet --out output-fact.json
hbf facts record --rpc $RPC --contract $FACTS --address <btc address> \
  --key-file .secrets/hemi.key --allow-mainnet --out balance-fact.json

hbf finality record --keystone <K> --rpc $RPC --contract $POP \
  --key-file .secrets/hemi.key --allow-mainnet --out publication-fact.json                  # finds the PoP tx via Esplora
hbf finality watch  --rpc $RPC --contract $POP --dry-run                                    # what a watcher would send
```

`finality record` checkpoints K in the same transaction if it is not yet. A keystone can be checkpointed only within
8,191 blocks (about 27 hours) of being cut. `finality watch` without `--dry-run` checkpoints every new keystone and
records each exact-match publication. On mainnet it costs about $0.14 to $0.33 a day.

On mainnet, a fact cost about 150k to 180k gas, about $0.001. A checkpoint with its publication cost 196k gas
(D-026, D-027).

## 5. Create, record, redeem and end a bond

A bond goes through Bitcoin and Hemi in turn, and each wait is set by Bitcoin:

```bash
BONDS=0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e

# 1. Lock BTC for an agent. Write the bond file first; --dry-run builds and signs without broadcasting.
hbf bond create --agent <0x agent> --sats 20000 --lock-for 23h --rpc $RPC \
  --btc-key-file .secrets/btc-mainnet.key --out bond.json --dry-run
hbf bond create --agent <0x agent> --sats 20000 --lock-for 23h --rpc $RPC \
  --btc-key-file .secrets/btc-mainnet.key --out bond.json --allow-mainnet

# 2. Once hVM counts 6 confirmations, about an hour after the funding transaction is mined:
hbf bond record --rpc $RPC --contract $BONDS --bond-file bond.json \
  --key-file .secrets/hemi.key --allow-mainnet --out bond.fact.json

# 3. About an hour after the locktime, once Bitcoin's median time past has passed it:
hbf bond redeem --bond-file bond.json --to <btc address> --btc-key-file .secrets/btc-mainnet.key --dry-run
hbf bond redeem --bond-file bond.json --to <btc address> --btc-key-file .secrets/btc-mainnet.key --allow-mainnet

# 4. Once hVM sees the redeem spent the bond:
hbf bond refresh --rpc $RPC --contract $BONDS --bond-file bond.json --key-file .secrets/hemi.key --allow-mainnet
hbf bond status bond.fact.json --rpc $RPC --contract $BONDS                                 # Ended (spent)
```

- **`bond create` checks the registry before it reads any key.** With `--rpc`, the code at the FidelityBonds address
  the tag will name must be this SDK's build.
- **On Bitcoin mainnet it refuses more than 20,000 sats, or a locktime more than 24 hours ahead,** unless
  `--override-caps`.
- **`bond redeem` refuses before the median time past passes the locktime,** before anything is sent.
- **`bond refresh` sends nothing, and asks for no key, while the bond is unspent** or hVM cannot say.

The mainnet bond in `mainnet/` took about 25 hours end to end. It cost 648 sats in Bitcoin fees at 2 sat/vB, and
0.00000084 ETH on Hemi (D-028).
