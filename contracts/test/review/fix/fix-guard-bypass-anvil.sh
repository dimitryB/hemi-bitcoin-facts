#!/usr/bin/env bash
# Fix review follow-up (F-1, F-2): ways left to send Deploy.s.sol's transactions to chain 43111 without the confirmation.
# LOCAL ANVIL ONLY. Each section wants its own fresh anvil (identical transactions replayed after an evm_revert keep
# their old hashes, which confuses a resume), e.g.
#   anvil --port 18621 --chain-id 43111     then  bash fix-guard-bypass-anvil.sh http://127.0.0.1:18621 D1
#   anvil --port 18622 --chain-id 43111     then  bash fix-guard-bypass-anvil.sh http://127.0.0.1:18622 D3
#   anvil --port 18623 --chain-id 43111     then  bash fix-guard-bypass-anvil.sh http://127.0.0.1:18623 D5
#   anvil --port 18624 --chain-id 43111     then  bash fix-guard-bypass-anvil.sh http://127.0.0.1:18624 E
#   anvil --port 18625 --chain-id 743111    then  bash fix-guard-bypass-anvil.sh http://127.0.0.1:18625 T
# Refuses any RPC that is not a local anvil; uses anvil's unlocked first account (no key is read or passed); builds
# and writes broadcast files in a temporary directory.
set -euo pipefail
RPC=${1:?usage: fix-guard-bypass-anvil.sh http://127.0.0.1:<anvil port> D1|D3|D5|E|T}
PART=${2:?section: D1, D3, D5, E or T}
case "$RPC" in http://127.0.0.1:* | http://localhost:*) ;; *) echo "refusing: not a local RPC: $RPC" >&2; exit 1 ;; esac
cast rpc web3_clientVersion --rpc-url "$RPC" | grep -qi anvil || { echo "refusing: not anvil" >&2; exit 1; }
CHAIN=$(cast chain-id --rpc-url "$RPC")
WANT=43111; [ "$PART" = T ] && WANT=743111
[ "$CHAIN" = "$WANT" ] || { echo "section $PART wants anvil --chain-id $WANT (got $CHAIN)" >&2; exit 1; }
[ "$(cast nonce "$(cast rpc eth_accounts --rpc-url "$RPC" | tr -d '[]" ' | cut -d, -f1)" --rpc-url "$RPC")" = 0 ] \
  || { echo "use a fresh anvil" >&2; exit 1; }
cd "$(dirname "$0")/../../.."   # contracts/

PINNED="0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC 0x0706C1582E7C27c09953803384396efd4fa62486 0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e"
SENDER=$(cast rpc eth_accounts --rpc-url "$RPC" | tr -d '[]" ' | cut -d, -f1)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export FOUNDRY_OUT="$TMP/out" FOUNDRY_CACHE_PATH="$TMP/cache" FOUNDRY_BROADCAST="$TMP/broadcast"
unset CONFIRM_MAINNET_DEPLOY FOUNDRY_CHAIN_ID

state() {
  local s="nonce $(cast nonce "$SENDER" --rpc-url "$RPC"); code"
  for a in $PINNED; do s="$s $(( ($(cast code "$a" --rpc-url "$RPC" | wc -c) - 3) / 2 ))"; done
  echo "$s"
}
fs() { # tag, then forge script args
  local tag=$1; shift
  forge script script/Deploy.s.sol --rpc-url "$RPC" "$@" > "$TMP/$tag.log" 2>&1 || true
  grep -E "^ *chain id:|^ *mode:|RPC eth_chainId|\[deploy\]|\[skip\]|script failed|ONCHAIN EXECUTION|No transactions|SIMULATION COMPLETE|Transactions saved|Error" "$TMP/$tag.log" \
    | grep -v "console::log" | grep -v "Failed to decode return value" | sed -E "s#(/private)?$TMP/##g; s/^ +//; s/^/    /" || true
  echo "    -> $(state)"
}
files() { if [ -d "$FOUNDRY_BROADCAST" ]; then (cd "$FOUNDRY_BROADCAST" && find . -name '*.json' | sort | sed 's/^/    file: /'); else echo "    (no broadcast files)"; fi; }
mined() { for f in "$FOUNDRY_BROADCAST"/Deploy.s.sol/*/*-latest.json; do [ -f "$f" ] || continue
  for h in $(grep -oE '"(transactionHash|hash)": *"0x[0-9a-f]{64}"' "$f" | grep -oE '0x[0-9a-f]{64}' | sort -u); do
    echo "    mined $h chainId $(cast tx "$h" chainId --rpc-url "$RPC" 2>/dev/null || echo '?')"; done; done; }

echo "anvil chain id $CHAIN, start: $(state)"
case "$PART" in
D1)
  echo "-- D1 dry run: --sig 'deployAll(bool)' true --chain 1, no --broadcast, no CONFIRM"
  fs d1 --sig 'deployAll(bool)' true --chain 1 --unlocked --sender "$SENDER"
  files
  echo "-- D2 --resume of that sequence (same --sig), no CONFIRM, no --chain"
  fs d2 --sig 'deployAll(bool)' true --resume --unlocked --sender "$SENDER"
  files; mined ;;
D3)
  echo "-- D3 the README's preview: CONFIRM_MAINNET_DEPLOY=yes --sig 'deployAll(bool)' true, no --broadcast"
  CONFIRM_MAINNET_DEPLOY=yes fs d3 --sig 'deployAll(bool)' true --unlocked --sender "$SENDER"
  files
  echo "-- D4 later, --resume with no CONFIRM"
  fs d4 --sig 'deployAll(bool)' true --resume --unlocked --sender "$SENDER"
  files; mined ;;
D5)
  echo "-- D5 control: run() dry run (records nothing), then --resume"
  fs d5 --unlocked --sender "$SENDER"
  files
  fs d6 --resume --unlocked --sender "$SENDER" ;;
E)
  echo "-- E1 run() --broadcast --chain 1, no CONFIRM (expected: refused by the RPC check)"
  fs e1 --broadcast --unlocked --sender "$SENDER" --chain 1
  echo "-- E2 --sig 'deployAll(bool)' true --broadcast --skip-simulation --chain 1, no CONFIRM"
  fs e2 --sig 'deployAll(bool)' true --broadcast --skip-simulation --unlocked --sender "$SENDER" --chain 1
  echo "-- E3 FOUNDRY_CHAIN_ID=743111 run() --broadcast, no CONFIRM"
  FOUNDRY_CHAIN_ID=743111 fs e3 --broadcast --unlocked --sender "$SENDER"
  echo "-- E4 run() --broadcast --chain 43111 (agrees with the RPC), no CONFIRM (expected: the mainnet confirmation)"
  fs e4 --broadcast --unlocked --sender "$SENDER" --chain 43111
  echo "-- E5 CONFIRM=yes run() --broadcast (expected: deploys)"
  CONFIRM_MAINNET_DEPLOY=yes fs e5 --broadcast --unlocked --sender "$SENDER"
  echo "-- E6 --resume after it (nothing pending)"
  fs e6 --resume --unlocked --sender "$SENDER" ;;
T)
  echo "-- T1 Hemi testnet's chain id (0xb56c7, an odd number of hex digits): run() --broadcast, no CONFIRM (expected: deploys)"
  fs t1 --broadcast --unlocked --sender "$SENDER"
  echo "-- T2 run() --broadcast --chain 43111 against this 743111 RPC (expected: refused by the RPC check)"
  CONFIRM_MAINNET_DEPLOY=yes fs t2 --broadcast --unlocked --sender "$SENDER" --chain 43111 ;;
*) echo "unknown section $PART" >&2; exit 1 ;;
esac
