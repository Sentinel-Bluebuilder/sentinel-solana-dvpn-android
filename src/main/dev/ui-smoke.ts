// ─── UI smoke run (tests only; DVPN_UI_SMOKE=<dir>) ───
// Clicks every sidebar entry, saves a screenshot of each screen, writes
// renderer console errors to errors.json, then quits. Read-only: it never
// presses a button that signs, spends or changes settings.
import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger';
import { rpcCallCounts } from '../../core/chain/rpc';
import { trayActive } from '../system/tray';
import { runScenario } from './ui-scenario';

const SCREENS = ['Connect', 'Servers', 'Plans', 'Activity', 'Node test', 'Wallet', 'Kill switch', 'Split tunnelling', 'Settings', 'Diagnostics', 'CLI'];
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Call before app ready: Windows occlusion throttling would make capturePage return stale frames. */
export function prepareUiSmoke(): void {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  // DVPN_UI_SMOKE_DPI=1.5 renders at 150 % (P7: every screen at 100 % and 150 %).
  const dpi = Number(process.env.DVPN_UI_SMOKE_DPI ?? '');
  if (dpi > 0 && dpi <= 4) app.commandLine.appendSwitch('force-device-scale-factor', String(dpi));
}

async function uiConnect(win: BrowserWindow, target: string, shot: (n: string) => Promise<void>, errors: string[]): Promise<void> {
  const [node, basis = 'per_gb', sub = ''] = target.split(':');
  const js = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code);
  const nav = (label: string): Promise<unknown> => js(`[...document.querySelectorAll('nav[aria-label="Main"] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})?.click()`);
  const until = async (code: string, ms: number): Promise<boolean> => {
    for (let t = 0; t < ms / 500; t++) { if (await js(code)) return true; await wait(500); }
    return false;
  };
  if (basis === 'plan') {
    // Plans -> subscription Servers -> roster Connect -> sheet (ticket, no deposit).
    await nav('Plans');
    if (!(await until(`!!document.querySelector('[data-roster="${sub}"]')`, 30_000))) { errors.push(`ui-connect: no subscription ${sub}`); return; }
    await js(`document.querySelector('[data-roster="${sub}"]').click()`);
    if (!(await until(`!!document.querySelector('[data-plan-connect="${node}"]:not([disabled])')`, 30_000))) { errors.push(`ui-connect: ${node} not connectable on the plan`); await shot('09-roster'); return; }
    await shot('09-roster');
    await js(`document.querySelector('[data-plan-connect="${node}"]').click()`);
    await wait(800);
  } else {
    await nav('Servers');
    // Country groups start collapsed; search for the address like a user would (it opens matches).
    await until(`!!document.querySelector('input[placeholder^="Search"]')`, 10_000);
    await js(`(() => { const i = document.querySelector('input[placeholder^="Search"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(node)});
      i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    if (!(await until(`!!document.querySelector('[data-connect="${node}"]:not([disabled])')`, 30_000))) { errors.push(`ui-connect: no enabled Connect for ${node}`); await shot('09-servers-search'); return; }
    await js(`document.querySelector('[data-connect="${node}"]').click()`);
    await wait(800);
    await js(`[...document.querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith(${JSON.stringify(basis === 'per_hour' ? 'Per hour' : 'Per GB')}))?.click()`);
  }
  await wait(500);
  await shot('09-connect-sheet');
  await js(`document.querySelector('[data-connect-confirm]').click()`);
  await nav('Connect');
  if (!(await until(`!!document.querySelector('[data-disconnect]') && /Protected/.test(document.querySelector('main').textContent)`, 150_000))) {
    errors.push(`ui-connect: not Protected: ${String(await js(`(document.querySelector('main')?.textContent ?? '[no main layout: the setup screen is showing]').slice(0, 200)`))}`);
    await shot('10-connect-failed');
    return;
  }
  await wait(3000);
  await shot('10-connected');
  await js(`document.querySelector('[data-disconnect]').click()`);
  if (!(await until(`!document.querySelector('[data-disconnect]')`, 60_000))) errors.push('ui-connect: Disconnect did not finish');
  await wait(1500);
  await shot('11-disconnected');
}

export function runUiSmoke(win: BrowserWindow, dir: string): void {
  win.webContents.setBackgroundThrottling(false);
  fs.mkdirSync(dir, { recursive: true });
  const errors: string[] = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  win.webContents.once('did-finish-load', async () => {
    try {
      await wait(Number(process.env.DVPN_UI_SMOKE_WAIT_MS ?? 9000));
      // T5: what startup read, per source, before any click (each should be 1 unless retried).
      fs.writeFileSync(path.join(dir, 'rpc-startup.json'), JSON.stringify(rpcCallCounts(), null, 2));
      // DVPN_UI_SMOKE_THEME=dark|light forces a theme for the run (default: the OS's).
      const theme = process.env.DVPN_UI_SMOKE_THEME;
      if (theme === 'dark' || theme === 'light') await win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme', '${theme}')`);
      // DVPN_UI_SMOKE_SIZE=<w>x<h> sets the window's content size (design checks at several widths).
      const size = /^(\d+)x(\d+)$/.exec(process.env.DVPN_UI_SMOKE_SIZE ?? '');
      // Below the 960x640 minimum too: Windows shrinks the window to a small screen anyway
      // (a 1366x768 laptop at 150 % leaves ~910x512), so the layout must hold there.
      if (size) { win.setMinimumSize(Math.min(960, Number(size[1])), Math.min(640, Number(size[2]))); win.setContentSize(Number(size[1]), Number(size[2])); await wait(600); }
      // The design rubric (scripts/ui-audit.js) runs on every screen when the file is present.
      // An installed app has no scripts/ folder: DVPN_UI_AUDIT_DIR points at a folder holding
      // ui-audit.js and axe.min.js (axe-core: WCAG 2 A/AA per screen -> axe.json).
      const auditDir = process.env.DVPN_UI_AUDIT_DIR;
      const auditPath = auditDir ? path.join(auditDir, 'ui-audit.js') : path.join(app.getAppPath(), 'scripts', 'ui-audit.js');
      const auditJs = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
      const axePath = auditDir ? path.join(auditDir, 'axe.min.js') : '';
      const axeJs = axePath && fs.existsSync(axePath) ? fs.readFileSync(axePath, 'utf8') : '';
      const audits: unknown[] = [];
      const axe: unknown[] = [];
      const audit = async (): Promise<void> => {
        if (auditJs) {
          try { audits.push(await win.webContents.executeJavaScript(auditJs)); } catch (err) { errors.push(`ui audit failed: ${(err as Error).message}`); }
        }
        if (!axeJs) return;
        try {
          if (!(await win.webContents.executeJavaScript('typeof window.axe === "object"'))) await win.webContents.executeJavaScript(axeJs);
          axe.push(await win.webContents.executeJavaScript(`(async () => {
            const screen = (document.querySelector('nav[aria-label="Main"] [aria-current="page"]')?.textContent ?? 'setup').trim();
            const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
            return { screen, violations: r.violations.map((x) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.length, targets: x.nodes.slice(0, 4).map((n) => n.target.join(' ')) })) };
          })()`));
        } catch (err) { errors.push(`axe failed: ${(err as Error).message}`); }
      };
      const shot = async (name: string): Promise<void> => {
        // Wait two animation frames in the page, then capture twice: the first
        // capture can return the previous compositor frame.
        await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
        win.webContents.invalidate();
        await win.webContents.capturePage();
        await wait(400);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
      };
      // F2.1: the welcome screen comes first every launch; shoot it, then Continue.
      const welcome = await win.webContents.executeJavaScript('!!document.querySelector("[data-welcome-continue]")');
      if (welcome) {
        await shot('00-welcome');
        await audit();
        await win.webContents.executeJavaScript('document.querySelector("[data-welcome-continue]").click()');
        await wait(1200);
      }
      // Setup steps clear as the first service, wallet and permission reads land (seconds on a
      // cold VM); checking once 1.2 s after Continue skipped the whole run with no error
      // (test-host 2026-10-22). Wait up to 60 s, then say which step held it.
      let onMain = false;
      for (let t = 0; t < 120 && !onMain; t++) {
        onMain = Boolean(await win.webContents.executeJavaScript('!!document.querySelector(\'nav[aria-label="Main"]\')'));
        if (!onMain) await wait(500);
      }
      if (!onMain) {
        await shot('00-onboarding');
        // The onboarding pass (P7) needs the rubric + axe on this screen too, or it passes with 0 audited.
        await audit();
        const held = String(await win.webContents.executeJavaScript('document.querySelector("[data-onboarding-step]")?.getAttribute("data-onboarding-step") ?? "unknown"'));
        errors.push(`setup screen still showing after 60 s (step: ${held}): no screen was walked`);
      } else {
        for (const [i, label] of SCREENS.entries()) {
          const clicked = await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Main"] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
          if (!clicked) errors.push(`nav button missing: ${label}`);
          // Servers waits for the 6 s probe timeout so results are on screen.
          await wait(label === 'Servers' ? 10_000 : label === 'Diagnostics' ? 5000 : 1800);
          // A busy renderer (first probes) can lag the click; wait until the screen really changed.
          for (let t = 0; t < 40; t++) {
            const cur = String(await win.webContents.executeJavaScript(`(document.querySelector('nav[aria-label="Main"] [aria-current="page"]')?.textContent ?? '').trim()`));
            if (cur === label) break;
            await wait(250);
          }
          // Diagnostics: the service + driver checks can outlast the 5 s on a slow (nested) VM, and a
          // shot of the "Checking…" placeholders reads as a half-empty page. Wait up to 30 s more.
          if (label === 'Diagnostics') {
            for (let t = 0; t < 60; t++) {
              if (!(await win.webContents.executeJavaScript(`(document.querySelector('main')?.textContent ?? '').includes('Checking…')`))) break;
              await wait(500);
            }
          }
          const shown = await win.webContents.executeJavaScript(`(document.querySelector('nav[aria-label="Main"] [aria-current="page"]')?.textContent ?? '').trim() + ' | ' + (document.querySelector('main h1')?.textContent ?? '')`);
          if (!String(shown).startsWith(label)) errors.push(`expected ${label}, showing ${shown}`);
          await shot(`${String(i + 1).padStart(2, '0')}-${label.toLowerCase()}`);
          await audit();
          if (label === 'CLI') {
            // Prove the terminal really runs commands: click Run on `version`, read the output.
            await win.webContents.executeJavaScript(`document.querySelector('[data-run="version"]')?.click()`);
            await wait(2500);
            const term = String(await win.webContents.executeJavaScript(`document.querySelector('[role="log"]')?.textContent ?? ''`));
            if (!term.includes('$ version') || !/network devnet/i.test(term.split('$ version')[1] ?? '')) errors.push(`cli terminal did not run version: ${term.slice(-200)}`);
            await shot(`${String(i + 1).padStart(2, '0')}-cli-ran`);
          }
        }
        // Opt-in, SPENDS: DVPN_UI_SMOKE_CONNECT=<node>:<per_gb|per_hour> clicks through a real
        // connect and disconnect. Only for a rig whose tunnel cannot touch this machine (box netns).
        const target = process.env.DVPN_UI_SMOKE_CONNECT;
        if (target) await uiConnect(win, target, shot, errors);
        // DVPN_UI_SCENARIO=<steps>: the matrix cells driven through the real screens (ui-scenario.ts).
        const steps = process.env.DVPN_UI_SCENARIO;
        if (steps) {
          const res = await runScenario(win, dir, steps, shot);
          for (const r of res) if (!r.ok) errors.push(`scenario ${r.step}: ${r.detail}`);
        }
      }
      if (auditJs) fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify(audits, null, 2));
      if (axeJs) fs.writeFileSync(path.join(dir, 'axe.json'), JSON.stringify(axe, null, 2));
      fs.writeFileSync(path.join(dir, 'rpc-end.json'), JSON.stringify(rpcCallCounts(), null, 2));
      // T21: closing the window hides it to the tray (app keeps running); the tray's Open shows it.
      const desktop = { trayActive: trayActive(), hiddenOnClose: false, aliveAfterClose: false, shownAgain: false };
      win.close();
      await wait(1200);
      desktop.aliveAfterClose = !win.isDestroyed();
      desktop.hiddenOnClose = desktop.aliveAfterClose && !win.isVisible();
      if (desktop.aliveAfterClose) { win.showInactive(); await wait(800); desktop.shownAgain = win.isVisible(); }
      if (!desktop.trayActive || !desktop.hiddenOnClose || !desktop.shownAgain) errors.push(`desktop: ${JSON.stringify(desktop)}`);
      // A second launch started now (DVPN_UI_SMOKE_HOLD_MS) must hand over to this window and exit.
      await wait(Number(process.env.DVPN_UI_SMOKE_HOLD_MS ?? 0));
      fs.writeFileSync(path.join(dir, 'desktop.json'), JSON.stringify(desktop, null, 2));
      fs.writeFileSync(path.join(dir, 'errors.json'), JSON.stringify(errors, null, 2));
    } catch (err) {
      log.error('ui smoke failed', err);
      fs.writeFileSync(path.join(dir, 'errors.json'), JSON.stringify([...errors, `smoke crashed: ${(err as Error).message}`], null, 2));
    } finally {
      app.exit(0);
    }
  });
}
