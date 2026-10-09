# IMD Money Back — payout engine

Off-chain engine for **IMD Money Back ($MONEYBACK)** on Robinhood Chain (chain id 4663). Every
15 minutes it works out which holders who bought through the MONEYBACK/IMD Uniswap v4 pool are
underwater, and pays part of their loss back in IMD through the `RoundPayout` contract. The pot is
funded by the MoneyBackHook's swap fees plus the pouch share of the launch distributor's LP fees.

TypeScript, run with `tsx`. It uses `viem` for chain access and `vitest` for tests, and runs under
pm2 on a Linux VPS. There is no frontend and no Solidity here. The engine reads the contracts and
calls them.

```
src/
  config.ts       launch.json + env knobs (rules, ops, exec, rpc); hardcodes only IMD, PoolManager, dead
  abi.ts          event/function ABIs (RoundPayout ABI from launch.json takes precedence)
  rpc.ts          round-robin RPC with backoff, getLogs endpoint, pinned priority endpoint, bisecting
                  chunked getLogs, lowest-head-minus-margin, timestamp interpolation, disk cache
  indexer.ts      backfill + follow; decode, group by tx, classify, rebuild wallet ledgers
  twap.ts         3-minute TWAP close (pure)
  eligibility.ts  eligibility + loss for a wallet at a close (pure; shared by rounds, snapshot, api)
  payout.ts       weights, caps, water-filling split, chunking, roundId (pure)
  ledger.ts       canonical ledger JSON + keccak256 ledgerHash + files
  rounds.ts       bookClaim (pure), deterministic history of every epoch, the per-epoch runner
  fees.ts         hook.sweep(), pending(), distributor trigger
  executor.ts     live state machine: fund -> prove -> payRound chunks -> retry/write-off
  wallet.ts       payout signer (key from env only), nonces, send with timeout + confirmations
  snapshot.ts     data/*.json + prices
  api.ts          GET /api/status, GET /api/wallet/:address, static /data/*
  alerts.ts       Telegram alerts + heartbeat
  lock.ts         single-writer lock
  log.ts          JSON log lines
  bin/            pm2 entry points: rounds, snapshot, data
scripts/          discover-launch.ts, reconcile-claim.ts, replay.ts
test/             vitest suites (offline), fixtures/replay (logs + expected ledgers)
```

## The rules it implements

1. **Epochs.** An epoch is 900 s, on a fixed grid from `launchTs`. Epoch *k* closes at
   `launchTs + (k+1)·900`. The **close** is the 3-minute TWAP of IMD per MONEYBACK ending at the
   boundary. It is built from the price after each Swap on our pool. If the window has no swaps,
   the last price carries. If two swaps share a timestamp, the last one wins.
2. **Qualifying buy.** This is a tx in which all of the following hold:
   - the wallet's balance rose;
   - tokens left *our* pool (a `Swap` on our pool id, with a positive token delta);
   - the hook emitted `FeeAccrued`.

   The qualifying tokens are capped at the tokens that left the pool. Tokens that arrive any other
   way have zero basis and never earn: airdrops, OTC, transfers and other pools.

   A wallet is **eligible** if it still holds every qualifying token and its qualifying buys add up
   to at least `MIN_BUY_IMD`. A wallet is **disqualified forever** if it ever sends tokens to
   another address (a sell on any venue, or a transfer out). Excluded addresses and addresses with
   code never qualify.
3. **Basis and loss.** The basis is the IMD spent including all fees: the swap's IMD leg (which
   contains the 1.25% LP fee) plus the hook's `baseFeeImd + surchargeImd`. It is split pro-rata
   over the tokens delivered. The entry price is the VWAP of those buys. The loss is
   `max(0, (entry − close) · heldQualifying)`, in IMD.
4. **Caps.** A single drop pays a wallet at most ⅓ of its current loss (`MAX_ROUND_RATIO`). Total
   payments never exceed the loss (`MAX_PAYOUT_RATIO = 1`). Once a wallet is covered it gets nothing
   until a deeper loss appears.
5. **Pot.** The pot for a drop is made up as follows:
   - the IMD from hook `Swept` events to the payout wallet since the last drop;
   - plus 25% of the IMD received from the distributor in that time (from its IMD `Transfer`s);
   - minus `OPS_SKIM_FRACTION` and the one-time `DEX_RESERVE_QUOTE` (both default 0);
   - plus the leftover carried from the previous drop.

   The other 75% of the distributor receipts is the team share: it is shown in `treasury.json` and
   never paid. No other IMD inflow ever counts toward the pot. The pot is split by
   `weight = loss^a · pct^b` (a=1, b=0, so a pure share of the loss). A water-fill re-splits
   whatever a capped wallet cannot take. Legs under `MIN_PAYOUT_IMD` are skipped and the remainder
   rolls forward.
6. **Transactions.** One `payRound` is sent per chunk of at most 200 payees, with
   `roundId = epochIndex·1000 + chunkIndex`. There is one ledger per drop, and its keccak256 is the
   `ledgerHash` argument.
