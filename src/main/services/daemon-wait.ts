// ─── Wait for the service link ───
// Applying a setting restarts the dvpnd service; the app's link comes back within seconds. A connect
// started in that window waits for it, as the banner promises (test-host 2026-10-22 10:18 UTC:
// Apply then Connect failed at once with "The VPN service is not running").

/** How long a connect waits for the service link. */
export const SERVICE_WAIT_MS = 30_000;

/** The info once `reachable`, or the last info after maxMs. */
export async function waitForDaemon<T extends { reachable: boolean }>(maxMs: number, info: () => T, stepMs = 500): Promise<T> {
  let d = info();
  const until = Date.now() + maxMs;
  while (!d.reachable && Date.now() < until) {
    await new Promise((r) => setTimeout(r, stepMs));
    d = info();
  }
  return d;
}
