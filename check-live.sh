#!/usr/bin/env bash
# Read-only live check of the contracts against Hemi's real hVM precompiles.
#
#   ./check-live.sh mainnet [section ...]      sections: facts finality bonds (default: all present)
#
# Forge cannot run hVM precompiles, so this uses `cast` against a real Hemi node. Each contract is
# used at its CREATE2 address if deployed there; otherwise its compiled code is placed at that address
# by eth_call state override. Every request is eth_call / eth_getCode / eth_getStorageAt or an Esplora
# GET: nothing is signed or sent, and no key is needed.
#
# Environment: HEMI_MAINNET_RPC_URL (default https://rpc.hemi.network/rpc), ESPLORA_URLS (space-separated).
# Exit status: 0 if every check passed, 1 if any failed, 2 on usage or RPC errors.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
CONTRACTS_DIR=$ROOT/contracts
# shellcheck source=contracts/live/lib.sh
. "$CONTRACTS_DIR/live/lib.sh"

NET=${1:-}
shift || true
case $NET in
  mainnet) CHAIN_ID=43111; RPC=${HEMI_MAINNET_RPC_URL:-https://rpc.hemi.network/rpc} ;;
  *) live_die "usage: $0 mainnet [facts|finality|bonds ...]" ;;
esac
for tool in forge cast jq curl; do command -v $tool >/dev/null || live_die "$tool not found on PATH"; done
got=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || live_die "RPC did not answer eth_chainId"
[ "$got" = "$CHAIN_ID" ] || live_die "RPC reports chain id $got, expected $CHAIN_ID"
# Lint warnings are not results: show the build's output only if it fails.
if ! build_out=$(cd "$CONTRACTS_DIR" && forge build 2>&1); then printf '%s\n' "$build_out" >&2; live_die "forge build failed"; fi

SECTIONS=("$@")
if [ ${#SECTIONS[@]} -eq 0 ]; then
  for f in "$CONTRACTS_DIR"/live/*.sh; do
    n=$(basename "$f" .sh); [ "$n" = lib ] || SECTIONS+=("$n")
  done
fi

echo "== Hemi $NET (chain id $CHAIN_ID), Hemi block $(cast block-number --rpc-url "$RPC")"
hdr=$(call 0x0000000000000000000000000000000000000044 0x) || live_die "0x44: $hdr"
echo "   hVM Bitcoin header: height $(cast to-dec "0x${hdr:2:8}"), hash 0x${hdr:10:64}"
echo

for s in "${SECTIONS[@]}"; do
  f=$CONTRACTS_DIR/live/$s.sh
  [ -f "$f" ] || live_die "no section $s ($f)"
  # shellcheck source=/dev/null
  . "$f"
  echo "== $s"
  "live_$s" || true
  echo
done

if [ "$LIVE_FAILS" -eq 0 ]; then
  if [ ${#LIVE_SKIPS[@]} -gt 0 ]; then
    echo "OK: every check that ran passed (${SECTIONS[*]}), but ${#LIVE_SKIPS[@]} were skipped:"
    for s in "${LIVE_SKIPS[@]}"; do echo "   SKIPPED $s"; done
  else
    echo "OK: every check passed (${SECTIONS[*]})."
  fi
  exit 0
fi
echo "NOT OK: $LIVE_FAILS check(s) failed."
exit 1
