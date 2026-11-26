"""Compare the SDK's committed init code, runtime and ABI with a forge build.

usage: python3 -I sdk_vs_build.py <repo root> <forge out dir>
"""
import json
import re
import sys
from pathlib import Path

repo, out = Path(sys.argv[1]), Path(sys.argv[2])
names = {"BitcoinFacts": "BITCOIN_FACTS", "PopFinality": "POP_FINALITY", "FidelityBonds": "FIDELITY_BONDS"}
ok = True
for c, prefix in names.items():
    ts = (repo / "sdk/src/abi" / f"{c}.ts").read_text()
    art = json.loads((out / f"{c}.sol" / f"{c}.json").read_text())
    init = re.search(rf'export const {prefix}_INIT_CODE = "(0x[0-9a-f]+)"', ts).group(1)
    rt = re.search(rf'export const {prefix}_RUNTIME = "(0x[0-9a-f]+)"', ts).group(1)
    abi_m = re.search(r"export const \w+Abi = (\[.*?\]) as const;", ts, re.S)
    abi_ts = json.loads(abi_m.group(1))
    same_init = init == art["bytecode"]["object"]
    same_rt = rt == art["deployedBytecode"]["object"]
    same_abi = json.dumps(abi_ts, sort_keys=True) == json.dumps(art["abi"], sort_keys=True)
    print(f"{c}: init {same_init} runtime {same_rt} abi {same_abi} (abi entries {len(abi_ts)} vs {len(art['abi'])})")
    ok &= same_init and same_rt and same_abi
print("ALL MATCH" if ok else "MISMATCH")
