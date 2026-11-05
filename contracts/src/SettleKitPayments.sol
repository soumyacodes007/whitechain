// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Non-custodial USDT payments. USDT moves straight from the payer to the merchant's
/// payout wallet, and the Paid and Refunded events are the public receipt for each order.
/// @dev One intent takes exactly one payment. A part-paid invoice uses one intent per payment,
/// linked offchain, so each payment keeps its own refund cap.
contract SettleKitPayments is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    struct Merchant {
        address payout;
        address refundWallet;
        address refundOperator;
    }

    struct Intent {
        address merchant;
        uint96 amount;
        address payer;
        uint96 refunded;
    }

    struct PermitSignature {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    bytes32 private constant INTENT_TYPEHASH =
        keccak256("Intent(bytes32 intentId,address merchant,uint256 amount,uint256 deadline)");
    bytes32 private constant PAYMENT_AUTHORIZATION_TYPEHASH =
        keccak256("PaymentAuthorization(bytes32 intentId,address merchant,uint256 amount,uint256 deadline,address payer)");

    IERC20 public immutable usdt;
    address public intentSigner;

    mapping(address merchant => Merchant) public merchants;
    mapping(bytes32 intentId => Intent) public intents;

    event MerchantRegistered(address indexed merchant, address payout, address refundWallet, address refundOperator);
    event IntentSignerUpdated(address indexed signer);
    event Paid(bytes32 indexed intentId, address indexed merchant, address indexed payer, uint256 amount, uint256 timestamp);
    event Refunded(
        bytes32 indexed intentId,
        address indexed merchant,
        address indexed payer,
        uint256 amount,
        uint8 reasonCode,
        uint256 totalRefunded
    );

    error AlreadyPaid();
    error IntentExpired();
    error BadSignature();
    error RefundExceedsPaid();
    error NotAuthorised();
    error MerchantNotRegistered();
    error ZeroAddress();
    error ZeroAmount();

    constructor(IERC20 usdt_, address intentSigner_, address owner_)
        Ownable(owner_)
        EIP712("SettleKitPayments", "1")
    {
        if (address(usdt_) == address(0) || intentSigner_ == address(0)) revert ZeroAddress();
        usdt = usdt_;
        intentSigner = intentSigner_;
    }

    /// @notice Registers or updates the caller as a merchant.
    /// @param refundWallet Wallet refunds are pulled from. It must approve this contract.
    /// @param refundOperator Extra address allowed to trigger refunds, such as a one-click dashboard
    /// key. Refunds only ever reach the original payer, so this key cannot redirect funds.
    function registerMerchant(address payout, address refundWallet, address refundOperator) external {
        if (payout == address(0) || refundWallet == address(0)) revert ZeroAddress();
        merchants[msg.sender] = Merchant(payout, refundWallet, refundOperator);
        emit MerchantRegistered(msg.sender, payout, refundWallet, refundOperator);
    }

    /// @notice Pays an intent from the caller's wallet, which must have approved this contract.
    /// @param sig SettleKit's signature over the intent, so the amount can't be changed client-side.
    function pay(bytes32 intentId, address merchant, uint256 amount, uint256 deadline, bytes calldata sig)
        external
        nonReentrant
        whenNotPaused
    {
        _pay(intentId, merchant, amount, deadline, sig, msg.sender);
    }

    /// @notice Gasless payment, submitted by the relayer on the payer's behalf.
    /// @dev A permit names a spender but no order, so a permit lifted from the mempool could otherwise
    /// be spent on an attacker's intent. `payerSig` binds the payer's consent to this exact intent.
    /// The permit call may fail if someone front-ran it; the allowance it set still applies, and
    /// transferFrom reverts when there is none, so the failure is safe to ignore.
    function payWithPermit(
        bytes32 intentId,
        address merchant,
        uint256 amount,
        uint256 deadline,
        bytes calldata sig,
        address payer,
        bytes calldata payerSig,
        PermitSignature calldata permit
    ) external nonReentrant whenNotPaused {
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(PAYMENT_AUTHORIZATION_TYPEHASH, intentId, merchant, amount, deadline, payer))
        );
        _requireSigner(digest, payerSig, payer);

        try IERC20Permit(address(usdt)).permit(payer, address(this), amount, permit.deadline, permit.v, permit.r, permit.s) {}
        catch {}

        _pay(intentId, merchant, amount, deadline, sig, payer);
    }

    /// @notice Refunds part or all of a payment to the original payer, from the merchant's refund wallet.
    function refund(bytes32 intentId, uint256 amount, uint8 reasonCode) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        Intent storage intent = intents[intentId];
        address merchant = intent.merchant;
        Merchant storage account = merchants[merchant];
        if (merchant == address(0) || (msg.sender != merchant && msg.sender != account.refundOperator)) {
            revert NotAuthorised();
        }

        uint256 totalRefunded = intent.refunded + amount;
        if (totalRefunded > intent.amount) revert RefundExceedsPaid();
        intent.refunded = uint96(totalRefunded);

        address payer = intent.payer;
        emit Refunded(intentId, merchant, payer, amount, reasonCode, totalRefunded);
        usdt.safeTransferFrom(account.refundWallet, payer, amount);
    }

    function setIntentSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        intentSigner = signer;
        emit IntentSignerUpdated(signer);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _requireSigner(bytes32 digest, bytes calldata sig, address expected) private pure {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError || recovered != expected) revert BadSignature();
    }

    function _pay(
        bytes32 intentId,
        address merchant,
        uint256 amount,
        uint256 deadline,
        bytes calldata sig,
        address payer
    ) private {
        if (amount == 0) revert ZeroAmount();
        if (intents[intentId].merchant != address(0)) revert AlreadyPaid();
        if (block.timestamp > deadline) revert IntentExpired();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(INTENT_TYPEHASH, intentId, merchant, amount, deadline)));
        _requireSigner(digest, sig, intentSigner);

        address payout = merchants[merchant].payout;
        if (payout == address(0)) revert MerchantNotRegistered();

        intents[intentId] = Intent(merchant, SafeCast.toUint96(amount), payer, 0);
        emit Paid(intentId, merchant, payer, amount, block.timestamp);
        usdt.safeTransferFrom(payer, payout, amount);
    }
}
