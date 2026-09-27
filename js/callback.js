// OAuth redirect target: hand the code to the app through same-origin storage, strip it from the URL, return to the app.
(function () {
  var p = new URLSearchParams(location.search);
  var msg = document.getElementById('msg');
  if (p.get('error')) { msg.textContent = 'Connection was cancelled: ' + p.get('error'); setTimeout(function () { location.replace('./#/settings/integrations'); }, 2500); return; }
  if (!p.get('code') || !p.get('state')) { msg.textContent = 'Missing authorization code.'; return; }
  try { localStorage.setItem('forge_oauth_result', JSON.stringify({ code: p.get('code'), state: p.get('state'), at: Date.now() })); } catch (e) { msg.textContent = 'Could not store the result: ' + e.message; return; }
  history.replaceState(null, '', location.pathname);
  location.replace('./#/settings/integrations');
})();
