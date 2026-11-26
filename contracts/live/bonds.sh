# FidelityBonds against Hemi's real hVM precompiles. Sourced by check-live.sh, which defines RPC, CHAIN_ID and the
# helpers in lib.sh. Read-only: eth_call and eth_estimateGas, with FidelityBonds placed at its CREATE2 address by
# state override (and, for checks 4 and 5, a stored bond placed in its storage the same way), plus Esplora GETs.
# Nothing is signed or sent, and no bond exists on mainnet: the checks show each rule on real Bitcoin data.
#
#   ./check-live.sh mainnet bonds
#
# Checks:
#   1. checkBond on the unspent payment fixture (43cb9bdc…cea4 vout 0, P2WPKH): NotABond; its as-of height is 0x44's,
#      and its bond id is keccak256(abi.encode(KIND_BOND, keccak256(txid ‖ vout)))
#   2. the PoP transaction's 83-byte OP_RETURN (d4ed6ec2…845e vout 1) read as a tag through 0x42: BadTag; checkBond
#      on that transaction stops at its spent P2PKH vout 0: NotABond
#   3. a made-up txid: NotFound; a bad template and a height locktime: BadWitnessScript, BadLocktime
#   4. the spent fixture (95bca029…367e vout 1, P2WSH) as a stored bond: liveBond reads Ended (Hvm.spendStatus Spent
#      through 0x48 and 0x42) and refresh by eth_call returns true; checkBond on it: NotABond
#   5. a real unspent P2WSH output (of a D-001 address, found through Esplora) as a stored bond: liveBond reads Live
#      with a future locktime, Expired with a past one, Unknown with a value 1 sat off; refresh returns false
#   6. liveBond of an id nothing is stored under: NotRecorded
#   7. eth_estimateGas of checkBond, liveBond (Live, Ended) and refresh (Spent -> ended)

FB_SALT_STRING="hemi-bitcoin-facts/FidelityBonds/v1"
FB_CHECK_T='(uint8,bytes32,bool,address,uint64,uint32,bytes32,uint32,uint32,bytes32,uint32,bool)'
FB_BOND_T='(bytes32,bytes32,bytes32,address,uint64,uint32,uint64,uint64,uint32,uint32,uint32,uint16,uint16)'
FB_VERDICTS=(Ok BadWitnessScript BadLocktime NoBitcoinView NotFound TooManyOutputs NotABond Spent SpendUnknown BadTag WrongChain WrongContract AmbiguousTag BelowFloor NoConfirmations FewConfirmations)
FB_STATUSES=(NotRecorded Live Expired Ended Unknown)
# The secp256k1 generator, compressed: a valid key that locks nothing real.
FB_KEY=0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798
FB_AGENT=000000000000000000000000000000000000a9e1
FB_FROM=0x000000000000000000000000000000000000dEaD
FB_UNSPENT_TXID=0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4
FB_SPENT_TXID=0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e
FB_SPENT_PROGRAM=0xff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4
FB_POP_TXID=0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e
FB_ZERO_ADDRESS=0x0000000000000000000000000000000000000000
# D-001's P2WSH addresses: a source of real unspent P2WSH outputs
FB_P2WSH_ADDRS=(bc1qdgmr8c9qpxg5qf5pjncj6eplztucv9j7upzveftmcxamd7g9xhzq03v89z bc1qz6mlqaqqp5q6938pmqde0jxp4mp3hyun25j5h8ev8wef07mqzj2stx7zw7)

# fb_le32 <n>: the 4-byte little-endian hex of n
fb_le32() {
  local h
  h=$(printf '%08x' "$1")
  printf '%s' "${h:6:2}${h:4:2}${h:2:2}${h:0:2}"
}
# fb_ws <locktime>: the 42-byte witness script for FB_KEY
fb_ws() { printf '0x04%sb17521%sac' "$(fb_le32 "$1")" "$FB_KEY"; }
# fb_id <txid> <vout>: keccak256(abi.encode(KIND_BOND, keccak256(txid ‖ uint16 vout)))
fb_id() {
  cast keccak "$(cast abi-encode 'f(bytes32,bytes32)' "$(cast keccak "hemi-bitcoin-facts/bond")" "$(cast keccak "$1$(printf '%04x' "$2")")")"
}

