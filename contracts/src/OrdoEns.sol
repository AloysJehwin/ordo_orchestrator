// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The parts of an ENSv2 PermissionedRegistry (UserRegistry) Ordo uses. Lookups are by label and return zero once
/// the name has expired or been unregistered; writes take any id of a name (its labelhash works).
interface IEnsV2Registry {
    function findOwner(string calldata label) external view returns (address);
    function getSubregistry(string calldata label) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
    function register(string calldata label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) external returns (uint256);
    function unregister(uint256 anyId) external;
    function renew(uint256 anyId, uint64 newExpiry) external;
    function setParent(address parent, string calldata label) external;
    function setSubregistry(uint256 anyId, address registry) external;
    function setResolver(uint256 anyId, address resolver) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
}

/// ENS Labs' VerifiableFactory: CREATE2 proxies whose address depends only on the deployer and the salt.
interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data) external returns (address);
    function predictProxyAddress(address deployer, uint256 salt) external view returns (address);
}

/// A UserRegistry proxy's initializer: the roles each account holds on the registry's root resource.
interface IUserRegistryInit {
    struct Grant {
        address account;
        uint256 roleBitmap;
    }

    function initialize(Grant[] calldata grants) external;
}

/// ENSIP-10 resolution, which ENSv2 resolvers implement.
interface IExtendedResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

interface ITextResolver {
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// Batched record writes on Ordo's PermissionedResolver (setText, setAddress, setContenthash calls).
interface IMulticallable {
    function multicall(bytes[] calldata calls) external returns (bytes[] memory);
}

/// DNS wire format and namehash for names built from labels, as ENS resolvers take them.
library OrdoEnsName {
    function dns(string[] memory labels) internal pure returns (bytes memory out) {
        for (uint256 i = 0; i < labels.length; i++) out = abi.encodePacked(out, uint8(bytes(labels[i]).length), labels[i]);
        out = abi.encodePacked(out, uint8(0));
    }

    function namehash(string[] memory labels) internal pure returns (bytes32 node) {
        for (uint256 i = labels.length; i > 0; i--) node = keccak256(abi.encodePacked(node, keccak256(bytes(labels[i - 1]))));
    }

    /// "a.b.eth" → ["a", "b", "eth"]
    function split(string memory name) internal pure returns (string[] memory labels) {
        bytes memory b = bytes(name);
        uint256 n = 1;
        for (uint256 i = 0; i < b.length; i++) if (b[i] == ".") n++;
        labels = new string[](n);
        uint256 start;
        uint256 k;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ".") {
                bytes memory l = new bytes(i - start);
                for (uint256 j = 0; j < l.length; j++) l[j] = b[start + j];
                labels[k++] = string(l);
                start = i + 1;
            }
        }
    }

    /// [first, ...rest]
    function prepend(string memory first, string[] memory rest) internal pure returns (string[] memory out) {
        out = new string[](rest.length + 1);
        out[0] = first;
        for (uint256 i = 0; i < rest.length; i++) out[i + 1] = rest[i];
    }

    /// "a" + ["b", "eth"] → "a.b.eth"
    function join(string[] memory labels) internal pure returns (string memory out) {
        for (uint256 i = 0; i < labels.length; i++) out = i == 0 ? labels[0] : string.concat(out, ".", labels[i]);
    }
}
