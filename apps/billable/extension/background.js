'use strict';
// Matterproof background worker: receives capture events from the content
// script and posts them to the local Matterproof server. Runs the fetch here
// (not in the content script) so host_permissions apply. Everything stays on
// 127.0.0.1.

// Settings — including client/matter names — live in chrome.storage.local.
// chrome.storage.sync would silently upload them to the signed-in Google
// account and every synced device, breaking the "nothing leaves your
// machine" privacy model (issue #3).
const DEFAULTS = { enabled: true, port: 4321, client: '', matter: '' };

function settings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (items) => resolve(items || DEFAULTS));
  });
}

// One-time cleanup: earlier versions kept these settings in
// chrome.storage.sync; purge the old synced copy from the Google account.
chrome.storage.sync.remove(Object.keys(DEFAULTS));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.kind === 'matterproof-prompt') {
    handlePrompt(msg).then((ok) => sendResponse({ ok }));
    return true; // async response
  }
  if (msg && msg.kind === 'matterproof-ping') {
    ping().then(sendResponse);
    return true;
  }
});

async function handlePrompt(msg) {
  const s = await settings();
  if (!s.enabled) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: msg.sessionId,
        prompt: `${msg.conversation}: ${msg.prompt}`.slice(0, 500),
        client: s.client || undefined,
        matter: s.matter || undefined,
        source: 'claude-web',
      }),
    });
    setBadge(res.ok);
    return res.ok;
  } catch {
    setBadge(false); // server not running; drop silently
    return false;
  }
}

async function ping() {
  const s = await settings();
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/entries`);
    return { connected: res.ok, port: s.port };
  } catch {
    return { connected: false, port: s.port };
  }
}

function setBadge(ok) {
  chrome.action.setBadgeText({ text: ok ? '' : '!' });
  if (!ok) chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
}