fb_call() { # <calldata> [overrides-json]
  call "$ADDR_FidelityBonds" "$1" "${2:-$(overrides_json)}"
}
fb_check() { # <txid> <bondVout> <tagVout> <ws>
  local ret
  ret=$(fb_call "$(cast calldata 'checkBond(bytes32,uint16,uint16,bytes)' "$1" "$2" "$3" "$4")") || {
    printf '%s' "$ret"
    return 1
  }
  cast decode-abi --json "f()($FB_CHECK_T)" "$ret" | jq -c '.data[0]'
}
fb_verdict() { printf '%s' "${FB_VERDICTS[$(jq -r '.[0]' <<<"$1")]:-?}"; }
fb_tag() { # <txid> <vout>: "<verdict> <agent>"
  local ret
  ret=$(fb_call "$(cast calldata 'readTag(bytes32,uint16)' "$1" "$2")") || {
    printf '%s' "$ret"
    return 1
  }
  cast decode-abi --json 'f()(uint8,address)' "$ret" | jq -r '.data | "\(.[0]) \(.[1])"' |
    { read -r v a; printf '%s %s' "${FB_VERDICTS[$v]:-?}" "$a"; }
}
fb_live() { # <id> [overrides]: [status, agent, sats, locktime]
  local ret
  ret=$(fb_call "$(cast calldata 'liveBond(bytes32)' "$1")" "${2:-$(overrides_json)}") || {
    printf '%s' "$ret"
    return 1
  }
  cast decode-abi --json 'f()(uint8,address,uint64,uint32)' "$ret" | jq -c '.data'
}
fb_status() { printf '%s' "${FB_STATUSES[$(jq -r '.[0]' <<<"$1")]:-?}"; }
fb_estimate() { # <calldata> <overrides>
  local out
  out=$(rpc eth_estimateGas "{\"from\":\"$FB_FROM\",\"to\":\"$ADDR_FidelityBonds\",\"data\":\"$1\"}" latest "$2") || {
    printf '%s' "$out"
    return 1
  }
  cast to-dec "$out"
}

# fb_slot <base> <k>: base + k as a 32-byte hex slot (256-bit arithmetic, which bash lacks)
fb_slot() { python3 -I -c 'import sys; print("0x%064x" % (int(sys.argv[1], 16) + int(sys.argv[2])))' "$1" "$2"; }

# fb_with_bond <id> <txid> <vout> <tagVout> <program> <sats> <locktime> <btcHeight>: the overrides JSON with
# FidelityBonds' code and a bond stored under <id>. The mapping is at slot 0 and the struct takes five slots (layout
# from `forge inspect FidelityBonds storageLayout`; check 4 reads it back through bond(id)).
fb_with_bond() {
  local base s3 s4 sd entry
  base=$(cast index bytes32 "$1" 0)
  # slot 3: locktime(4) sats(8) agent(20), high to low
  s3=$(printf '0x%08x%016x%s' "$7" "$6" "$FB_AGENT")
  # slot 4: tagVout(2) vout(2) confirmations(4) endedBtcHeight(4) btcHeight(4) endedHemiBlock(8) hemiBlock(8)
  s4=$(printf '0x%04x%04x%08x%08x%08x%016x%016x' "$4" "$3" 6 0 "$8" 0 1)
  sd="\"$base\":\"$2\""
  sd+=",\"$(fb_slot "$base" 1)\":\"$5\""
  sd+=",\"$(fb_slot "$base" 2)\":\"0x$(printf '%064x' 1)\""
  sd+=",\"$(fb_slot "$base" 3)\":\"$s3\""
  sd+=",\"$(fb_slot "$base" 4)\":\"$s4\""
  entry="\"$ADDR_FidelityBonds\":{\"code\":"
  if [[ $OVERRIDES == *"$entry"* ]]; then
    # one string replacement; bash's ${var/…/…} treats quotes in the replacement differently across versions
    python3 -I -c 'import sys; print("{%s}" % sys.argv[1].replace(sys.argv[2], sys.argv[3], 1), end="")' \
      "$OVERRIDES" "$entry" "\"$ADDR_FidelityBonds\":{\"stateDiff\":{$sd},\"code\":"
  else
    overrides_json "\"$ADDR_FidelityBonds\":{\"stateDiff\":{$sd}}"
  fi
}

