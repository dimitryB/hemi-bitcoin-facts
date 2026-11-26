#!/usr/bin/env bash
# Delta review: Deploy.s.sol's pin check and mainnet confirmation run only in run(); deployAll(bool) broadcasts
# without either. LOCAL ANVIL ONLY: start one first, with Hemi mainnet's chain id, e.g.
#   anvil --port 18546 --chain-id 43111
# then: bash contracts/test/review/delta/deploy-bypass.sh http://127.0.0.1:18546
# It refuses any RPC that is not a local anvil. It uses anvil's unlocked first account (no key is read or passed).
# The non-default build goes to a temporary directory, so contracts/out and contracts/broadcast are untouched.
set -euo pipefail
RPC=${1:?usage: deploy-bypass.sh http://127.0.0.1:<anvil port>}
case "$RPC" in http://127.0.0.1:* | http://localhost:*) ;; *) echo "refusing: not a local RPC: $RPC" >&2; exit 1 ;; esac
cast rpc web3_clientVersion --rpc-url "$RPC" | grep -qi anvil || { echo "refusing: not anvil" >&2; exit 1; }
echo "chain id: $(cast chain-id --rpc-url "$RPC")"
cd "$(dirname "$0")/../../.."   # contracts/

DEPLOYER=0x4e59b44847b379578588920cA78FbF26c0B4956C
if [ "$(cast code "$DEPLOYER" --rpc-url "$RPC")" = "0x" ]; then
  # Arachnid's deterministic deployer runtime (as Deploy.checkDeployer expects), on this local anvil only.
  cast rpc anvil_setCode "$DEPLOYER" 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3 --rpc-url "$RPC" > /dev/null
fi

TMP=$(mktemp -d)
export FOUNDRY_OUT="$TMP/out" FOUNDRY_CACHE_PATH="$TMP/cache" FOUNDRY_BROADCAST="$TMP/broadcast"
# A build other than the pinned one: CBOR metadata on (what the removed `verify` profile did).
export FOUNDRY_CBOR_METADATA=true FOUNDRY_BYTECODE_HASH=ipfs
unset CONFIRM_MAINNET_DEPLOY
SENDER=$(cast rpc eth_accounts --rpc-url "$RPC" | tr -d '[]" ' | cut -d, -f1)

echo
echo "== 1a. run() --broadcast with that build, no CONFIRM_MAINNET_DEPLOY (as designed: refused)"
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --unlocked --sender "$SENDER" 2>&1 \
  | grep -E "^Error" || true
echo "== 1b. the same with CONFIRM_MAINNET_DEPLOY=yes (as designed: the pin check refuses it)"
CONFIRM_MAINNET_DEPLOY=yes forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --unlocked \
  --sender "$SENDER" 2>&1 | grep -E "^Error" || true

echo
echo "== 2. --sig 'deployAll(bool)' true --broadcast with the same build, no CONFIRM_MAINNET_DEPLOY"
forge script script/Deploy.s.sol --sig 'deployAll(bool)' true --rpc-url "$RPC" --broadcast --unlocked \
  --sender "$SENDER" 2>&1 | tee "$TMP/step2.txt" | grep -E "\[deploy\]|\[skip\]|ONCHAIN EXECUTION COMPLETE|Error" || true

echo
echo "== 3. code at the pinned (documented) addresses and at the ones step 2 used"
for a in 0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC 0x0706C1582E7C27c09953803384396efd4fa62486 \
  0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e; do
  echo "pinned $a code bytes: $(( ($(cast code "$a" --rpc-url "$RPC" | wc -c) - 3) / 2 ))"
done
for a in $(grep -oE "\[deploy\] [A-Za-z]+ -> 0x[0-9a-fA-F]{40}" "$TMP/step2.txt" | awk '{print $4}'); do
  echo "step 2 $a code bytes: $(( ($(cast code "$a" --rpc-url "$RPC" | wc -c) - 3) / 2 ))"
done
rm -rf "$TMP"
