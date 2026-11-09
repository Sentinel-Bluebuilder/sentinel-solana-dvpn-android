// ─── Q0317: a dead WebView renderer must not take the app process down ───
// and1 15:04:32: the sandboxed renderer died unprompted and the whole app process restarted with it
// (am_proc_died, then am_proc_start). Node and dvpnd live in that process, so a Top up / Sign in
// flight never reached the chain and its dialog vanished with no message. The shell now handles
// onRenderProcessGone (returns true) and rebuilds the page.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const kt = readFileSync(join(__dirname, '../../android/app/src/main/java/network/sentinel/devnetdvpn/MainActivity.kt'), 'utf8');

describe('WebView renderer death (Q0317)', () => {
  it('the client handles onRenderProcessGone and keeps the process (returns true)', () => {
    const m = /override fun onRenderProcessGone\(view: WebView, detail: RenderProcessGoneDetail\): Boolean \{([\s\S]*?)\n {12}\}/.exec(kt);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/view\.destroy\(\)/);
    expect(body).toMatch(/buildWeb\(\)/);
    expect(body).toMatch(/return true\s*$/);
    expect(body).not.toMatch(/return false/);
  });

  it('the page is built by one function, used at create and after a renderer death', () => {
    expect(kt).toMatch(/private fun buildWeb\(\) \{/);
    expect(kt.match(/buildWeb\(\)/g)?.length).toBeGreaterThanOrEqual(3); // definition, onCreate, recovery
    // the rebuilt view gets the bridge and the preload again (both inside buildWeb)
    const build = kt.slice(kt.indexOf('private fun buildWeb()'), kt.indexOf('private fun isNight()'));
    expect(build).toMatch(/addJavascriptInterface\(Native\(\), "DdvNative"\)/);
    expect(build).toMatch(/addDocumentStartJavaScript\(web, preloadScript\(\)/);
    expect(build).toMatch(/web\.loadUrl\(/);
  });
});
