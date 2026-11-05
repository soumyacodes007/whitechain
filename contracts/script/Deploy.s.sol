// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script, console2} from "forge-std/Script.sol";
import {SettleKitPayments} from "../src/SettleKitPayments.sol";
import {IMerchantRegistry, SettleKitSubscriptions} from "../src/SettleKitSubscriptions.sol";

contract Deploy is Script {
    address private constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;

    function run() external {
        require(block.chainid == 1874, "Deploy: expected Whitechain Sepolia (1874)");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address signer = vm.envOr("INTENT_SIGNER_ADDRESS", deployer);
        address keeper = vm.envOr("KEEPER_ADDRESS", deployer);

        vm.startBroadcast(deployerKey);
        SettleKitPayments payments = new SettleKitPayments(IERC20(USDT), signer, deployer);
        SettleKitSubscriptions subscriptions =
            new SettleKitSubscriptions(IERC20(USDT), IMerchantRegistry(address(payments)), keeper, deployer);
        vm.stopBroadcast();

        console2.log("SettleKitPayments", address(payments));
        console2.log("SettleKitSubscriptions", address(subscriptions));
    }
}
