// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title OrdoSigned
/// @notice Verifies Ordo's EIP-712 `OrdoSignature` (domain {name:"Ordo",version:"1",chainId}) — the typed data
///         people sign in the Ordo console — so anyone may relay an authorisation and the contract checks who
///         signed it, not who sent the transaction. Same scheme as OrdoTrust, which keeps its own copy because
///         it was deployed first.
abstract contract OrdoSigned {
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId)");
    bytes32 private constant SIG_TYPEHASH =
        keccak256("OrdoSignature(string action,string entity,string meaning,string comment,string site,string nonce,string issuedAt)");

    struct OrdoSig {
        string action;
        string entity;
        string meaning;
        string comment;
        string site;
        string nonce;
        string issuedAt;
        bytes signature;
    }

    mapping(bytes32 => bool) public usedNonces;

    error WrongAction();
    error WrongSite();
    error WrongEntity();
    error NonceUsed();
    error BadSignature();

    function siteKey(string memory siteId) public pure returns (bytes32) {
        return keccak256(bytes(siteId));
    }

    function digest(OrdoSig calldata s) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Ordo"), keccak256("1"), block.chainid));
        bytes32 structHash = keccak256(
            abi.encode(
                SIG_TYPEHASH,
                keccak256(bytes(s.action)),
                keccak256(bytes(s.entity)),
                keccak256(bytes(s.meaning)),
                keccak256(bytes(s.comment)),
                keccak256(bytes(s.site)),
                keccak256(bytes(s.nonce)),
                keccak256(bytes(s.issuedAt))
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// Verify action, site and entity; burn the nonce; return the signer.
    function _consume(OrdoSig calldata s, string memory action, string memory siteId, string memory entity) internal returns (address) {
        if (keccak256(bytes(s.action)) != keccak256(bytes(action))) revert WrongAction();
        if (keccak256(bytes(s.site)) != keccak256(bytes(siteId))) revert WrongSite();
        if (keccak256(bytes(s.entity)) != keccak256(bytes(entity))) revert WrongEntity();
        bytes32 n = keccak256(bytes(s.nonce));
        if (usedNonces[n]) revert NonceUsed();
        usedNonces[n] = true;
        return _recover(digest(s), s.signature);
    }

    // ------------------------------------------------------------------ helpers (no mcopy: runs on any EVM)

    /// secp256k1 recovery of a 65-byte signature, rejecting malleable s values.
    function _recover(bytes32 h, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 sv = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(sv) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address a = ecrecover(h, v, r, sv);
        if (a == address(0)) revert BadSignature();
        return a;
    }

    /// Lowercase 0x-prefixed hex address, as Ordo writes addresses.
    function _hex(address a) internal pure returns (string memory) {
        return _hexN(uint256(uint160(a)), 20);
    }

    /// Lowercase 0x-prefixed 32-byte hex, as Ordo writes hashes.
    function _hex32(bytes32 b) internal pure returns (string memory) {
        return _hexN(uint256(b), 32);
    }

    function _hexN(uint256 v, uint256 bytesLen) private pure returns (string memory) {
        bytes memory out = new bytes(2 + bytesLen * 2);
        bytes16 digits = "0123456789abcdef";
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = out.length - 1; i > 1; i--) {
            out[i] = digits[v & 0xf];
            v >>= 4;
        }
        return string(out);
    }

    function _dec(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory out = new bytes(len);
        while (v != 0) {
            out[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(out);
    }
}

/// The parts of OrdoTrust that other Ordo contracts read: whether a site exists and who holds which credential.
interface IOrdoTrust {
    function sites(bytes32 site) external view returns (bool exists, address treasury);
    function roles(bytes32 site, address account) external view returns (uint8);
}
