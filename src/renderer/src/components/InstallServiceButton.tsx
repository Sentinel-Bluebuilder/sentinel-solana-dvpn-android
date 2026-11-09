// ─── Install service: the onboarding install, reachable after setup too (Q0305) ───
// On a set-up device whose service is gone, setup no longer takes the window (setup-gate), so the
// "not answering" banner and Diagnostics need this button or there is no way back short of a
// reinstall. Same call as onboarding (DAEMON_INIT install: one administrator prompt on Windows; on
// Android it starts the bundled dvpnd again, as onboarding's "Start service").
// Hooks: data-install-service="idle|busy|done"; errors reach the user through call()'s toast.
import { useState } from 'react';
import { call, useApp } from '../lib/store';
import { byPlatform } from '../lib/platform';

export function InstallServiceButton({ className = 'btn-primary btn-sm' }: { className?: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  return (
    <button className={className} disabled={state === 'busy'} data-install-service={state} onClick={async () => {
      setState('busy');
      try {
        await call(window.api.IPC.DAEMON_INIT, { step: 'install' });
        useApp.getState().toast('success', byPlatform('VPN service installed.', 'VPN service started.'));
        setState('done');
      } catch (err) {
        console.warn('service install failed', err);
        setState('idle');
      }
    }}>{state === 'busy' ? byPlatform('Waiting for Windows…', 'Starting…') : byPlatform('Install service', 'Start service')}</button>
  );
}
