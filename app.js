'use strict';
/*
 * Generic unlock runtime. Brand-agnostic: it renders the whole canonical shell from window.DRIVER and
 * carries NO brand string and NO protocol UUID of its own - everything brand-specific comes from the
 * driver (meta/connection/telemetry/settings/advanced/logAnonymize/docs + the pure protocol functions).
 * Swap the driver -> this runtime drives a different scooter unchanged.
 *
 * Transport model (M3, multi-characteristic): connection.transports = [{role,uuid,notify,optional}]. A
 * single-char brand may instead declare connection.char (string|{write}) and the runtime synthesizes one
 * 'main' transport. RX dispatches by the notifying characteristic's uuid -> its transport role:
 *   - a driver with onNotify(role,bytes,S) owns all decode/reassembly (per-char; returns an ack key or null),
 *   - otherwise the legacy single-char framed path reassembles by driver.reassemble + validate + decode + rxKey.
 * Writes go to connection.defaultTarget unless the settings/advanced item carries a `target` role. An optional
 * connection.onConnect(tx) runs a handshake after subscribe (tx.write(role,bytes), tx.log/logErr/logDiag).
 */

// Pre-commit cache-buster auto-bumps BUILD and every ?v= on any web-asset change.
const BUILD = 'v1';

const D = (typeof window !== 'undefined' && window.DRIVER) ? window.DRIVER : null;

// --------------------------- helpers ---------------------------
const $ = (id) => document.getElementById(id);
const hex = (arr) => Array.from(arr, b => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(' ');
const short = (u) => String(u).slice(0, 8).toUpperCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MID = D ? D.meta.id : 'device';
const LS = { THEME: MID + '_theme', OPEN: MID + '_open', EKFV: MID + '_ekfv', PUBLOG: MID + '_publog', DEV: MID + '_device' };

let dev = null, server = null, busy = false;
let connected = false;
let curModel = D ? D.meta.defaultModel : null;

// live device state, rebuilt from the push frames (the command builders read from this)
const S = D ? D.newState() : {};
function resetState() { const fresh = D.newState(); for (const k of Object.keys(fresh)) S[k] = fresh[k]; }

// --------------------------- transports (multi-characteristic; single-char brands synthesize one) ---------------------------
function deriveTransports() {
  if (!D) return [];
  const c = D.connection;
  if (Array.isArray(c.transports) && c.transports.length) return c.transports.map(t => Object.assign({}, t));
  const uuid = (typeof c.char === 'string') ? c.char : (c.char && c.char.write);
  return [{ role: 'main', uuid: uuid, notify: true, legacy: true }];
}
const TRANSPORTS = deriveTransports();
const DEFAULT_TARGET = (D && D.connection.defaultTarget) || (TRANSPORTS[0] && TRANSPORTS[0].role) || 'main';
const MAIN_UUID = (TRANSPORTS[0] && TRANSPORTS[0].uuid) || '';
const chByRole = {};   // role -> BluetoothRemoteGATTCharacteristic
function transportByUuid(u) { u = String(u).toLowerCase(); return TRANSPORTS.find(t => String(t.uuid).toLowerCase() === u); }
function uuidForRole(role) { const t = TRANSPORTS.find(t => t.role === role); return t ? t.uuid : MAIN_UUID; }

// --------------------------- log (redaction pipeline: scrub secrets + anonymize PII) ---------------------------
let logBuffer = [];   // { raw, cls }
let publicLog = true; // anonymize device name/id/MAC on display/copy/save (default on)
let diag = false;     // verbose diagnostics (default off)
const LA = (D && D.logAnonymize) || { mask: [], redact: [] };
function redact(text) {
  let s = String(text);
  if (dev && dev.id) s = s.split(dev.id).join('[redacted-id]');
  for (const r of (LA.redact || [])) s = s.replace(r.re, r.repl);
  return s;
}
// Unconditional secret scrubber, runs at the source before the buffer (independent of the Public Log toggle).
function maskSecrets(text) {
  let s = String(text);
  for (const r of (LA.mask || [])) s = s.replace(r.re, r.repl);
  return s;
}
function anonymize(s) {
  if (!publicLog) return String(s).replace(/\x01/g, '');
  return redact(String(s).replace(/\x01[^\x01]*\x01/g, 'XX').replace(/\x01/g, ''));
}
function logLine(cls, text) {
  const safe = '[' + new Date().toTimeString().slice(0, 8) + '] ' + maskSecrets(text);
  logBuffer.push({ raw: safe, cls: cls });
  const el = $('log'); if (!el) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = anonymize(safe) + '\n';
  el.appendChild(span); el.scrollTop = el.scrollHeight;
}
function renderLog() {
  const el = $('log'); if (!el) return;
  el.textContent = '';
  for (const e of logBuffer) { const span = document.createElement('span'); if (e.cls) span.className = e.cls; span.textContent = anonymize(e.raw) + '\n'; el.appendChild(span); }
  el.scrollTop = el.scrollHeight;
}
function logText() { return logBuffer.map(e => anonymize(e.raw)).join('\n'); }
const logTx = (b, u) => logLine('log-tx', '>>> ' + short(u || MAIN_UUID) + ' | ' + hex(b));
const logRx = (b, u) => logLine('log-rx', '<<< ' + short(u || MAIN_UUID) + ' | ' + hex(b));
const logSys = (t) => logLine('', '--- ' + t);
const logErr = (t) => logLine('log-err', '!!! ' + t);
const logDiag = (t) => { if (diag) logLine('', '... ' + t); };
// CRLF on Windows so the copied log pastes cleanly into Notepad (nv osNewline polish).
function osNewline() { return (navigator.platform || '').toLowerCase().indexOf('win') === 0 ? '\r\n' : '\n'; }
function saveLog() {
  try {
    const blob = new Blob([logText().split('\n').join(osNewline())], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'laufbursche42-' + MID + '-log.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logSys('log saved');
  } catch (e) { logErr('save failed: ' + (e && e.message ? e.message : e)); }
}
function logDiagnosticHeader() {
  const st = D ? D.selfTest() : { ok: false };
  logLine('', '=== ' + MID + '-unlock diagnostic ===');
  logLine('', 'build: ' + BUILD);
  logLine('', 'time: ' + new Date().toISOString());
  logLine('', 'userAgent: ' + (navigator.userAgent || '?'));
  logLine('', 'platform: ' + (navigator.platform || '?'));
  logLine('', 'webBluetooth: ' + (navigator.bluetooth ? 'yes' : 'no'));
  logLine('', 'protocol self-test: ' + (st.ok ? 'OK' : 'FAILED'));
  logLine('', '================================');
}

// --------------------------- i18n ---------------------------
let lang = 'de';
function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function L(obj) { return obj ? (obj[lang] != null ? obj[lang] : obj.de) : ''; }
function ctx() { return { lang: lang, t: t }; }
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => { const v = t(n.getAttribute('data-t')); if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v; }); // scan-ok: curated i18n values with markup (banner/disclaimer links); own table, not user input
  document.querySelectorAll('[data-t-ph]').forEach(n => { const v = t(n.getAttribute('data-t-ph')); if (v) n.setAttribute('placeholder', v); });
  ['GUIDE', 'README', 'LICENSE', 'PRIVACY', 'TRADEMARKS'].forEach(name => { const el = $('link-' + name.toLowerCase()); if (el) el.href = docFile(name); });
  { const el = $('langs'); if (el) el.setAttribute('aria-label', t('langGroup')); }
  { const el = $('build-ver'); if (el) el.textContent = t('buildLabel') + ' ' + BUILD; }
  document.querySelectorAll('#langs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  renderTiles(); renderSettings(); renderAdvanced(); refreshTiles(); updateSpeedUI();
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
  { const dark = document.documentElement.getAttribute('data-theme') !== 'light'; const el = $('btn-theme'); if (el) { el.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); el.title = el.getAttribute('aria-label'); } }
}
function initLangSwitch() { document.querySelectorAll('#langs button').forEach(b => b.addEventListener('click', () => { lang = b.dataset.lang; applyLang(); })); }

