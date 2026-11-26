// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Read-only spike probe. Placed at an arbitrary address by eth_call state override; never deployed.
contract Probe {
    /// @notice One staticcall to `target` with raw `input` and an explicit gas cap, measured with gasleft().
    /// @return ok the call's success flag
    /// @return used gasleft() before minus after, around the staticcall alone (includes the CALL's own
    ///         access cost: 2600 cold / 100 warm, and returndata copy into memory)
    /// @return ret the raw returned bytes
    function probe(address target, bytes calldata input, uint256 gasCap)
        external
        view
        returns (bool ok, uint256 used, bytes memory ret)
    {
        bytes memory inp = input; // copy first so the copy's memory cost is outside the measurement
        uint256 g0 = gasleft();
        (ok, ret) = target.staticcall{gas: gasCap}(inp);
        uint256 g1 = gasleft();
        used = g0 - g1;
    }

    /// @notice The same call twice in one frame: the first pays the cold access, the second the warm one.
    function probeTwice(address target, bytes calldata input, uint256 gasCap)
        external
        view
        returns (bool ok1, uint256 used1, bool ok2, uint256 used2, uint256 len1, uint256 len2)
    {
        bytes memory inp = input;
        bytes memory r1;
        bytes memory r2;
        uint256 g0 = gasleft();
        (ok1, r1) = target.staticcall{gas: gasCap}(inp);
        uint256 g1 = gasleft();
        (ok2, r2) = target.staticcall{gas: gasCap}(inp);
        uint256 g2 = gasleft();
        used1 = g0 - g1;
        used2 = g1 - g2;
        len1 = r1.length;
        len2 = r2.length;
    }

    /// @notice blockhash at several depths, and the EIP-2935 history contract at others.
    function hashes(uint256[] calldata depths, uint256[] calldata historyDepths)
        external
        view
        returns (uint256 number, bytes32[] memory bh, bool[] memory histOk, bytes32[] memory hist)
    {
        number = block.number;
        bh = new bytes32[](depths.length);
        for (uint256 i; i < depths.length; ++i) {
            bh[i] = depths[i] <= number ? blockhash(number - depths[i]) : bytes32(0);
        }
        hist = new bytes32[](historyDepths.length);
        histOk = new bool[](historyDepths.length);
        address h = 0x0000F90827F1C53a10cb7A02335B175320002935;
        for (uint256 i; i < historyDepths.length; ++i) {
            (bool ok, bytes memory r) = h.staticcall{gas: 50_000}(abi.encode(number - historyDepths[i]));
            histOk[i] = ok && r.length == 32;
            if (histOk[i]) hist[i] = abi.decode(r, (bytes32));
        }
    }
}
