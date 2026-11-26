// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Security review helper: calls `target` with an exact gas allowance from inside one frame, so the callee sees
/// the 63/64 rule exactly as a consumer contract or a gas-limited transaction would give it.
contract GasProbe {
    function call(address target, bytes calldata data, uint256 g) external returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call{gas: g}(data);
    }

    /// @dev Gas used by one call with all available gas (cold accounts and slots, as in a fresh transaction).
    function measure(address target, bytes calldata data) external returns (bool ok, uint256 used, bytes memory ret) {
        uint256 before = gasleft();
        (ok, ret) = target.call(data);
        used = before - gasleft();
    }
}

/// @dev Builds 0x42 answers (flags 003c0703) the way op-geth 539f4e33 `btcTxByTxid.Run` writes them.
library Raw42 {
    /// @dev `n` listed outputs (of `total`), each with a `len`-byte script cut to 128, UTXO byte `utxo`;
    /// `special` replaces the listed output at `specialVout`.
    function big(uint256 total, uint256 n, uint256 len, uint8 utxo, uint256 specialVout, bytes memory special)
        internal
        pure
        returns (bytes memory r)
    {
        // forge-lint: disable-next-line(unsafe-typecast)
        r = abi.encodePacked(uint16(total));
        bytes memory filler = new bytes(len < 128 ? len : 128);
        for (uint256 i; i < filler.length; ++i) {
            filler[i] = 0x51; // OP_1: parses, spendable
        }
        for (uint256 i; i < n; ++i) {
            if (i == specialVout) {
                // forge-lint: disable-next-line(unsafe-typecast)
                r = abi.encodePacked(r, uint64(0), uint16(special.length), special, uint8(0));
            } else {
                // forge-lint: disable-next-line(unsafe-typecast)
                r = abi.encodePacked(r, uint64(546), uint16(len), filler, utxo);
            }
        }
    }
}