// --------------------------- theme ---------------------------
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = $('btn-theme');
  if (b) { b.textContent = dark ? '\u2600' : '\u263E'; b.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); b.title = b.getAttribute('aria-label'); }
  try { localStorage.setItem(LS.THEME, dark ? 'dark' : 'light'); } catch (e) {}
}
function initTheme() {
  let saved = null; try { saved = localStorage.getItem(LS.THEME); } catch (e) {}
  applyTheme(saved !== 'light');
  const b = $('btn-theme'); if (b) b.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light'));
}

// --------------------------- model selector (only when meta.models.length > 1) ---------------------------
function itemVisible(item) { if (!item || !item.model) return true; return item.model.indexOf('*') >= 0 || item.model.indexOf(curModel) >= 0; }
function renderModelBar() {
  const bar = $('model-bar'); if (!bar) return;
  const models = (D && D.meta.models) || [];
  if (models.length <= 1) { bar.hidden = true; bar.textContent = ''; return; }
  bar.hidden = false; bar.textContent = '';
  const sel = document.createElement('select'); sel.id = 'model-select';
  models.forEach(m => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.label; sel.appendChild(o); });
  sel.value = curModel;
  sel.addEventListener('change', () => { curModel = sel.value; renderTiles(); renderSettings(); renderAdvanced(); refreshTiles(); updateSpeedUI(); });
  bar.appendChild(sel);
}

