// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettleKitPayments} from "../src/SettleKitPayments.sol";
import {IMerchantRegistry, SettleKitSubscriptions} from "../src/SettleKitSubscriptions.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";

contract SettleKitSubscriptionsTest is Test {
    uint256 private constant PRICE = 300e6;
    uint32 private constant MONTH = 30 days;

    MockUSDT private usdt;
    SettleKitPayments private payments;
    SettleKitSubscriptions private subs;

    address private keeper = makeAddr("keeper");
    address private customer = makeAddr("customer");
    address private merchant = makeAddr("merchant");
    address private payout = makeAddr("payout");

    function setUp() public {
        usdt = new MockUSDT();
        payments = new SettleKitPayments(usdt, makeAddr("signer"), address(this));
        subs = new SettleKitSubscriptions(usdt, IMerchantRegistry(address(payments)), keeper, address(this));

        vm.prank(merchant);
        payments.registerMerchant(payout, payout, address(0));

        usdt.mint(customer, 10_000e6);
        vm.prank(customer);
        usdt.approve(address(subs), type(uint256).max);
    }

    function _subscribe(uint32 maxPeriods) private returns (uint256 subId) {
        vm.prank(customer);
        subId = subs.subscribe(merchant, PRICE, MONTH, maxPeriods);
    }

    function _charge(uint256 subId) private {
        vm.prank(keeper);
        subs.charge(subId);
    }

    function test_subscribe_chargesFirstPeriod() public {
        uint256 subId = _subscribe(0);
        assertEq(usdt.balanceOf(payout), PRICE);
        (,,,,, uint32 charged, uint40 next, bool active) = subs.subscriptions(subId);
        assertEq(charged, 1);
        assertEq(next, block.timestamp + MONTH);
        assertTrue(active);
    }

    function test_subscribe_rejectsUnregisteredMerchant() public {
        vm.prank(customer);
        vm.expectRevert(SettleKitSubscriptions.MerchantNotRegistered.selector);
        subs.subscribe(makeAddr("stranger"), PRICE, MONTH, 0);
    }

    function test_subscribe_rejectsTooShortInterval() public {
        vm.prank(customer);
        vm.expectRevert(SettleKitSubscriptions.InvalidInterval.selector);
        subs.subscribe(merchant, PRICE, 59, 0);
    }

    function test_charge_oncePerPeriod() public {
        uint256 subId = _subscribe(0);

        vm.warp(block.timestamp + MONTH - 1);
        vm.prank(keeper);
        vm.expectRevert(SettleKitSubscriptions.NotDue.selector);
        subs.charge(subId);

        vm.warp(block.timestamp + 1);
        _charge(subId);
        assertEq(usdt.balanceOf(payout), PRICE * 2);

        vm.prank(keeper);
        vm.expectRevert(SettleKitSubscriptions.NotDue.selector);
        subs.charge(subId);
    }

    function test_charge_isKeeperOnly() public {
        uint256 subId = _subscribe(0);
        vm.warp(block.timestamp + MONTH);
        vm.expectRevert(SettleKitSubscriptions.NotAuthorised.selector);
        subs.charge(subId);
    }

    function test_charge_failsCleanlyAfterCancel() public {
        uint256 subId = _subscribe(0);
        vm.prank(customer);
        subs.cancel(subId);

        vm.warp(block.timestamp + MONTH);
        vm.prank(keeper);
        vm.expectRevert(SettleKitSubscriptions.NotActive.selector);
        subs.charge(subId);
        assertEq(usdt.balanceOf(payout), PRICE);
    }

    function test_charge_lowAllowanceEmitsFailureThenRecovers() public {
        uint256 subId = _subscribe(0);
        vm.prank(customer);
        usdt.approve(address(subs), 0);

        vm.warp(block.timestamp + MONTH);
        vm.expectEmit(address(subs));
        emit SettleKitSubscriptions.ChargeFailed(subId, 2, PRICE);
        _charge(subId);
        assertEq(usdt.balanceOf(payout), PRICE);

        vm.prank(customer);
        usdt.approve(address(subs), type(uint256).max);
        _charge(subId);
        assertEq(usdt.balanceOf(payout), PRICE * 2);
    }

    function test_charge_lowBalanceEmitsFailure() public {
        uint256 subId = _subscribe(0);
        uint256 rest = usdt.balanceOf(customer);
        vm.prank(customer);
        usdt.transfer(makeAddr("elsewhere"), rest);

        vm.warp(block.timestamp + MONTH);
        vm.expectEmit(address(subs));
        emit SettleKitSubscriptions.ChargeFailed(subId, 2, PRICE);
        _charge(subId);
    }

    /// Three missed months must bill one period, not three in a row.
    function test_charge_doesNotCatchUpAfterMissedPeriods() public {
        uint256 subId = _subscribe(0);
        vm.warp(block.timestamp + MONTH * 3 + 1);
        _charge(subId);

        vm.prank(keeper);
        vm.expectRevert(SettleKitSubscriptions.NotDue.selector);
        subs.charge(subId);
        assertEq(usdt.balanceOf(payout), PRICE * 2);
    }

    function test_charge_stopsAtMaxPeriods() public {
        uint256 subId = _subscribe(2);
        vm.warp(block.timestamp + MONTH);
        _charge(subId);

        (,,,,,,, bool active) = subs.subscriptions(subId);
        assertFalse(active);

        vm.warp(block.timestamp + MONTH);
        vm.prank(keeper);
        vm.expectRevert(SettleKitSubscriptions.NotActive.selector);
        subs.charge(subId);
    }

    function test_subscribe_singlePeriodFinishesImmediately() public {
        uint256 subId = _subscribe(1);
        (,,,,,,, bool active) = subs.subscriptions(subId);
        assertFalse(active);
    }

    function test_cancel_byMerchant() public {
        uint256 subId = _subscribe(0);
        vm.prank(merchant);
        subs.cancel(subId);
        (,,,,,,, bool active) = subs.subscriptions(subId);
        assertFalse(active);
    }

    function test_cancel_rejectsStrangers() public {
        uint256 subId = _subscribe(0);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(SettleKitSubscriptions.NotAuthorised.selector);
        subs.cancel(subId);
    }

    function test_cancel_worksWhilePaused() public {
        uint256 subId = _subscribe(0);
        subs.pause();
        vm.prank(customer);
        subs.cancel(subId);
        (,,,,,,, bool active) = subs.subscriptions(subId);
        assertFalse(active);
    }
}
