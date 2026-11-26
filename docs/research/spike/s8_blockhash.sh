#!/usr/bin/env bash
# S8: how far back can a contract read a Hemi block hash? blockhash() and the EIP-2935 history contract.
#   bash docs/research/spike/s8_blockhash.sh > docs/research/spike/out/s8-blockhash.txt
# Read-only: eth_call with the probe's runtime code placed by state override, eth_getCode, eth_getBlockByNumber.
set -uo pipefail
cd "$(dirname "$0")"
source lib.sh
RPC=$MAIN
PROBE=0x51ce000000000000000000000000000000000001
CODE=$(cat out/probe-runtime.hex)
H2935=0x0000F90827F1C53a10cb7A02335B175320002935
run() { echo "\$ $*" | sed -E "s/0x608060[0-9a-f]+/<probe runtime, spike\/out\/probe-runtime.hex>/"; sleep 0.5; "$@" 2>&1; echo; }

N=$(cast block-number --rpc-url $RPC)
echo "# S8 run at Hemi block $N ($(date -u +%FT%TZ))"
echo
echo "## EIP-2935 history contract code"
run cast code $H2935 --rpc-url $RPC
echo "## EIP-4788 beacon roots contract code (Cancun system contract, for comparison)"
run cast code 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02 --rpc-url $RPC
echo "## blockhash() at depths 1, 255, 256, 257, 300; EIP-2935 get() at depths 1, 1000, 8000, 8191, 8192 (pinned to block $N)"
run cast call $PROBE 'hashes(uint256[],uint256[])(uint256,bytes32[],bool[],bytes32[])' '[1,255,256,257,300]' '[1,1000,8000,8191,8192]' \
  --block $N --override-code "$PROBE:$CODE" --rpc-url $RPC
echo "## reference hashes from eth_getBlockByNumber"
for d in 1 255 256 257 300 1000 8000 8191 8192; do
  sleep 0.4
  printf 'block %s (N-%s): %s\n' $((N - d)) $d "$(cast block $((N - d)) --field hash --rpc-url $RPC)"
done
echo
echo "## raw call to the EIP-2935 contract (32-byte block number), N-1000 and N-8000"
for d in 1000 8000; do
  run cast call $H2935 "$(cast to-uint256 $((N - d)))" --block $N --rpc-url $RPC
done
echo "## fork activation: GasPriceOracle flags and the newest header's fields"
GPO=0x420000000000000000000000000000000000000F
for f in 'isEcotone()(bool)' 'isFjord()(bool)' 'isIsthmus()(bool)' 'isJovian()(bool)' 'version()(string)'; do
  run cast call $GPO "$f" --rpc-url $RPC
done
sleep 0.4
echo "\$ cast rpc eth_getBlockByNumber latest false --rpc-url $RPC | jq '{number, requestsHash, withdrawalsRoot, blobGasUsed, excessBlobGas, parentBeaconBlockRoot}'"
cast rpc eth_getBlockByNumber latest false --rpc-url $RPC | jq -c '{number, requestsHash, withdrawalsRoot, blobGasUsed, excessBlobGas, parentBeaconBlockRoot}'
echo
echo "## first transaction of the newest block (L1-info deposit selector: 0x098999be Isthmus, 0x440a5e20 Ecotone)"
sleep 0.4
cast rpc eth_getBlockByNumber latest true --rpc-url $RPC | jq -c '{number, firstTxTo: .transactions[0].to, selector: .transactions[0].input[0:10]}'
echo
echo "## a Prague opcode-level check: EIP-7702 / BLS precompile 0x0b (Prague, in OP Isthmus) with empty input"
run cast call 0x000000000000000000000000000000000000000b 0x --rpc-url $RPC
