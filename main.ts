// Dartboard: a small-stakes pump.fun paper-trading bot for the agent-fun/replay/v2
// harness. The grader runs `node /bot/main.ts`; all of the strategy lives in
// strategy.ts and the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte
// for byte at vendor/makefun-bot.ts. Deterministic: no clock, no randomness.
//
// Entry modes (all tuned on the kit's dev data): small LAUNCH flips on fresh
// curves with real opening demand, plus larger MIGRATION flips on coins closing
// on the 85 SOL migration line with a broad buyer crowd.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
