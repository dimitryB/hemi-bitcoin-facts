// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Admin surface of MockHvm. Only MOCK_HVM_ADMIN may call it; every other caller is treated as a
/// precompile caller and gets raw-byte answers, so no precompile input can collide with an admin selector.
interface IMockHvmAdmin {
    /// @notice Exact response for an exact input. Wins over everything else except `setFail`.
    function setRaw(bytes calldata input, bytes calldata response) external;
    /// @notice Response for any input to this precompile. Wins over typed state.
    function setAny(bytes calldata response) external;
    function clearAny() external;
    /// @notice Fail every call (burning all gas given), as a faulting hVM precompile does.
    function setFail(bool on) external;
    /// @notice Fail calls with exactly this input.
    function setFailInput(bytes calldata input) external;

    function setBalance(string calldata btcAddress, uint64 sats) external; // 0x40
    function setBlock(bytes32 txid, bytes32 blockHash) external; // 0x42
    function setConfirmations(bytes32 txid, uint32 count) external; // 0x43
    function setTip(bytes calldata header) external; // 0x44
    function setHeader(uint32 height, bytes calldata header) external; // 0x45
    function setScript(string calldata btcAddress, bytes calldata script) external; // 0x46
    function setInput( // 0x47
        bytes32 txid,
        uint16 index,
        uint16 witnessCount,
        uint64 prevSats,
        bytes32 prevTxid,
        uint16 prevVout,
        uint32 sequence,
        bytes calldata scriptSig
    ) external;
    /// @notice 0x48 and 0x42 (call on both). flag 1 = unspent; 0 = spent or unspendable (0x48 then gives no
    /// answer, 0x42 lists it with UTXO byte 0x00); other values are written raw, for malformed-answer tests.
    function setOutput(bytes32 txid, uint16 index, uint64 sats, bytes calldata script, uint8 flag) external;
    function setWitness(bytes32 txid, uint16 inputIndex, uint16 witnessIndex, bytes calldata item) external; // 0x49
}

address constant MOCK_HVM_ADMIN = address(uint160(uint256(keccak256("hemi-bitcoin-facts.mock-hvm.admin"))));

