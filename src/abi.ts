// Event and function ABIs the engine reads or calls.
import { parseAbi, parseAbiItem, toEventSelector, type Abi } from 'viem';

export const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
export const swapEvent = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);
export const initializeEvent = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);
export const feeAccruedEvent = parseAbiItem(
  'event FeeAccrued(bool isSell, uint256 baseFeeImd, uint256 surchargeImd, uint256 imdLeg)',
);
export const sweptEvent = parseAbiItem('event Swept(uint256 imdAmount, address to)');
export const roundPaidEvent = parseAbiItem(
  'event RoundPaid(uint256 indexed roundId, address token, uint256 total, bytes32 ledgerHash, uint256 twapCloseX96, uint256 totalEligibleLoss)',
);

export const TOPIC = {
  transfer: toEventSelector(transferEvent),
  swap: toEventSelector(swapEvent),
  initialize: toEventSelector(initializeEvent),
  feeAccrued: toEventSelector(feeAccruedEvent),
  swept: toEventSelector(sweptEvent),
  roundPaid: toEventSelector(roundPaidEvent),
};

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const hookAbi = parseAbi([
  'function sweep()',
  'function pending() view returns (uint256)',
  'event FeeAccrued(bool isSell, uint256 baseFeeImd, uint256 surchargeImd, uint256 imdLeg)',
  'event Swept(uint256 imdAmount, address to)',
]);

export const poolManagerAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);

/** Built-in RoundPayout ABI; the copy shipped in launch.json (roundPayoutAbi) takes precedence. */
export const defaultRoundPayoutAbi: Abi = parseAbi([
  'function fund(address token, uint256 amount)',
  'function payRound(uint256 roundId, address token, address[] to, uint256[] amounts, bytes32 ledgerHash, uint256 twapCloseX96, uint256 totalEligibleLoss)',
  'function retryFailed(uint256 roundId, address[] to)',
  'function writeOffFailed(uint256 roundId, address to)',
  'function isPaid(uint256 roundId) view returns (bool)',
  'function failed(uint256 roundId, address to) view returns (uint256)',
  'function paused() view returns (bool)',
  'event RoundPaid(uint256 indexed roundId, address token, uint256 total, bytes32 ledgerHash, uint256 twapCloseX96, uint256 totalEligibleLoss)',
]);