live_bonds() {
  local fails_before=$LIVE_FAILS ic salt c ws hvm_height now lt t
  salt=$(cast keccak "$FB_SALT_STRING")
  ic=$(initcode FidelityBonds)
  place FidelityBonds "$salt" "$ic"
  hvm_height=$(cast to-dec "0x$(call 0x0000000000000000000000000000000000000044 0x | cut -c3-10)")
  now=$(date +%s)
  lt=$((now + 86400))
  ws=$(fb_ws "$lt")
  echo "   witness script for the checks: $ws (locktime $lt; a key that locks nothing)"

  # -- 1. the unspent payment fixture is not a bond ----------------------------------------------
  if c=$(fb_check "$FB_UNSPENT_TXID" 0 1 "$ws"); then
    expect_eq "checkBond(unspent fixture 43cb9bdc…cea4 vout 0, a P2WPKH) verdict" "$(fb_verdict "$c")" NotABond
    expect_eq "  as-of height = 0x44's" "$(jq -r '.[8]' <<<"$c")" "$hvm_height"
    expect_eq "  bond id = keccak256(abi.encode(KIND_BOND, keccak256(txid ‖ vout)))" "$(jq -r '.[1]' <<<"$c")" "$(fb_id "$FB_UNSPENT_TXID" 0)"
    expect_eq "  locktime read from the witness script" "$(jq -r '.[5]' <<<"$c")" "$lt"
  else
    fail "checkBond(unspent fixture): $c"
  fi

  # -- 2. a real OP_RETURN is not a tag ------------------------------------------------------------
  if t=$(fb_tag "$FB_POP_TXID" 1); then
    expect_eq "readTag(PoP tx d4ed6ec2…845e vout 1, the 83-byte HEMI OP_RETURN, via 0x42)" "$t" "BadTag $FB_ZERO_ADDRESS"
  else
    fail "readTag(PoP vout 1): $t"
  fi
  if t=$(fb_tag "$FB_POP_TXID" 2); then
    expect_eq "readTag(PoP tx vout 2, past its 2 outputs)" "$t" "NotFound $FB_ZERO_ADDRESS"
  else
    fail "readTag(PoP vout 2): $t"
  fi
  if c=$(fb_check "$FB_POP_TXID" 0 1 "$ws"); then
    expect_eq "checkBond(PoP tx; bond vout 0 is a spent P2PKH) verdict" "$(fb_verdict "$c")" NotABond
  else
    fail "checkBond(PoP): $c"
  fi

  # -- 3. an unknown transaction, bad witness scripts -----------------------------------------------
  if c=$(fb_check 0x1111111111111111111111111111111111111111111111111111111111111111 0 1 "$ws"); then
    expect_eq "checkBond(made-up txid) verdict" "$(fb_verdict "$c")" NotFound
  else
    fail "checkBond(made-up txid): $c"
  fi
  if c=$(fb_check "$FB_UNSPENT_TXID" 0 1 "0x05${ws:4}"); then
    expect_eq "checkBond(witness script with a 5-byte push for the locktime) verdict" "$(fb_verdict "$c")" BadWitnessScript
  else
    fail "checkBond(bad template): $c"
  fi
  if c=$(fb_check "$FB_UNSPENT_TXID" 0 1 "$(fb_ws 976900)"); then
    expect_eq "checkBond(a block-height locktime) verdict" "$(fb_verdict "$c")" BadLocktime
  else
    fail "checkBond(height locktime): $c"
  fi

  # -- 4. the spent fixture as a stored bond: Ended ---------------------------------------------------
  local sid ov b l g r
  sid=$(fb_id "$FB_SPENT_TXID" 1)
  ov=$(fb_with_bond "$sid" "$FB_SPENT_TXID" 1 0 "$FB_SPENT_PROGRAM" 83050000 "$lt" 975189)
  echo "   spent fixture ${FB_SPENT_TXID:0:10}…${FB_SPENT_TXID: -4} vout 1 placed in storage as bond $sid"
  if b=$(fb_call "$(cast calldata 'bond(bytes32)' "$sid")" "$ov"); then
    b=$(cast decode-abi --json "f()($FB_BOND_T)" "$b" | jq -c '.data[0]')
    expect_eq "  bond(id) reads back txid, program, sats, locktime, vout (the storage layout)" \
      "$(jq -r '[.[0], .[1], .[4], .[5], .[11]] | join(" ")' <<<"$b")" "$FB_SPENT_TXID $FB_SPENT_PROGRAM 83050000 $lt 1"
  else
    fail "bond(id) with the placed storage: $b"
  fi
  if l=$(fb_live "$sid" "$ov"); then
    expect_eq "  liveBond status (Hvm.spendStatus Spent: 0x48 silent, 0x42 lists it with UTXO byte 0)" "$(fb_status "$l")" Ended
    expect_eq "  liveBond sats" "$(jq -r '.[2]' <<<"$l")" 83050000
  else
    fail "liveBond(spent fixture): $l"
  fi
  if r=$(fb_call "$(cast calldata 'refresh(bytes32)' "$sid")" "$ov"); then
    expect_eq "  refresh by eth_call returns ended" "$(cast decode-abi 'f()(bool)' "$r")" true
  else
    fail "refresh(spent fixture) by eth_call: $r"
  fi
  if g=$(fb_estimate "$(cast calldata 'refresh(bytes32)' "$sid")" "$ov"); then
    pass "eth_estimateGas refresh (Spent -> ended): $g gas"
  else
    fail "eth_estimateGas refresh: $g"
  fi
  if g=$(fb_estimate "$(cast calldata 'liveBond(bytes32)' "$sid")" "$ov"); then
    pass "eth_estimateGas liveBond (Ended, read from hVM): $g gas"
  else
    fail "eth_estimateGas liveBond (Ended): $g"
  fi
  if c=$(fb_check "$FB_SPENT_TXID" 1 0 "$ws"); then
    expect_eq "checkBond(spent fixture vout 1, a P2WSH of another script) verdict" "$(fb_verdict "$c")" NotABond
  else
    fail "checkBond(spent fixture): $c"
  fi

  # -- 5. a real unspent P2WSH output as a stored bond: Live, Expired, Unknown -----------------------
  local addr utxos u txid vout value script uid found=0
  for addr in "${FB_P2WSH_ADDRS[@]}"; do
    utxos=$(esplora "/address/$addr/utxo") || {
      echo "   NOTE: Esplora did not answer for $addr"
      continue
    }
    u=$(jq -c --argjson h "$hvm_height" '[.[] | select(.status.confirmed and .status.block_height <= ($h - 2))] | first // empty' <<<"$utxos")
    if [ -z "$u" ]; then
      echo "   $addr: no UTXO hVM has indexed; next"
      continue
    fi
    txid=0x$(jq -r .txid <<<"$u")
    vout=$(jq -r .vout <<<"$u")
    value=$(jq -r .value <<<"$u")
    script=$(esplora "/tx/${txid#0x}" | jq -r ".vout[$vout].scriptpubkey")
    if ! [[ $script =~ ^0020[0-9a-f]{64}$ ]]; then
      echo "   NOTE: unexpected script $script for $txid:$vout"
      continue
    fi
    found=1
    echo "   unspent P2WSH output ${txid:0:10}…${txid: -4}:$vout ($value sats, $addr) placed in storage as a bond"
    uid=$(fb_id "$txid" "$vout")
    ov=$(fb_with_bond "$uid" "$txid" "$vout" 0 "0x${script:4}" "$value" 2147483647 "$hvm_height")
    if l=$(fb_live "$uid" "$ov"); then
      expect_eq "  liveBond with locktime 2147483647 (2038)" "$(fb_status "$l")" Live
    else
      fail "liveBond(unspent P2WSH): $l"
    fi
    if g=$(fb_estimate "$(cast calldata 'liveBond(bytes32)' "$uid")" "$ov"); then
      pass "eth_estimateGas liveBond (Live): $g gas"
    else
      fail "eth_estimateGas liveBond (Live): $g"
    fi
    if r=$(fb_call "$(cast calldata 'refresh(bytes32)' "$uid")" "$ov"); then
      expect_eq "  refresh by eth_call returns not ended" "$(cast decode-abi 'f()(bool)' "$r")" false
    else
      fail "refresh(unspent P2WSH): $r"
    fi
    ov=$(fb_with_bond "$uid" "$txid" "$vout" 0 "0x${script:4}" "$value" 500000000 "$hvm_height")
    if l=$(fb_live "$uid" "$ov"); then
      expect_eq "  liveBond with locktime 500000000 (1985)" "$(fb_status "$l")" Expired
    else
      fail "liveBond(unspent P2WSH, past locktime): $l"
    fi
    ov=$(fb_with_bond "$uid" "$txid" "$vout" 0 "0x${script:4}" "$((value + 1))" 2147483647 "$hvm_height")
    if l=$(fb_live "$uid" "$ov"); then
      expect_eq "  liveBond with the value 1 sat off (0x48's answer disagrees)" "$(fb_status "$l")" Unknown
    else
      fail "liveBond(value 1 sat off): $l"
    fi
    break
  done
  [ "$found" = 1 ] || echo "   NOTE: no unspent P2WSH output found through Esplora; check 5 skipped"

  # -- 6. nothing stored ---------------------------------------------------------------------------
  if l=$(fb_live 0x7777777777777777777777777777777777777777777777777777777777777777); then
    expect_eq "liveBond(an id nothing is stored under)" "$(fb_status "$l")" NotRecorded
  else
    fail "liveBond(unrecorded): $l"
  fi

  # -- 7. gas of a check ---------------------------------------------------------------------------
  if g=$(fb_estimate "$(cast calldata 'checkBond(bytes32,uint16,uint16,bytes)' "$FB_UNSPENT_TXID" 0 1 "$ws")" "$(overrides_json)"); then
    pass "eth_estimateGas checkBond(unspent fixture: 0x44, 0x42, stops at NotABond): $g gas"
  else
    fail "eth_estimateGas checkBond: $g"
  fi

  [ "$LIVE_FAILS" -eq "$fails_before" ]
}
