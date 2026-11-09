// ─── Plain copy for "cannot reach the VPN service" (F23: never raw errors) ───
// The raw gRPC / pipe text still goes to the log; the user sees one of these.

export function daemonLinkCopy(raw: string): string {
  if (/access is denied|permission|EACCES|EPERM/i.test(raw)) {
    return 'This app is not allowed to talk to the VPN service. Reinstall the service to fix its permissions.';
  }
  if (/deadline|timed? ?out/i.test(raw)) return 'The VPN service did not answer in time.';
  if (/ECONNREFUSED|ENOENT|UNAVAILABLE|No connection established|cannot reach|dial|not found|cannot find/i.test(raw)) {
    return 'The VPN service is not running.';
  }
  return 'The VPN service could not be reached.';
}