/// @title MockHvm
/// @notice A stand-in for hVM precompiles 0x40–0x49, etched at each address. It takes and returns raw bytes with
/// op-geth's layouts (hemilabs/op-geth, branch hemi, commit 67f25b90) and reproduces its edge behaviour: wrong-length input gives an
/// empty successful return; an unknown txid on 0x43 and an undecodable address on 0x46 fail and burn all gas; scripts
/// are cut to the caller's maximum while the length field keeps the full length.
/// @dev Payloads live in code (one tiny data contract each) so a read costs a few thousand gas and stays under the
/// gas caps in Hvm.sol even for a 10,000-byte script.
contract MockHvm {
    // One slot of mode bits keeps the common path to a single extra SLOAD, so the mock fits in Hvm's tightest cap
    // (2 x 5,000 gas for 0x43 and 0x44): the override mappings are read only when their bit is set.
    uint256 private constant FAIL = 1;
    uint256 private constant HAS_FAIL_INPUT = 2;
    uint256 private constant HAS_RAW = 4;
    uint256 private constant HAS_ANY = 8;

    uint256 private _mode;
    mapping(bytes32 => address) private _blob;
    mapping(bytes32 => uint256) private _num;

    fallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender == MOCK_HVM_ADMIN) {
            _admin(data);
            return "";
        }
        return _answer(data);
    }

    // ---------------------------------------------------------------------------------------------
    // Precompile side
    // ---------------------------------------------------------------------------------------------

    function _answer(bytes calldata input) private view returns (bytes memory) {
        uint256 mode = _mode;
        if (mode & FAIL != 0) _burn();
        if (mode & HAS_FAIL_INPUT != 0 && _num[keccak256(abi.encodePacked("failInput", input))] != 0) _burn();
        if (mode & HAS_RAW != 0) {
            (bool hasRaw, bytes memory raw) = _get(keccak256(abi.encodePacked("raw", input)));
            if (hasRaw) return raw;
        }
        if (mode & HAS_ANY != 0) {
            (bool hasAny, bytes memory any) = _get(keccak256("any"));
            if (hasAny) return any;
        }

        uint160 self = uint160(address(this));
        if (self == 0x40) return _balance(input);
        if (self == 0x41) return ""; // raw overrides only
        if (self == 0x42) return _txByTxid(input);
        if (self == 0x43) return _confirmations(input);
        if (self == 0x44) return _tip();
        if (self == 0x45) return _headerN(input);
        if (self == 0x46) return _addrToScript(input);
        if (self == 0x47) return _input(input);
        if (self == 0x48) return _output(input);
        if (self == 0x49) return _witness(input);
        return "";
    }

    function _balance(bytes calldata input) private view returns (bytes memory) {
        if (input.length < 24) return "";
        (bool has, bytes memory v) = _get(keccak256(abi.encodePacked("bal", input)));
        return has ? v : bytes("");
    }

    /// @dev Two flag sets are modelled: 0x40000000 (containing block) and 0x003c0703 (all outputs with scripts cut
    /// to 128 bytes and UTXO bytes, at most 128 outputs). Anything else answers only through setRaw / setAny.
    function _txByTxid(bytes calldata input) private view returns (bytes memory) {
        if (input.length != 36) return "";
        bytes32 txid = bytes32(input[0:32]);
        bytes4 flags = bytes4(input[32:36]);
        if (flags == bytes4(0x40000000)) {
            (bool has, bytes memory v) = _get(keccak256(abi.encodePacked("blk", txid)));
            return has ? v : bytes("");
        }
        if (flags != bytes4(0x003c0703)) return "";
        uint256 total = _num[keccak256(abi.encodePacked("outs", txid))];
        if (total == 0) return "";
        uint256 n = total < 128 ? total : 128;
        bytes memory out = abi.encodePacked(uint16(total));
        for (uint256 i; i < n; ++i) {
            (bool has, bytes memory v) = _get(keccak256(abi.encodePacked("out", txid, uint16(i))));
            if (!has) {
                out = abi.encodePacked(out, uint64(0), uint16(0), uint8(0));
                continue;
            }
            // stored: sats(8) flag(1) script; 0x42 writes the UTXO byte 0x01 only for an unspent output
            uint256 scriptLen = v.length - 9;
            uint256 cut = scriptLen < 128 ? scriptLen : 128;
            bytes memory script = new bytes(cut);
            _copy(script, 0, v, 9, cut);
            out = abi.encodePacked(out, bytes8(_word(v, 0)), uint16(scriptLen), script, uint8(v[8]));
        }
        return out;
    }

    function _word(bytes memory b, uint256 off) private pure returns (bytes32 w) {
        assembly {
            w := mload(add(add(b, 32), off))
        }
    }

    function _confirmations(bytes calldata input) private view returns (bytes memory) {
        if (input.length != 32) return "";
        uint256 n = _num[keccak256(abi.encodePacked("conf", bytes32(input)))];
        if (n == 0) _burn(); // op-geth: unknown txid is a CALL failure
        return abi.encodePacked(uint32(n - 1));
    }

    function _tip() private view returns (bytes memory) {
        (bool has, bytes memory v) = _get(keccak256("tip"));
        return has ? v : bytes("");
    }

    function _headerN(bytes calldata input) private view returns (bytes memory) {
        if (input.length != 4) return "";
        (bool has, bytes memory v) = _get(keccak256(abi.encodePacked("hdr", bytes4(input))));
        return has ? v : bytes("");
    }

    function _addrToScript(bytes calldata input) private view returns (bytes memory) {
        if (input.length < 24) return "";
        (bool has, bytes memory v) = _get(keccak256(abi.encodePacked("script", input)));
        if (!has) _burn(); // op-geth: DecodeAddress error is a CALL failure
        return v;
    }

    function _input(bytes calldata input) private view returns (bytes memory) {
        if (input.length != 36) return "";
        (bool has, bytes memory v) = _get(keccak256(abi.encodePacked("in", input[0:34])));
        if (!has) return "";
        uint256 max = uint16(bytes2(input[34:36]));
        // stored: witnessCount(2) prevSats(8) prevTxid(32) prevVout(2) sequence(4) scriptSig
        uint256 sigLen = v.length - 48;
        uint256 cut = sigLen < max ? sigLen : max;
        bytes memory out = new bytes(50 + cut);
        _copy(out, 0, v, 0, 44);
        out[44] = bytes1(uint8(sigLen >> 8));
        out[45] = bytes1(uint8(sigLen));
        _copy(out, 46, v, 48, cut);
        _copy(out, 46 + cut, v, 44, 4);
        return out;
    }

    function _output(bytes calldata input) private view returns (bytes memory) {
        if (input.length != 36) return "";
        (bool has, bytes memory v) = _get(keccak256(abi.encodePacked("out", input[0:34])));
        if (!has) return "";
        // stored: sats(8) flag(1) script. Flag 0 is a spent (or unspendable) output: mainnet's 0x48 gives no
        // answer for it (DECISIONS.md D-004). Flag 1 is unspent. Other values are written as-is, for tests of
        // malformed answers.
        if (uint8(v[8]) == 0) return "";
        uint256 max = uint16(bytes2(input[34:36]));
        uint256 scriptLen = v.length - 9;
        uint256 cut = scriptLen < max ? scriptLen : max;
        uint256 lenField = scriptLen > type(uint16).max ? type(uint16).max : scriptLen;
        bytes memory out = new bytes(11 + cut);
        _copy(out, 0, v, 0, 8);
        out[8] = bytes1(uint8(lenField >> 8));
        out[9] = bytes1(uint8(lenField));
        _copy(out, 10, v, 9, cut);
        out[10 + cut] = v[8];
        return out;
    }

    function _witness(bytes calldata input) private view returns (bytes memory) {
        if (input.length != 38) return "";
        (bool has, bytes memory v) = _get(keccak256(abi.encodePacked("wit", input[0:36])));
        if (!has) return "";
        uint256 max = uint16(bytes2(input[36:38]));
        uint256 cut = v.length < max ? v.length : max;
        bytes memory out = new bytes(2 + cut);
        out[0] = bytes1(uint8(v.length >> 8));
        out[1] = bytes1(uint8(v.length));
        _copy(out, 2, v, 0, cut);
        return out;
    }

    function _burn() private pure {
        assembly {
            invalid()
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Admin side
    // ---------------------------------------------------------------------------------------------

    function _admin(bytes calldata data) private {
        bytes4 sel = bytes4(data[0:4]);
        bytes calldata args = data[4:];
        if (sel == IMockHvmAdmin.setRaw.selector) {
            (bytes memory input, bytes memory response) = abi.decode(args, (bytes, bytes));
            _put(keccak256(abi.encodePacked("raw", input)), response);
            _mode |= HAS_RAW;
        } else if (sel == IMockHvmAdmin.setAny.selector) {
            _put(keccak256("any"), abi.decode(args, (bytes)));
            _mode |= HAS_ANY;
        } else if (sel == IMockHvmAdmin.clearAny.selector) {
            _blob[keccak256("any")] = address(0);
            _mode &= ~HAS_ANY;
        } else if (sel == IMockHvmAdmin.setFail.selector) {
            _mode = abi.decode(args, (bool)) ? _mode | FAIL : _mode & ~FAIL;
        } else if (sel == IMockHvmAdmin.setFailInput.selector) {
            _num[keccak256(abi.encodePacked("failInput", abi.decode(args, (bytes))))] = 1;
            _mode |= HAS_FAIL_INPUT;
        } else if (sel == IMockHvmAdmin.setBalance.selector) {
            (string memory a, uint64 sats) = abi.decode(args, (string, uint64));
            _put(keccak256(abi.encodePacked("bal", a)), abi.encodePacked(sats));
        } else if (sel == IMockHvmAdmin.setBlock.selector) {
            (bytes32 txid, bytes32 blockHash) = abi.decode(args, (bytes32, bytes32));
            _put(keccak256(abi.encodePacked("blk", txid)), abi.encodePacked(blockHash));
        } else if (sel == IMockHvmAdmin.setConfirmations.selector) {
            (bytes32 txid, uint32 count) = abi.decode(args, (bytes32, uint32));
            _num[keccak256(abi.encodePacked("conf", txid))] = uint256(count) + 1;
        } else if (sel == IMockHvmAdmin.setTip.selector) {
            _put(keccak256("tip"), abi.decode(args, (bytes)));
        } else if (sel == IMockHvmAdmin.setHeader.selector) {
            (uint32 height, bytes memory header) = abi.decode(args, (uint32, bytes));
            _put(keccak256(abi.encodePacked("hdr", bytes4(height))), header);
        } else if (sel == IMockHvmAdmin.setScript.selector) {
            (string memory a, bytes memory script) = abi.decode(args, (string, bytes));
            _put(keccak256(abi.encodePacked("script", a)), script);
        } else if (sel == IMockHvmAdmin.setInput.selector) {
            _setInput(args);
        } else if (sel == IMockHvmAdmin.setOutput.selector) {
            (bytes32 txid, uint16 index, uint64 sats, bytes memory script, uint8 flag) =
                abi.decode(args, (bytes32, uint16, uint64, bytes, uint8));
            _put(keccak256(abi.encodePacked("out", txid, index)), abi.encodePacked(sats, flag, script));
            bytes32 countKey = keccak256(abi.encodePacked("outs", txid));
            if (_num[countKey] < uint256(index) + 1) _num[countKey] = uint256(index) + 1;
        } else if (sel == IMockHvmAdmin.setWitness.selector) {
            (bytes32 txid, uint16 inputIndex, uint16 witnessIndex, bytes memory item) =
                abi.decode(args, (bytes32, uint16, uint16, bytes));
            _put(keccak256(abi.encodePacked("wit", txid, inputIndex, witnessIndex)), item);
        } else {
            revert("MockHvm: unknown admin call");
        }
    }

    function _setInput(bytes calldata args) private {
        (
            bytes32 txid,
            uint16 index,
            uint16 witnessCount,
            uint64 prevSats,
            bytes32 prevTxid,
            uint16 prevVout,
            uint32 sequence,
            bytes memory scriptSig
        ) = abi.decode(args, (bytes32, uint16, uint16, uint64, bytes32, uint16, uint32, bytes));
        _put(
            keccak256(abi.encodePacked("in", txid, index)),
            abi.encodePacked(witnessCount, prevSats, prevTxid, prevVout, sequence, scriptSig)
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Code-backed storage: each value is the runtime code of a data contract, prefixed with 0x01 so an empty
    // value is distinguishable from an unset one.
    // ---------------------------------------------------------------------------------------------

    function _put(bytes32 key, bytes memory value) private {
        bytes memory runtime = abi.encodePacked(hex"01", value);
        // init code (12 bytes): PUSH2 len, DUP1, PUSH1 12, PUSH1 0, CODECOPY, PUSH1 0, RETURN; then the runtime
        bytes memory init = abi.encodePacked(hex"61", uint16(runtime.length), hex"80600c6000396000f3", runtime);
        address a;
        assembly {
            a := create(0, add(init, 32), mload(init))
        }
        require(a != address(0), "MockHvm: store failed");
        _blob[key] = a;
    }

    function _get(bytes32 key) private view returns (bool has, bytes memory value) {
        address a = _blob[key];
        if (a == address(0)) return (false, "");
        uint256 size = a.code.length;
        value = new bytes(size - 1);
        assembly {
            extcodecopy(a, add(value, 32), 1, sub(size, 1))
        }
        return (true, value);
    }

    function _copy(bytes memory dst, uint256 dstOff, bytes memory src, uint256 srcOff, uint256 len) private pure {
        assembly {
            mcopy(add(add(dst, 32), dstOff), add(add(src, 32), srcOff), len)
        }
    }
}
