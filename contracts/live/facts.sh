# BitcoinFacts against Hemi's real hVM precompiles. Sourced by check-live.sh, which defines RPC, CHAIN_ID and the
# helpers in lib.sh. Read-only: eth_call and eth_estimateGas (with BitcoinFacts placed by state override when it
# is not deployed) and Esplora GETs. Nothing is signed or sent.
#
#   ./check-live.sh mainnet facts
#
# Checks:
#   1. the unspent fixture (43cb9bdc…cea4 vout 0) is Ok, 1,000 sats, the right script hash, not spent, after first
#      asking Esplora whether it is still unspent; its confirmations equal Bitcoin's own count (offset 0, D-005)
#   2. the spent fixture (95bca029…367e vout 1) is Ok, spent, 83,050,000 sats, the right script hash
#   3. the PoP OP_RETURN (d4ed6ec2…845e vout 1) is Unspendable, never "spent"; a made-up txid is NotFound
#   4. balances: the first D-001 address with no Bitcoin activity for a while equals Esplora's balance, its subject
#      is keccak256 of its script, and the upper-case spelling of a bech32 address gives the same subject and id
#   5. a bad-checksum address is BadAddress
#   6. eth_estimateGas of recordOutput (unspent, spent) and recordBalance, and that a NotFound record reverts

BF_SALT_STRING="hemi-bitcoin-facts/BitcoinFacts/v1"
BF_OUTPUT_T='(uint8,bytes32,bool,uint64,bytes32,uint16,bool,uint32,uint32,bytes32,bytes)'
BF_BALANCE_T='(uint8,bytes32,bool,uint64,bytes32,uint16,uint32,bytes32,bytes)'
BF_VERDICTS=(Ok NoBitcoinView NotFound VoutTooHigh Unspendable ScriptTooLong Inconsistent NoConfirmations BadAddress NoBalance)

FX_UNSPENT_TXID=0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4
FX_UNSPENT_SCRIPT=0x001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831
FX_UNSPENT_HEIGHT=975240
FX_SPENT_TXID=0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e
FX_SPENT_SCRIPT=0x0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4
FX_POP_TXID=0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e
# D-001 addresses with their 0x46 scripts; the first with no recent activity is used.
FX_BALANCE_ADDRS=(
  "18DqQBT9CKb3RJ94H1d2JJbnHWp25uRmjm 0x76a9144f364626b44b11929dd604d3cc592c4b8d887d1c88ac"
  "bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkv 0x0014d57738858e10d8b5b3ae80047cbb7750e028b6f2"
  "34zF3mWjUUE8rWkJycrWHGEFsopCHS6sY3 0xa914242a678f7eb9660bf11e1c5cd9bed51e6b2a16dc87"
  "bc1pd0stas9vawgcf20uk799z2d8rmw66xfj3xayv75lr7qjw5suxwnsrfaena 0x51206be0bec0aceb9184a9fcb78a5129a71eddad193289ba467a9f1f8127521c33a7"
)
FX_BECH32=bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkv
FX_BAD_ADDR=bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkq
# An address with no balance and no key: eth_estimateGas needs a sender, not funds (no gas price is given).
BF_FROM=0x000000000000000000000000000000000000dEaD

# bf_decode <tuple-type> <hex>: the ABI-decoded struct as a JSON array.
bf_decode() { cast decode-abi --json "f()($1)" "$2" | jq -c '.data[0]'; }
bf_field() { jq -r ".[$2]" <<<"$1"; }
bf_verdict() { printf '%s' "${BF_VERDICTS[$(bf_field "$1" 0)]:-?}"; }

# bf_check_output <txid> <vout>: prints the decoded OutputCheck, or fails.
bf_check_output() {
  local ret
  ret=$(call "$ADDR_BitcoinFacts" "$(cast calldata 'checkOutput(bytes32,uint16)' "$1" "$2")" "$(overrides_json)") || {
    printf '%s' "$ret"
    return 1
  }
  bf_decode "$BF_OUTPUT_T" "$ret"
}

bf_check_balance() {
  local ret
  ret=$(call "$ADDR_BitcoinFacts" "$(cast calldata 'checkBalance(string)' "$1")" "$(overrides_json)") || {
    printf '%s' "$ret"
    return 1
  }
  bf_decode "$BF_BALANCE_T" "$ret"
}

# bf_estimate <calldata>: eth_estimateGas of a call to BitcoinFacts with the overrides; nothing is sent.
bf_estimate() {
  local out
  out=$(rpc eth_estimateGas "{\"from\":\"$BF_FROM\",\"to\":\"$ADDR_BitcoinFacts\",\"data\":\"$1\"}" latest "$(overrides_json)") || {
    printf '%s' "$out"
    return 1
  }
  cast to-dec "$out"
}

