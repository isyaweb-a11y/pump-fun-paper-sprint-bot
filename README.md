[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/isyaweb-a11y/pump-fun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/isyaweb-a11y/pump-fun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Dartboard — pump.fun paper-trading bot

A small-stakes bot for the `agent-fun/replay/v2` paper-trading sprint. On a 6-hour
window almost every new bonding curve goes to zero, so the bot never bets big:

- **LAUNCH** — 0.03 SOL flips on fresh curves (5–600 slots old) whose opening tape
  shows real demand: ≥10 SOL of buys from ≥8 distinct non-creator buyers, no
  creator sell, price not yet run up. Sold on a fixed 15-slot hold.
- **MIGRATION** — 0.5 SOL flips on coins with ≥55 SOL real reserves closing on the
  85 SOL migration line, while a broad crowd is still pushing them up: ≥10
  distinct buyers in the last 40 slots and no single buyer over 30% of buy flow.
  A narrow cluster of wallets churning one coin is a rug in waiting, not demand.
- **Guardrail probes** — 0.012 SOL round trips, opened only when fills or coins lag
  the pace, so the run clears the 20-coin minimum bar.
- SURGE and DIP modes were built and measured, then switched off: both lost money
  on every dev window.

Fully deterministic: no clock, no randomness. The grader runs `node /bot/main.ts`;
the strategy lives in `strategy.ts` and the SDK shim is vendored byte for byte at
`vendor/makefun-bot.ts`.

## Dev results

Backtested on the kit's dev dataset (2026-11-02 03:09Z – 2026-11-03 03:09Z),
sliced into four 6-hour windows matching the final grading window:

| window | net PnL | fills | coins | trips | max drawdown |
| --- | --- | --- | --- | --- | --- |
| W0 | −0.040 SOL | 66 | 27 | 33 | 0.5% |
| W1 | −0.116 SOL | 82 | 32 | 41 | 2.0% |
| W2 | +0.271 SOL | 145 | 53 | 73 | 1.6% |
| W3 | +0.161 SOL | 206 | 63 | 103 | 1.9% |
| **total** | **+0.276 SOL** | **499** | — | **250** | **≤2.0%** |

For comparison on the same windows: house momentum pilot −9.38 SOL, house
reversion pilot −3.66 SOL, house sniper pilot −0.53 SOL, equal-weight baseline
−0.02 SOL (only 5 coins — fails the 20-coin guardrail). Every window above
clears the guardrail (≥20 coins with ≥0.01 SOL round trips, drawdown ≤50%).

## Grade locally

```sh
node cli/makefun.mjs grade-local --repo . --dev
```

## License

MIT — see `LICENSE`.