// --------------------------- status ---------------------------
function statusLabel(s) {
  const map = { disconnected: 'stDisconnected', connecting: 'stConnecting', linking: 'stLinking', connected: 'stConnected', 'no-service': 'stNoService' };
  return t(map[s] || 'stDisconnected') || s;
}
function setStatus(s) {
  const el = $('status'); if (el) { el.dataset.state = s; el.textContent = statusLabel(s); }
  const cb = $('btn-conn');
  if (cb) { const on = (s === 'connecting' || s === 'linking' || s === 'connected'); cb.textContent = on ? t('btnDisconnect') : t('btnConnect'); cb.dataset.act = on ? 'disconnect' : 'connect'; }
}
function setControlsEnabled(on) {
  // telemetry + settings cards hidden until connected; on load only intro/connect/log show. A card whose body
  // is empty for the current driver/model (e.g. no battery tiles) stays hidden even when connected (honest).
  const cards = [['live-card', 'live-grid'], ['batt-card', 'batt-grid'], ['more-card', 'settings-root'], ['raw-card', 'advanced-root']];
  for (const pair of cards) {
    const el = $(pair[0]); if (!el) continue;
    const body = $(pair[1]); const empty = !body || body.children.length === 0;
    el.hidden = !on || empty;
  }
  document.querySelectorAll('[data-conn]').forEach(e => { e.disabled = !on; });
}

// --------------------------- tiles (built from driver telemetry) ---------------------------
const tileEls = {};   // key -> { b, item }
function buildGrid(containerId, items) {
  const box = $(containerId); if (!box) return;
  box.textContent = '';
  for (const item of items) {
    if (!itemVisible(item)) continue;
    const tile = document.createElement('div'); tile.className = 'tile';
    const b = document.createElement('b'); b.textContent = '-';
    const small = document.createElement('small'); small.textContent = L(item.label);
    tile.appendChild(b); tile.appendChild(small); box.appendChild(tile);
    tileEls[item.key] = { b: b, item: item };
  }
}
function renderTiles() {
  for (const k of Object.keys(tileEls)) delete tileEls[k];
  buildGrid('live-grid', (D.telemetry && D.telemetry.live) || []);
  buildGrid('batt-grid', (D.telemetry && D.telemetry.battery) || []);
}
function refreshTiles() {
  const c = ctx();
  for (const k of Object.keys(tileEls)) {
    const { b, item } = tileEls[k];
    let v = null; try { v = item.get(S, c); } catch (e) { v = null; }
    b.textContent = (v == null ? '-' : v);
  }
}
function resetTiles() { for (const k of Object.keys(tileEls)) tileEls[k].b.textContent = '-'; }

// --------------------------- connect (GATT service is the real gate; 4x retry) ---------------------------
async function connect() {
  if (!navigator.bluetooth) { logErr(t('errNoWebBt')); return; }
  try {
    setStatus('connecting');
    const showAll = ($('showall') || {}).checked;
    const optional = D.connection.services;
    const filterSvc = D.connection.filterServices || D.connection.services;
    const opts = showAll
      ? { acceptAllDevices: true, optionalServices: optional }
      : { filters: [{ services: filterSvc }], optionalServices: optional };
    dev = await navigator.bluetooth.requestDevice(opts);
    dev.addEventListener('gattserverdisconnected', onDisconnected);
    try { localStorage.setItem(LS.DEV, dev.id); } catch (e) {}
    logSys('device: \x01' + (dev.name || '(no name)') + '\x01');
    setStatus('linking');
    await connectGatt();
    setStatus('connected'); connected = true;
    setControlsEnabled(true);
    { const el = $('devinfo'); if (el) el.textContent = t('devPrefix') + ' \x01' + (dev.name || D.meta.brand) + '\x01'; }
    logSys('connected, subscribed to ' + TRANSPORTS.filter(tp => tp.notify).map(tp => short(tp.uuid)).join('/'));
  } catch (e) {
    logErr('connect failed: ' + (e && e.message ? e.message : e));
    connected = false; setStatus('disconnected'); setControlsEnabled(false);
  }
}
// tolerate the Android discovery race (nv 4x retry): service can be briefly absent right after link.
async function connectGatt() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      server = await dev.gatt.connect();
      const svc = await resolveService(server);
      if (!svc) { setStatus('no-service'); throw new Error(D.meta.brand + ' service ' + short(D.connection.services[0]) + ' not found'); }
      for (const k of Object.keys(chByRole)) delete chByRole[k];
      for (const tp of TRANSPORTS) {
        try {
          const c = await svc.getCharacteristic(tp.uuid);
          chByRole[tp.role] = c;
          if (tp.notify) { await c.startNotifications(); c.addEventListener('characteristicvaluechanged', onCharValue); }
        } catch (e) {
          if (tp.optional) { chByRole[tp.role] = null; logDiag('optional characteristic ' + tp.role + ' absent'); }
          else throw e;
        }
      }
      // optional handshake (telemetry kick etc.): driver gets a tiny tx with write(role,bytes) + loggers
      if (typeof D.connection.onConnect === 'function') {
        const tx = { write: (role, bytes) => writeFrameTo(role, bytes), log: logSys, logErr: logErr, logDiag: logDiag };
        try { await D.connection.onConnect(tx); } catch (e) { logDiag('onConnect: ' + (e && e.message ? e.message : e)); }
      }
      return;
    } catch (e) {
      lastErr = e; logDiag('connect attempt ' + attempt + ' failed: ' + (e && e.message ? e.message : e));
      try { if (dev.gatt.connected) dev.gatt.disconnect(); } catch (_) {}
      await sleep(400);
    }
  }
  throw lastErr || new Error('gatt connect failed');
}
async function resolveService(srv) {
  for (const uuid of D.connection.services) { try { return await srv.getPrimaryService(uuid); } catch (_) {} }
  return null;
}
function onDisconnected() {
  connected = false; for (const k of Object.keys(chByRole)) delete chByRole[k]; rxBuf = [];
  if (typeof D.reset === 'function') { try { D.reset(S); } catch (e) {} }
  setStatus('disconnected'); setControlsEnabled(false);
  resetState(); resetTiles(); clearAcks(); updateSpeedUI();
  const el = $('devinfo'); if (el) el.textContent = '';
  logSys('disconnected');
}
function disconnect() { if (dev && dev.gatt.connected) dev.gatt.disconnect(); }

