# Whitechain feedback

Running notes from building SettleKit on Whitechain Sepolia.

## Network facts, measured against the live RPC (6 Nov 2026)

| Item | Result |
| --- | --- |
| RPC | `https://rpc.testnet.whitechain.io` |
| Chain ID | 1874 |
| Client | `op-reth/v2.8.1` |
| Block time | 1 s, averaged over the last 100 blocks |
| Gas price | about 5 gwei of WBT, base fee 5 gwei |
| Test USDT | `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`, 6 decimals, EIP-1967 proxy |
| USDT implementation | `0x26425662d126412128967ecf0a02ec48573026f7` |
| EIP-2612 permit | Supported. Domain is name `Tether USD`, version `1` |
| EIP-3009 `transferWithAuthorization` | Selector present in the implementation |

## Friction

- Two Whitechain testnets show up side by side in search results. The legacy testnet is chain 2625 at
  `rpc-testnet.whitechain.io`, while the OP Stack one is chain 1874 at `rpc.testnet.whitechain.io`. The
  hostnames differ by a single character, so it's easy to end up on the wrong network.
- The USDT is a proxy, so scanning the proxy bytecode for `permit` finds nothing. You have to read the
  EIP-1967 slot and scan the implementation.
- The token has no `eip712Domain()` or `version()`, so the permit version has to be found by hashing
  candidates against `DOMAIN_SEPARATOR()`. Publishing the domain in the docs would save that step.
- `forge install` fails on Windows with "Library directory is not relative to the repository root" when
  the Foundry project sits in a subfolder of the repo. Adding the libraries with `git submodule add` works.
  This is a Foundry issue rather than a Whitechain one.

## Still unknown

- Which contract verification method the explorer supports (Etherscan-compatible API, Sourcify or manual).
- The explorer URL for chain 1874. Hosts could not be confirmed from this network yet.
- How to get test USDT. The implementation has `mint(address,uint256)`, but who may call it is unconfirmed.
