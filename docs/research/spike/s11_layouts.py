#!/usr/bin/env python3
"""D-011 support: live checks of the layouts and failure modes read from source, for 0x41, 0x42, 0x46, 0x47, 0x49.

  python3 -I docs/research/spike/s11_layouts.py > docs/research/spike/out/s11-layouts.txt
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hvmlib import (MAIN, call, cast_cmd, esplora, hb, out, parse42, pc, res, u16)  # noqa: E402

U = "43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4"   # 1 P2WPKH input (2 witness items)
POP = "d4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e"  # PoP tx, P2PKH input(s)?
CB1 = "0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098"  # block 1 coinbase
TAPROOT_SPEND = "95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e"  # 1 P2TR key-path input
PROBE = "0x51ce000000000000000000000000000000000001"
CODE = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "probe-runtime.hex")).read().strip()


def raw(a, data):
    r = res(call(pc(a), data))
    out(f"$ {cast_cmd(pc(a), data)}\n{r}")
    return r


def probe(target, inp, cap):
    data = bytes.fromhex(inp[2:])
    enc = ("0xe4a8012e" + target[2:].rjust(64, "0") + format(0x60, "064x") + format(cap, "064x")
           + format(len(data), "064x") + data.hex() + "00" * ((32 - len(data) % 32) % 32))
    r = res(call(PROBE, enc, override={PROBE: {"code": CODE}}))
    b = bytes.fromhex(r[2:])
    ok, used, off = (int.from_bytes(b[i * 32:(i + 1) * 32], "big") for i in range(3))
    ln = int.from_bytes(b[off:off + 32], "big")
    return bool(ok), used, "0x" + b[off + 32:off + 32 + ln].hex()


def main():
    out("# 0x46 btcAddrToScript")
    for a in ("bc1qv6v32p9kw0az6lv6mz62famwf5acajp3wyntsa", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
              "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "bc1qwqdg6squsna38e46795at95yu9atm8azzmyvckulcc7kytlcckxswvvzej",
              "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297"):
        r = raw(0x46, "0x" + a.encode().hex())
        out(f"  {a} -> script {r}")
    bad = "bc1qv6v32p9kw0az6lv6mz62famwf5acajp3wyntsb"  # last character changed: bad checksum
    r = raw(0x46, "0x" + bad.encode().hex())
    out(f"  bad checksum {bad} -> {r}")
    out(f"  through the probe, cap 30000: {probe(pc(0x46), '0x' + bad.encode().hex(), 30000)}  (ok, used, ret)")
    out(f"  23-byte input through the probe: {probe(pc(0x46), '0x' + ('x' * 23).encode().hex(), 30000)}")
    out(f"  201-byte input through the probe: {probe(pc(0x46), '0x' + ('1' * 201).encode().hex(), 30000)}")
    out(f"  0x40 with the bad-checksum address, probe cap 60000: {probe(pc(0x40), '0x' + bad.encode().hex(), 60000)}")

    out("\n# 0x41 btcUtxosAddrList: fixture address, page 0, size 10")
    addr = "bc1qv6v32p9kw0az6lv6mz62famwf5acajp3wyntsa"
    r = raw(0x41, "0x" + addr.encode().hex() + "000000" + "0a")
    b = hb(r)
    n = b[0] if b else None
    ents = [(b[1 + i * 42:33 + i * 42].hex(), int.from_bytes(b[33 + i * 42:35 + i * 42], "big"), int.from_bytes(b[35 + i * 42:43 + i * 42], "big")) for i in range(n or 0)]
    out(f"  count {n}: {ents}")
    out(f"  esplora /address/{addr}/utxo: {[(u['txid'], u['vout'], u['value']) for u in esplora(f'/address/{addr}/utxo')]}")
    r = raw(0x41, "0x" + addr.encode().hex() + "000001" + "0a")
    out(f"  page 1 -> {r}")
    out("## is the 3-byte 'page' a page number or an offset? The genesis address has thousands of UTXOs:")
    g = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
    pages = {}
    for pg, size in ((0, 3), (1, 3), (3, 3)):
        r = raw(0x41, "0x" + g.encode().hex() + format(pg, "06x") + format(size, "02x"))
        b = hb(r)
        pages[pg] = [(b[1 + i * 42:33 + i * 42].hex()[:16], int.from_bytes(b[33 + i * 42:35 + i * 42], "big")) for i in range(b[0])] if b else []
        out(f"  page {pg} size {size}: {pages[pg]}")
    out(f"  -> page 1 starts at entry {'1 (offset semantics)' if pages[1] and pages[1][0] == pages[0][1] else '3 (page semantics)' if pages[3] and pages[1] and pages[1][0] != pages[0][1] else '?'}")

    out("\n# 0x47 btcInputByTxid: txid + input index (2) + max scriptSig bytes (2)")
    for txid, idx, mx, note in ((U, 0, 100, "P2WPKH spend: Esplora shows 2 witness items"),
                                (TAPROOT_SPEND, 0, 100, "P2TR key-path spend: 1 witness item"),
                                (POP, 0, 200, "PoP tx input 0"), (POP, 0, 10, "PoP tx input 0, scriptSig cut to 10"),
                                (CB1, 0, 100, "block 1 coinbase input (no source tx)"), (U, 1, 100, "input index out of range")):
        tx = esplora(f"/tx/{txid}")
        out(f"\n## {txid[:8]} input {idx}, max {mx}: {note}")
        r = raw(0x47, "0x" + txid + u16(idx) + u16(mx))
        if idx < len(tx["vin"]):
            v = tx["vin"][idx]
            out(f"  esplora: prevout {v.get('txid')}:{v.get('vout')} value {(v.get('prevout') or {}).get('value')} "
                f"scriptSig {v.get('scriptsig')} ({len(v.get('scriptsig', '')) // 2} bytes) witness items {len(v.get('witness') or [])} sequence {v.get('sequence'):#010x}")
        b = hb(r)
        if len(b) >= 50:
            sl = int.from_bytes(b[44:46], "big")
            out(f"  0x47: witnessCount {int.from_bytes(b[0:2], 'big')} prevoutSats {int.from_bytes(b[2:10], 'big')} prevTxid {b[10:42].hex()} "
                f"prevVout {int.from_bytes(b[42:44], 'big')} scriptSigLen {sl} scriptSig {b[46:-4].hex()} sequence 0x{b[-4:].hex()}")

    out("\n# 0x49 btcTxGetInputWitness: txid + input index (2) + witness index (2) + max bytes (2)")
    for txid, idx, w in ((U, 0, 0), (U, 0, 1), (TAPROOT_SPEND, 0, 0)):
        tx = esplora(f"/tx/{txid}")
        out(f"## {txid[:8]} input {idx} witness {w}: esplora item {(tx['vin'][idx].get('witness') or [None, None])[w]}")
        raw(0x49, "0x" + txid + u16(idx) + u16(w) + u16(200))

    out("\n# 0x42 btcTxByTxid, every flag on: 7f bc 3f 0f (block, version, sizes, locktime, inputs+source+scriptSig+seq,")
    out("#   outputs+script+unspendable+spent; up to 128 inputs/outputs, 128-byte scripts)")
    for txid in (U, POP, TAPROOT_SPEND):
        flags = bytes.fromhex("7fbc3f0f")
        tx = esplora(f"/tx/{txid}")
        out(f"\n## {txid}: esplora block {tx['status']['block_hash']} version {tx['version']} size {tx['size']} weight {tx['weight']} locktime {tx['locktime']}")
        r = raw(0x42, "0x" + txid + flags.hex())
        out(f"  parsed: {parse42(hb(r), flags) if len(r) > 2 else 'EMPTY'}")
    out("\n## coinbase with inputs requested (source tx of a coinbase input does not exist):")
    r = raw(0x42, "0x" + CB1 + "04000000")
    out("## coinbase without inputs (outputs only):")
    r = raw(0x42, "0x" + CB1 + "003c0703")
    out(f"  parsed: {parse42(hb(r), bytes.fromhex('003c0703')) if len(r) > 2 else 'EMPTY'}")
    out("## 0x42 maxOutputs exponent 0 (1 output) on the 948-output whitepaper tx, script cap 16 bytes:")
    r = raw(0x42, "0x" + "54e48e5f5c656b26c3bca14a8c95aa583d07ebe84dde3b7dd4a78f4e4186e713" + "003c0000")
    out(f"  parsed: {parse42(hb(r), bytes.fromhex('003c0000'))}")


if __name__ == "__main__":
    main()