// --------------------------- notify + ACK ---------------------------
let rxBuf = [];   // legacy single-char framed reassembly buffer (drivers without onNotify)
function onCharValue(ev) {
  const b = Array.from(new Uint8Array(ev.target.value.buffer));
  const uuid = (ev.target && ev.target.uuid) ? ev.target.uuid : MAIN_UUID;
  logRx(b, uuid);
  const tp = transportByUuid(uuid) || TRANSPORTS[0] || { role: 'main' };
  if (typeof D.onNotify === 'function') {
    // driver owns all per-characteristic decode/reassembly; returns an ack key to resolve, or null
    let rxKey = null;
    try { rxKey = D.onNotify(tp.role, b, S); } catch (e) { logDiag(tp.role + ' parse error: ' + (e && e.message ? e.message : e)); }
    if (rxKey) resolveAck(rxKey);
  } else {
    legacyFramedNotify(b);
  }
  refreshTiles(); updateSpeedUI(); applyReportToSettings();
}
// legacy single-char framed path: reassemble by the driver's header + declared length, validate, decode, ack.
function legacyFramedNotify(b) {
  for (const x of b) rxBuf.push(x);
  const R = D.reassemble;
  while (rxBuf.length >= R.min) {
    if (rxBuf[0] !== R.header) { rxBuf.shift(); continue; }
    const N = rxBuf[R.lenAt]; const total = N + R.extra;
    if (rxBuf.length < total) break;
    const frame = rxBuf.slice(0, total); rxBuf = rxBuf.slice(total);
    if (!D.validate(frame)) { logDiag('bad checksum, dropped: ' + hex(frame)); continue; }
    D.decode(frame, S);
    if (typeof D.rxKey === 'function') resolveAck(D.rxKey(frame));
  }
}
const pendingAcks = new Map();
const ACK_TIMEOUT_MS = 3000;
function armAck(key, label) {
  clearAckTimer(key);
  const timer = setTimeout(() => { pendingAcks.delete(key); logSys(label + ': ' + t('ackNone')); }, ACK_TIMEOUT_MS);
  pendingAcks.set(key, { timer, label });
}
function resolveAck(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); logSys(a.label + ': ' + t('ackOk')); } }
function clearAckTimer(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); } }
function clearAcks() { for (const a of pendingAcks.values()) clearTimeout(a.timer); pendingAcks.clear(); }

// --------------------------- transmit (single funnel: log TX, arm ack, write to the target role's char) ---------------------------
async function writeFrameTo(role, bytes) {
  const c = chByRole[role] || chByRole[DEFAULT_TARGET] || chByRole[(TRANSPORTS[0] || {}).role];
  if (!c) throw new Error('characteristic ' + role + ' not available');
  const arr = Uint8Array.from(bytes);
  // write WITH response when supported; fall back if the stack reports otherwise.
  if (c.properties.write) return c.writeValueWithResponse(arr);
  if (c.properties.writeWithoutResponse) return c.writeValueWithoutResponse(arr);
  return c.writeValue(arr);
}
async function transmit(bytes, label, ackKey, target) {
  if (!connected) { logErr(t('errNotConnected')); return; }
  const role = target || DEFAULT_TARGET;
  logTx(bytes, uuidForRole(role));
  if (ackKey) armAck(ackKey, label);
  try { await writeFrameTo(role, bytes); logSys(label + ': ' + t('txSent')); }
  catch (e) { clearAckTimer(ackKey); logErr(label + ' ' + t('txFailed') + ': ' + (e && e.message ? e.message : e)); }
}
// serialize writes (eg guard mutex)
async function guard(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { logErr(e && e.message ? e.message : String(e)); } finally { busy = false; } }