live_facts() {
  local fails_before=$LIVE_FAILS ic salt c v tip hvm_height want_spent note
  salt=$(cast keccak "$BF_SALT_STRING")
  ic=$(initcode BitcoinFacts)
  place BitcoinFacts "$salt" "$ic"
  hvm_height=$(cast to-dec "0x$(call 0x0000000000000000000000000000000000000044 0x | cut -c3-10)")

  # -- 1. the unspent fixture -----------------------------------------------------------------
  echo "   unspent fixture ${FX_UNSPENT_TXID:0:10}…${FX_UNSPENT_TXID: -4} vout 0"
  want_spent=false
  if c=$(esplora "/tx/${FX_UNSPENT_TXID#0x}/outspend/0"); then
    if [ "$(jq -r .spent <<<"$c")" = "true" ]; then
      note="SPENT on Bitcoin since the spike, by $(jq -r .txid <<<"$c") ($(jq -r '.status.block_height // "unconfirmed"' <<<"$c"))"
      echo "   NOTE: the unspent fixture is $note"
      local sh
      sh=$(jq -r '.status.block_height // empty' <<<"$c")
      if [ -n "$sh" ] && [ "$sh" -le "$hvm_height" ]; then want_spent=true; else echo "   NOTE: hVM (height $hvm_height) has not reached that spend yet; still expecting unspent"; fi
    else
      echo "   Esplora: still unspent"
    fi
  else
    echo "   NOTE: Esplora did not answer for the fixture's outspend; assuming it is still unspent"
  fi
  if c=$(bf_check_output "$FX_UNSPENT_TXID" 0); then
    expect_eq "checkOutput verdict" "$(bf_verdict "$c")" Ok
    expect_eq "sats" "$(bf_field "$c" 3)" 1000
    expect_eq "scriptHash" "$(bf_field "$c" 4)" "$(cast keccak "$FX_UNSPENT_SCRIPT")"
    expect_eq "scriptLength" "$(bf_field "$c" 5)" 22
    expect_eq "script" "$(bf_field "$c" 10)" "$FX_UNSPENT_SCRIPT"
    expect_eq "spent" "$(bf_field "$c" 6)" "$want_spent"
    expect_eq "as-of height = 0x44's" "$(bf_field "$c" 8)" "$hvm_height"
    expect_eq "fact id = outputId(txid, 0, as-of hash)" "$(bf_field "$c" 1)" \
      "$(cast keccak "$(cast abi-encode 'f(bytes32,bytes32,bytes32)' "$(cast keccak "hemi-bitcoin-facts/output")" \
        "$(cast keccak "${FX_UNSPENT_TXID}0000")" "$(bf_field "$c" 9)")")"
    local confs btc_tip
    confs=$(bf_field "$c" 7)
    if btc_tip=$(esplora /blocks/tip/height) && [[ $btc_tip =~ ^[0-9]+$ ]]; then
      local want=$((btc_tip - FX_UNSPENT_HEIGHT + 1)) d
      d=$((confs - want))
      if [ "${d#-}" -le 1 ]; then
        pass "confirmations: $confs = Bitcoin's own count $want (Esplora tip $btc_tip; offset $d)"
      else
        fail "confirmations: $confs, Bitcoin's own count is $want (Esplora tip $btc_tip)"
      fi
    else
      echo "   NOTE: no Esplora tip; confirmations $confs not compared"
    fi
  else
    fail "checkOutput(unspent fixture): $c"
  fi

  # -- 2. the spent fixture -------------------------------------------------------------------
  echo "   spent fixture ${FX_SPENT_TXID:0:10}…${FX_SPENT_TXID: -4} vout 1"
  if c=$(bf_check_output "$FX_SPENT_TXID" 1); then
    expect_eq "checkOutput verdict" "$(bf_verdict "$c")" Ok
    expect_eq "spent" "$(bf_field "$c" 6)" true
    expect_eq "sats" "$(bf_field "$c" 3)" 83050000
    expect_eq "scriptHash" "$(bf_field "$c" 4)" "$(cast keccak "$FX_SPENT_SCRIPT")"
    expect_eq "scriptLength" "$(bf_field "$c" 5)" 34
  else
    fail "checkOutput(spent fixture): $c"
  fi

  # -- 3. never "spent" without a positive answer -----------------------------------------------
  if c=$(bf_check_output "$FX_POP_TXID" 1); then
    expect_eq "PoP OP_RETURN ${FX_POP_TXID:0:10}… vout 1 verdict" "$(bf_verdict "$c")" Unspendable
    expect_eq "  and spent" "$(bf_field "$c" 6)" false
  else
    fail "checkOutput(PoP OP_RETURN): $c"
  fi
  if c=$(bf_check_output 0x1111111111111111111111111111111111111111111111111111111111111111 0); then
    expect_eq "made-up txid verdict" "$(bf_verdict "$c")" NotFound
  else
    fail "checkOutput(made-up txid): $c"
  fi

  # -- 4. balances against Esplora --------------------------------------------------------------
  local entry addr script info txs funded spent_sum mempool newest balance_ok=0
  for entry in "${FX_BALANCE_ADDRS[@]}"; do
    addr=${entry% *}
    script=${entry#* }
    info=$(esplora "/address/$addr") || { echo "   NOTE: Esplora did not answer for $addr"; continue; }
    txs=$(esplora "/address/$addr/txs") || { echo "   NOTE: Esplora did not answer for $addr's transactions"; continue; }
    funded=$(jq -r '.chain_stats.funded_txo_sum' <<<"$info")
    spent_sum=$(jq -r '.chain_stats.spent_txo_sum' <<<"$info")
    mempool=$(jq -r '.mempool_stats.tx_count' <<<"$info")
    newest=$(jq -r '[.[] | select(.status.confirmed) | .status.block_height] | max // 0' <<<"$txs")
    [[ $newest =~ ^[0-9]+$ && $mempool =~ ^[0-9]+$ ]] || { echo "   NOTE: unexpected Esplora answer for $addr"; continue; }
    if [ "$mempool" != 0 ] || [ "$newest" -gt $((hvm_height - 6)) ]; then
      echo "   $addr: activity at Bitcoin height $newest or in the mempool ($mempool); not comparable, next"
      continue
    fi
    echo "   balance $addr (newest transaction at Bitcoin height $newest, hVM at $hvm_height)"
    if c=$(bf_check_balance "$addr"); then
      expect_eq "checkBalance verdict" "$(bf_verdict "$c")" Ok
      expect_eq "sats = Esplora funded − spent" "$(bf_field "$c" 3)" "$((funded - spent_sum))"
      expect_eq "subject = keccak256(0x46 script)" "$(bf_field "$c" 4)" "$(cast keccak "$script")"
      expect_eq "script" "$(bf_field "$c" 8)" "$script"
      balance_ok=1
    else
      fail "checkBalance($addr): $c"
    fi
    break
  done
  [ "$balance_ok" = 1 ] || fail "no D-001 address was quiet enough to compare a balance with Esplora"

  local lo up
  if lo=$(bf_check_balance "$FX_BECH32") && up=$(bf_check_balance "$(tr '[:lower:]' '[:upper:]' <<<"$FX_BECH32")"); then
    expect_eq "upper-case bech32: same subject" "$(bf_field "$up" 4)" "$(bf_field "$lo" 4)"
    expect_eq "upper-case bech32: same fact id" "$(bf_field "$up" 1)" "$(bf_field "$lo" 1)"
    expect_eq "upper-case bech32: same sats" "$(bf_field "$up" 3)" "$(bf_field "$lo" 3)"
  else
    fail "checkBalance of two spellings: $lo $up"
  fi

  # -- 5. an undecodable address ----------------------------------------------------------------
  if c=$(bf_check_balance "$FX_BAD_ADDR"); then
    expect_eq "bad-checksum address verdict" "$(bf_verdict "$c")" BadAddress
  else
    fail "checkBalance(bad checksum): $c"
  fi

  # -- 6. gas of the record calls (eth_estimateGas; nothing is sent) ----------------------------
  local g
  if g=$(bf_estimate "$(cast calldata 'recordOutput(bytes32,uint16)' "$FX_UNSPENT_TXID" 0)"); then
    pass "eth_estimateGas recordOutput(unspent fixture): $g gas"
  else
    fail "eth_estimateGas recordOutput(unspent fixture): $g"
  fi
  if g=$(bf_estimate "$(cast calldata 'recordOutput(bytes32,uint16)' "$FX_SPENT_TXID" 1)"); then
    pass "eth_estimateGas recordOutput(spent fixture): $g gas"
  else
    fail "eth_estimateGas recordOutput(spent fixture): $g"
  fi
  if g=$(bf_estimate "$(cast calldata 'recordBalance(string)' "${FX_BALANCE_ADDRS[0]% *}")"); then
    pass "eth_estimateGas recordBalance(${FX_BALANCE_ADDRS[0]% *}): $g gas"
  else
    fail "eth_estimateGas recordBalance: $g"
  fi
  local notfound
  notfound=$(cast calldata 'NotRecordable(uint8)' 2)
  if g=$(bf_estimate "$(cast calldata 'recordOutput(bytes32,uint16)' 0x1111111111111111111111111111111111111111111111111111111111111111 0)"); then
    fail "eth_estimateGas recordOutput(made-up txid) should revert, estimated $g"
  elif [[ $g == *"${notfound#0x}"* ]]; then
    pass "eth_estimateGas recordOutput(made-up txid) reverts NotRecordable(NotFound)"
  else
    fail "eth_estimateGas recordOutput(made-up txid): unexpected error: $g"
  fi

  [ "$LIVE_FAILS" -eq "$fails_before" ]
}
