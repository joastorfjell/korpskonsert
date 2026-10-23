/* Korpskonsert – offline chord chart + backing track player for iPad.
   Data lives in IndexedDB (imported from a .korps bundle); the app shell is cached by sw.js. */
'use strict';

const APP_VERSION = '1.1.0';
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtT = t => { if (!isFinite(t)) t = 0; t = Math.max(0, t); const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + String(s).padStart(2, '0'); };
const clone = o => JSON.parse(JSON.stringify(o));

/* ================= IndexedDB ================= */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('korpskonsert', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('songs', { keyPath: 'id' });
        d.createObjectStore('files', { keyPath: 'id' });
        d.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode), s = t.objectStore(store);
      let out; const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  all(store) { return this.tx(store, 'readonly', s => s.getAll()); },
  get(store, k) { return this.tx(store, 'readonly', s => s.get(k)); },
  put(store, v) { return this.tx(store, 'readwrite', s => s.put(v)); },
  del(store, k) { return this.tx(store, 'readwrite', s => s.delete(k)); },
  clear(store) { return this.tx(store, 'readwrite', s => s.clear()); },
};

/* ================= Settings ================= */
const DEFAULT_SETTINGS = { theme: 'dark', naming: 'intl', fs: 1, perRow: 'sheet', preroll: true, wake: true, invertSheet: false };
let settings = Object.assign({}, DEFAULT_SETTINGS);
async function loadSettings() { const m = await DB.get('meta', 'settings'); if (m) Object.assign(settings, m.v); applySettings(); }
function saveSettings() { applySettings(); return DB.put('meta', { k: 'settings', v: settings }); }
function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--fs', settings.fs);
}

