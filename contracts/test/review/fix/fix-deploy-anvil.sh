#!/usr/bin/env bash
# Fix review: Deploy.s.sol's broadcast guard end to end. LOCAL ANVIL ONLY. Start one with Hemi mainnet's
# chain id first, e.g.
#   anvil --port 18611 --chain-id 43111
# then: bash contracts/test/review/fix/fix-deploy-anvil.sh http://127.0.0.1:18611
# It refuses any RPC that is not a local anvil, uses anvil's unlocked first account (no key is read or passed), and
# builds into a temporary directory, so contracts/out, contracts/cache and contracts/broadcast are untouched.
set -euo pipefail
RPC=${1:?usage: fix-deploy-anvil.sh http://127.0.0.1:<anvil port>}
case "$RPC" in http://127.0.0.1:* | http://localhost:*) ;; *) echo "refusing: not a local RPC: $RPC" >&2; exit 1 ;; esac
cast rpc web3_clientVersion --rpc-url "$RPC" | grep -qi anvil || { echo "refusing: not anvil" >&2; exit 1; }
CHAIN=$(cast chain-id --rpc-url "$RPC")
echo "anvil chain id: $CHAIN"
[ "$CHAIN" = 43111 ] || { echo "start anvil with --chain-id 43111" >&2; exit 1; }
cd "$(dirname "$0")/../../.."   # contracts/

DEPLOYER=0x4e59b44847b379578588920cA78FbF26c0B4956C
if [ "$(cast code "$DEPLOYER" --rpc-url "$RPC")" = "0x" ]; then
  cast rpc anvil_setCode "$DEPLOYER" 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3 --rpc-url "$RPC" > /dev/null
fi
PINNED="0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC 0x0706C1582E7C27c09953803384396efd4fa62486 0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e"
SENDER=$(cast rpc eth_accounts --rpc-url "$RPC" | tr -d '[]" ' | cut -d, -f1)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
unset CONFIRM_MAINNET_DEPLOY

state() { # nonce of the sender, and code bytes at each pinned address
  local s="nonce $(cast nonce "$SENDER" --rpc-url "$RPC"); code"
  for a in $PINNED; do s="$s $(( ($(cast code "$a" --rpc-url "$RPC" | wc -c) - 3) / 2 ))"; done
  echo "$s"
}
fs() { # forge script with a build directory per profile; prints the lines that matter
  local tag=$1; shift
  FOUNDRY_OUT="$TMP/out-$BUILD" FOUNDRY_CACHE_PATH="$TMP/cache-$BUILD" FOUNDRY_BROADCAST="$TMP/broadcast-$tag" \
    forge script script/Deploy.s.sol --rpc-url "$RPC" "$@" 2>&1 | tee "$TMP/$tag.log" \
    | grep -E "^ *chain id:|^ *mode:|^ *PLAN |\[deploy\]|\[skip\]|script failed|ONCHAIN EXECUTION|No transactions|SIMULATION COMPLETE|Transactions saved" \
    | grep -v "console::log" | sed -E 's/^ +/    /' || true
  echo "    -> $(state)"
}

echo "start: $(state)"
BUILD=pinned
echo
echo "== A. the pinned build (default profile)"
echo "-- A1 plan()"; fs a1 --sig 'plan()'
echo "-- A2 run(), simulation, no CONFIRM_MAINNET_DEPLOY (expected: works, sends nothing)"; fs a2
echo "-- A3 run() --broadcast, no CONFIRM (expected: refused)"; fs a3 --broadcast --unlocked --sender "$SENDER"
echo "-- A4 deployAll(true) --broadcast, no CONFIRM (expected: refused)"
fs a4 --sig 'deployAll(bool)' true --broadcast --unlocked --sender "$SENDER"
echo "-- A5 deployAll(false) --broadcast, no CONFIRM (expected: nothing sent)"
fs a5 --sig 'deployAll(bool)' false --broadcast --unlocked --sender "$SENDER"
echo "-- A6 CONFIRM=no run() --broadcast (expected: refused)"
CONFIRM_MAINNET_DEPLOY=no fs a6 --broadcast --unlocked --sender "$SENDER"
echo "-- A7 run() --broadcast --chain 1, no CONFIRM: block.chainid overridden in the script, RPC is 43111"
SNAP=$(cast rpc evm_snapshot --rpc-url "$RPC" | tr -d '"')
fs a7 --broadcast --unlocked --sender "$SENDER" --chain 1
for f in "$TMP"/broadcast-a7/Deploy.s.sol/*/run-latest.json; do
  [ -f "$f" ] && echo "    broadcast file: ${f#"$TMP"/} tx chainIds: $(grep -oE '"chainId": *"?0x[0-9a-f]+"?' "$f" | sort -u | tr '\n' ' ')"
done
for h in $(grep -oE '"transactionHash": *"0x[0-9a-f]{64}"' "$TMP"/broadcast-a7/Deploy.s.sol/*/run-latest.json 2>/dev/null | grep -oE '0x[0-9a-f]{64}' | sort -u); do
  echo "    mined $h chainId $(cast tx "$h" chainId --rpc-url "$RPC")"
done
echo "-- A8 the same with --sig 'deployAll(bool)' true --chain 743111 (testnet's id)"
cast rpc evm_revert "$SNAP" --rpc-url "$RPC" > /dev/null
SNAP=$(cast rpc evm_snapshot --rpc-url "$RPC" | tr -d '"')
fs a8 --sig 'deployAll(bool)' true --broadcast --unlocked --sender "$SENDER" --chain 743111
cast rpc evm_revert "$SNAP" --rpc-url "$RPC" > /dev/null
echo "-- A9 run() --broadcast with FOUNDRY_CHAIN_ID=743111 in the environment (no flag), no CONFIRM"
SNAP=$(cast rpc evm_snapshot --rpc-url "$RPC" | tr -d '"')
FOUNDRY_CHAIN_ID=743111 fs a9 --broadcast --unlocked --sender "$SENDER"
cast rpc evm_revert "$SNAP" --rpc-url "$RPC" > /dev/null
echo "    reverted the anvil to before A7: $(state)"

echo
echo "== B. a build other than the pinned one (CBOR metadata on)"
BUILD=cbor
export FOUNDRY_CBOR_METADATA=true FOUNDRY_BYTECODE_HASH=ipfs
echo "-- B1 plan()"; fs b1 --sig 'plan()'
echo "-- B2 run(), simulation (expected: refused by the pin check)"; fs b2
echo "-- B3 CONFIRM=yes deployAll(true) --broadcast (expected: refused by the pin check)"
CONFIRM_MAINNET_DEPLOY=yes fs b3 --sig 'deployAll(bool)' true --broadcast --unlocked --sender "$SENDER"
echo "-- B4 deployAll(false), simulation (no guard; shows the non-pinned addresses, sends nothing)"
fs b4 --sig 'deployAll(bool)' false
unset FOUNDRY_CBOR_METADATA FOUNDRY_BYTECODE_HASH

echo
echo "== C. the pinned build, confirmed"
BUILD=pinned
echo "-- C1 CONFIRM=yes run() --broadcast (expected: deploys at the pinned addresses, or skips)"
CONFIRM_MAINNET_DEPLOY=yes fs c1 --broadcast --unlocked --sender "$SENDER"
echo "-- C2 plan() (expected: code present 1, pinned)"; fs c2 --sig 'plan()'
echo "-- C3 deployAll(true) --broadcast, no CONFIRM, everything deployed (expected: still refused)"
fs c3 --sig 'deployAll(bool)' true --broadcast --unlocked --sender "$SENDER"
