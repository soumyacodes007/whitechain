// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettleKitPayments} from "../src/SettleKitPayments.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";

contract SettleKitPaymentsTest is Test {
    bytes32 private constant INTENT_TYPEHASH =
        keccak256("Intent(bytes32 intentId,address merchant,uint256 amount,uint256 deadline)");
    bytes32 private constant AUTH_TYPEHASH =
        keccak256("PaymentAuthorization(bytes32 intentId,address merchant,uint256 amount,uint256 deadline,address payer)");
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    uint256 private constant PRICE = 500e6;
    bytes32 private constant ID = keccak256("pi_7Hk2LmQ");

    MockUSDT private usdt;
    SettleKitPayments private payments;

    uint256 private signerKey = 0xA11CE;
    uint256 private payerKey = 0xB0B;
    address private payer;
    address private merchant = makeAddr("merchant");
    address private payout = makeAddr("payout");
    address private refundWallet = makeAddr("refundWallet");
    address private operator = makeAddr("operator");
    uint256 private deadline;

    function setUp() public {
        payer = vm.addr(payerKey);
        deadline = block.timestamp + 30 minutes;

        usdt = new MockUSDT();
        payments = new SettleKitPayments(usdt, vm.addr(signerKey), address(this));

        vm.prank(merchant);
        payments.registerMerchant(payout, refundWallet, operator);

        usdt.mint(payer, 1_000e6);
        usdt.mint(refundWallet, 1_000e6);
        vm.prank(payer);
        usdt.approve(address(payments), type(uint256).max);
        vm.prank(refundWallet);
        usdt.approve(address(payments), type(uint256).max);
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", payments.domainSeparator(), structHash));
    }

    function _intentSig(bytes32 id, address m, uint256 amount, uint256 dl) private view returns (bytes memory) {
        bytes32 digest = _digest(keccak256(abi.encode(INTENT_TYPEHASH, id, m, amount, dl)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _authSig(uint256 key, bytes32 id, address m, uint256 amount, uint256 dl, address who)
        private
        view
        returns (bytes memory)
    {
        bytes32 digest = _digest(keccak256(abi.encode(AUTH_TYPEHASH, id, m, amount, dl, who)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _permit(address owner_, uint256 key, uint256 value, uint256 dl)
        private
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner_, address(payments), value, usdt.nonces(owner_), dl));
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdt.DOMAIN_SEPARATOR(), structHash)));
    }

    function _pay() private {
        bytes memory sig = _intentSig(ID, merchant, PRICE, deadline);
        vm.prank(payer);
        payments.pay(ID, merchant, PRICE, deadline, sig);
    }

    function test_pay_movesUsdtToPayoutAndEmitsReceipt() public {
        bytes memory sig = _intentSig(ID, merchant, PRICE, deadline);

        vm.expectEmit(address(payments));
        emit SettleKitPayments.Paid(ID, merchant, payer, PRICE, block.timestamp);
        vm.prank(payer);
        payments.pay(ID, merchant, PRICE, deadline, sig);

        assertEq(usdt.balanceOf(payout), PRICE);
        assertEq(usdt.balanceOf(address(payments)), 0, "contract must stay non-custodial");
    }

    function test_pay_revertsWhenAmountDiffersFromSigned() public {
        bytes memory sig = _intentSig(ID, merchant, PRICE, deadline);
        vm.prank(payer);
        vm.expectRevert(SettleKitPayments.BadSignature.selector);
        payments.pay(ID, merchant, 1e6, deadline, sig);
    }

    function test_pay_revertsWhenMerchantDiffersFromSigned() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        payments.registerMerchant(attacker, attacker, address(0));

        bytes memory sig = _intentSig(ID, merchant, PRICE, deadline);
        vm.prank(payer);
        vm.expectRevert(SettleKitPayments.BadSignature.selector);
        payments.pay(ID, attacker, PRICE, deadline, sig);
    }

    function test_pay_revertsOnSecondPayment() public {
        _pay();
        bytes memory sig = _intentSig(ID, merchant, PRICE, deadline);
        vm.prank(payer);
        vm.expectRevert(SettleKitPayments.AlreadyPaid.selector);
        payments.pay(ID, merchant, PRICE, deadline, sig);
    }

    function test_pay_revertsAfterDeadline() public {
        bytes memory sig = _intentSig(ID, merchant, PRICE, deadline);
        vm.warp(deadline + 1);
        vm.prank(payer);
        vm.expectRevert(SettleKitPayments.IntentExpired.selector);
        payments.pay(ID, merchant, PRICE, deadline, sig);
    }

    function test_pay_revertsForUnregisteredMerchant() public {
        address stranger = makeAddr("stranger");
        bytes memory sig = _intentSig(ID, stranger, PRICE, deadline);
        vm.prank(payer);
        vm.expectRevert(SettleKitPayments.MerchantNotRegistered.selector);
        payments.pay(ID, stranger, PRICE, deadline, sig);
    }

    function test_pay_revertsWhenPaused() public {
        payments.pause();
        bytes memory sig = _intentSig(ID, merchant, PRICE, deadline);
        vm.prank(payer);
        vm.expectRevert();
        payments.pay(ID, merchant, PRICE, deadline, sig);
    }

    function test_payWithPermit_needsNoGasFromPayer() public {
        address payer2;
        uint256 key2 = 0xC0FFEE;
        payer2 = vm.addr(key2);
        usdt.mint(payer2, PRICE);
        assertEq(payer2.balance, 0);

        bytes memory sig = _intentSig(ID, merchant, PRICE, deadline);
        bytes memory auth = _authSig(key2, ID, merchant, PRICE, deadline, payer2);
        (uint8 v, bytes32 r, bytes32 s) = _permit(payer2, key2, PRICE, deadline);

        vm.prank(makeAddr("relayer"));
        payments.payWithPermit(ID, merchant, PRICE, deadline, sig, payer2, auth, SettleKitPayments.PermitSignature(deadline, v, r, s));

        assertEq(usdt.balanceOf(payout), PRICE);
        (,, address recorded,) = payments.intents(ID);
        assertEq(recorded, payer2, "refunds must go to the payer, not the relayer");
    }

    /// A permit taken from the mempool must not be spendable on an intent the payer never agreed to.
    function test_payWithPermit_rejectsStolenPermitOnAttackerIntent() public {
        uint256 key2 = 0xC0FFEE;
        address victim = vm.addr(key2);
        usdt.mint(victim, PRICE);

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        payments.registerMerchant(attacker, attacker, address(0));

        bytes32 attackerId = keccak256("attacker-intent");
        bytes memory attackerSig = _intentSig(attackerId, attacker, PRICE, deadline);
        bytes memory honestAuth = _authSig(key2, ID, merchant, PRICE, deadline, victim);
        (uint8 v, bytes32 r, bytes32 s) = _permit(victim, key2, PRICE, deadline);

        vm.prank(attacker);
        vm.expectRevert(SettleKitPayments.BadSignature.selector);
        payments.payWithPermit(attackerId, attacker, PRICE, deadline, attackerSig, victim, honestAuth, SettleKitPayments.PermitSignature(deadline, v, r, s));

        assertEq(usdt.balanceOf(attacker), 0);
    }

    /// A leftover allowance must not be spendable without the payer's signature either.
    function test_payWithPermit_rejectsForgedPayerAuthorization() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        payments.registerMerchant(attacker, attacker, address(0));

        bytes32 attackerId = keccak256("attacker-intent");
        bytes memory attackerSig = _intentSig(attackerId, attacker, PRICE, deadline);
        bytes memory forged = _authSig(0xDEAD, attackerId, attacker, PRICE, deadline, payer);

        vm.prank(attacker);
        vm.expectRevert(SettleKitPayments.BadSignature.selector);
        payments.payWithPermit(attackerId, attacker, PRICE, deadline, attackerSig, payer, forged, SettleKitPayments.PermitSignature(0, 0, 0, 0));
    }

    /// Front-running the permit burns its nonce but must not stop the payment going through.
    function test_payWithPermit_survivesFrontRunPermit() public {
        uint256 key2 = 0xC0FFEE;
        address payer2 = vm.addr(key2);
        usdt.mint(payer2, PRICE);

        bytes memory sig = _intentSig(ID, merchant, PRICE, deadline);
        bytes memory auth = _authSig(key2, ID, merchant, PRICE, deadline, payer2);
        (uint8 v, bytes32 r, bytes32 s) = _permit(payer2, key2, PRICE, deadline);

        usdt.permit(payer2, address(payments), PRICE, deadline, v, r, s);
        payments.payWithPermit(ID, merchant, PRICE, deadline, sig, payer2, auth, SettleKitPayments.PermitSignature(deadline, v, r, s));

        assertEq(usdt.balanceOf(payout), PRICE);
    }

    function test_refund_partialThenOverLimit() public {
        _pay();

        vm.expectEmit(address(payments));
        emit SettleKitPayments.Refunded(ID, merchant, payer, 100e6, 2, 100e6);
        vm.prank(merchant);
        payments.refund(ID, 100e6, 2);

        assertEq(usdt.balanceOf(payer), 600e6);
        assertEq(usdt.balanceOf(refundWallet), 900e6);

        vm.prank(merchant);
        vm.expectRevert(SettleKitPayments.RefundExceedsPaid.selector);
        payments.refund(ID, 400e6 + 1, 2);

        vm.prank(operator);
        payments.refund(ID, 400e6, 0);
        (,,, uint96 refunded) = payments.intents(ID);
        assertEq(refunded, PRICE);
    }

    function test_refund_rejectsStrangers() public {
        _pay();
        vm.prank(payer);
        vm.expectRevert(SettleKitPayments.NotAuthorised.selector);
        payments.refund(ID, 1e6, 0);
    }

    function test_refund_rejectsUnknownIntent() public {
        vm.prank(merchant);
        vm.expectRevert(SettleKitPayments.NotAuthorised.selector);
        payments.refund(keccak256("unknown"), 1e6, 0);
    }

    function testFuzz_refund_totalNeverExceedsPaid(uint96 first, uint96 second) public {
        first = uint96(bound(first, 1, PRICE));
        second = uint96(bound(second, 1, type(uint64).max));
        _pay();

        vm.startPrank(merchant);
        payments.refund(ID, first, 0);
        if (uint256(first) + second > PRICE) {
            vm.expectRevert(SettleKitPayments.RefundExceedsPaid.selector);
            payments.refund(ID, second, 0);
        } else {
            payments.refund(ID, second, 0);
        }
        vm.stopPrank();

        (,,, uint96 refunded) = payments.intents(ID);
        assertLe(refunded, PRICE);
    }

    function test_adminFunctionsAreOwnerOnly() public {
        vm.startPrank(makeAddr("stranger"));
        vm.expectRevert();
        payments.pause();
        vm.expectRevert();
        payments.setIntentSigner(address(1));
        vm.stopPrank();
    }
}
