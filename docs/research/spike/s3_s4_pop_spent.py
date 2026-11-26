#!/usr/bin/env python3
"""S3 (PoP OP_RETURN) and S4 (spent flag): 0x48, with 0x42 btcTxByTxid as the comparison read.

  python3 -I docs/research/spike/s3_s4_pop_spent.py > docs/research/spike/out/s3-s4.txt

0x42 flags used: 00 3c 07 03 = outputs + output script + unspendable outputs + output spent flag,
up to 2^7 = 128 outputs, scripts cut to 2^(4+3) = 128 bytes.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hvmlib import (MAIN, call, cast_cmd, esplora, hb, last_header, out, output48, parse42, pc, res, rpc, u16)  # noqa: E402

POPS = [("d4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e", 5620225, 973746),
        ("c6835b0e6675122e8ccf103d361af4ef1c7d4883d46e48c1be91a858e66c6a23", 5734725, 975836)]
UNSPENT = ("43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4", 0)
SPENT = ("95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e", 1)
FLAGS = bytes.fromhex("003c0703")


def raw48(txid, vout, mx):
    data = "0x" + txid + u16(vout) + u16(mx)
    r = res(call(pc(0x48), data))
    out(f"$ {cast_cmd(pc(0x48), data)}\n{r}")
    return r


def raw42(txid, flags=FLAGS):
    data = "0x" + txid + flags.hex()
    r = res(call(pc(0x42), data))
    out(f"$ {cast_cmd(pc(0x42), data)}\n{r}")
    return r


def keystone_from_hemi(k):
    """The canonical 76-byte abbreviated keystone for block K, rebuilt as receipts sdk/src/keystone.ts does."""
    b = rpc(MAIN, "eth_getBlockByNumber", [hex(k), True])["result"]
    prev = rpc(MAIN, "eth_getBlockByNumber", [hex(k - 25), False])["result"]
    first = b["transactions"][0]
    l1 = int(first["input"][2 + 28 * 2: 2 + 36 * 2], 16)
    ab = (bytes([1]) + l1.to_bytes(4, "big") + k.to_bytes(4, "big") + hb(b["parentHash"])[:11]
          + hb(prev["hash"])[:12] + hb(b["stateRoot"]) + hb(b["hash"])[:12])
    return ab, b["hash"], first["input"][:10], l1


def main():
    r, h = last_header()
    out(f"# S3/S4 run. 0x44 at start: height {h['height']} hash {h['hash']}")

    out("\n# S3. PoP OP_RETURN outputs")
    for txid, k, height in POPS:
        tx = esplora(f"/tx/{txid}")
        vout = next(i for i, o in enumerate(tx["vout"]) if o["scriptpubkey_type"] == "op_return")
        spk = tx["vout"][vout]["scriptpubkey"]
        out(f"\n## PoP tx {txid} (Bitcoin block {tx['status']['block_height']}), keystone {k}")
        out(f"esplora: OP_RETURN is vout {vout}, {len(spk) // 2} bytes: {spk}")
        out("-- 0x48, max 100:")
        r48 = raw48(txid, vout, 100)
        out("-- 0x48, max 83:")
        raw48(txid, vout, 83)
        out("-- 0x42 (outputs, scripts, unspendable, spent; 128 outputs x 128 bytes):")
        r42 = raw42(txid)
        d = parse42(hb(r42), FLAGS) if r42.startswith("0x") and len(r42) > 2 else None
        out(f"0x42 parsed: {d}")
        ab, bhash, sel, l1 = keystone_from_hemi(k)
        out(f"Hemi block {k}: hash {bhash}; L1-info selector {sel}, L1 origin {l1}")
        out(f"rebuilt abbreviated keystone: {ab.hex()}")
        for src, script in (("0x48", output48(hb(r48))["script"] if r48 not in ("0x",) and r48.startswith("0x") else None),
                            ("0x42", d["outputs"][vout]["script"] if d else None)):
            if script is None:
                out(f"{src}: no script returned -> FAIL for this source")
                continue
            s = bytes.fromhex(script)
            ks = s[7:]
            checks = {
                "length 83": len(s) == 83,
                "prefix 6a4c5048454d49": s[:7].hex() == "6a4c5048454d49",
                "version 0x01": len(ks) > 0 and ks[0] == 1,
                f"[5:9] == {k}": int.from_bytes(ks[5:9], "big") == k,
                "[64:76] == block hash prefix": ks[64:76] == hb(bhash)[:12],
                "all 76 bytes == rebuilt keystone": ks == ab,
                "== Esplora script": script == spk,
            }
            out(f"{src}: keystone L2 {int.from_bytes(ks[5:9], 'big')}, L1 {int.from_bytes(ks[1:5], 'big')}, "
                f"[64:76] {ks[64:76].hex()} vs hash[0:12] {hb(bhash)[:12].hex()}")
            out(f"{src}: checks {checks} -> {'PASS' if all(checks.values()) else 'FAIL'}")

    out("\n# S4. Spent flag")
    for label, (txid, vout) in (("unspent fixture", UNSPENT), ("spent fixture", SPENT)):
        spends = esplora(f"/tx/{txid}/outspends")
        out(f"\n## {label} {txid} vout {vout}: esplora outspends[{vout}] = {spends[vout]}")
        out("-- 0x48, max 100:")
        r48 = raw48(txid, vout, 100)
        d48 = output48(hb(r48)) if r48.startswith("0x") and len(r48) > 2 else None
        out(f"0x48 flag byte: {('0x%02x' % d48['flagByte']) if d48 else 'none (empty answer)'}")
        out("-- 0x42 outputs with the spent flag:")
        r42 = raw42(txid)
        d = parse42(hb(r42), FLAGS)
        out(f"0x42 per-output spent bytes: {[o['spentByte'] for o in d['outputs']]}; this vout: 0x{d['outputs'][vout]['spentByte']:02x}; sats {d['outputs'][vout]['sats']}")
        out("-- 0x43 (is the tx itself indexed?):")
        data = "0x" + txid
        out(f"$ {cast_cmd(pc(0x43), data, gas=500000)}\n{res(call(pc(0x43), data, gas=500000))}")

    r, h = last_header()
    out(f"\n# 0x44 at end: height {h['height']} hash {h['hash']}")


if __name__ == "__main__":
    main()
