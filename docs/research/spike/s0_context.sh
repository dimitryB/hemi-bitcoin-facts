#!/usr/bin/env bash
# Context for the spike: client versions, chain ids, and 0x44 against Esplora's block at the same height.
#   bash docs/research/spike/s0_context.sh > docs/research/spike/out/s0-context.txt
set -uo pipefail
cd "$(dirname "$0")"
source lib.sh
run() { echo "\$ $*"; sleep 0.5; "$@" 2>&1; echo; }
echo "# run at $(date -u +%FT%TZ)"
for u in $MAIN $MAIN_FALLBACK $TEST; do
  run cast rpc web3_clientVersion --rpc-url $u
  run cast chain-id --rpc-url $u
  run cast block-number --rpc-url $u
done
r=$(cast call 0x0000000000000000000000000000000000000044 0x --rpc-url $MAIN)
echo "\$ cast call 0x0000000000000000000000000000000000000044 0x --rpc-url $MAIN"
echo "$r"
echo "decoded: $(python3 -I decode.py header "$r")"
h=$((16#${r:2:8}))
sleep 0.5
echo "\$ curl -s https://blockstream.info/api/block-height/$h"
curl -s https://blockstream.info/api/block-height/$h; echo
echo "\$ curl -s https://blockstream.info/api/blocks/tip/height"
curl -s https://blockstream.info/api/blocks/tip/height; echo
