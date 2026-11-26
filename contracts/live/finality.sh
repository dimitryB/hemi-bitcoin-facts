# PopFinality against Hemi's real hVM precompiles. Sourced by check-live.sh, which defines RPC, CHAIN_ID and the
# helpers in lib.sh. Read-only: eth_call and eth_estimateGas with PopFinality placed at its CREATE2 address by state
# override, its storage set by stateDiff in the same override, and Esplora GETs. Nothing is signed or sent.
#
#   ./check-live.sh mainnet finality
#
# First, checkpoints on the real chain: a keystone about 30 blocks back reads through blockhash and one about 1,000
# back through the EIP-2935 history contract, each equal to eth_getBlockByNumber's hash, with eth_estimateGas of
# checkpoint(K) for both. Then, for each PoP fixture (keystone 5620225 in d4ed6ec2…845e, keystone 5734725 in
# c6835b0e…6a23):
#   1. the keystone is outside every block hash window on the real chain: checkCheckpoint is OutsideWindow
#   2. with its checkpoint slot set by state override to block K's real hash prefix (read by eth_getBlockByNumber),
#      checkPublication on the real 0x42 answer is Ok: L2 number K, the block hash prefix, version 1, an 83-byte
#      "HEMI" script, and 0x43's count equal to Bitcoin's own (Esplora tip − height + 1, ±1)
#   3. the real data fails where it should: the other keystone's number is WrongKeystone, the P2PKH output is
#      WrongLength, a wrong checkpoint is WrongBlockHash
#   4. eth_estimateGas of recordPublication succeeds with that override (nothing is sent)
#   5. with the publication's three slots and K's best pointer set by stateDiff too (a simulated record does not
#      persist between eth_calls): btcConfirmationsVia of a block K covers is Ok, isBtcFinalVia is true through this
#      publication and false for block K + 1 or another vout, and the anchored isBtcAnchored reads K's best
#   6. `hbf finality status` runs the receipts SDK's PoP finality reader on the same block: it finds this transaction,
#      the SDK confirms all 76 bytes equal the keystone rebuilt from Hemi RPC, and isBtcFinalVia through it agrees

PF_SALT_STRING="hemi-bitcoin-facts/PopFinality/v1"
PF_VERDICTS=(Ok NotKeystone NotProduced OutsideWindow NoBitcoinView NotFound VoutTooHigh WrongLength WrongPrefix
  Inconsistent WrongVersion WrongKeystone WrongBlockHash NoConfirmations NotCovering NotRecorded)
PF_CHECK_T='(uint8,bytes32,uint32,uint32,bytes32,bytes12,bool,(uint8,uint32,uint32,bytes11,bytes12,bytes32,bytes12),bytes,bool,bool,bool,bytes32,uint16,uint32)'
# keystone, PoP txid, vout, Bitcoin height of the PoP transaction, a Hemi block the keystone covers
PF_FIXTURES=(
  "5620225 0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e 1 973746 5620209"
  "5734725 0xc6835b0e6675122e8ccf103d361af4ef1c7d4883d46e48c1be91a858e66c6a23 1 975836 5734701"
)
PF_FROM=0x000000000000000000000000000000000000dEaD

pf_verdict() { printf '%s' "${PF_VERDICTS[$1]:-?}"; }

