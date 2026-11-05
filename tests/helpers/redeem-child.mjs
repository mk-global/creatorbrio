// A separate process that redeems pairing codes with the real StudioSessions,
// for the cross-process tests in tests/production-session-claims.test.ts.
//
// Protocol over IPC: the child loads sessions.ts, then sends { ready: true }.
// The parent sends { rounds: [{ code, at }], storesPerRound }. For each round
// the child builds fresh stores (so rate limits and the guessing cancellation
// from earlier rounds never apply), waits until `at`, and redeems the code
// from every store at once. It replies with one entry per attempt.

import { createJiti } from "jiti";

const [dir] = process.argv.slice(2);
const jiti = createJiti(import.meta.url);
const { StudioSessions } = await jiti.import("../../src/lib/video/production/api/sessions.ts");

process.on("message", async ({ rounds, storesPerRound }) => {
  const attempts = [];
  for (const [round, { code, at }] of rounds.entries()) {
    const stores = Array.from({ length: storesPerRound }, () => new StudioSessions(dir));
    while (Date.now() < at) {
      // Spin rather than sleep: timers on a loaded machine fire late, which would spread the contenders apart.
    }
    const results = await Promise.all(
      stores.map(async (store) => {
        const startedAt = performance.timeOrigin + performance.now();
        const result = await store.redeem(code);
        return { round, ok: result.ok, startedAt };
      }),
    );
    attempts.push(...results);
  }
  process.send({ attempts }); // the parent ends this process once it has the reply
});

process.send({ ready: true });
