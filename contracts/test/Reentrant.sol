// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test helper: a malicious vendor that tries to call back into the contract paying it.
contract ReentrantVendor {
    address public target;
    bytes public data;
    bool public attempted;
    bool public reentered;

    /// The call to try from receive(), e.g. an ABI-encoded release of another work order.
    function arm(address t, bytes calldata d) external {
        target = t;
        data = d;
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        (bool ok, ) = target.call(data);
        reentered = ok;
    }
}
