"""Independent derivation of genesis coinbase txids (display order) and genesis block hashes.

Builds each coinbase exactly as Bitcoin Core's CreateGenesisBlock does (src/kernel/chainparams.cpp), double-SHA256s
it, and checks the block header built on it hashes to the genesis hash Core asserts (which also carries the PoW).
"""
import hashlib
import struct


def sha256d(b: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(b).digest()).digest()


def push(data: bytes) -> bytes:
    n = len(data)
    if n < 0x4C:
        return bytes([n]) + data
    if n <= 0xFF:
        return b"\x4c" + bytes([n]) + data
    raise ValueError("too long")


def varint(n: int) -> bytes:
    assert n < 0xFD
    return bytes([n])


def coinbase(msg: str, out_script: bytes, value: int) -> bytes:
    # CScript() << 486604799 << CScriptNum(4) << msg
    script_sig = push(struct.pack("<I", 486604799)) + push(b"\x04") + push(msg.encode())
    tx = struct.pack("<i", 1)  # version
    tx += varint(1) + b"\x00" * 32 + struct.pack("<I", 0xFFFFFFFF)
    tx += varint(len(script_sig)) + script_sig + struct.pack("<I", 0xFFFFFFFF)
    tx += varint(1) + struct.pack("<q", value) + varint(len(out_script)) + out_script
    tx += struct.pack("<I", 0)  # locktime
    return tx


def header_hash(merkle_internal: bytes, t: int, nonce: int, bits: int) -> bytes:
    h = struct.pack("<i", 1) + b"\x00" * 32 + merkle_internal + struct.pack("<III", t, bits, nonce)
    return sha256d(h)[::-1]


COIN = 100_000_000
MAIN_MSG = "The Times 03/Jan/2009 Chancellor on brink of second bailout for banks"
MAIN_PK = bytes.fromhex(
    "04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f"
)
T4_MSG = "03/May/2024 000000000000000000001ebd58c244970b3aa9d783bb001011fbe8ea8e98e00e"
T4_PK = bytes(33)

nets = {
    "mainnet": (MAIN_MSG, MAIN_PK, 1231006505, 2083236893, 0x1D00FFFF,
                "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"),
    "testnet3": (MAIN_MSG, MAIN_PK, 1296688602, 414098458, 0x1D00FFFF,
                 "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943"),
    "signet": (MAIN_MSG, MAIN_PK, 1598918400, 52613770, 0x1E0377AE,
               "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6"),
    "regtest": (MAIN_MSG, MAIN_PK, 1296688602, 2, 0x207FFFFF,
                "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206"),
    "testnet4": (T4_MSG, T4_PK, 1714777860, 393743547, 0x1D00FFFF,
                 "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043"),
}

for name, (msg, pk, t, nonce, bits, want_block) in nets.items():
    out_script = push(pk) + b"\xac"
    tx = coinbase(msg, out_script, 50 * COIN)
    txid_internal = sha256d(tx)
    txid_display = txid_internal[::-1].hex()
    block = header_hash(txid_internal, t, nonce, bits).hex()
    print(f"{name:9s} txid(display)={txid_display} block={block} block_ok={block == want_block} "
          f"out_script={out_script.hex()} tx_len={len(tx)}")
    if name == "testnet4":
        print("testnet4 raw coinbase:", tx.hex())
