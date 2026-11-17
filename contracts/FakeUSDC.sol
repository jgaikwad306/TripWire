// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Counterfeit token for the red-team "fake USDC" scenario. It copies USDC's name,
/// symbol and decimals, so only the contract address tells it apart from the real one.
/// Testnet only.
contract FakeUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient balance");
        unchecked {
            balanceOf[msg.sender] -= value;
        }
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }
}
