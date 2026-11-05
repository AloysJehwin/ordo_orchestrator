// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test double for Hedera's Schedule Service system contract at 0x16b: its runtime code is copied there with
/// `evm_setAccountCode`. It records which contract authorized each schedule, answers SUCCESS (22), and answers
/// SCHEDULE_ALREADY_EXECUTED (229) for a schedule authorized before.
contract HssStub {
    mapping(address => address) public authorizedBy;

    function authorizeSchedule(address schedule) external returns (int64) {
        if (authorizedBy[schedule] != address(0)) return 229;
        authorizedBy[schedule] = msg.sender;
        return 22;
    }
}