// --------------------------- confirm dialog (themed; window.confirm fallback) ---------------------------
function confirmRisky(msg) {
  return new Promise(resolve => {
    const dlg = $('confirm'); const body = $('confirm-body');
    if (!dlg || !dlg.showModal) { resolve(window.confirm(msg)); return; }
    if (body) body.textContent = msg;
    const ok = $('confirm-ok'), cancel = $('confirm-x'), no = $('confirm-no');
    const done = (v) => { dlg.close(); ok.removeEventListener('click', onOk); if (no) no.removeEventListener('click', onNo); if (cancel) cancel.removeEventListener('click', onNo); resolve(v); };
    const onOk = () => done(true), onNo = () => done(false);
    ok.addEventListener('click', onOk); if (no) no.addEventListener('click', onNo); if (cancel) cancel.addEventListener('click', onNo);
    dlg.showModal();
  });
}

// --------------------------- settings engine (driver-driven; selects report-gated unless gate:false) ---------------------------
let selectRows = [];   // { item, row, sel }
let numberRows = [];   // { item, row, inp }
let speedWidget = null;
function groupKey(item) { return item.group ? (item.group.de || '') : ''; }
function renderSettings() {
  const box = $('settings-root'); if (!box) return;
  box.textContent = '';
  selectRows = []; numberRows = []; speedWidget = null;
  let lastGroup = null;
  for (const item of D.settings) {
    if (!itemVisible(item)) continue;
    const gk = groupKey(item);
    if (gk !== lastGroup) { lastGroup = gk; const h = document.createElement('h3'); h.className = 'set-group'; h.textContent = L(item.group); box.appendChild(h); }
    if (item.type === 'speed') renderSpeed(box, item);
    else if (item.type === 'action') renderAction(box, item);
    else if (item.type === 'number') renderNumber(box, item);
    else renderSelect(box, item);
  }
  applyReportToSettings();
}
function renderSelect(box, item) {
  const row = document.createElement('div'); row.className = 'set-row'; row.hidden = (item.gate !== false);
  const lab = document.createElement('label'); lab.textContent = L(item.label); row.appendChild(lab);
  const sel = document.createElement('select'); sel.setAttribute('data-conn', ''); sel.disabled = !connected;
  (item.options || []).forEach(o => { const opt = document.createElement('option'); opt.value = String(o.val); opt.textContent = L(o.label); sel.appendChild(opt); });
  row.appendChild(sel);
  const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = t('btnSet'); btn.setAttribute('data-conn', ''); btn.disabled = !connected;
  btn.addEventListener('click', () => guard(async () => {
    const v = parseInt(sel.value, 10) || 0;
    if (item.risky && !await confirmRisky(L(item.warn))) return;
    await transmit(item.write(v, S), L(item.label), item.ack, item.target);
  }));
  row.appendChild(btn); box.appendChild(row);
  if (item.hint) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = L(item.hint); box.appendChild(p); }
  selectRows.push({ item: item, row: row, sel: sel });
}
function renderAction(box, item) {
  const btns = document.createElement('div'); btns.className = 'btns';
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'primary span2';
  btn.textContent = L(item.label); btn.setAttribute('data-conn', ''); btn.disabled = !connected;
  btn.addEventListener('click', () => guard(async () => {
    if (item.risky && !await confirmRisky(L(item.warn))) return;
    await transmit(item.write(null, S), L(item.label), item.ack, item.target);
  }));
  btns.appendChild(btn); box.appendChild(btns);
  if (item.hint) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = L(item.hint); box.appendChild(p); }
}
function renderNumber(box, item) {
  const row = document.createElement('div'); row.className = 'set-row'; row.hidden = (item.gate === true);
  const lab = document.createElement('label'); lab.textContent = L(item.label); row.appendChild(lab);
  const inp = document.createElement('input'); inp.type = 'number'; inp.step = String(item.step || 1);
  if (item.bounds) { inp.min = String(item.bounds.min); inp.max = String(item.bounds.max); }
  inp.setAttribute('data-conn', ''); inp.disabled = !connected;
  if (item.placeholder) inp.placeholder = item.placeholder;
  const lsKey = item.ls ? (MID + '_' + item.ls) : null;
  let seeded = null; if (lsKey) { try { seeded = localStorage.getItem(lsKey); } catch (e) {} }
  if (seeded != null) inp.value = seeded; else if (item.default != null) inp.value = String(item.default);
  if (lsKey) inp.addEventListener('change', () => { try { localStorage.setItem(lsKey, inp.value); } catch (e) {} });
  row.appendChild(inp);
  const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = t('btnSet'); btn.setAttribute('data-conn', ''); btn.disabled = !connected;
  btn.addEventListener('click', () => guard(async () => {
    const v = parseInt(inp.value, 10);
    const lo = item.bounds ? item.bounds.min : -Infinity, hi = item.bounds ? item.bounds.max : Infinity;
    if (!(v >= lo && v <= hi)) { logErr(t(item.errKey || 'errSpeedRange')); return; }
    if (item.risky && !await confirmRisky(L(item.warn))) return;
    await transmit(item.write(v, S), L(item.label) + ' ' + v, item.ack, item.target);
  }));
  row.appendChild(btn); box.appendChild(row);
  if (item.hint) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = L(item.hint); box.appendChild(p); }
  numberRows.push({ item: item, row: row, inp: inp });
}
function renderSpeed(box, item) {
  const lb = item.labels;
  const btns = document.createElement('div'); btns.className = 'btns';
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'primary span2';
  toggle.setAttribute('data-conn', ''); toggle.disabled = !connected;
  btns.appendChild(toggle); box.appendChild(btns);

  const two = document.createElement('div'); two.className = 'two';
  const mkFld = (labObj, def, lsKey) => {
    const fld = document.createElement('div'); fld.className = 'fld';
    const lab = document.createElement('label'); lab.textContent = L(labObj); fld.appendChild(lab);
    const inp = document.createElement('input'); inp.type = 'number'; inp.step = '1';
    inp.min = String(item.bounds.min); inp.max = String(item.bounds.max); inp.value = String(def);
    let saved = null; try { saved = localStorage.getItem(lsKey); } catch (e) {}
    if (saved) inp.value = saved;
    fld.appendChild(inp); two.appendChild(fld);
    return inp;
  };
  const openIn = mkFld(lb.open, item.defaults.open, LS.OPEN);
  const ekfvIn = mkFld(lb.ekfv, item.defaults.ekfv, LS.EKFV);
  box.appendChild(two);

  const cur = document.createElement('p'); cur.className = 'hint'; box.appendChild(cur);
  if (item.hint) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = L(item.hint); box.appendChild(p); }

  openIn.addEventListener('change', () => { try { localStorage.setItem(LS.OPEN, openIn.value); } catch (e) {} });
  ekfvIn.addEventListener('change', () => { try { localStorage.setItem(LS.EKFV, ekfvIn.value); } catch (e) {} updateSpeedUI(); });
  toggle.addEventListener('click', () => guard(async () => {
    const inp = (toggle.dataset.mode === 'lock') ? ekfvIn : openIn;
    const v = parseInt(inp.value, 10);
    if (!(v >= item.bounds.min && v <= item.bounds.max)) { logErr(t('errSpeedRange')); return; }
    await transmit(item.write(v, S), L(item.logLabel) + ' ' + (v & 0xff) + ' km/h', item.ack, item.target);
  }));

  speedWidget = { item: item, toggle: toggle, openIn: openIn, ekfvIn: ekfvIn, cur: cur };
}
function updateSpeedUI() {
  if (!speedWidget) return;
  const w = speedWidget, item = w.item, lb = item.labels;
  const limit = item.read(S);
  w.cur.textContent = (limit == null) ? L(lb.curUnknown) : (L(lb.curPrefix) + ' ' + limit + ' km/h');
  const ekfv = parseInt(w.ekfvIn.value, 10) || item.defaults.ekfv;
  const locked = (limit == null) ? true : (limit <= ekfv);
  w.toggle.dataset.mode = locked ? 'unlock' : 'lock';
  w.toggle.textContent = locked ? L(lb.unlock) : L(lb.lock);
}
function applyReportToSettings() {
  for (const r of selectRows) {
    let cur = null; try { cur = r.item.read(S); } catch (e) { cur = null; }
    if (cur != null) { r.row.hidden = false; if (document.activeElement !== r.sel) r.sel.value = String(cur); }
  }
  for (const r of numberRows) {
    if (!r.item.reflect || typeof r.item.read !== 'function') continue;
    let cur = null; try { cur = r.item.read(S); } catch (e) { cur = null; }
    if (cur != null) { r.row.hidden = false; if (document.activeElement !== r.inp) r.inp.value = String(cur); }
  }
}

