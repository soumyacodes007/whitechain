// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMerchantRegistry {
    function merchants(address merchant)
        external
        view
        returns (address payout, address refundWallet, address refundOperator);
}

/// @notice Recurring USDT mandates. The amount and interval are fixed onchain when the customer
/// subscribes, so a compromised keeper can trigger a due charge but can never overcharge.
contract SettleKitSubscriptions is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Subscription {
        address customer;
        uint96 amount;
        address merchant;
        uint32 interval;
        uint32 maxPeriods; // 0 means no limit
        uint32 periodsCharged;
        uint40 nextChargeAt;
        bool active;
    }

    /// @dev Short enough to show a live renewal on testnet. The API only offers weekly and monthly.
    uint32 public constant MIN_INTERVAL = 60;

    IERC20 public immutable usdt;
    IMerchantRegistry public immutable registry;
    address public keeper;
    uint256 public nextSubId = 1;

    mapping(uint256 subId => Subscription) public subscriptions;

    event KeeperUpdated(address indexed keeper);
    event Subscribed(
        uint256 indexed subId,
        address indexed merchant,
        address indexed customer,
        uint256 amount,
        uint256 interval,
        uint256 maxPeriods
    );
    event Charged(uint256 indexed subId, uint256 period, uint256 amount);
    event ChargeFailed(uint256 indexed subId, uint256 period, uint256 amount);
    event Cancelled(uint256 indexed subId, address indexed by);
    event Completed(uint256 indexed subId);

    error NotActive();
    error NotDue();
    error NotAuthorised();
    error MerchantNotRegistered();
    error InvalidInterval();
    error ZeroAddress();
    error ZeroAmount();

    constructor(IERC20 usdt_, IMerchantRegistry registry_, address keeper_, address owner_) Ownable(owner_) {
        if (address(usdt_) == address(0) || address(registry_) == address(0) || keeper_ == address(0)) {
            revert ZeroAddress();
        }
        usdt = usdt_;
        registry = registry_;
        keeper = keeper_;
    }

    /// @notice Creates a mandate and charges the first period. The caller must have approved this
    /// contract for at least one period; the allowance they leave in place funds later renewals.
    function subscribe(address merchant, uint256 amount, uint32 interval, uint32 maxPeriods)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 subId)
    {
        if (amount == 0) revert ZeroAmount();
        if (interval < MIN_INTERVAL) revert InvalidInterval();
        address payout = _payout(merchant);

        subId = nextSubId++;
        bool finished = maxPeriods == 1;
        subscriptions[subId] = Subscription({
            customer: msg.sender,
            amount: SafeCast.toUint96(amount),
            merchant: merchant,
            interval: interval,
            maxPeriods: maxPeriods,
            periodsCharged: 1,
            nextChargeAt: uint40(block.timestamp + interval),
            active: !finished
        });

        emit Subscribed(subId, merchant, msg.sender, amount, interval, maxPeriods);
        emit Charged(subId, 1, amount);
        if (finished) emit Completed(subId);
        usdt.safeTransferFrom(msg.sender, payout, amount);
    }

    /// @notice Charges one due period. A failed transfer emits ChargeFailed and leaves the period due,
    /// so the keeper can retry. Keeper-only, so outsiders can't fake failures to force past_due.
    function charge(uint256 subId) external nonReentrant whenNotPaused {
        if (msg.sender != keeper) revert NotAuthorised();

        Subscription storage sub = subscriptions[subId];
        if (!sub.active) revert NotActive();
        if (block.timestamp < sub.nextChargeAt) revert NotDue();

        uint256 amount = sub.amount;
        uint32 period = sub.periodsCharged + 1;

        // State is written after the transfer because it depends on the result. The token is the
        // immutable USDT address and nonReentrant covers the rest.
        if (!usdt.trySafeTransferFrom(sub.customer, _payout(sub.merchant), amount)) {
            emit ChargeFailed(subId, period, amount);
            return;
        }

        sub.periodsCharged = period;
        // A renewal that recovers after missed periods bills once, not once for each missed period.
        uint256 next = uint256(sub.nextChargeAt) + sub.interval;
        if (next <= block.timestamp) next = block.timestamp + sub.interval;
        sub.nextChargeAt = uint40(next);

        emit Charged(subId, period, amount);
        if (period == sub.maxPeriods) {
            sub.active = false;
            emit Completed(subId);
        }
    }

    /// @notice Stops future charges. The customer or the merchant can call this at any time, even
    /// while paused, because cancelling only ever reduces what can be charged.
    function cancel(uint256 subId) external {
        Subscription storage sub = subscriptions[subId];
        if (!sub.active) revert NotActive();
        if (msg.sender != sub.customer && msg.sender != sub.merchant) revert NotAuthorised();

        sub.active = false;
        emit Cancelled(subId, msg.sender);
    }

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperUpdated(keeper_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _payout(address merchant) private view returns (address payout) {
        (payout,,) = registry.merchants(merchant);
        if (payout == address(0)) revert MerchantNotRegistered();
    }
}
