'use strict';
// Matterproof content script: detect when the user sends a message on
// claude.ai and forward a capture event to the background worker, which
// posts it to the local Matterproof server. DOM heuristics are deliberately
// loose (claude.ai's markup changes); failure mode is "no capture," never
// interference with the page.

(() => {
  let lastComposerText = '';
  let lastSentAt = 0;

  function composer() {
    return document.querySelector('div[contenteditable="true"]');
  }

  function sessionId() {
    const m = location.pathname.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
    return m ? `web-${m[0]}` : `web-${location.pathname.replace(/\W+/g, '-') || 'new'}`;
  }

  function conversationName() {
    const title = document.title.replace(/\s*[-–|]\s*Claude.*$/i, '').trim();
    return title || 'Claude chat';
  }

  function capture(promptText) {
    const now = Date.now();
    // A click and an Enter can both fire for one send; collapse them.
    if (now - lastSentAt < 1500) return;
    lastSentAt = now;
    try {
      chrome.runtime.sendMessage({
        kind: 'matterproof-prompt',
        sessionId: sessionId(),
        prompt: promptText || conversationName(),
        conversation: conversationName(),
      });
    } catch {
      // Extension was reloaded; the page script will be replaced shortly.
    }
  }

  // Track composer text continuously — by the time a send is confirmed,
  // the composer has usually already been cleared.
  document.addEventListener(
    'input',
    (ev) => {
      const box = composer();
      if (box && (ev.target === box || box.contains(ev.target))) {
        const text = box.innerText.trim();
        if (text) lastComposerText = text;
      }
    },
    true
  );

  document.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
      const box = composer();
      if (box && box.contains(ev.target) && lastComposerText) {
        capture(lastComposerText);
        lastComposerText = '';
      }
    },
    true
  );

  document.addEventListener(
    'click',
    (ev) => {
      const btn = ev.target.closest && ev.target.closest('button[aria-label]');
      if (!btn) return;
      if (/send/i.test(btn.getAttribute('aria-label') || '') && lastComposerText) {
        capture(lastComposerText);
        lastComposerText = '';
      }
    },
    true
  );
})();