// --------------------------- advanced tier (raw verbatim + free builder + engine-level numbers) ---------------------------
function renderAdvanced() {
  const box = $('advanced-root'); if (!box) return;
  box.textContent = '';
  const items = (D.advanced || []).filter(itemVisible);
  let first = true, lastGroup = null;
  for (const item of items) {
    const gk = item.group ? (item.group.de || '') : null;
    if (gk != null) {
      if (gk !== lastGroup) { lastGroup = gk; const h = document.createElement('h3'); h.className = 'set-group'; h.textContent = L(item.group); box.appendChild(h); }
    } else if (!first) { const hr = document.createElement('hr'); hr.className = 'sep'; box.appendChild(hr); }
    first = false;
    if (item.type === 'raw') renderRaw(box, item);
    else if (item.type === 'free') renderFree(box, item);
    else if (item.type === 'number') renderNumber(box, item);
  }
}
function renderRaw(box, item) {
  const row = document.createElement('div'); row.className = 'set-row';
  const lab = document.createElement('label'); lab.textContent = L(item.label); row.appendChild(lab);
  let targetSel = null;
  if (item.targets && item.targets.length) {
    targetSel = document.createElement('select'); targetSel.setAttribute('data-conn', ''); targetSel.disabled = !connected;
    item.targets.forEach(r => { const o = document.createElement('option'); o.value = r; o.textContent = item.targetLabels ? L(item.targetLabels[r]) : r; targetSel.appendChild(o); });
    if (item.target) targetSel.value = item.target;
    row.appendChild(targetSel);
  }
  const inp = document.createElement('input'); inp.type = 'text'; inp.setAttribute('data-conn', ''); inp.disabled = !connected;
  if (item.placeholder) inp.placeholder = item.placeholder; row.appendChild(inp);
  const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = L(item.btn); btn.setAttribute('data-conn', ''); btn.disabled = !connected;
  btn.addEventListener('click', () => guard(async () => {
    const bytes = D.build.raw(inp.value || '');
    if (!bytes.length) { logErr(t('errNoBytes')); return; }
    const tgt = targetSel ? targetSel.value : item.target;
    await transmit(bytes, L(item.logLabel) + (targetSel ? ' (' + tgt + ')' : ''), null, tgt);   // sent verbatim, no header/checksum added
  }));
  row.appendChild(btn); box.appendChild(row);
  if (item.hint) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = L(item.hint); box.appendChild(p); }
}
function renderFree(box, item) {
  const two = document.createElement('div'); two.className = 'two';
  const mk = (labObj, ph, max) => {
    const fld = document.createElement('div'); fld.className = 'fld';
    const lab = document.createElement('label'); lab.textContent = L(labObj); fld.appendChild(lab);
    const inp = document.createElement('input'); inp.type = 'text'; if (max) inp.maxLength = max; if (ph) inp.placeholder = ph;
    inp.setAttribute('data-conn', ''); inp.disabled = !connected; fld.appendChild(inp); two.appendChild(fld);
    return inp;
  };
  const opIn = mk(item.opLabel, item.opPlaceholder, item.radix === 'dec' ? 3 : 2);
  const payIn = mk(item.payloadLabel, item.payloadPlaceholder, 0);
  box.appendChild(two);
  const btns = document.createElement('div'); btns.className = 'btns';
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'primary span2'; btn.textContent = L(item.btn);
  btn.setAttribute('data-conn', ''); btn.disabled = !connected;
  btn.addEventListener('click', () => guard(async () => {
    const radix = item.radix === 'dec' ? 10 : 16;
    const op = parseInt(opIn.value, radix);
    if (isNaN(op)) { logErr(t(item.errKey || 'errBadOp')); return; }
    const bytes = D.build.free(opIn.value, payIn.value || '');
    if (!bytes) { logErr(t(item.errKey || 'errBadOp')); return; }
    const tag = (radix === 16) ? ' 0x' + (op & 0xff).toString(16) : ' #' + op;
    await transmit(bytes, L(item.logLabel) + tag, null, item.target);   // proper frame + checksum, or driver-defined bytes
  }));
  btns.appendChild(btn); box.appendChild(btns);
  if (item.hint) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = L(item.hint); box.appendChild(p); }
}

