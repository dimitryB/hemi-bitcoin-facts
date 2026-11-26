#!/usr/bin/env bash
# Internal review live reads (docs/SECURITY-AUDIT.md). Run from anywhere: bash contracts/test/review/live-review.sh
# Read-only: eth_call / eth_estimateGas with state overrides on Hemi mainnet. Nothing is signed or sent.
# Paced at ~2 requests a second. Needs forge, cast and python3.
set -uo pipefail
R=${RPC:-https://rpc.hemi.network/rpc}
C=$(cd "$(dirname "$0")/../.." && pwd)
BF=0x00000000000000000000000000000000000b1f01
FB=0x00000000000000000000000000000000000b1f02
FROM=0x000000000000000000000000000000000000dEaD
BF_RT=$(cd "$C" && forge inspect BitcoinFacts deployedBytecode); FB_RT=$(cd "$C" && forge inspect FidelityBonds deployedBytecode)
WP=0x54e48e5f5c656b26c3bca14a8c95aa583d07ebe84dde3b7dd4a78f4e4186e713
GEN=0x4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b
pace() { sleep 0.5; }
ov() { printf '{"%s":{"code":"%s"}%s}' "$1" "$2" "${3:-}"; }
ecall() { pace; cast rpc eth_call "{\"to\":\"$1\",\"data\":\"$2\",\"gas\":\"0x1c9c380\"}" latest "$3" --rpc-url "$R" | tr -d '"'; }
egas() { pace; local o; o=$(cast rpc eth_estimateGas "{\"from\":\"$FROM\",\"to\":\"$1\",\"data\":\"$2\"}" latest "$3" --rpc-url "$R" 2>&1 | tr -d '"'); [[ $o =~ ^0x ]] && cast to-dec "$o" || echo "$o"; }
OUT_T='(uint8,bytes32,bool,uint64,bytes32,uint16,bool,uint32,uint32,bytes32,bytes)'

echo "== Hemi block $(cast block-number --rpc-url "$R")"
pace; h=$(cast call 0x0000000000000000000000000000000000000044 0x --rpc-url "$R"); echo "0x44 height $(cast to-dec 0x${h:2:8}) hash 0x${h:10:64}"

echo "== 0. raw reads: the genesis coinbase (0x48, 0x42, 0x43) and a BIP30 duplicate coinbase (0x43)"
pace; echo "0x48 genesis: $(cast call 0x0000000000000000000000000000000000000048 ${GEN}00000064 --rpc-url "$R" 2>/dev/null)"
pace; echo "0x42 genesis: $(cast call 0x0000000000000000000000000000000000000042 ${GEN}003c0703 --rpc-url "$R" 2>/dev/null)"
pace; echo "0x43 genesis: $(cast call 0x0000000000000000000000000000000000000043 ${GEN} --rpc-url "$R" 2>/dev/null)"
GPK=04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f
pace; echo "0x46 genesis pubkey string: $(cast call 0x0000000000000000000000000000000000000046 $(cast from-utf8 $GPK) --rpc-url "$R" 2>/dev/null)"
pace; echo "0x40 genesis pubkey string: $(cast call 0x0000000000000000000000000000000000000040 $(cast from-utf8 $GPK) --rpc-url "$R" 2>/dev/null)"
BIP30=0xd5d27987d2a3dfc724e359870c6644b40e497bdc0589a033220fe15429d88599
Q='{"to":"0x0000000000000000000000000000000000000043","data":"'$BIP30'"}'
pace; a=$(cast rpc eth_call "$Q" latest --rpc-url "$R" 2>&1); echo "0x43 BIP30 d5d27987…8599: $a"

echo "== 1. BitcoinFacts.checkOutput(genesis coinbase, 0)"
o=$(ecall $BF "$(cast calldata 'checkOutput(bytes32,uint16)' $GEN 0)" "$(ov $BF "$BF_RT")")
cast decode-abi "f()($OUT_T)" "$o"

echo "== 2. worst-case 0x42 parse: whitepaper tx (948 outputs, 201-byte scripts), eth_estimateGas"
for v in 32 947 948; do
  c=$(cast calldata 'checkOutput(bytes32,uint16)' $WP $v)
  o=$(ecall $BF "$c" "$(ov $BF "$BF_RT")"); verdict=$(cast decode-abi "f()($OUT_T)" "$o" | head -1)
  echo "checkOutput(wp, $v): verdict $verdict, gas $(egas $BF "$c" "$(ov $BF "$BF_RT")")"
done

echo "== 3. FidelityBonds.checkBond(wp, 0, 1, template ws): parses 128 outputs then TooManyOutputs"
WS=0x042b33016bb1752103e62f16c95dc68d101ae345eafc27a8cc1a1398999db07667a651382733913654ac
c=$(cast calldata 'checkBond(bytes32,uint16,uint16,bytes)' $WP 0 1 $WS)
o=$(ecall $FB "$c" "$(ov $FB "$FB_RT")"); echo "verdict word: ${o:0:66}"
echo "checkBond gas: $(egas $FB "$c" "$(ov $FB "$FB_RT")")"

echo "== 4. FidelityBonds.liveBond on a bond planted by stateDiff at (wp, 947): spent path parses 128 outputs"
SUB=$(cast keccak $(printf '%s%04x' $WP 947))
KIND=$(cast keccak "hemi-bitcoin-facts/bond")
ID=$(cast keccak $(cast abi-encode 'f(bytes32,bytes32)' $KIND $SUB))
BASE=$(cast keccak $(cast abi-encode 'f(bytes32,uint256)' $ID 0))
S0=$BASE; S4=$(python3 -I -c "print('0x%064x' % (int('$BASE',16)+4))")
echo "bondId(wp, 947) = $ID"
W4=$(python3 -I -c "print('0x%064x' % (1 | (947 << (28*8))))")
SD=",\"stateDiff\":{\"$S0\":\"$WP\",\"$S4\":\"$W4\"}"
OVB=$(printf '{"%s":{"code":"%s"%s}}' $FB "$FB_RT" "$SD")
c=$(cast calldata 'liveBond(bytes32)' $ID)
o=$(ecall $FB "$c" "$OVB"); echo "liveBond status word: ${o:0:66} (4 = Unknown)"
echo "liveBond gas: $(egas $FB "$c" "$OVB")"
c=$(cast calldata 'refresh(bytes32)' $ID)
echo "refresh gas: $(egas $FB "$c" "$OVB")"
