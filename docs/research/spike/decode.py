#!/usr/bin/env python3
"""Decoders for raw hVM precompile answers (layouts from op-geth core/vm/contracts.go).

  python3 -I docs/research/spike/decode.py header 0x<hex>        # 0x44 / 0x45
  python3 -I docs/research/spike/decode.py output 0x<hex>        # 0x48
  python3 -I docs/research/spike/decode.py input 0x<hex>         # 0x47
  python3 -I docs/research/spike/decode.py witness 0x<hex>       # 0x49
  python3 -I docs/research/spike/decode.py u64|u32 0x<hex>       # 0x40 / 0x43
  python3 -I docs/research/spike/decode.py utxos 0x<hex>         # 0x41
"""
import json
import sys


def b(h):
    h = h.strip().strip('"')
    if h.startswith("0x"):
        h = h[2:]
    return bytes.fromhex(h)


def header(r):
    if len(r) != 116:
        return {"error": f"length {len(r)}, expected 116"}
    return {
        "height": int.from_bytes(r[0:4], "big"),
        "hash": r[4:36].hex(),
        "version": "0x" + r[36:40].hex(),
        "prev": r[40:72].hex(),
        "merkle": r[72:104].hex(),
        "time": int.from_bytes(r[104:108], "big"),
        "bits": "0x" + r[108:112].hex(),
        "nonce": int.from_bytes(r[112:116], "big"),
    }


def output(r):
    if len(r) < 11:
        return {"error": f"length {len(r)}, too short"}
    full = int.from_bytes(r[8:10], "big")
    script = r[10:-1]
    return {
        "sats": int.from_bytes(r[0:8], "big"),
        "fullScriptLength": full,
        "returnedScriptBytes": len(script),
        "script": script.hex(),
        "flagByte": r[-1],
        "totalLength": len(r),
    }


def inp(r):
    if len(r) < 50:
        return {"error": f"length {len(r)}, too short"}
    n = int.from_bytes(r[44:46], "big")
    return {
        "witnessCount": int.from_bytes(r[0:2], "big"),
        "prevoutSats": int.from_bytes(r[2:10], "big"),
        "prevTxid": r[10:42].hex(),
        "prevVout": int.from_bytes(r[42:44], "big"),
        "scriptSigFullLength": n,
        "scriptSig": r[46:-4].hex(),
        "sequence": "0x" + r[-4:].hex(),
        "totalLength": len(r),
    }


def witness(r):
    if len(r) < 2:
        return {"error": f"length {len(r)}"}
    return {"fullLength": int.from_bytes(r[0:2], "big"), "item": r[2:].hex()}


def utxos(r):
    if not r:
        return {"error": "empty"}
    n = r[0]
    out = []
    for i in range(n):
        o = 1 + i * 42
        e = r[o:o + 42]
        out.append({"txid": e[0:32].hex(), "vout": int.from_bytes(e[32:34], "big"), "sats": int.from_bytes(e[34:42], "big")})
    return {"count": n, "utxos": out, "totalLength": len(r)}


def main():
    kind, h = sys.argv[1], sys.argv[2]
    r = b(h)
    if kind == "header":
        res = header(r)
    elif kind == "output":
        res = output(r)
    elif kind == "input":
        res = inp(r)
    elif kind == "witness":
        res = witness(r)
    elif kind == "utxos":
        res = utxos(r)
    elif kind in ("u64", "u32"):
        res = {"value": int.from_bytes(r, "big") if r else None, "length": len(r)}
    else:
        raise SystemExit("unknown kind")
    print(json.dumps(res))


if __name__ == "__main__":
    main()