/* ================= Chords ================= */
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, H: 11 };
function notePc(n) { let p = PC[n[0]]; for (const ch of n.slice(1)) p += ch === '#' ? 1 : ch === 'b' ? -1 : 0; return (p + 12) % 12; }
function parseChord(s) {
  s = (s || '').trim(); if (!s) return null;
  let unsure = false; if (s.endsWith('?')) { unsure = true; s = s.slice(0, -1); }
  const m = /^([A-H])([#b]?)(.*?)(?:\/([A-H])([#b]?))?$/.exec(s);
  if (!m) return { raw: s, unsure };
  return { root: notePc(m[1] + m[2]), q: m[3] || '', bass: m[4] ? notePc(m[4] + m[5]) : null, unsure, rootName: m[1] + m[2], bassName: m[4] ? m[4] + m[5] : null };
}
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm']);
function keyName(key, semis) {
  if (!key) return null;
  const minor = /m$/.test(key) && !/maj$/.test(key);
  const root = key.replace(/m$/, '');
  const pc = (notePc(root) + semis + 120) % 12;
  // choose spelling for the key itself
  const flatPref = minor ? [3, 5, 7, 0, 10].includes(pc) : [5, 10, 3, 8, 1, 6].includes(pc);
  return (flatPref ? FLAT : SHARP)[pc] + (minor ? 'm' : '');
}
function useFlats(song) {
  const k = keyName(song.keySig || 'C', song.transpose || 0);
  if (!k) return true;
  if (FLAT_KEYS.has(k)) return true;
  if (k === 'C' || k === 'Am') return true;
  return false;
}
function spell(pc, flats) {
  let n = (flats ? FLAT : SHARP)[(pc + 120) % 12];
  if (settings.naming === 'no') { if (n === 'B') n = 'H'; else if (n === 'Bb') n = 'B'; else if (n === 'A#') n = 'B'; }
  return n;
}
function prettyQ(q) {
  return esc(q).replace(/maj/g, 'maj').replace(/b(?=\d)/g, '♭').replace(/#(?=\d)/g, '♯');
}
function chordText(s, song) {
  const c = parseChord(s); if (!c) return '';
  if (c.raw) return c.raw;
  const t = song.transpose || 0, fl = useFlats(song);
  return spell(c.root + t, fl) + c.q + (c.bass != null ? '/' + spell(c.bass + t, fl) : '');
}
function chordHTML(s, song) {
  const c = parseChord(s); if (!c) return '';
  if (c.raw) return esc(c.raw);
  const t = song.transpose || 0, fl = useFlats(song);
  const root = spell(c.root + t, fl).replace('b', '♭').replace('#', '♯');
  let q = c.q, html = esc(root);
  // minor 'm' stays on baseline, rest becomes superscript
  const mm = /^(m(?!aj))?(.*)$/.exec(q);
  if (mm[1]) html += 'm';
  if (mm[2]) html += '<sup class="q">' + prettyQ(mm[2]) + '</sup>';
  if (c.bass != null) html += '<span class="sl">/' + esc(spell(c.bass + t, fl).replace('b', '♭').replace('#', '♯')) + '</span>';
  return html;
}

/* ================= Song model helpers ================= */
function beatsOf(ts) {
  const m = /^(\d+)\/(\d+)$/.exec(ts || '4/4'); if (!m) return 4;
  const n = +m[1], d = +m[2];
  if (d === 8 && n % 3 === 0 && n > 3) return n / 3;
  if (d === 8 && n === 3) return 1;
  return n;
}
function prep(song) {
  // derived structures (not stored)
  const byN = new Map(); let ts = song.timeSig || '4/4';
  song.measures.forEach((m, i) => { if (m.ts) ts = m.ts; m._ts = ts; m._beats = beatsOf(ts); m._i = i; byN.set(m.n, m); });
  song._byN = byN;
  const exp = [];
  const form = song.form && song.form.length ? song.form : [[song.measures[0].n, song.measures[song.measures.length - 1].n]];
  for (const [a, b] of form) {
    let ia = song.measures.findIndex(m => m.n === a), ib = song.measures.findIndex(m => m.n === b);
    if (ia < 0 || ib < 0) continue;
    for (let i = ia; i <= ib; i++) exp.push(song.measures[i].n);
  }
  if (!exp.length) song.measures.forEach(m => exp.push(m.n));
  song._exp = exp;
  // chord events over expanded positions
  const ev = []; let last = null;
  exp.forEach((n, k) => {
    const m = byN.get(n);
    if (m.rest && !(m.chords && m.chords.length)) { if (last !== 'N.C.') { ev.push({ pos: k, c: null }); last = 'N.C.'; } return; }
    for (const [c, b] of (m.chords || [])) {
      const pos = k + clamp((b - 1) / m._beats, 0, 0.999);
      if (c !== last) { ev.push({ pos, c }); last = c; }
    }
  });
  song._ev = ev;
  // sections in performance order: start, rehearsal mark, or a jump in the form (repeat, D.S., coda)
  const secs = [], secOf = [];
  exp.forEach((n, k) => {
    const m = byN.get(n), jump = k > 0 && byN.get(exp[k - 1])._i + 1 !== m._i;
    if (!k || m.mark || jump) secs.push({ k0: k, k1: k, n0: n, n1: n, label: m.mark || '', jump });
    const c = secs[secs.length - 1]; c.k1 = k; c.n1 = n;
  });
  // long unmarked stretches (charts without rehearsal letters) are split into 8-measure chunks
  for (let i = 0; i < secs.length; i++) {
    const c = secs[i];
    if (c.k1 - c.k0 + 1 > 16) secs.splice(i + 1, 0, { k0: c.k0 + 8, k1: c.k1, n0: exp[c.k0 + 8], n1: c.n1, label: '' }), c.k1 = c.k0 + 7, c.n1 = exp[c.k1];
  }
  secs.forEach((c, i) => { for (let k = c.k0; k <= c.k1; k++) secOf[k] = i; });
  song._secs = secs; song._secOf = secOf;
  // lines for the focus view: 4 measures in play order, never across sections; runs of 3+ rests become one line
  const isRest = k => { const m = byN.get(exp[k]); return m.rest && !(m.chords && m.chords.length); };
  const lines = [], lineOf = [];
  for (const sec of secs) {
    let cur = null, first = true;
    const push = ln => { ln.sec = sec; ln.first = first; first = false; ln.ks.forEach(k => lineOf[k] = lines.length); lines.push(ln); };
    const flush = () => { if (cur) push(cur); cur = null; };
    for (let k = sec.k0; k <= sec.k1;) {
      let j = k; while (j <= sec.k1 && isRest(j)) j++;
      if (j - k >= 3) { flush(); push({ rest: true, ks: Array.from({ length: j - k }, (_, i) => k + i) }); k = j; continue; }
      if (!cur) cur = { ks: [] };
      cur.ks.push(k++); if (cur.ks.length === 4) flush();
    }
    flush();
  }
  song._lines = lines; song._lineOf = lineOf;
  // carried chord per printed measure (for display)
  let carry = null;
  for (const m of song.measures) { m._carry = carry; if (m.chords && m.chords.length) carry = m.chords[m.chords.length - 1][0]; }
}
function chordAt(song, pos) { let c = null; for (const e of song._ev) { if (e.pos <= pos + 1e-6) c = e.c; else break; } return c; }
function occurrences(song, n) { const r = []; song._exp.forEach((x, k) => { if (x === n) r.push(k); }); return r; }
function rec(song) { return (song.recordings || [])[song.recIndex || 0] || null; }

/* time map: [[t, pos|null], ...] sorted by t */
function posAt(map, t) {
  if (!map || !map.length || t < map[0][0]) return null;
  let lo = 0, hi = map.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (map[mid][0] <= t) lo = mid; else hi = mid - 1; }
  const a = map[lo], b = map[lo + 1];
  if (a[1] == null) return null;
  if (b && b[1] != null && b[1] > a[1] && b[1] - a[1] <= 8) return a[1] + (t - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
  // discontinuity or end: extrapolate with the local measure duration, at most to the end of this measure
  const d = localDur(map, lo);
  const p = a[1] + (t - a[0]) / d;
  if (!b && p >= Math.floor(a[1]) + 1 && a[1] % 1 === 0 && t - a[0] > d * 1.5) return null;
  return Math.min(p, Math.floor(a[1]) + 0.999);
}
function localDur(map, i) {
  for (let j = i; j > 0; j--) { const a = map[j - 1], b = map[j]; if (a[1] != null && b[1] != null && b[1] > a[1]) return (b[0] - a[0]) / (b[1] - a[1]); }
  for (let j = i; j < map.length - 1; j++) { const a = map[j], b = map[j + 1]; if (a[1] != null && b[1] != null && b[1] > a[1]) return (b[0] - a[0]) / (b[1] - a[1]); }
  return 2;
}
function timesAt(map, pos) {
  const out = [];
  if (!map) return out;
  for (let i = 0; i < map.length; i++) {
    const a = map[i], b = map[i + 1];
    if (a[1] == null) continue;
    if (b && b[1] != null && b[1] > a[1] && b[1] - a[1] <= 8) {
      if (pos >= a[1] && pos < b[1]) out.push(a[0] + (pos - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    } else if (pos >= a[1] && pos < Math.floor(a[1]) + 1) out.push(a[0] + (pos - a[1]) * localDur(map, i));
  }
  return out;
}

/* ================= State ================= */
const S = {
  songs: [], song: null, mode: 'chart', editing: false, syncing: false,
  pos: null, cursor: null,            // pos: fractional expanded position from audio; cursor: expanded index when no audio
  loop: null, loopPick: null, tap: null, rate: 1, objUrl: null, lastMeasureKey: null, pageUrls: [],
};
const audio = $('#audio');

/* ================= UI helpers ================= */
function toast(msg, ms) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms || 2200);
}
function modal(title, html, onMount) {
  $('#mTitle').textContent = title; $('#mBody').innerHTML = html; $('#modal').classList.remove('hidden');
  if (onMount) onMount($('#mBody'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#mBody').innerHTML = ''; }
$('#mClose').onclick = closeModal;
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
function choose(title, options) {
  return new Promise(res => {
    modal(title, '<div class="choices">' + options.map((o, i) => `<button class="btn" data-i="${i}">${o}</button>`).join('') + '</div>');
    $$('#mBody [data-i]').forEach(b => b.onclick = () => { closeModal(); res(+b.dataset.i); });
    $('#mClose').onclick = () => { closeModal(); res(-1); $('#mClose').onclick = closeModal; };
  });
}
function numpad(title, initial) {
  return new Promise(res => {
    let v = initial != null ? String(initial) : '';
    modal(title, `<div class="kpdisp" id="kpd"></div><div class="keypad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="btn" data-k="${n}">${n}</button>`).join('')}
      <button class="btn ghost" data-k="del">⌫</button><button class="btn" data-k="0">0</button><button class="btn primary" data-k="ok">OK</button></div>`);
    const d = $('#kpd'); const upd = () => d.textContent = v || ' ';
    upd();
    $$('#mBody [data-k]').forEach(b => b.onclick = () => {
      const k = b.dataset.k;
      if (k === 'del') v = v.slice(0, -1); else if (k === 'ok') { closeModal(); res(v === '' ? null : +v); return; } else if (v.length < 4) v += k;
      upd();
    });
    $('#mClose').onclick = () => { closeModal(); res(null); $('#mClose').onclick = closeModal; };
  });
}

/* ================= Song list ================= */
async function loadSongs() {
  S.songs = (await DB.all('songs')).sort((a, b) => (a.order || 0) - (b.order || 0) || a.title.localeCompare(b.title));
  renderList();
}
function renderList() {
  const el = $('#songList');
  if (!S.songs.length) {
    el.innerHTML = `<div class="empty">Ingen sanger ennå.<br>Trykk <b>Importer</b> og velg datafila (<i>korpskonsert-data.korps</i>),<br>f.eks. fra iCloud Drive eller AirDrop → Filer.</div>`;
    return;
  }
  el.innerHTML = S.songs.map((s, i) => {
    const r = (s.recordings || []).length, synced = (s.recordings || []).some(x => x.map && x.map.length);
    const tr = s.transpose ? `<span class="tag warn">Transp. ${s.transpose > 0 ? '+' : ''}${s.transpose}</span>` : '';
    return `<div class="songrow" data-id="${esc(s.id)}">
      <div class="num">${i + 1}</div>
      <div style="flex:1;min-width:0"><div class="t">${esc(s.title)}</div>
        <div class="meta">${esc(s.part || '')} · ${esc(keyName(s.keySig, s.transpose || 0) || s.keySig || '')} · ${esc(s.timeSig || '')} · ${s.measures.length} takter</div></div>
      <div class="tags">${tr}${r ? `<span class="tag ${synced ? 'ok' : 'warn'}">${r} opptak${synced ? ' ✓' : ''}</span>` : '<span class="tag">uten opptak</span>'}${s.edited ? '<span class="tag warn">redigert</span>' : ''}</div>
      <div class="mv"><button class="btn ghost" data-mv="-1">▲</button><button class="btn ghost" data-mv="1">▼</button></div>
    </div>`;
  }).join('');
  $$('.songrow', el).forEach(row => row.onclick = async e => {
    const mv = e.target.closest('[data-mv]');
    if (mv) {
      e.stopPropagation();
      const i = S.songs.findIndex(s => s.id === row.dataset.id), j = i + (+mv.dataset.mv);
      if (j < 0 || j >= S.songs.length) return;
      [S.songs[i], S.songs[j]] = [S.songs[j], S.songs[i]];
      for (let k = 0; k < S.songs.length; k++) { S.songs[k].order = k; await DB.put('songs', strip(S.songs[k])); }
      renderList(); return;
    }
    if (el.classList.contains('reorder')) return;
    openSong(row.dataset.id);
  });
  updateStorageInfo();
}
async function updateStorageInfo() {
  try {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const pers = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
    $('#storageInfo').textContent = (est ? (est.usage / 1e6).toFixed(0) + ' MB lagret' : '') + (pers ? ' · varig lagring ✓' : '') + ' · v' + APP_VERSION;
  } catch (e) { }
}
$('#btnReorder').onclick = () => { const el = $('#songList'); el.classList.toggle('reorder'); $('#btnReorder').classList.toggle('on'); };
function strip(song) { const o = {}; for (const k in song) if (k[0] !== '_') o[k] = song[k]; o.measures = song.measures.map(m => { const x = {}; for (const k in m) if (k[0] !== '_') x[k] = m[k]; return x; }); return o; }
async function saveSong(song, markEdited) {
  if (markEdited) song.edited = true;
  prep(song);
  await DB.put('songs', strip(song));
  const i = S.songs.findIndex(s => s.id === song.id); if (i >= 0) S.songs[i] = song; else S.songs.push(song);
}

/* ================= Import / export ================= */
$('#btnImport').onclick = () => pickFile('', importFile);
function pickFile(accept, cb, multiple) {
  const fi = $('#fileInput'); fi.value = ''; fi.accept = accept || ''; fi.multiple = !!multiple;
  fi.onchange = () => { if (fi.files.length) cb(multiple ? Array.from(fi.files) : fi.files[0]); };
  fi.click();
}
async function importFile(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const magic = String.fromCharCode.apply(null, head.slice(0, 8));
    if (magic === 'KORPS001') return importBundle(file, new DataView(head.buffer).getUint32(8, true));
    const txt = await file.text();
    const j = JSON.parse(txt);
    if (j.kind === 'korps-edits') return importEdits(j);
    toast('Ukjent filformat');
  } catch (e) { console.error(e); toast('Klarte ikke å lese fila: ' + e.message, 4000); }
}
async function importBundle(file, hlen) {
  toast('Importerer …', 60000);
  const header = JSON.parse(await file.slice(12, 12 + hlen).text());
  const base = 12 + hlen;
  const existing = new Map(S.songs.map(s => [s.id, s]));
  const editedHere = header.songs.filter(s => existing.get(s.id) && existing.get(s.id).edited);
  let keepEdits = true;
  if (editedHere.length) {
    const c = await choose(`${editedHere.length} sang(er) er redigert på iPaden (${editedHere.map(s => s.title).join(', ')}). Hva vil du gjøre?`,
      ['Behold mine redigeringer (oppdater bare lyd/noter)', 'Overskriv med versjonen i fila']);
    if (c < 0) { toast('Avbrutt'); return; }
    keepEdits = c === 0;
  }
  let n = 0;
  for (const f of header.files) {
    const buf = await file.slice(base + f.offset, base + f.offset + f.length).arrayBuffer();
    await DB.put('files', { id: f.id, type: f.type, blob: new Blob([buf], { type: f.type }) });
    n++; if (n % 5 === 0) toast(`Importerer … ${Math.round(100 * n / header.files.length)} %`, 60000);
  }
  let order = S.songs.length;
  for (const s of header.songs) {
    const old = existing.get(s.id);
    s.orig = { measures: clone(s.measures), form: clone(s.form), maps: (s.recordings || []).map(r => clone(r.map || [])) };
    if (old) {
      s.order = old.order;
      if (old.edited && keepEdits) {
        for (const k of ['measures', 'form', 'title', 'part', 'keySig', 'timeSig', 'transpose', 'notes']) s[k] = old[k];
        s.edited = true;
        (s.recordings || []).forEach(r => { const o = (old.recordings || []).find(x => x.id === r.id); if (o && o.mapEdited) { r.map = o.map; r.mapEdited = true; } });
      }
    } else s.order = s.order != null ? s.order : order++;
    await DB.put('songs', s);
  }
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { }
  await loadSongs();
  toast(`Importert ${header.songs.length} sanger ✓`, 3000);
}
async function exportEdits() {
  const songs = S.songs.filter(s => s.edited || (s.recordings || []).some(r => r.mapEdited) || s.userCreated);
  if (!songs.length) { toast('Ingen endringer å eksportere'); return; }
  const data = {
    kind: 'korps-edits', version: 1, date: new Date().toISOString(),
    songs: songs.map(s => ({
      id: s.id, title: s.title, part: s.part, keySig: s.keySig, timeSig: s.timeSig, transpose: s.transpose || 0, notes: s.notes,
      measures: strip(s).measures, form: s.form, userCreated: !!s.userCreated, edited: !!s.edited,
      maps: (s.recordings || []).map(r => ({ id: r.id, map: r.map, mapEdited: !!r.mapEdited })),
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const name = 'korps-endringer-' + new Date().toISOString().slice(0, 10) + '.json';
  try {
    const f = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
}
async function importEdits(j) {
  let n = 0;
  for (const e of j.songs) {
    let s = S.songs.find(x => x.id === e.id);
    if (!s) { if (!e.userCreated) continue; s = { id: e.id, recordings: [], pages: [], systems: [], order: S.songs.length, userCreated: true }; }
    Object.assign(s, { title: e.title, part: e.part, keySig: e.keySig, timeSig: e.timeSig, transpose: e.transpose, notes: e.notes, measures: e.measures, form: e.form, edited: e.edited });
    (e.maps || []).forEach(m => { const r = (s.recordings || []).find(x => x.id === m.id); if (r && m.mapEdited) { r.map = m.map; r.mapEdited = true; } });
    await saveSong(s); n++;
  }
  await loadSongs(); toast(`Endringer importert for ${n} sanger ✓`);
}

/* ================= Settings modal ================= */
$('#btnSettings').onclick = openSettings;
function openSettings() {
  const opt = (k, v, label) => `<option value="${v}" ${String(settings[k]) === String(v) ? 'selected' : ''}>${label}</option>`;
  modal('Innstillinger', `
    <div class="field"><label>Tema</label><select data-s="theme">${opt('theme', 'dark', 'Mørk (scene)')}${opt('theme', 'light', 'Lys')}</select></div>
    <div class="field"><label>Akkordnavn</label><select data-s="naming">${opt('naming', 'intl', 'Internasjonal (B♭, B)')}${opt('naming', 'no', 'Norsk (B = B♭, H = B)')}</select></div>
    <div class="field"><label>Tekststørrelse for akkorder</label><select data-s="fs">${[0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75].map(v => opt('fs', v, Math.round(v * 100) + ' %')).join('')}</select></div>
    <div class="field"><label>Takter per linje i besifring</label><select data-s="perRow">${opt('perRow', 'sheet', 'Som i notene')}${[2, 3, 4, 5, 6, 8].map(v => opt('perRow', v, v + ' takter')).join('')}</select></div>
    <div class="field"><label>Ved hopp til takt</label><select data-s="preroll">${opt('preroll', true, 'Start én takt før (tid til å komme inn)')}${opt('preroll', false, 'Start akkurat på takten')}</select></div>
    <div class="field"><label>Noter i mørkt tema</label><select data-s="invertSheet">${opt('invertSheet', false, 'Vanlig (hvitt ark)')}${opt('invertSheet', true, 'Inverter (lys tekst på mørkt)')}</select></div>
    <div class="field"><label>Hold skjermen på</label><select data-s="wake">${opt('wake', true, 'Ja, mens en sang er åpen')}${opt('wake', false, 'Nei')}</select></div>
    <div class="field"><label>Sikkerhetskopi</label>
      <div class="row2"><button class="btn" id="sExport">Eksporter mine endringer</button><button class="btn ghost" id="sImport">Importer endringer / data</button></div>
      <div class="hint">Endringer lagres automatisk på iPaden. Eksporter dem av og til (f.eks. til iCloud Drive) som backup.</div></div>
    <div class="field"><label>Faresone</label><button class="btn danger" id="sWipe">Slett alle data på denne iPaden</button></div>
    <div class="muted small">Korpskonsert v${APP_VERSION} · fungerer offline når den er lagt til på Hjem-skjermen.</div>`, body => {
    $$('[data-s]', body).forEach(sel => sel.onchange = () => {
      const k = sel.dataset.s; let v = sel.value;
      if (v === 'true') v = true; else if (v === 'false') v = false; else if (!isNaN(+v)) v = +v;
      settings[k] = v; saveSettings();
      if (S.song) { renderChart(); renderSheet(); S.focusLi = null; S.curH = S.nxtH = null; updateNow(true); }
    });
    $('#sExport', body).onclick = exportEdits;
    $('#sImport', body).onclick = () => { closeModal(); pickFile('', importFile); };
    $('#sWipe', body).onclick = async () => {
      if (!confirm('Slette alle sanger, opptak og endringer fra denne iPaden?')) return;
      await DB.clear('songs'); await DB.clear('files'); closeModal(); await loadSongs(); toast('Alt slettet');
    };
  });
}

/* ================= Song view ================= */
async function openSong(id) {
  const song = S.songs.find(s => s.id === id); if (!song) return;
  prep(song);
  S.song = song; S.pos = null; S.cursor = 0; S.loop = null; S.loopPick = null; S.lastMeasureKey = null; S.focusLi = null; S.curH = S.nxtH = null;
  $('#listView').classList.add('hidden'); $('#songView').classList.remove('hidden');
  setEditing(false); setSyncing(false);
  renderHeader(); renderChart(); renderRoadmap(); await renderSheet(); await loadAudio();
  setMode(song.viewMode || (song.measures.some(m => m.chords && m.chords.length) ? 'focus' : 'sheet'));
  updateNow(true);
  wake(true);
}
function closeSong() {
  audio.pause(); wake(false);
  if (S.objUrl) { URL.revokeObjectURL(S.objUrl); S.objUrl = null; }
  S.pageUrls.forEach(u => URL.revokeObjectURL(u)); S.pageUrls = [];
  S.song = null; $('#songView').classList.add('hidden'); $('#listView').classList.remove('hidden'); renderList();
}
$('#btnBack').onclick = closeSong;

function renderHeader() {
  const s = S.song;
  $('#songTitle').textContent = s.title;
  const k = keyName(s.keySig, s.transpose || 0);
  $('#songSub').textContent = [s.part, k ? 'Toneart ' + k : '', s.timeSig, s.tempo ? '♩=' + s.tempo : ''].filter(Boolean).join(' · ');
  const b = $('#transBadge');
  if (s.transpose) { b.textContent = `Besifring transponert ${s.transpose > 0 ? '+' : ''}${s.transpose} (noter: ${s.keySig})`; b.classList.remove('hidden'); } else b.classList.add('hidden');
}

/* ---- mode ---- */
$$('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
function setMode(m) {
  S.mode = m; $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('#content').className = 'content mode-' + m;
  $('#nowStrip').classList.toggle('hidden', m === 'focus');
  if (S.song) { S.song.viewMode = m; DB.put('songs', strip(S.song)); }
  S.focusLi = null;
  requestAnimationFrame(() => { S.lastMeasureKey = null; updateNow(true); });
}

/* ---- chart rendering ---- */
function chartRows(song) {
  const ms = song.measures;
  if (settings.perRow === 'sheet' && song.systems && song.systems.length) {
    const rows = [];
    for (const sy of song.systems) {
      const r = ms.filter(m => m.n >= sy.first && m.n <= sy.last);
      if (r.length) rows.push(r);
    }
    const seen = new Set(rows.flat().map(m => m.n));
    const rest = ms.filter(m => !seen.has(m.n));
    for (let i = 0; i < rest.length; i += 4) rows.push(rest.slice(i, i + 4));
    return rows;
  }
  const per = settings.perRow === 'sheet' ? 4 : +settings.perRow, rows = [];
  for (let i = 0; i < ms.length; i += per) rows.push(ms.slice(i, i + per));
  return rows;
}
function measureHTML(m, song, first) {
  let chords = '';
  if (m.chords && m.chords.length) {
    const bs = m._beats;
    chords = m.chords.map(([c, b], i) => {
      const nb = i + 1 < m.chords.length ? m.chords[i + 1][1] : bs + 1;
      const w = Math.max(0.5, nb - b);
      const u = /\?$/.test(c) ? ' unsure' : '';
      return `<span class="c${u}" style="flex:${w} 1 0">${chordHTML(c, song)}</span>`;
    }).join('');
    const lead = m.chords[0][1] - 1;
    if (lead > 0.01) chords = `<span class="c carry" style="flex:${lead} 1 0">${m._carry ? chordHTML(m._carry, song) : ''}</span>` + chords;
  } else if (m.rest) chords = '<span class="c">–</span>';
  else if (first && m._carry) chords = `<span class="c carry">${chordHTML(m._carry, song)}</span>`;
  else chords = '<span class="c hold">%</span>';
  return `<div class="m${m.rest ? ' rest' : ''}${first ? ' first' : ''}" data-n="${m.n}">
    <span class="mn">${m.n}</span>${m.mark ? `<span class="mk">${esc(m.mark)}</span>` : ''}
    <div class="cs">${chords}</div>${m.text ? `<div class="tx">${esc(m.text)}</div>` : ''}<div class="prog"></div></div>`;
}
function renderChart() {
  const s = S.song; if (!s) return;
  const rows = chartRows(s);
  const maxLen = Math.max(4, ...rows.map(r => r.length));
  const isRest = m => m.rest && !(m.chords && m.chords.length) && !m.mark && !m.text;
  $('#chart').innerHTML = rows.map(r => {
    const pad = settings.perRow === 'sheet' ? '' : '<div style="flex:1 1 0"></div>'.repeat(maxLen - r.length);
    const out = [];
    for (let i = 0; i < r.length;) {
      // two or more rest measures in a row collapse into one block (not while editing: every measure must be tappable)
      let j = i; while (!S.editing && j < r.length && isRest(r[j])) j++;
      if (j - i >= 2) {
        const run = r.slice(i, j);
        out.push(`<div class="m rest run" style="flex:${Math.min(run.length, 2)} 1 0" data-n="${run[0].n}" data-ns="${run.map(m => m.n).join(',')}">
          <span class="mn">${run[0].n}–${run[run.length - 1].n}</span><div class="cs"><span class="c rl">Pause · ${run.length} takter</span></div><div class="prog"></div></div>`);
        i = j; continue;
      }
      out.push(measureHTML(r[i], s, i === 0)); i++;
    }
    return `<div class="sys">${out.join('')}${pad}</div>`;
  }).join('') + (s.notes ? `<div class="muted small" style="margin-top:16px;white-space:pre-wrap">${esc(s.notes)}</div>` : '');
  $('#chart').classList.toggle('editing', S.editing);
  S.mEl = new Map(); S.chartRi = null;
  $$('#chart .m').forEach(el => (el.dataset.ns || el.dataset.n).split(',').forEach(n => S.mEl.set(+n, el)));
  S.lastMeasureKey = null; markLoop();
}
$('#chart').addEventListener('click', e => {
  const el = e.target.closest('.m'); if (!el) return;
  onMeasureTap(+el.dataset.n);
});

/* ---- sheet rendering ---- */
async function renderSheet() {
  const s = S.song; S.pageUrls.forEach(u => URL.revokeObjectURL(u)); S.pageUrls = [];
  const el = $('#sheet');
  if (!s.pages || !s.pages.length) { el.innerHTML = '<div class="empty">Ingen noter for denne sangen.<br>⋯ → «Legg til notebilder» for å legge til.</div>'; return; }
  const html = [];
  for (let i = 0; i < s.pages.length; i++) {
    const f = await DB.get('files', s.pages[i]);
    const u = f ? URL.createObjectURL(f.blob) : ''; S.pageUrls.push(u);
    html.push(`<div class="page" data-p="${i + 1}"><img class="${settings.invertSheet ? 'inv' : ''}" src="${u}" alt="Side ${i + 1}"><div class="syshl hidden"></div><div class="hl hidden"></div><span class="pno">${i + 1}/${s.pages.length}</span></div>`);
  }
  el.innerHTML = html.join('');
}
function sysFor(song, n) { return (song.systems || []).find(sy => n >= sy.first && n <= sy.last); }
function measureBox(song, n) {
  const sy = sysFor(song, n); if (!sy) return null;
  const cnt = sy.last - sy.first + 1, k = n - sy.first;
  let x0, x1;
  if (sy.xs && sy.xs.length === cnt + 1) { x0 = sy.xs[k]; x1 = sy.xs[k + 1]; }
  else { const a = sy.x0 != null ? sy.x0 : 0.06, b = sy.x1 != null ? sy.x1 : 0.95; x0 = a + (b - a) * k / cnt; x1 = a + (b - a) * (k + 1) / cnt; }
  return { page: sy.page, x0, x1, y0: sy.y0, y1: sy.y1, sy };
}
$('#sheet').addEventListener('click', e => {
  const pg = e.target.closest('.page'); if (!pg || !S.song) return;
  const r = pg.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height, p = +pg.dataset.p;
  let best = null, bd = 1e9;
  for (const sy of S.song.systems || []) {
    if (sy.page !== p) continue;
    const d = fy < sy.y0 ? sy.y0 - fy : fy > sy.y1 ? fy - sy.y1 : 0;
    if (d < bd) { bd = d; best = sy; }
  }
  if (!best || bd > 0.08) return;
  for (let n = best.first; n <= best.last; n++) { const b = measureBox(S.song, n); if (b && fx >= b.x0 - 0.01 && fx <= b.x1 + 0.01) { onMeasureTap(n); return; } }
  onMeasureTap(fx < 0.5 ? best.first : best.last);
});

/* ---- current position + highlight ---- */
function curExpPos() {
  if (S.pos != null) return S.pos;
  return S.cursor;
}
function updateNow(force) {
  const s = S.song; if (!s) return;
  const p = curExpPos();
  const k = p == null ? null : Math.floor(p);
  const n = k == null ? null : s._exp[k];
  const key = k + '|' + S.mode;
  // measure display
  if (force || key !== S.lastMeasureKey) {
    S.lastMeasureKey = key;
    $('#nowMeasure').textContent = $('#fMeasure').textContent = n == null ? '–' : n;
    let rep = '';
    if (n != null) { const occ = occurrences(s, n), oi = occ.indexOf(k); if (occ.length > 1) rep = `gang ${oi + 1} av ${occ.length}`; }
    $('#nowRep').textContent = $('#fRep').textContent = rep;
    $$('#chart .m.cur').forEach(e => { e.classList.remove('cur'); $('.prog', e).style.width = 0; });
    if (n != null) {
      const el = S.mEl && S.mEl.get(n);
      if (el) {
        el.classList.add('cur'); scrollIntoViewIfNeeded($('#chartPane'), el);
        const rows = $$('#chart .sys'), ri = rows.indexOf(el.parentNode);
        if (ri !== S.chartRi) { S.chartRi = ri; rows.forEach((r, i) => r.classList.toggle('past', i < ri)); }
      }
    }
    highlightSheet(n);
    renderFocus(k);
    markRoadmap(k);
  }
  // beat progress
  if (n != null && S.pos != null) {
    const el = $('#chart .m.cur .prog');
    if (el) { const ns = el.parentNode.dataset.ns, f = ns ? (ns.split(',').indexOf(String(n)) + p - k) / ns.split(',').length : p - k; el.style.width = (f * 100).toFixed(1) + '%'; }
    const fe = $('#fLane .fm.cur .prog');
    if (fe) { const a = +fe.parentNode.dataset.k0, b = +fe.parentNode.dataset.k1; fe.style.width = ((p - a) / (b - a + 1) * 100).toFixed(1) + '%'; }
  }
  updateBeats(s, p, k);
  // now / next chord
  const ev = s._ev; let cur = null, nxt = null;
  if (p != null) {
    let i = -1; for (let j = 0; j < ev.length; j++) { if (ev[j].pos <= p + 1e-6) i = j; else break; }
    cur = i >= 0 ? ev[i] : null; nxt = ev[i + 1] || null;
  }
  const curH = cur ? (cur.c ? chordHTML(cur.c, s) : 'N.C.') : '–', nxtH = nxt ? (nxt.c ? chordHTML(nxt.c, s) : 'N.C.') : '–';
  if (curH !== S.curH) { S.curH = curH; $('#nowChord').innerHTML = $('#fNow').innerHTML = curH; }
  if (nxtH !== S.nxtH) { S.nxtH = nxtH; $('#nextChord').innerHTML = $('#fNext').innerHTML = nxtH; }
  let nin = '';
  if (nxt && p != null) {
    const beats = beatsBetween(s, p, nxt.pos);
    nin = beats < 0.05 ? '' : beats <= 8 ? `om ${Math.max(1, Math.round(beats))} slag` : `takt ${s._exp[Math.floor(nxt.pos)]}`;
  }
  $('#nextIn').textContent = $('#fNextIn').textContent = nin;
}

/* ---- focus view: big now/next + the current line and the two after it, in play order ---- */
function focusMeasureHTML(s, k, j) {
  const m = s._byN.get(s._exp[k]);
  let cs;
  if (m.chords && m.chords.length) {
    cs = m.chords.map(([c, b], i) => {
      const nb = i + 1 < m.chords.length ? m.chords[i + 1][1] : m._beats + 1;
      return `<span class="c${/\?$/.test(c) ? ' unsure' : ''}" style="flex:${Math.max(0.5, nb - b)} 1 0">${chordHTML(c, s)}</span>`;
    }).join('');
    const lead = m.chords[0][1] - 1, held = chordAt(s, k - 0.001);
    if (lead > 0.01) cs = `<span class="c carry" style="flex:${lead} 1 0">${held ? chordHTML(held, s) : ''}</span>` + cs;
  } else if (m.rest) cs = '<span class="c">–</span>';
  else if (j === 0) { const held = chordAt(s, k); cs = `<span class="c carry">${held ? chordHTML(held, s) : '%'}</span>`; }
  else cs = '<span class="c hold">%</span>';
  return `<div class="fm${m.rest ? ' rest' : ''}" data-k0="${k}" data-k1="${k}"><span class="mn">${m.n}</span>${m.mark ? `<span class="mk">${esc(m.mark)}</span>` : ''}
    <div class="cs">${cs}</div>${m.text ? `<div class="tx">${esc(m.text)}</div>` : ''}<div class="prog"></div></div>`;
}
function focusLineHTML(s, ln, li, cur) {
  const sc = ln.sec, lbl = !ln.first ? '' : `<span class="fsec">${sc.jump ? '↺ ' : ''}${esc(sc.label || (sc.jump ? 'tilbake til takt ' : 'takt ') + sc.n0)}</span>`;
  let body;
  if (ln.rest) {
    const a = s._exp[ln.ks[0]], b = s._exp[ln.ks[ln.ks.length - 1]];
    body = `<div class="fm rest restline" data-k0="${ln.ks[0]}" data-k1="${ln.ks[ln.ks.length - 1]}"><span class="mn">${a}–${b}</span>
      <div class="cs"><span class="c rl">Pause · ${ln.ks.length} takter</span><span class="rleft"></span></div><div class="prog"></div></div>`;
  } else body = ln.ks.map((k, j) => focusMeasureHTML(s, k, j)).join('') + '<div class="fm pad"></div>'.repeat(4 - ln.ks.length);
  return `<div class="fl${cur ? ' now' : ''}" data-li="${li}">${lbl}<div class="flm">${body}</div></div>`;
}
function renderFocus(k) {
  const s = S.song; if (S.mode !== 'focus' || !s) return;
  const li = k == null ? 0 : s._lineOf[k];
  if (li !== S.focusLi) {
    S.focusLi = li;
    // as many lines as fit under the now/next panel
    const nl = clamp(1 + Math.floor(($('#fLane').clientHeight - 104 * settings.fs - 32) / (84 * settings.fs + 26)), 2, 8);
    const out = [];
    for (let i = li; i < Math.min(s._lines.length, li + nl); i++) out.push(focusLineHTML(s, s._lines[i], i, i === li));
    if (li + nl >= s._lines.length) out.push('<div class="fend">Slutt</div>');
    $('#fLane').innerHTML = out.join('');
  }
  $$('#fLane .fm.cur').forEach(e => { e.classList.remove('cur'); const pr = $('.prog', e); if (pr) pr.style.width = 0; });
  let txt = '';
  if (k != null) {
    const e = $$('#fLane .fm[data-k0]').find(e => +e.dataset.k0 <= k && k <= +e.dataset.k1);
    if (e) {
      e.classList.add('cur');
      const left = $('.rleft', e); if (left) left.textContent = `${+e.dataset.k1 - k + 1} igjen`;
    }
    const sec = s._secs[s._secOf[k]];
    $('#fMark').textContent = sec.label; $('#fMark').classList.toggle('hidden', !sec.label);
    for (let i = k; i <= k + 2 && i < s._exp.length; i++) {
      const m = s._byN.get(s._exp[i]);
      if (m.text) { txt = i === k ? esc(m.text) : `Snart (takt ${m.n}): ${esc(m.text)}`; break; }
    }
  } else $('#fMark').classList.add('hidden');
  $('#fText').innerHTML = txt;
}
function updateBeats(s, p, k) {
  if (S.mode !== 'focus') return;
  const m = k == null ? null : s._byN.get(s._exp[k]);
  const nb = m ? m._beats : 0, b = m && S.pos != null ? Math.floor((p - k) * nb) : -1;
  const key = nb + '|' + b;
  if (key === S.beatKey) return; S.beatKey = key;
  $('#fBeats').innerHTML = Array.from({ length: nb }, (_, i) => `<i class="${i === b ? 'on' : i < b ? 'done' : ''}"></i>`).join('');
}
$('#fLane').addEventListener('click', e => {
  const el = e.target.closest('.fm[data-k0]'); if (!el || !S.song) return;
  const k = +el.dataset.k0;
  if (S.editing || S.loopPick || (S.syncing && S.anchorPending)) { onMeasureTap(S.song._exp[k]); return; }
  gotoExp(k);
});

/* ---- roadmap: sections in performance order ---- */
function renderRoadmap() {
  const s = S.song, el = $('#roadmap');
  S.secI = null;
  if (!s || s._secs.length < 2) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = s._secs.map((c, i) => c.label
    ? `<button class="sec" data-i="${i}"><b>${c.jump ? '↺ ' : ''}${esc(c.label)}</b><span>${c.n0}–${c.n1}</span></button>`
    : `<button class="sec" data-i="${i}"><b>${c.jump ? '↺ ' : ''}${c.n0}</b><span>–${c.n1}</span></button>`).join('');
}
function markRoadmap(k) {
  const s = S.song; if (!s || !s._secs.length) return;
  const i = k == null ? -1 : s._secOf[k]; if (i === S.secI) return; S.secI = i;
  const bs = $$('#roadmap .sec'); bs.forEach((b, j) => { b.classList.toggle('on', j === i); b.classList.toggle('past', j < i); });
  const b = bs[i], r = $('#roadmap');
  if (b && r.offsetParent) r.scrollTo({ left: b.offsetLeft - r.clientWidth / 3, behavior: 'smooth' });
}
$('#roadmap').addEventListener('click', e => { const b = e.target.closest('.sec'); if (b && S.song) gotoExp(S.song._secs[+b.dataset.i].k0); });
function gotoExp(k) { const s = S.song, n = s._exp[k]; return gotoMeasure(n, occurrences(s, n).indexOf(k)); }
function beatsBetween(s, a, b) {
  let tot = 0, k = Math.floor(a);
  while (k < b && k < s._exp.length) { const m = s._byN.get(s._exp[k]); const lo = Math.max(a, k), hi = Math.min(b, k + 1); tot += (hi - lo) * m._beats; k++; }
  return tot;
}
function scrollIntoViewIfNeeded(pane, el) {
  if (!pane.offsetParent) return;
  const pr = pane.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (r.top < pr.top + 10 || r.bottom > pr.bottom - pr.height * 0.35) {
    pane.scrollTo({ top: pane.scrollTop + (r.top - pr.top) - pr.height * 0.25, behavior: 'smooth' });
  }
}
function highlightSheet(n) {
  const s = S.song;
  $$('#sheet .hl, #sheet .syshl').forEach(e => e.classList.add('hidden'));
  if (n == null) return;
  const b = measureBox(s, n); if (!b) return;
  const pg = $(`#sheet .page[data-p="${b.page}"]`); if (!pg) return;
  const pad = (b.y1 - b.y0) * 0.35 + 0.012;
  const hl = $('.hl', pg), sh = $('.syshl', pg);
  Object.assign(hl.style, { left: (b.x0 * 100) + '%', width: ((b.x1 - b.x0) * 100) + '%', top: ((b.y0 - pad) * 100) + '%', height: ((b.y1 - b.y0 + pad * 1.6) * 100) + '%' });
  Object.assign(sh.style, { top: ((b.y0 - pad) * 100) + '%', height: ((b.y1 - b.y0 + pad * 1.6) * 100) + '%' });
  hl.classList.remove('hidden'); sh.classList.remove('hidden');
  const pane = $('#sheetPane');
  if (pane.offsetParent) {
    const pr = pane.getBoundingClientRect(), r = sh.getBoundingClientRect();
    if (r.top < pr.top + 10 || r.bottom > pr.bottom - 10) pane.scrollTo({ top: pane.scrollTop + (r.top - pr.top) - pr.height * 0.2, behavior: 'smooth' });
  }
}

/* ================= Audio ================= */
async function loadAudio() {
  const s = S.song; audio.pause();
  if (S.objUrl) { URL.revokeObjectURL(S.objUrl); S.objUrl = null; }
  const r = rec(s);
  const has = !!r;
  $('#transport').classList.toggle('noaud', !has);
  $('#noAudio').classList.toggle('hidden', has);
  $('#btnSync').classList.toggle('hidden', !has);
  $('#trackName').textContent = has ? (r.short || r.name) : 'Legg til lyd';
  if (!has) { audio.removeAttribute('src'); audio.load(); $('#recName').textContent = ''; S.pos = null; return; }
  const f = await DB.get('files', r.fileId);
  if (!f) { toast('Fant ikke lydfila'); return; }
  S.objUrl = URL.createObjectURL(f.blob);
  audio.src = S.objUrl; audio.load();
  audio.playbackRate = S.rate; try { audio.preservesPitch = true; audio.webkitPreservesPitch = true; } catch (e) { }
  $('#recName').textContent = (r.group ? r.group + ': ' : '') + r.name + (r.map && r.map.length ? '' : ' · ikke synket');
}
function whenReady() {
  return audio.readyState >= 1 ? Promise.resolve() : new Promise(res => { const f = () => { audio.removeEventListener('loadedmetadata', f); res(); }; audio.addEventListener('loadedmetadata', f); });
}
audio.addEventListener('loadedmetadata', () => { $('#tDur').textContent = fmtT(audio.duration); });
audio.addEventListener('play', () => { $('#btnPlay').textContent = '❚❚'; tick(); });
audio.addEventListener('pause', () => { $('#btnPlay').textContent = '▶'; });
audio.addEventListener('ended', () => { $('#btnPlay').textContent = '▶'; });
audio.addEventListener('seeked', () => { onTime(); });
$('#btnPlay').onclick = () => { if (audio.paused) audio.play().catch(e => toast('Kan ikke spille: ' + e.message)); else audio.pause(); };

function tick() { onTime(); if (!audio.paused) requestAnimationFrame(tick); }
function onTime() {
  const s = S.song; if (!s) return;
  const t = audio.currentTime;
  if (S.loop && !audio.paused && t >= S.loop.t1) { audio.currentTime = S.loop.t0; return; }
  if (!scrubbing) $('#scrub').value = audio.duration ? Math.round(1000 * t / audio.duration) : 0;
  $('#tCur').textContent = fmtT(t);
  const r = rec(s);
  const p = r ? posAt(r.map, t) : null;
  S.pos = p != null && p < s._exp.length ? p : null;
  if (S.pos != null) S.cursor = Math.floor(S.pos);
  updateNow(false);
}
let scrubbing = false;
$('#scrub').addEventListener('input', () => { scrubbing = true; if (audio.duration) { audio.currentTime = audio.duration * $('#scrub').value / 1000; onTime(); } });
$('#scrub').addEventListener('change', () => { scrubbing = false; });

/* jump to measure */
async function gotoMeasure(n, occIdx) {
  const s = S.song; const occ = occurrences(s, n);
  if (!occ.length) { toast('Takt ' + n + ' finnes ikke'); return; }
  const r = rec(s);
  if (!r || !r.map || !r.map.length) {
    let k = occ.find(x => x > (S.cursor == null ? -1 : S.cursor)); if (occIdx != null) k = occ[occIdx]; if (k == null) k = occ[0];
    S.cursor = k; S.pos = null; updateNow(true); return;
  }
  await whenReady();
  const t = audio.currentTime;
  // candidate (k, time) pairs
  let cands = [];
  occ.forEach((k, oi) => timesAt(r.map, k).forEach(tt => cands.push({ k, oi, t: tt })));
  if (occIdx != null) cands = cands.filter(c => c.oi === occIdx);
  if (!cands.length) {
    toast(`Takt ${n} er ikke med i dette opptaket`);
    S.cursor = occ[0]; S.pos = null; updateNow(true); return;
  }
  cands.sort((a, b) => a.t - b.t);
  const c = cands.find(c => c.t > t + 0.3) || cands[0];
  let target = c.t;
  if (settings.preroll && c.k > 0) { const pre = timesAt(r.map, c.k - 1).filter(x => x < c.t && c.t - x < 12); if (pre.length) target = Math.max(...pre); }
  audio.currentTime = Math.max(0, target);
  S.cursor = c.k; onTime();
}
function onMeasureTap(n) {
  if (S.editing) { editMeasure(n); return; }
  if (S.loopPick) { pickLoop(n); return; }
  if (S.syncing && S.anchorPending) { S.anchorPending = false; setAnchorAt(n); return; }
  gotoMeasure(n);
}
$('#btnGoto').onclick = async () => {
  const n = await numpad('Gå til takt'); if (n == null) return;
  const occ = occurrences(S.song, n);
  if (occ.length > 1) {
    const i = await choose(`Takt ${n} spilles ${occ.length} ganger`, occ.map((k, i) => `${i + 1}. gang`));
    if (i < 0) return; gotoMeasure(n, i);
  } else gotoMeasure(n);
};
function stepMeasure(d) {
  const s = S.song; const k = Math.floor(curExpPos() == null ? 0 : curExpPos());
  const nk = clamp(k + d, 0, s._exp.length - 1);
  const r = rec(s);
  if (r && r.map && r.map.length) {
    const ts = timesAt(r.map, nk); const t = audio.currentTime;
    if (ts.length) { ts.sort((a, b) => Math.abs(a - t) - Math.abs(b - t)); audio.currentTime = ts[0]; S.cursor = nk; onTime(); return; }
  }
  S.cursor = nk; S.pos = null; updateNow(true);
}
$('#btnPrev').onclick = () => stepMeasure(-1);
$('#btnNext').onclick = () => stepMeasure(1);

/* speed */
$('#btnSpeed').onclick = async () => {
  const opts = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1];
  const i = await choose('Avspillingshastighet (samme tonehøyde)', opts.map(v => Math.round(v * 100) + ' %' + (v === S.rate ? '  ✓' : '')));
  if (i < 0) return; S.rate = opts[i]; audio.playbackRate = S.rate;
  $('#btnSpeed').textContent = Math.round(S.rate * 100) + ' %'; $('#btnSpeed').classList.toggle('on', S.rate !== 1);
};
/* loop */
$('#btnLoop').onclick = () => {
  if (S.loop || S.loopPick) { S.loop = null; S.loopPick = null; $('#btnLoop').classList.remove('on'); $('#btnLoop').textContent = '⟲ Løkke'; markLoop(); return; }
  S.loopPick = { a: null }; $('#btnLoop').classList.add('on'); $('#btnLoop').textContent = 'Trykk første takt';
  toast('Trykk på første takt i løkka');
};
function pickLoop(n) {
  const s = S.song, r = rec(s);
  if (S.loopPick.a == null) { S.loopPick.a = n; $('#btnLoop').textContent = 'Trykk siste takt'; markLoop(); return; }
  const a = S.loopPick.a, b = n; S.loopPick = null;
  // find a playing of a..b in the recording: occurrence of a, then first occurrence of b at/after it
  let best = null;
  if (r && r.map) for (const ka of occurrences(s, a)) {
    const kb = occurrences(s, b).find(k => k >= ka); if (kb == null) continue;
    const t0 = timesAt(r.map, ka), t1 = timesAt(r.map, kb + 0.999);
    for (const x of t0) { const y = t1.filter(y => y > x).sort((p, q) => p - q)[0]; if (y != null && !best) best = { t0: x, t1: y, a, b }; }
    if (best) break;
  }
  if (!best) { toast('Fant ikke de taktene sammenhengende i opptaket'); $('#btnLoop').classList.remove('on'); $('#btnLoop').textContent = '⟲ Løkke'; markLoop(); return; }
  if (settings.preroll) { const pre = timesAt(r.map, occurrences(s, a)[0] - 1).filter(x => x < best.t0 && best.t0 - x < 12); if (pre.length) best.t0 = Math.max(...pre); }
  S.loop = best; $('#btnLoop').textContent = `⟲ ${a}–${b} ✕`; markLoop();
  audio.currentTime = best.t0; audio.play();
}
function markLoop() {
  $$('#chart .m').forEach(e => e.classList.remove('loopsel', 'inloop'));
  if (S.loopPick && S.loopPick.a != null) { const e = $(`#chart .m[data-n="${S.loopPick.a}"]`); if (e) e.classList.add('loopsel'); }
  if (S.loop) $$('#chart .m').forEach(e => { const n = +e.dataset.n; if (n >= S.loop.a && n <= S.loop.b) e.classList.add('inloop'); });
}
/* recordings */
$('#btnRec').onclick = () => {
  const s = S.song, recs = s.recordings || [], cur = s.recIndex || 0;
  if (!recs.length) return addRecording();
  modal('Lydspor', `<div class="tracks">${recs.map((r, i) => `<button class="track${i === cur ? ' on' : ''}" data-i="${i}">
      <span class="tg">${esc(r.group || 'Opptak')}</span><span class="tn">${esc(r.name)}</span>
      ${r.desc ? `<span class="td">${esc(r.desc)}</span>` : ''}
      <span class="tt">${r.map && r.map.length ? '<span class="tag ok">følger taktene ✓</span>' : '<span class="tag warn">ikke synket</span>'}</span></button>`).join('')}</div>
    <div class="row2" style="margin-top:12px"><button class="btn ghost" id="tAdd">+ Legg til lydspor fra Filer …</button></div>
    <div class="hint" style="margin-top:8px">Bytter du spor mens musikken går, fortsetter avspillingen fra samme takt (hvis takten finnes i det nye sporet).</div>`, body => {
    $$('.track', body).forEach(b => b.onclick = () => { closeModal(); switchTrack(+b.dataset.i); });
    $('#tAdd', body).onclick = () => { closeModal(); addRecording(); };
  });
};
async function switchTrack(i) {
  const s = S.song; if (i === (s.recIndex || 0)) return;
  const playing = !audio.paused, p = S.pos;
  s.recIndex = i; DB.put('songs', strip(s));
  await loadAudio();
  const r = rec(s);
  if (p != null && r.map && r.map.length) {
    await whenReady();
    const ts = timesAt(r.map, p);
    if (ts.length) audio.currentTime = ts[0]; else toast('Takten finnes ikke i dette sporet – starter fra begynnelsen');
  }
  if (playing) audio.play().catch(() => { });
  onTime();
}
function addRecording() {
  pickFile('audio/*', async f => {
    const s = S.song, id = 'rec-' + Date.now();
    await DB.put('files', { id, type: f.type || 'audio/mp4', blob: f });
    s.recordings = s.recordings || []; s.recordings.push({ id, name: f.name.replace(/\.[^.]+$/, ''), fileId: id, map: [] });
    s.recIndex = s.recordings.length - 1; await saveSong(s); await loadAudio();
    toast('Opptak lagt til. Bruk ⏱ Synk → «Tapp inn takter» for å koble det til taktene.', 5000);
  });
}

/* keyboard / page-turn pedal */
document.addEventListener('keydown', e => {
  if (!S.song || !$('#modal').classList.contains('hidden') || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (S.tap && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); doTap(); return; }
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'ArrowDown') { e.preventDefault(); stepRow(1); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'ArrowUp') { e.preventDefault(); stepRow(-1); }
  else if (e.key === ' ') { e.preventDefault(); $('#btnPlay').click(); }
});
function stepRow(d) {
  // pedal: move cursor by one system (line)
  const s = S.song, k = Math.floor(curExpPos() || 0), n = s._exp[k];
  if (S.mode === 'focus') {
    const nk = s._lines[clamp(s._lineOf[k] + d, 0, s._lines.length - 1)].ks[0];
    if (!audio.paused) { gotoExp(nk); return; }
    S.cursor = nk; S.pos = null; updateNow(true); return;
  }
  const rows = chartRows(s); const ri = rows.findIndex(r => r.some(m => m.n === n));
  const target = rows[clamp(ri + d, 0, rows.length - 1)][0].n;
  const occ = occurrences(s, target); const nk = d > 0 ? (occ.find(x => x > k) ?? occ[0]) : ([...occ].reverse().find(x => x < k) ?? occ[0]);
  if (!audio.paused) { gotoMeasure(target, occ.indexOf(nk)); return; }
  S.cursor = nk; S.pos = null; updateNow(true);
}

/* wake lock */
let wakeLock = null;
async function wake(on) {
  try {
    if (on && settings.wake && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); }
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.song) wake(true); });
window.addEventListener('resize', () => { if (S.song && S.mode === 'focus') { S.focusLi = null; updateNow(true); } });

/* ================= Editing ================= */
$('#btnEdit').onclick = () => setEditing(!S.editing);
function setEditing(on) {
  S.editing = on; $('#btnEdit').classList.toggle('on', on); $('#editBadge').classList.toggle('hidden', !on);
  $('#chart').classList.toggle('editing', on);
  if (on && S.mode === 'sheet') setMode('split');
  if (on && S.mode === 'focus') setMode('chart');
  if (S.song) { renderChart(); updateNow(true); }
}
function chordsToText(m) {
  if (!m.chords || !m.chords.length) return '';
  const bs = m._beats;
  const intBeats = m.chords.every(([, b]) => Number.isInteger(b) && b >= 1 && b <= bs);
  if (intBeats && bs <= 6) {
    const slots = Array(bs).fill('.');
    m.chords.forEach(([c, b]) => slots[b - 1] = c);
    if (m.chords.length === 1 && m.chords[0][1] === 1) return m.chords[0][0];
    return slots.join(' ');
  }
  return m.chords.map(([c, b]) => b === 1 ? c : c + '@' + b).join(' ');
}
function textToChords(txt, beats) {
  const toks = txt.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  if (toks.some(t => /@/.test(t))) return toks.map(t => { const [c, b] = t.split('@'); return [c, b ? +b.replace(',', '.') : 1]; });
  if (toks.length === beats && toks.some(t => t === '.' || t === '%' || t === '/')) {
    const out = []; toks.forEach((t, i) => { if (!/^[.%/]$/.test(t)) out.push([t, i + 1]); }); return out;
  }
  if (toks.length === 1) return [[toks[0], 1]];
  // spread evenly
  return toks.filter(t => !/^[.%/]$/.test(t)).map((t, i, a) => [t, Math.round((1 + i * beats / a.length) * 2) / 2]);
}
function normChord(c) { return c.replace(/^([a-h])/, x => x.toUpperCase()).replace(/^H/, 'B').replace(/♭/g, 'b').replace(/♯/g, '#'); }
function editMeasure(n) {
  const s = S.song, m = s._byN.get(n); if (!m) return;
  // edits are made in written (untransposed) key; show hint if transposed
  const quick = ['m', '7', 'm7', 'maj7', 'sus4', '6', '9', 'dim', '/'];
  modal(`Takt ${n}`, `
    ${s.transpose ? `<div class="hint" style="margin-bottom:8px;color:var(--accent)">NB: Skriv akkordene slik de står i notene (${esc(s.keySig)}). Visningen transponeres ${s.transpose > 0 ? '+' : ''}${s.transpose} automatisk.</div>` : ''}
    <div class="field"><label>Akkorder</label>
      <input type="text" id="eCh" class="chordin" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(chordsToText(m))}">
      <div class="hint">Én akkord = hele takten. To akkorder = deles likt. Per slag: «Gm . C7 .» (${m._beats} slag). Eller «Gm C7@3». Tomt = forrige akkord fortsetter. Legg til «?» hvis usikker.</div>
      <div class="quick">${quick.map(q => `<button class="btn ghost" data-q="${esc(q)}">${esc(q)}</button>`).join('')}<button class="btn ghost" data-q=" ">mellomrom</button><button class="btn ghost" data-q=" . ">· slag</button></div>
    </div>
    <div class="row2">
      <div class="field" style="flex:1"><label>Merke (A, B, segno …)</label><input type="text" id="eMk" value="${esc(m.mark || '')}"></div>
      <div class="field" style="flex:2"><label>Tekst (D.S., Coda, rit. …)</label><input type="text" id="eTx" value="${esc(m.text || '')}"></div>
    </div>
    <div class="row2" style="margin-bottom:12px">
      <label class="row2"><input type="checkbox" id="eRest" ${m.rest ? 'checked' : ''}> Pause / tacet (jeg spiller ikke)</label>
      <label class="row2">Taktart <input type="text" id="eTs" style="width:70px" value="${esc(m.ts || '')}" placeholder="${esc(m._ts)}"></label>
    </div>
    <div class="row2">
      <button class="btn" id="ePrev">‹ Forrige</button>
      <button class="btn ghost" id="eCopy">Kopier forrige takt</button>
      <div class="spacer"></div>
      <button class="btn primary" id="eSave">Lagre</button>
      <button class="btn" id="eNext">Lagre + neste ›</button>
    </div>`, body => {
    const inp = $('#eCh', body);
    setTimeout(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }, 50);
    $$('[data-q]', body).forEach(b => b.onclick = () => { const q = b.dataset.q; const p = inp.selectionStart; inp.value = inp.value.slice(0, p) + q + inp.value.slice(inp.selectionEnd); inp.focus(); inp.setSelectionRange(p + q.length, p + q.length); });
    const save = async () => {
      const ts = $('#eTs', body).value.trim();
      const beats = beatsOf(ts || m._ts);
      m.chords = textToChords(inp.value, beats).map(([c, b]) => [normChord(c), b]);
      m.mark = $('#eMk', body).value.trim() || undefined; m.text = $('#eTx', body).value.trim() || undefined;
      m.rest = $('#eRest', body).checked || undefined; m.ts = ts || undefined;
      await saveSong(s, true); renderChart(); renderRoadmap(); S.focusLi = null; updateNow(true);
    };
    const idx = s.measures.indexOf(m);
    $('#eSave', body).onclick = async () => { await save(); closeModal(); };
    $('#eNext', body).onclick = async () => { await save(); const nx = s.measures[idx + 1]; if (nx) editMeasure(nx.n); else closeModal(); };
    $('#ePrev', body).onclick = async () => { await save(); const pv = s.measures[idx - 1]; if (pv) editMeasure(pv.n); };
    $('#eCopy', body).onclick = () => { const pv = s.measures[idx - 1]; if (pv) inp.value = chordsToText(pv); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#eNext', body).click(); } });
  });
}

/* song menu */
$('#btnSongMenu').onclick = async () => {
  const s = S.song;
  const items = ['Sanginfo, toneart og transponering …', 'Form / rekkefølge (repetisjoner, D.S.) …', 'Legg til takt på slutten', 'Fjern siste takt',
    'Legg til opptak fra Filer …', 'Legg til notebilder (bilder/skann) …', 'Tilbakestill besifring til original', 'Slett sangen'];
  const i = await choose(s.title, items);
  if (i === 0) songInfo();
  else if (i === 1) editForm();
  else if (i === 2) { const last = s.measures[s.measures.length - 1]; s.measures.push({ n: (last ? last.n : 0) + 1, chords: [] }); if (s.form && s.form.length) s.form[s.form.length - 1][1] = s.measures[s.measures.length - 1].n; await saveSong(s, true); renderChart(); }
  else if (i === 3) { if (s.measures.length > 1 && confirm('Fjerne takt ' + s.measures[s.measures.length - 1].n + '?')) { s.measures.pop(); const ln = s.measures[s.measures.length - 1].n; s.form = (s.form || []).map(([a, b]) => [Math.min(a, ln), Math.min(b, ln)]); await saveSong(s, true); renderChart(); } }
  else if (i === 4) addRecording();
  else if (i === 5) addPages();
  else if (i === 6) {
    if (!s.orig) { toast('Ingen original lagret'); return; }
    if (!confirm('Tilbakestille besifring og form til importert versjon?')) return;
    s.measures = clone(s.orig.measures); s.form = clone(s.orig.form); s.edited = false; await saveSong(s); renderChart(); updateNow(true);
  } else if (i === 7) {
    if (!confirm(`Slette «${s.title}» fra iPaden?`)) return;
    await DB.del('songs', s.id); S.songs = S.songs.filter(x => x.id !== s.id); closeSong();
  }
};
function songInfo() {
  const s = S.song;
  const kc = s.keyCheck;
  modal('Sanginfo', `
    <div class="field"><label>Tittel</label><input type="text" id="iT" value="${esc(s.title)}"></div>
    <div class="row2">
      <div class="field" style="flex:1"><label>Stemme</label><input type="text" id="iP" value="${esc(s.part || '')}"></div>
      <div class="field" style="flex:1"><label>Toneart i notene</label><input type="text" id="iK" value="${esc(s.keySig || '')}"></div>
      <div class="field" style="flex:1"><label>Taktart</label><input type="text" id="iTs" value="${esc(s.timeSig || '4/4')}"></div>
    </div>
    <div class="field"><label>Transponer besifring (halvtoner)</label>
      <div class="row2"><button class="btn" id="iTm">−1</button><span id="iTv" style="font-size:22px;font-weight:700;min-width:120px;text-align:center"></span><button class="btn" id="iTp">+1</button><button class="btn ghost" id="iT0">Nullstill</button></div>
      <div class="hint">Påvirker bare akkordvisningen, ikke notebildene eller lyden.</div></div>
    ${kc ? `<div class="field"><label>Tonearts-sjekk mot opptak</label><div class="hint" style="font-size:14px;color:var(--fg)">${esc(kc)}</div></div>` : ''}
    <div class="field"><label>Notater</label><textarea id="iN">${esc(s.notes || '')}</textarea></div>
    <button class="btn primary" id="iSave">Lagre</button>`, body => {
    let tr = s.transpose || 0;
    const upd = () => $('#iTv', body).textContent = (tr > 0 ? '+' : '') + tr + ' → ' + (keyName($('#iK', body).value || 'C', tr) || '');
    upd();
    $('#iTm', body).onclick = () => { tr = tr - 1 < -6 ? tr + 11 : tr - 1; upd(); };
    $('#iTp', body).onclick = () => { tr = tr + 1 > 6 ? tr - 11 : tr + 1; upd(); };
    $('#iT0', body).onclick = () => { tr = 0; upd(); };
    $('#iSave', body).onclick = async () => {
      Object.assign(s, { title: $('#iT', body).value.trim() || s.title, part: $('#iP', body).value.trim(), keySig: $('#iK', body).value.trim(), timeSig: $('#iTs', body).value.trim() || '4/4', notes: $('#iN', body).value, transpose: tr });
      await saveSong(s, true); closeModal(); renderHeader(); renderChart(); S.focusLi = null; S.curH = S.nxtH = null; updateNow(true);
    };
  });
}
function editForm() {
  const s = S.song;
  const txt = (s.form || []).map(([a, b]) => a === b ? a : a + '-' + b).join(', ');
  modal('Form / rekkefølge', `
    <div class="field"><label>Rekkefølge taktene spilles i</label><input type="text" id="fF" value="${esc(txt)}">
    <div class="hint">Eksempel: «1-16, 5-12, 17-40» = spill 1–16, gå tilbake og spill 5–12, så 17–40. Brukes til repetisjoner, D.S. og coda, og for å finne riktig sted i opptaket.</div></div>
    <button class="btn primary" id="fSave">Lagre</button>`, body => {
    $('#fSave', body).onclick = async () => {
      const parts = $('#fF', body).value.split(/[,;]+/).map(x => x.trim()).filter(Boolean);
      const f = []; for (const p of parts) { const m = /^(-?\d+)\s*(?:-|–)\s*(-?\d+)$/.exec(p) || /^(-?\d+)$/.exec(p); if (!m) { toast('Forstår ikke «' + p + '»'); return; } f.push([+m[1], +(m[2] || m[1])]); }
      if (S.song.recordings && S.song.recordings.some(r => r.map && r.map.length) && !confirm('Endret form kan forskyve synken mot opptaket. Fortsette?')) return;
      s.form = f; await saveSong(s, true); closeModal(); renderChart(); renderRoadmap(); S.focusLi = null; updateNow(true);
    };
  });
}
function addPages() {
  pickFile('image/*', async files => {
    const s = S.song; s.pages = s.pages || [];
    for (const f of files) { const id = 'pg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); await DB.put('files', { id, type: f.type, blob: f }); s.pages.push(id); }
    await saveSong(s); await renderSheet(); toast(files.length + ' side(r) lagt til');
  }, true);
}
$('#btnNewSong').onclick = () => {
  modal('Ny sang', `
    <div class="field"><label>Tittel</label><input type="text" id="nT"></div>
    <div class="row2"><div class="field" style="flex:1"><label>Antall takter</label><input type="number" id="nN" value="32"></div>
    <div class="field" style="flex:1"><label>Taktart</label><input type="text" id="nTs" value="4/4"></div>
    <div class="field" style="flex:1"><label>Toneart</label><input type="text" id="nK" value="C"></div></div>
    <button class="btn primary" id="nOk">Opprett</button>`, body => {
    $('#nOk', body).onclick = async () => {
      const t = $('#nT', body).value.trim(); if (!t) return;
      const N = clamp(+$('#nN', body).value || 32, 1, 999);
      const s = { id: 'user-' + Date.now(), title: t, part: '', keySig: $('#nK', body).value.trim(), timeSig: $('#nTs', body).value.trim() || '4/4', measures: Array.from({ length: N }, (_, i) => ({ n: i + 1, chords: [] })), form: [[1, N]], systems: [], pages: [], recordings: [], order: S.songs.length, userCreated: true, edited: true };
      await saveSong(s); closeModal(); renderList(); openSong(s.id); setEditing(true);
    };
  });
};

/* ================= Sync ================= */
$('#btnSync').onclick = () => setSyncing(!S.syncing);
$('#btnSyncClose').onclick = () => setSyncing(false);
function setSyncing(on) {
  S.syncing = on; $('#syncPanel').classList.toggle('hidden', !on); $('#btnSync').classList.toggle('on', on);
  if (!on) stopTap();
  syncHint();
}
function syncHint(msg) {
  const r = S.song && rec(S.song);
  $('#syncHint').textContent = msg || (r && r.map && r.map.length ? `Tidskart: ${r.map.length} punkter${r.mapEdited ? ' (justert av deg)' : ' (automatisk)'}. Tips: spill av, og trykk «Akkurat nå = start på takt …» i det takten begynner.` : 'Opptaket er ikke synket ennå. Bruk «Tapp inn takter».');
}
async function saveMap(r) { r.mapEdited = true; await saveSong(S.song); syncHint(); onTime(); }
$$('#syncPanel [data-shift]').forEach(b => b.onclick = async () => {
  const r = rec(S.song); if (!r || !r.map) return; const d = +b.dataset.shift;
  r.map.forEach(p => p[0] = Math.max(0, p[0] + d)); await saveMap(r); toast(`Flyttet ${d > 0 ? 'senere' : 'tidligere'} ${Math.abs(d)} s`);
});
$('#btnAnchor').onclick = async () => {
  const t = audio.currentTime; S.anchorTime = t;
  const n = await numpad(`Ved ${fmtT(t)} starter takt …`); if (n == null) return;
  setAnchorAt(n);
};
async function setAnchorAt(n) {
  const s = S.song, r = rec(s), t = S.anchorTime != null ? S.anchorTime : audio.currentTime; S.anchorTime = null;
  const occ = occurrences(s, n); if (!occ.length) return;
  let k = occ[0];
  if (occ.length > 1) {
    // guess the occurrence closest to what the map says now
    const p = posAt(r.map, t); let gi = 0;
    if (p != null) { let bd = 1e9; occ.forEach((x, i) => { if (Math.abs(x - p) < bd) { bd = Math.abs(x - p); gi = i; } }); }
    const i = await choose(`Takt ${n} spilles ${occ.length} ganger – hvilken?`, occ.map((x, i) => `${i + 1}. gang${i === gi ? '  (antatt)' : ''}`));
    if (i < 0) return; k = occ[i];
  }
  r.map = anchorMap(r.map || [], t, k);
  await saveMap(r); toast(`Synket: ${fmtT(t)} = takt ${n}`);
}
/* Shift the segment around time t so that t maps to pos k; points after the next discontinuity are untouched. */
function anchorMap(map, t, k) {
  map = map.slice().sort((a, b) => a[0] - b[0]);
  if (!map.length) return [[t, k]];
  const cur = posAt(map, t);
  // find segment bounds containing t
  let i = map.findIndex(p => p[0] > t); if (i < 0) i = map.length;
  let lo = i - 1; while (lo > 0 && map[lo - 1][1] != null && map[lo][1] != null && map[lo][1] > map[lo - 1][1] && map[lo][1] - map[lo - 1][1] <= 8) lo--;
  let hi = i; while (hi < map.length - 1 && map[hi][1] != null && map[hi + 1][1] != null && map[hi + 1][1] > map[hi][1] && map[hi + 1][1] - map[hi][1] <= 8) hi++;
  if (cur == null || lo < 0) {
    // inside a gap: start a new segment at t using local tempo
    const d = localDur(map, Math.max(0, i - 1));
    const out = map.filter(p => p[0] < t - 0.05);
    out.push([t, k]);
    // continue measure grid until the next point
    const nextT = i < map.length ? map[i][0] : t + d * 16;
    for (let j = 1; t + j * d < nextT - 0.2 && j < 64; j++) out.push([t + j * d, k + j]);
    return out.concat(map.filter(p => p[0] >= nextT - 0.2));
  }
  const dt = t - (timesAt(map.slice(Math.max(0, lo), hi + 1), k).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0] ?? t);
  const dpos = k - cur;
  if (Math.abs(dpos) < 0.5 && isFinite(dt)) {
    // small correction: shift time of this segment from t onwards (and stretch before)
    return map.map((p, j) => (j >= lo && j <= hi && p[0] >= t - 0.001) ? [p[0] + dt, p[1]] : p).sort((a, b) => a[0] - b[0]);
  }
  // larger correction: renumber positions of this segment by offset
  const off = Math.round(dpos);
  return map.map((p, j) => (j >= lo && j <= hi && p[1] != null) ? [p[0], p[1] + off] : p);
}
$('#btnGap').onclick = async () => {
  const r = rec(S.song), t = audio.currentTime;
  const map = (r.map || []).filter(p => p[0] < t - 0.05 || p[0] > t + 0.05);
  map.push([t, null]); map.sort((a, b) => a[0] - b[0]);
  // drop points after t until the next explicit jump (the user re-anchors when music resumes)
  const i = map.findIndex(p => p[0] === t);
  let j = i + 1; while (j < map.length && map[j][1] != null && (j === i + 1 || map[j][1] > map[j - 1][1])) j++;
  r.map = map.slice(0, i + 1).concat(map.slice(j));
  await saveMap(r); toast('Merket: ingen takt herfra. Sett «Akkurat nå = takt …» når musikken starter igjen.', 4000);
};
$('#btnSyncReset').onclick = async () => {
  const s = S.song, r = rec(s);
  const i = await choose('Tilbakestill synk', ['Tilbake til automatisk synk', 'Slett hele tidskartet (start på nytt)']);
  if (i < 0) return;
  const ri = s.recordings.indexOf(r);
  r.map = i === 0 && s.orig && s.orig.maps && s.orig.maps[ri] ? clone(s.orig.maps[ri]) : [];
  r.mapEdited = i !== 0; await saveSong(s); syncHint(); onTime();
};
/* tap-in */
$('#btnTapStart').onclick = async () => {
  const n = await numpad('Første takt du tapper på (slag 1)'); if (n == null) return;
  const occ = occurrences(S.song, n); if (!occ.length) { toast('Takt finnes ikke'); return; }
  let k = occ[0];
  if (occ.length > 1) { const i = await choose(`Takt ${n} – hvilken gang?`, occ.map((x, i) => `${i + 1}. gang`)); if (i < 0) return; k = occ[i]; }
  S.tap = { k, pts: [] };
  $('#btnTap').classList.remove('hidden'); $('#btnTapStop').classList.remove('hidden'); $('#btnTapStart').classList.add('hidden');
  $('#btnTap').textContent = `TAPP: takt ${n}`;
  syncHint('Start avspilling og trykk TAPP (eller mellomrom/pedal) på slag 1 i hver takt. Trykk «Stopp tapping» når du er ferdig.');
  if (audio.paused) audio.play();
};
function doTap() {
  if (!S.tap) return;
  const t = audio.currentTime - 0.04;
  S.tap.pts.push([t, S.tap.k]); S.tap.k++;
  const n = S.song._exp[S.tap.k];
  $('#btnTap').textContent = n != null ? `TAPP: takt ${n}` : 'Slutt';
}
$('#btnTap').addEventListener('touchstart', e => { e.preventDefault(); doTap(); }, { passive: false });
$('#btnTap').addEventListener('mousedown', e => { e.preventDefault(); doTap(); });
$('#btnTapStop').onclick = () => stopTap(true);
async function stopTap(save) {
  if (!S.tap) return;
  const pts = S.tap.pts; S.tap = null;
  $('#btnTap').classList.add('hidden'); $('#btnTapStop').classList.add('hidden'); $('#btnTapStart').classList.remove('hidden');
  if (!save || pts.length < 2) { syncHint(); return; }
  const r = rec(S.song), t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  // replace the tapped range; add the end of the last tapped measure
  const d = (t1 - t0) / (pts.length - 1);
  pts.push([t1 + d, pts[pts.length - 1][1] + 1]);
  const keep = (r.map || []).filter(p => p[0] < t0 - 0.05 || p[0] > t1 + d + 0.05);
  r.map = keep.concat(pts).sort((a, b) => a[0] - b[0]);
  await saveMap(r); toast(`${pts.length - 1} takter tappet inn ✓`);
}

/* ================= Boot ================= */
(async function boot() {
  try {
    await DB.open(); await loadSettings(); await loadSongs();
  } catch (e) { document.body.innerHTML = '<p style="padding:20px">Kunne ikke åpne lagring: ' + esc(e.message) + '</p>'; return; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  // #import=<url> imports a bundle from a URL (handy when the PC serves the data file on the local network)
  const m = /#import=(.+)$/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname);
    try { toast('Laster ned data …', 60000); const r = await fetch(decodeURIComponent(m[1])); const b = await r.blob(); await importFile(new File([b], 'data.korps')); }
    catch (e) { toast('Nedlasting feilet: ' + e.message, 4000); }
  }
})();