7. **Exclusions.** These addresses never qualify: the deployer, factory, distributor, PoolManager,
   hook, router, RoundPayout, the payout wallet, the dead and zero addresses, any address with code,
   `launch.json.exclude` and `EXCLUDE_ADDRESSES`.

**Timing of inflows.** The engine sweeps right after each boundary. For that reason, inflows with a
timestamp in `(B_{k−1}+grace, B_k+grace]` count toward drop *k*, with `grace = CLAIM_GRACE_SECONDS`
(default 120). Eligibility and the close are still taken at `B_k`. This keeps replays deterministic:
the pot is a function of the logs alone.

**Swap sign convention.** A v4 `Swap` event carries the swapper's `BalanceDelta`: a negative value
was paid into the pool, a positive one was taken out. The currency order is read from the pool's
`Initialize` log and never assumed.

## Install

Requires Node ≥ 22.9 and pm2 (`npm i -g pm2`).

```
npm ci
npm test            # offline: twap, eligibility, payout, bookClaim, indexer, executor, replay
npm run typecheck
```

## Configure

1. Find the on-chain launch facts from the token address:

   ```
   RPC_URLS=https://rpc.mainnet.chain.robinhood.com npm run discover -- <MONEYBACK address> --from <block before launch>
   ```

   This prints the `poolId`, `hook`, `launchBlock/Ts/Tx`, the `deployer` (sender of the launch tx)
   and the `factory` (its target). It also lists the contracts that received tokens in the launch
   tx as `distributorCandidates`.
2. Copy `launch.example.json` to `launch.json` and fill in the printed fields. Then add
   `router`, `roundPayout` and `payoutWallet` from the deployment. Optionally add:
   - `imdEthPoolId`, the public ETH/IMD v4 pool, used for USD prices;
   - `distributorTrigger`, the distributor's permissionless trigger as
     `{"signature": "function …", "args": [...]}`. Without it the engine logs that the 1% share
     is not being realised.
   - `roundPayoutAbi`, the ABI shipped with the deployment.

   The loader refuses to start while any field is missing or still reads `REPLACE`.
3. Copy `env.example` to `.env`. Every variable is commented there, and the defaults are the locked
   product rules.

## Dry run (default)

```
npm run rounds:once
```

This backfills from `launchBlock` and computes every closed epoch. It writes the ledgers to
`data/ledgers/` and prints two things: the latest drop, and the would-be payouts if the next epoch
closed now (unswept hook fees included). Nothing is sent: `EXECUTOR=dry-run` never loads a key. To
run it continuously:

```
pm2 start ecosystem.config.cjs     # apps: rounds, snapshot, data
pm2 logs rounds
```

## Go live

1. Fund the payout wallet with a little ETH for gas. The IMD arrives through sweeps and distributor
   receipts.
2. In `.env`, set `EXECUTOR=live` and `PAYOUT_PRIVATE_KEY=0x…`. Set `RPC_PRIORITY_URL` to your most
   reliable node. Set `MAX_ROUND_PAYOUT_QUOTE` to a sane ceiling.
3. Run `pm2 restart rounds --update-env`.

Each epoch the live rounds app does the following, one round at a time:

- **sweep.** Calls `hook.sweep()` (if `pending() > 0`) and the distributor trigger.
- **bookClaim.** Books the pot from the indexed `Swept` events and distributor transfers.
- **compute.** Computes eligibility at the TWAP close, then the drop and its ledger.
- **execute:**
  - If the pause file exists, it stops.
  - It refuses any drop above `MAX_ROUND_PAYOUT_QUOTE` and alerts.
  - It skips any chunk the contract already reports as `isPaid`.
  - It calls `approve` and then `fund(IMD, need)` once per drop.
  - It **proves the funding** in two ways: the receipt must contain the IMD `Transfer` payout
    wallet → RoundPayout of exactly `need`, *and* a priority-node `balanceOf(RoundPayout) ≥ need`
    read at or after the funding block. If the priority node is behind, or briefly reports a stale
    zero, the round is deferred to the next tick. It is never failed, and it is never funded twice.
  - It sends `payRound` per chunk, re-checking `isPaid` before each send.
  - It reads `failed(roundId, payee)` for every leg. Failed legs are retried with `retryFailed` up
    to `MAX_LEG_RETRIES` times, then `writeOffFailed`.

Execution state is kept in `data/state/exec.json`. Only one process may write: the rounds app holds
`data/state/writer.lock`.

**Pause:** `touch data/PAUSE`, or the file named in `PAUSE_FILE`. Removing the file resumes.

**Refused drop:** check the ledger. Once you are satisfied, raise the cap and delete that epoch's
entry from `data/state/exec.json`.

### Key handling

`PAYOUT_PRIVATE_KEY` is read from the environment only, and only when `EXECUTOR=live`. It is never
written to disk or logged. Send errors are scrubbed of it, and the signer refuses to start if the key
does not control `launch.json.payoutWallet`. Keep `.env` at mode `600`. It is git-ignored.

