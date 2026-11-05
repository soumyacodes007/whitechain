// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Test} from "forge-std/Test.sol";
import {SettleKitPayments} from "../src/SettleKitPayments.sol";

/// Runs the gasless flow against the real test USDT, which differs from the mock.
/// forge test --match-path test/RealUsdt.fork.t.sol --fork-url $WHITECHAIN_RPC_URL
contract RealUsdtForkTest is Test {
    IERC20 private constant USDT = IERC20(0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7);

    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant INTENT_TYPEHASH =
        keccak256("Intent(bytes32 intentId,address merchant,uint256 amount,uint256 deadline)");
    bytes32 private constant AUTH_TYPEHASH =
        keccak256("PaymentAuthorization(bytes32 intentId,address merchant,uint256 amount,uint256 deadline,address payer)");

    uint256 private constant AMOUNT = 500e6;
    uint256 private constant SIGNER_KEY = 0xA11CE;
    uint256 private constant PAYER_KEY = 0xC0FFEE;
    bytes32 private constant ID = keccak256("fork-intent");

    SettleKitPayments private payments;
    address private merchant = makeAddr("merchant");
    address private payout = makeAddr("payout");
    address private payer = vm.addr(PAYER_KEY);

    function _signTyped(uint256 key, bytes32 domain, bytes32 structHash) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _permit(uint256 deadline) private view returns (SettleKitPayments.PermitSignature memory) {
        IERC20Permit token = IERC20Permit(address(USDT));
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, payer, address(payments), AMOUNT, token.nonces(payer), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_KEY, digest);
        return SettleKitPayments.PermitSignature(deadline, v, r, s);
    }

    function test_payWithPermit_onRealUsdt() public {
        vm.skip(block.chainid != 1874);

        payments = new SettleKitPayments(USDT, vm.addr(SIGNER_KEY), address(this));
        vm.prank(merchant);
        payments.registerMerchant(payout, payout, address(0));
        deal(address(USDT), payer, AMOUNT);

        uint256 deadline = block.timestamp + 30 minutes;
        bytes32 domain = payments.domainSeparator();
        bytes memory sig =
            _signTyped(SIGNER_KEY, domain, keccak256(abi.encode(INTENT_TYPEHASH, ID, merchant, AMOUNT, deadline)));
        bytes memory auth =
            _signTyped(PAYER_KEY, domain, keccak256(abi.encode(AUTH_TYPEHASH, ID, merchant, AMOUNT, deadline, payer)));

        assertEq(payer.balance, 0);
        vm.prank(makeAddr("relayer"));
        payments.payWithPermit(ID, merchant, AMOUNT, deadline, sig, payer, auth, _permit(deadline));

        assertEq(USDT.balanceOf(payout), AMOUNT);
        assertEq(USDT.balanceOf(payer), 0);
    }
}