# pf_slot_add <slot> <n>: slot + n (n small; a carry out of the low 60 bits is refused rather than mis-computed).
pf_slot_add() {
  local h=${1#0x} lo
  lo=$((16#${h:49:15} + $2))
  ((lo < 16#1000000000000000)) || live_die "pf_slot_add: carry"
  printf '0x%s%015x' "${h:0:49}" "$lo"
}

# pf_overrides <stateDiff-json>: the current overrides with this stateDiff on PopFinality (code kept if placed).
pf_overrides() {
  overrides_json | jq -c --arg a "$ADDR_PopFinality" --argjson sd "$1" '.[$a] = ((.[$a] // {}) + {stateDiff: $sd})'
}

# pf_check <keystone> <txid> <vout> <overrides>: the decoded PublicationCheck as a JSON array, or fails.
pf_check() {
  local ret
  ret=$(call "$ADDR_PopFinality" "$(cast calldata 'checkPublication(uint256,bytes32,uint16)' "$1" "$2" "$3")" "$4") || {
    printf '%s' "$ret"
    return 1
  }
  cast decode-abi --json "f()($PF_CHECK_T)" "$ret" | jq -c '.data[0]'
}

live_finality() {
  local fails_before=$LIVE_FAILS ic salt hdr hvm_height hvm_hash btc_tip
  salt=$(cast keccak "$PF_SALT_STRING")
  ic=$(initcode PopFinality)
  place PopFinality "$salt" "$ic"
  hdr=$(call 0x0000000000000000000000000000000000000044 0x)
  hvm_height=$(cast to-dec "0x${hdr:2:8}")
  hvm_hash=0x${hdr:10:64}
  btc_tip=$(esplora /blocks/tip/height) || btc_tip=""
  [[ $btc_tip =~ ^[0-9]+$ ]] || { echo "   NOTE: no Esplora tip; confirmations not compared with Bitcoin"; btc_tip=""; }
  local sdk_ok=1
  if ! command -v node >/dev/null || [ ! -d "$ROOT/sdk/node_modules" ]; then
    sdk_ok=0
    echo "   NOTE: node or sdk/node_modules missing (cd sdk && npm install); the receipts-reader comparison is skipped"
    LIVE_SKIPS+=("finality: the receipts-reader comparison (cd sdk && npm install)")
  fi

  # -- 0. checkpoints on the real chain: a recent keystone by blockhash, an older one by EIP-2935 -------
  local entry k txid vout pop_height block blk hash prefix cp_slot cp_val sd ov v other how head kr ko g c pfx
  local b want label sig a1 a2 a3 a4
  head=$(cast block-number --rpc-url "$RPC")
  kr=$(((head - 30) / 25 * 25))
  ko=$(((head - 1000) / 25 * 25))
  for c in "$kr blockhash" "$ko EIP-2935"; do
    read -r k how <<<"$c"
    if pfx=$(call "$ADDR_PopFinality" "$(cast calldata 'checkCheckpoint(uint256)' "$k")" "$(overrides_json)"); then
      live_pace
      hash=$(cast rpc eth_getBlockByNumber "$(cast to-hex "$k")" false --rpc-url "$RPC" | jq -r .hash)
      expect_eq "checkCheckpoint($k), $((head - k)) blocks back ($how): verdict" "$(pf_verdict "$(cast to-dec "0x${pfx:2:64}")")" Ok
      expect_eq "  prefix = eth_getBlockByNumber's hash [0:12]" "0x${pfx:66:24}" "0x${hash:2:24}"
    else
      fail "checkCheckpoint($k): $pfx"
    fi
    if g=$(rpc eth_estimateGas "{\"from\":\"$PF_FROM\",\"to\":\"$ADDR_PopFinality\",\"data\":\"$(cast calldata 'checkpoint(uint256)' "$k")\"}" latest "$(overrides_json)"); then
      pass "eth_estimateGas checkpoint($k) via $how: $(cast to-dec "$g") gas"
    else
      fail "eth_estimateGas checkpoint($k): $g"
    fi
  done

  for entry in "${PF_FIXTURES[@]}"; do
    read -r k txid vout pop_height block <<<"$entry"
    echo "   keystone $k, PoP ${txid:0:10}…${txid: -4} vout $vout (Bitcoin block $pop_height)"
    # lib.sh's rpc strips quotes, which a JSON object needs; this one read goes to cast directly, paced the same.
    live_pace
    blk=$(cast rpc eth_getBlockByNumber "$(cast to-hex "$k")" false --rpc-url "$RPC" 2>&1) || { fail "eth_getBlockByNumber $k: $blk"; continue; }
    hash=$(jq -r .hash <<<"$blk")
    [[ $hash =~ ^0x[0-9a-f]{64}$ ]] || { fail "block $k: no hash in $blk"; continue; }
    prefix=0x${hash:2:24}
    echo "   block $k: hash $hash (eth_getBlockByNumber)"

    # -- 1. outside every window on the real chain ----------------------------------------------
    if c=$(call "$ADDR_PopFinality" "$(cast calldata 'checkCheckpoint(uint256)' "$k")" "$(overrides_json)"); then
      expect_eq "checkCheckpoint($k) on the real chain (beyond blockhash and EIP-2935)" \
        "$(pf_verdict "$(cast to-dec "0x${c:2:64}")")" OutsideWindow
    else
      fail "checkCheckpoint($k): $c"
    fi

    # -- 2. the checkpoint slot by state override; the real 0x42 answer passes --------------------
    cp_slot=$(cast index uint256 "$k" 0)
    cp_val=$(printf '0x%024x%016x%s' 0 1 "${prefix:2}")
    sd="{\"$cp_slot\":\"$cp_val\"}"
    ov=$(pf_overrides "$sd")
    # 0x44 read just before and just after the check: a Bitcoin block can land in between (the run takes minutes)
    local h_before h_after as_of
    h_before=$(cast to-dec "0x$(call 0x0000000000000000000000000000000000000044 0x | cut -c3-10)")
    if c=$(pf_check "$k" "$txid" "$vout" "$ov"); then
      h_after=$(cast to-dec "0x$(call 0x0000000000000000000000000000000000000044 0x | cut -c3-10)")
      expect_eq "checkPublication verdict (checkpoint $prefix by state override)" "$(pf_verdict "$(jq -r '.[0]' <<<"$c")")" Ok
      expect_eq "  L2 number [5:9]" "$(jq -r '.[7][2]' <<<"$c")" "$k"
      expect_eq "  block hash prefix [64:76] = block $k's" "$(jq -r '.[7][6]' <<<"$c")" "$prefix"
      expect_eq "  version" "$(jq -r '.[7][0]' <<<"$c")" 1
      expect_eq "  abrev = the 83-byte script after 6a4c5048454d49" "$(( ($(jq -r '.[8]' <<<"$c" | wc -c) - 3) / 2 ))" 76
      as_of=$(jq -r '.[3]' <<<"$c")
      if [ "$as_of" -ge "$h_before" ] && [ "$as_of" -le "$h_after" ]; then
        pass "  as of = 0x44's height: $as_of (0x44 read $h_before before, $h_after after)"
      else
        fail "  as of: $as_of, 0x44 read $h_before before and $h_after after"
      fi
      expect_eq "  publication id" "$(jq -r '.[1]' <<<"$c")" "$(cast keccak "$(cast abi-encode 'f(bytes32,bytes32,bytes32)' \
        "$(cast keccak hemi-bitcoin-facts/publication)" "$(cast keccak "$(printf '0x%08x%s%04x' "$k" "${txid:2}" "$vout")")" \
        "$(jq -r '.[4]' <<<"$c")")")"
      local confs
      confs=$(jq -r '.[2]' <<<"$c")
      if [ -n "$btc_tip" ]; then
        local want=$((btc_tip - pop_height + 1)) d
        d=$((confs - want))
        if [ "${d#-}" -le 1 ]; then pass "  confirmations: $confs = Bitcoin's own count $want (Esplora tip $btc_tip)"; else fail "  confirmations: $confs, Bitcoin's own count is $want"; fi
      else
        pass "  confirmations: $confs"
      fi
    else
      fail "checkPublication($k): $c"
    fi

    # -- 3. and fails where it should ------------------------------------------------------------
    for other in 5620225 5734725; do
      [ "$other" = "$k" ] && continue
      local osd
      osd="{\"$(cast index uint256 "$other" 0)\":\"$cp_val\"}"
      if c=$(pf_check "$other" "$txid" "$vout" "$(pf_overrides "$osd")"); then
        expect_eq "  offered as keystone $other's" "$(pf_verdict "$(jq -r '.[0]' <<<"$c")")" WrongKeystone
      else
        fail "checkPublication($other): $c"
      fi
    done
    if c=$(pf_check "$k" "$txid" 0 "$ov"); then
      expect_eq "  its P2PKH output (vout 0)" "$(pf_verdict "$(jq -r '.[0]' <<<"$c")")" WrongLength
    else
      fail "checkPublication vout 0: $c"
    fi
    if c=$(pf_check "$k" "$txid" "$vout" "$(pf_overrides "{\"$cp_slot\":\"$(printf '0x%024x%016x%024x' 0 1 1)\"}")"); then
      expect_eq "  against a wrong checkpoint" "$(pf_verdict "$(jq -r '.[0]' <<<"$c")")" WrongBlockHash
    else
      fail "checkPublication wrong checkpoint: $c"
    fi

    # -- 4. the record call estimates (nothing is sent) --------------------------------------------
    if g=$(rpc eth_estimateGas "{\"from\":\"$PF_FROM\",\"to\":\"$ADDR_PopFinality\",\"data\":\"$(cast calldata 'recordPublication(uint256,bytes32,uint16)' "$k" "$txid" "$vout")\"}" latest "$ov"); then
      pass "eth_estimateGas recordPublication($k): $(cast to-dec "$g") gas"
    else
      fail "eth_estimateGas recordPublication($k): $g"
    fi

    # -- 5. the stored publication by stateDiff; the Hemi PoP reading (Via) and the anchored one ----
    # _publications (slot 1) is keyed by the subject keccak256(uint32 K ‖ txid ‖ uint16 vout); _best (slot 2) holds
    # K's best subject. Slots from `forge inspect PopFinality storageLayout`.
    local base subject pub_sd pov r conf_now
    subject=$(cast keccak "$(printf '0x%08x%s%04x' "$k" "${txid:2}" "$vout")")
    base=$(cast index bytes32 "$subject" 1)
    pub_sd=$(jq -nc --arg cs "$cp_slot" --arg cv "$cp_val" --arg s0 "$base" --arg v0 "$txid" \
      --arg s1 "$(pf_slot_add "$base" 1)" --arg v1 "$hvm_hash" \
      --arg s2 "$(pf_slot_add "$base" 2)" --arg v2 "$(printf '0x%028x%04x%08x%08x%016x' 0 "$vout" "${confs:-1}" "$hvm_height" 1)" \
      --arg sb "$(cast index uint256 "$k" 2)" --arg vb "$subject" \
      '{($cs): $cv, ($s0): $v0, ($s1): $v1, ($s2): $v2, ($sb): $vb}')
    pov=$(pf_overrides "$pub_sd")
    if r=$(call "$ADDR_PopFinality" "$(cast calldata 'publicationOf(uint256,bytes32,uint16)' "$k" "$txid" "$vout")" "$pov"); then
      expect_eq "  publicationOf($k, ${txid:0:10}…, $vout).btcTxid by stateDiff" "0x${r:2:64}" "$txid"
    else
      fail "publicationOf: $r"
    fi
    if r=$(call "$ADDR_PopFinality" "$(cast calldata 'bestPublicationOf(uint256)' "$k")" "$pov"); then
      expect_eq "  bestPublicationOf($k).btcTxid (the best pointer)" "0x${r:2:64}" "$txid"
    else
      fail "bestPublicationOf: $r"
    fi
    if r=$(call "$ADDR_PopFinality" "$(cast calldata 'btcConfirmationsVia(uint256,uint256,bytes32,uint16)' "$block" "$k" "$txid" "$vout")" "$pov"); then
      conf_now=$(cast to-dec "0x${r:66:64}")
      expect_eq "btcConfirmationsVia(block $block, keystone $k, this publication) verdict" "$(pf_verdict "$(cast to-dec "0x${r:2:64}")")" Ok
      if [ "$conf_now" -ge 9 ]; then pass "  confirmations: $conf_now (>= 9)"; else fail "  confirmations: $conf_now"; fi
    else
      fail "btcConfirmationsVia: $r"
    fi
    for c in "$block $vout 1 isBtcFinalVia(block $block, keystone $k, this publication): Hemi PoP finality" \
      "$((k + 1)) $vout 0 isBtcFinalVia(block $((k + 1)), keystone $k): not covered" \
      "$block 0 0 isBtcFinalVia(block $block, keystone $k, vout 0): not stored"; do
      read -r b v want label <<<"$c"
      if r=$(call "$ADDR_PopFinality" "$(cast calldata 'isBtcFinalVia(uint256,uint256,bytes32,uint16)' "$b" "$k" "$txid" "$v")" "$pov"); then
        expect_eq "$label" "$(cast to-dec "$r")" "$want"
      else
        fail "isBtcFinalVia: $r"
      fi
    done
    if r=$(call "$ADDR_PopFinality" "$(cast calldata 'isBtcAnchored(uint256,uint256)' "$block" "$k")" "$pov"); then
      expect_eq "isBtcAnchored(block $block, keystone $k): anchored, through K's best" "$(cast to-dec "$r")" 1
    else
      fail "isBtcAnchored: $r"
    fi
    if r=$(call "$ADDR_PopFinality" "$(cast calldata 'isBtcAnchored(uint256,uint256)' "$((k + 1))" "$k")" "$pov"); then
      expect_eq "isBtcAnchored(block $((k + 1)), keystone $k): not covered" "$(cast to-dec "$r")" 0
    else
      fail "isBtcAnchored(K+1): $r"
    fi
    # what a consumer contract pays (as a transaction's total, so 21,000 of it is the intrinsic cost)
    for c in "isBtcFinalVia(uint256,uint256,bytes32,uint16) $block $k $txid $vout" "isBtcAnchored(uint256,uint256) $block $k" \
      "checkPublication(uint256,bytes32,uint16) $k $txid $vout"; do
      read -r sig a1 a2 a3 a4 <<<"$c"
      if g=$(rpc eth_estimateGas "{\"from\":\"$PF_FROM\",\"to\":\"$ADDR_PopFinality\",\"data\":\"$(cast calldata "$sig" $a1 $a2 ${a3:-} ${a4:-})\"}" latest "$pov"); then
        pass "eth_estimateGas ${sig%%(*}: $(cast to-dec "$g") gas"
      else
        fail "eth_estimateGas ${sig%%(*}: $g"
      fi
    done

    # -- 6. the receipts SDK's reader on the same block --------------------------------------------
    if [ "$sdk_ok" = 1 ]; then
      local ovfile st
      ovfile=$(mktemp "${TMPDIR:-/tmp}/hbf-finality-override.XXXXXX")
      printf '%s' "$pov" >"$ovfile"
      echo "   receipts SDK reader on block $block (Esplora; may take a minute)…"
      if st=$(cd "$ROOT/sdk" && node bin/hbf.mjs finality status --block "$block" --keystone "$k" --rpc "$RPC" \
        --contract "$ADDR_PopFinality" --state-override "$ovfile" --json 2>&1); then
        expect_eq "  receipts SDK reader source" "$(jq -r .reader.source <<<"$st")" bitcoin
        echo "   reader: $(jq -r '"\(.reader.btcConfirmations) confirmations via keystone \(.reader.viaKeystone), tx \(.reader.popTxid)"' <<<"$st")"
        expect_eq "  reader final (>= 9)" "$(jq -r .readerFinal <<<"$st")" true
        expect_eq "  hbf finality status: the exact-match publication is the reader's" \
          "$(jq -r '"\(.exact.source) \(.exact.keystone) \(.exact.btcTxid) \(.exact.vout)"' <<<"$st")" "reader $k $txid $vout"
        expect_eq "  its 76 bytes equal the keystone rebuilt from Hemi RPC" "$(jq -r .exact.match.exact <<<"$st")" true
        expect_eq "  isBtcFinalVia through it (Hemi PoP finality)" "$(jq -r .exact.contract.final <<<"$st")" true
        expect_eq "  hbf finality status final (exact match checked, and isBtcFinalVia)" "$(jq -r .final <<<"$st")" true
        expect_eq "  isBtcAnchored (anchored)" "$(jq -r .anchored.final <<<"$st")" true
        expect_eq "  the reader and isBtcFinalVia agree" "$(jq -r .agree <<<"$st")" true
      else
        fail "hbf finality status: $(tail -c 400 <<<"$st")"
      fi
      rm -f "$ovfile"
    fi
  done

  [ "$LIVE_FAILS" -eq "$fails_before" ]
}