## Alerts

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. You get alerts for:

- a paid drop (amount, number of payees, ledger hash);
- a failed or written-off leg;
- a refused or failed round;
- a ledger that changed on recomputation, which is treated as an incident and halts the rounds;
- a stall: no progress for `STALL_MINUTES`;
- a heartbeat every `HEARTBEAT_MINUTES`.

Without a token, alerts go to the pm2 log.

## Data and API

The `snapshot` app writes the following to `data/` every 60 s:

| file | contents |
|---|---|
| `token.json` | addresses and rules |
| `status.json` | index progress, next boundary, unswept fees, next-drop estimate, `prices {imdUsd, ethUsd, tokenUsd, source, at}` (if a refresh fails, the last good value is kept) |
| `treasury.json` | sweeps, distributor gross, pouch, team, skim, reserve, paid, carry |
| `rounds.json` | per epoch: close, pot, paid, payees, ledgerHash, roundIds, execution status |
| `chart.json` | close / pot / paid series |
| `leaderboard.json` | top 100 by paid, then by loss |
| `wallets.json` | every wallet's eligibility, entry, loss, paid |
| `ledgers/epoch-NNNNNNN.json` | one per drop (written by the rounds app) |

The prices come from two places. `imdUsd` is the RH ETH/IMD pool spot (read through
`PoolManager.extsload`) combined with ETH/USD from CoinGecko, or from Dexscreener as a fallback.
`tokenUsd` is our pool's spot × `imdUsd`. Payouts are always made in IMD.

The `data` app serves these on `API_HOST:API_PORT` (default `127.0.0.1:8787`; put a reverse proxy in
front):

- `GET /api/status`
- `GET /api/wallet/0x…` returns eligibility, reason, entry, loss at the last close, total paid, the
  next-drop estimate, and the wallet's buys. It uses the same eligibility and payout code as the
  rounds.
- `GET /data/<file>.json`

## Reading a ledger

`data/ledgers/epoch-0000042.json` is canonical JSON: fixed key order, integers as decimal strings, no
whitespace.

```
{"version":1,"epochIndex":42,"boundaryTs":…,"token":"0x…","closeX96":"…","pot":"…","paidTotal":"…",
 "leftover":"…","totalEligibleLoss":"…",
 "entries":[{"payee":"0x…","loss":"…","entry":"…","close":"…","amount":"…"},…],
 "chunks":[{"roundId":"42000","payees":[…],"amounts":[…]},…]}
```

- Amounts are IMD wei, 18 decimals.
- `entry` and `close` are Q96 prices of IMD per MONEYBACK: divide by 2^96 to get IMD per token.
- `entries` lists every eligible underwater wallet, including those that got 0 this drop because
  they are capped, already covered, or under `MIN_PAYOUT`.

## Verifying a drop on-chain

1. `keccak256` of the ledger file's exact bytes is the `ledgerHash`:

   ```
   cast keccak "$(cat data/ledgers/epoch-0000042.json)"
   ```

2. Each `chunks[i].roundId` must be paid with that hash:

   ```
   cast call <roundPayout> "isPaid(uint256)(bool)" 42000 --rpc-url $RPC
   cast logs --address <roundPayout> "RoundPaid(uint256 indexed,address,uint256,bytes32,uint256,uint256)" --from-block <b> --rpc-url $RPC
   ```

   The arguments of the `payRound` tx are `(roundId, IMD, payees, amounts, ledgerHash, closeX96,
   totalEligibleLoss)`. They must equal the ledger chunk.
3. Recompute everything independently:

   ```
   npm run replay          # recompute every drop from data/index and diff against on-chain RoundPaid
   ```

   `npm run replay:fixture` does the same offline, using the committed fixture logs. Its ledgers must
   match `test/fixtures/replay/expected/` byte for byte.

## Out-of-band claims

Sometimes IMD reaches the payout wallet through a sweep or distributor payment that the indexer did
not book, for example through an older hook. Record it with:

```
npm run reconcile -- <txHash> --kind sweep|distributor --note "why"
```

This appends the entry to `data/claims-manual.json`. That file feeds the next drop and every replay.
If the tx's inflow of that kind is already indexed, it is never counted twice.

## Trust assumptions and limits

- The payout wallet's key holder can stop paying (pause file) or decline to go live. `RoundPayout`
  is owned by that wallet. Ledgers and `replay` make any deviation publicly checkable.
- The code check ("any address with code") runs once per wallet and is cached in
  `data/index/code.json`. It is only done for wallets with a qualifying buy.
- The cumulative-paid figure used for the made-whole cap counts each computed drop. A leg that was
  later written off on-chain still counts as paid.
- The engine decodes the hook's `FeeAccrued(bool,uint256,uint256,uint256)` and
  `Swept(uint256,address)` by declaration order, so it does not depend on which parameters are
  `indexed`. The topic hashes must match those signatures.
- `RoundPaid`'s exact layout comes from the ABI shipped in `launch.json`. The built-in ABI is a
  best-effort default used by `replay`.
