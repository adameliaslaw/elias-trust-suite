'use strict';

const DEFAULTS = { enabled: true, port: 4321, client: '', matter: '' };
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(DEFAULTS, (s) => {
  $('enabled').checked = !!s.enabled;
  $('port').value = s.port;
  $('client').value = s.client;
  $('matter').value = s.matter;
  ping();
});

function save() {
  chrome.storage.local.set({
    enabled: $('enabled').checked,
    port: Number($('port').value) || 4321,
    client: $('client').value.trim(),
    matter: $('matter').value.trim(),
  }, ping);
}

for (const id of ['enabled', 'port', 'client', 'matter']) {
  $(id).addEventListener('change', save);
}

function ping() {
  chrome.runtime.sendMessage({ kind: 'matterproof-ping' }, (res) => {
    const el = $('status');
    if (res && res.connected) {
      el.textContent = `● Connected to Matterproof on port ${res.port}`;
      el.className = 'ok';
    } else {
      el.textContent = `○ Not connected — run: billable serve`;
      el.className = 'bad';
    }
  });
}
