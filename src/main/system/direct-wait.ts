// ─── Wait until the direct internet is really back after a Disconnect ───
// dvpnd removes the tunnel and Windows then re-learns routes and DNS; for a few seconds (longer
// on a slow or loaded machine) the first request after "Disconnected" still times out
// (W5 d, uiproof wireguard/amneziawg/xray: curl empty right after Disconnect, reproduced on a
// quiet host). "Disconnected" should mean the internet works, so Disconnect holds a bounded moment.

export interface DirectWaitDeps {
  /** One direct request; true = it got an answer. */
  probe: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** Probe until it answers or `maxMs` pass. Returns how long it took, or null if it never did. */
export async function waitForDirect(deps: DirectWaitDeps, maxMs = 25_000, everyMs = 1500): Promise<number | null> {
  const start = deps.now();
  for (;;) {
    if (await deps.probe()) return deps.now() - start;
    if (deps.now() - start + everyMs >= maxMs) return null;
    await deps.sleep(everyMs);
  }
}
