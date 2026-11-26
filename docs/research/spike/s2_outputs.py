#!/usr/bin/env python3
"""S2 (and the 0x48 half of S3/S4): raw 0x48 btcOutputByTxid against Esplora.

  python3 -I docs/research/spike/s2_outputs.py > docs/research/spike/out/s2-outputs.txt

Input: txid (32, display order) + output index (2, BE) + max script bytes (2, BE).
Output: sats (8) + full script length (2) + script cut to max + flag (1).
For each case it prints the copy-pasteable cast command, the raw answer, Esplora's view and a verdict.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hvmlib import (BLOCKSTREAM, MAIN, call, cast_cmd, esplora, hb, last_header, out, output48, pc, res, u16)  # noqa: E402

FIXTURE = "43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4"
SPENT = "95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e"
WHITEPAPER = "54e48e5f5c656b26c3bca14a8c95aa583d07ebe84dde3b7dd4a78f4e4186e713"  # 948 outputs, 945 x 201-byte bare multisig
BATCH55 = "6ac09b111f3819aa66a6d61a467c84f5f023bf30021bcf912038e9162f5a075b"  # 55 outputs, block 976790
BATCH42 = "3ba6a454b345e429ffccdf542428e4d6bf462cd9b520d0ba22006af03a3b2a46"  # 42 outputs, block 976800
BLOCK1_CB = "0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098"  # block 1 coinbase, 67-byte P2PK
POP = "d4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e"

TX_CACHE = {}


def esplora_tx(txid):
    if txid not in TX_CACHE:
        TX_CACHE[txid] = (esplora(f"/tx/{txid}"), esplora(f"/tx/{txid}/outspends"))
    return TX_CACHE[txid]


tally = {"match": 0, "mismatch": 0}


def case(label, txid, vout, mx, note=""):
    data = "0x" + txid + u16(vout) + u16(mx)
    raw = res(call(pc(0x48), data))
    tx, spends = esplora_tx(txid)
    out(f"\n## {label}{(' - ' + note) if note else ''}")
    out(f"$ {cast_cmd(pc(0x48), data)}")
    out(raw)
    if vout >= len(tx["vout"]):
        exp = None
        out(f"esplora: tx has {len(tx['vout'])} outputs; vout {vout} does not exist")
    else:
        o = tx["vout"][vout]
        spent = spends[vout].get("spent")
        exp = o
        out(f"esplora: value {o['value']} type {o['scriptpubkey_type']} script length {len(o['scriptpubkey']) // 2} spent {spent}")
    d = output48(hb(raw)) if raw.startswith("0x") else None
    if d is None:
        reason = "empty" if raw == "0x" else raw
        expected_empty = exp is None or spends[vout].get("spent") or exp["scriptpubkey_type"] == "op_return"
        verdict = "MATCH (empty, as source predicts for a spent, unspendable or missing output)" if expected_empty else "MISMATCH (empty for an unspent output)"
        tally["match" if expected_empty else "mismatch"] += 1
        out(f"0x48: {reason} -> {verdict}")
        return
    full = exp["scriptpubkey"]
    want = full[: 2 * mx]
    ok = (d["sats"] == exp["value"] and d["fullScriptLength"] == len(full) // 2 and d["script"] == want
          and d["returnedScriptBytes"] == min(mx, len(full) // 2))
    tally["match" if ok else "mismatch"] += 1
    out(f"0x48: sats {d['sats']} fullScriptLength {d['fullScriptLength']} returned {d['returnedScriptBytes']} bytes flag 0x{d['flagByte']:02x}")
    out(f"      script {d['script'][:80]}{'...' if len(d['script']) > 80 else ''}")
    out(f"-> {'MATCH' if ok else 'MISMATCH'} (value, full length, script bytes{' cut to ' + str(mx) if mx < len(full) // 2 else ''})")


def bad_input(label, data):
    raw = res(call(pc(0x48), data))
    out(f"\n## {label}\n$ {cast_cmd(pc(0x48), data)}\n{raw}")


def main():
    r, h = last_header()
    out(f"# S2 run. 0x44 at start: height {h['height']} hash {h['hash']}")
    tip = esplora("/blocks/tip/height", as_json=False)
    out(f"# Esplora ({BLOCKSTREAM}) tip at start: {tip}")

    out("\n# A. The unspent fixture")
    case("A1 fixture vout 0, max 100", FIXTURE, 0, 100, "brief: 1000 sats, 0x001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831")
    case("A2 fixture vout 0, max 22 (exact)", FIXTURE, 0, 22)
    case("A3 fixture vout 0, max 10 (truncation)", FIXTURE, 0, 10)
    case("A4 fixture vout 0, max 0", FIXTURE, 0, 0)
    case("A5 fixture vout 1 (change), max 100", FIXTURE, 1, 100)
    case("A6 fixture vout 2 (does not exist)", FIXTURE, 2, 100)

    out("\n# B. Output index >= 32 and scripts > 64 bytes: the whitepaper tx (948 outputs, 201-byte bare multisig)")
    for v in (0, 31, 32, 33, 255, 256, 500, 944, 945, 946, 947):
        case(f"B whitepaper vout {v}, max 300", WHITEPAPER, v, 300)
    case("B whitepaper vout 32, max 64 (truncation of a 201-byte script)", WHITEPAPER, 32, 64)
    case("B whitepaper vout 32, max 200 (one byte short)", WHITEPAPER, 32, 200)
    case("B whitepaper vout 32, max 201 (exact)", WHITEPAPER, 32, 201)
    case("B whitepaper vout 32, max 65535", WHITEPAPER, 32, 65535)
    case("B whitepaper vout 948 (does not exist)", WHITEPAPER, 948, 300)

    out("\n# C. Index >= 32 in recent batch transactions (all five address types, OP_RETURN)")
    for v in range(30, 55):
        case(f"C 6ac09b11 vout {v}, max 100", BATCH55, v, 100)
    for v in range(30, 42):
        case(f"C 3ba6a454 vout {v}, max 100", BATCH42, v, 100)

    out("\n# D. Other scripts longer than 64 bytes")
    case("D1 block 1 coinbase vout 0, 67-byte P2PK, max 100", BLOCK1_CB, 0, 100)
    case("D2 PoP tx vout 1, 83-byte OP_RETURN, max 100", POP, 1, 100)

    out("\n# E. Malformed input")
    bad_input("E1 35-byte input (max length missing one byte)", "0x" + FIXTURE + "0000" + "00")
    bad_input("E2 37-byte input", "0x" + FIXTURE + "0000006400")
    bad_input("E3 txid in internal (reversed) byte order", "0x" + bytes.fromhex(FIXTURE)[::-1].hex() + "0000" + "0064")
    bad_input("E4 spent fixture vout 1 (spent at block 975330)", "0x" + SPENT + "0001" + "0064")

    r, h = last_header()
    out(f"\n# 0x44 at end: height {h['height']} hash {h['hash']}")
    out(f"# tally (cases with an Esplora comparison): {tally}")


if __name__ == "__main__":
    main()