// --------------------------- doc viewer (markdown of our own docs) ---------------------------
const DOC_TITLES = { 'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide', 'README.md': 'footReadme', 'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense', 'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy', 'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks' };
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = s => s.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
function docFile(name) { if (name === 'README') return 'README.md'; if (name === 'GUIDE') return 'GUIDE.' + lang + '.md'; return name + (lang === 'de' ? '.de.md' : '.md'); }
function mdToHtml(src) {
  const inline = s => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => DOC_TITLES[href] ? '<a href="' + href + '" data-docfile="' + href + '">' + text + '</a>' : '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>');
  const lines = String(src).split(/\r?\n/); let html = '', inList = false, inCode = false;
  for (const ln of lines) {
    if (/^```/.test(ln)) { if (inCode) { html += '</pre>'; inCode = false; } else { if (inList) { html += '</ul>'; inList = false; } html += '<pre class="doc-code">'; inCode = true; } continue; }
    if (inCode) { html += escHtml(ln) + '\n'; continue; }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) { if (inList) { html += '</ul>'; inList = false; } const lvl = h[1].length + 1; html += '<h' + lvl + ' id="' + slug(h[2]) + '">' + inline(h[2]) + '</h' + lvl + '>'; continue; }
    const li = ln.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(li[1]) + '</li>'; continue; }
    if (/^\s*$/.test(ln)) { if (inList) { html += '</ul>'; inList = false; } continue; }
    if (inList) { html += '</ul>'; inList = false; }
    html += '<p>' + inline(ln) + '</p>';
  }
  if (inList) html += '</ul>'; if (inCode) html += '</pre>';
  return html;
}
const docCache = {};
async function openDocFile(file) {
  const dlg = $('doc'); const titleEl = $('doc-title'); const bodyEl = $('doc-body');
  titleEl.textContent = t(DOC_TITLES[file] || 'footReadme');
  if (lang === 'de' && /\.md$/.test(file) && !/\.de\.md$/.test(file) && file !== 'README.md') titleEl.textContent += ' (englisch)';
  try { if (!docCache[file]) { const r = await fetch(file); docCache[file] = await r.text(); } bodyEl.innerHTML = mdToHtml(docCache[file]); } // scan-ok: own in-repo markdown rendered via mdToHtml; not user input
  catch (e) { bodyEl.textContent = 'Could not load ' + file; }
  if (dlg.showModal) dlg.showModal();
}
function openDisclaimer() { openHelpText(t('footDisclaimer'), D && D.docs && D.docs.disclaimer ? L(D.docs.disclaimer) : ''); }
function wireDocViewer() {
  // delegated: footer doc links, the intro guide link (injected by i18n at runtime), in-doc links, disclaimer
  document.addEventListener('click', e => {
    const d = e.target.closest('a[data-doc]'); if (d) { e.preventDefault(); openDocFile(docFile(d.getAttribute('data-doc'))); return; }
    const df = e.target.closest('a[data-docfile]'); if (df) { e.preventDefault(); openDocFile(df.getAttribute('data-docfile')); return; }
    const disc = e.target.closest('[data-open-disclaimer]'); if (disc) { e.preventDefault(); openDisclaimer(); return; }
  });
  ['doc-x', 'doc-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', () => $('doc').close()); });
}

// --------------------------- help modal ---------------------------
function openHelp(key) { openHelpText(t('help_' + key + '_t'), t('help_' + key + '_b')); }
function openHelpText(title, body) {
  const dlg = $('help'); $('help-title').textContent = title || ''; const b = $('help-body'); if (/[<&]/.test(body || '')) b.innerHTML = body; else b.textContent = body || ''; // scan-ok: curated i18n help text; own table, not user input
  if (dlg.showModal) dlg.showModal();
}
function closeHelp() { const d = $('help'); if (d) d.close(); }

// --------------------------- init ---------------------------
window.addEventListener('DOMContentLoaded', () => {
  if (!D) { return; }
  initLangSwitch(); initTheme(); wireDocViewer(); renderModelBar(); renderTiles(); renderSettings(); renderAdvanced();
  applyLang(); setStatus('disconnected'); resetTiles();
  logDiagnosticHeader();

  $('btn-conn').addEventListener('click', () => { if ($('btn-conn').dataset.act === 'disconnect') disconnect(); else guard(connect); });

  document.querySelectorAll('.help-btn[data-help]').forEach(btn => btn.addEventListener('click', () => openHelp(btn.getAttribute('data-help'))));
  ['help-x', 'help-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', closeHelp); });
  { const b = $('link-disclaimer'); if (b) b.addEventListener('click', e => { e.preventDefault(); openDisclaimer(); }); }

  { const cb = $('public-log'); if (cb) { let saved = null; try { saved = localStorage.getItem(LS.PUBLOG); } catch (e) {} publicLog = saved !== '0'; cb.checked = publicLog; cb.addEventListener('change', () => { publicLog = cb.checked; try { localStorage.setItem(LS.PUBLOG, cb.checked ? '1' : '0'); } catch (e) {} renderLog(); }); } }
  { const cb = $('diag-log'); if (cb) { cb.addEventListener('change', () => { diag = cb.checked; logSys(diag ? 'diagnostic log on' : 'diagnostic log off'); }); } }
  { const b = $('btn-clear-log'); if (b) b.addEventListener('click', () => { logBuffer = []; $('log').textContent = ''; logDiagnosticHeader(); }); }
  { const b = $('btn-copy-log'); if (b) b.addEventListener('click', () => navigator.clipboard.writeText(logText()).then(() => logSys('log copied')).catch(() => {})); }
  { const b = $('btn-save-log'); if (b) b.addEventListener('click', saveLog); }
});
