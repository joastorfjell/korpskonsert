/* Korpskonsert – offline chord chart + backing track player for iPad.
   Data lives in IndexedDB (imported from a .korps bundle); the app shell is cached by sw.js. */
'use strict';

const APP_VERSION = '1.5.0';
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
const DEFAULT_SETTINGS = { theme: 'dark', naming: 'intl', fs: 1, perRow: 'sheet', preroll: false, wake: true, invertSheet: false, sv: 2 };
let settings = Object.assign({}, DEFAULT_SETTINGS);
async function loadSettings() {
  const m = await DB.get('meta', 'settings'); if (m) Object.assign(settings, m.v);
  if ((settings.sv || 1) < 2) { settings.preroll = false; settings.sv = 2; saveSettings(); }   // 1.4: taps land exactly on the measure/chord
  applySettings();
}
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
  // section in effect for every printed measure: the latest name (Vers/Refreng …) and rehearsal mark
  let lab = '', mk = '';
  for (const m of song.measures) {
    if (m.sec || m.mark) { lab = m.sec || m.mark; mk = m.sec ? (m.mark || '') : ''; }
    m._lab = lab; m._mk = mk; m._color = secColor(lab);
  }
  // sections in performance order: start, rehearsal mark/section name, or a jump in the form (repeat, D.S., coda)
  const secs = [], secOf = [];
  exp.forEach((n, k) => {
    const m = byN.get(n), jump = k > 0 && byN.get(exp[k - 1])._i + 1 !== m._i;
    if (!k || m.mark || m.sec || jump) secs.push({ k0: k, k1: k, n0: n, n1: n, label: m._lab, mark: m._mk, jump });
    const c = secs[secs.length - 1]; c.k1 = k; c.n1 = n;
  });
  // long stretches are split into 8-measure chunks (continuations of the same section)
  for (let i = 0; i < secs.length; i++) {
    const c = secs[i];
    if (c.k1 - c.k0 + 1 > 16) secs.splice(i + 1, 0, { k0: c.k0 + 8, k1: c.k1, n0: exp[c.k0 + 8], n1: c.n1, label: c.label, mark: c.mark, cont: true }), c.k1 = c.k0 + 7, c.n1 = exp[c.k1];
  }
  // number repeated section names in play order (Refreng 1, Refreng 2 …)
  const total = {}, seen = {};
  secs.forEach(c => { if (c.label && !c.cont) total[c.label] = (total[c.label] || 0) + 1; });
  secs.forEach(c => {
    if (c.label && !c.cont) seen[c.label] = (seen[c.label] || 0) + 1;
    const num = c.label && total[c.label] > 1 && !/^(intro|outro|coda)/i.test(c.label) ? ' ' + seen[c.label] : '';
    c.name = c.label ? c.label + num : 'takt ' + c.n0;
    c.color = secColor(c.label);
  });
  secs.forEach((c, i) => { for (let k = c.k0; k <= c.k1; k++) secOf[k] = i; });
  song._secs = secs; song._secOf = secOf;
  // logical parts (8-measure continuation chunks merged back) for the roadmap and "3/8 i delen"
  const lsecs = [], lsecOf = [];
  secs.forEach(c => {
    const l = lsecs[lsecs.length - 1];
    if (c.cont && l) { l.k1 = c.k1; l.n1 = c.n1; }
    else if (l && c.jump && c.label && c.label === l.label) { l.k1 = c.k1; l.n1 = Math.max(l.n1, c.n1); l.reps = (l.reps || 1) + 1; }   // same part repeated (4x vamp)
    else lsecs.push(Object.assign({}, c));
  });
  lsecs.forEach(c => { if (c.reps) c.name += ` ×${c.reps}`; });
  lsecs.forEach((c, i) => { for (let k = c.k0; k <= c.k1; k++) lsecOf[k] = i; });
  song._lsecs = lsecs; song._lsecOf = lsecOf;
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
  // rehearsal notes: which start at / cover each printed measure
  const anAt = new Map(), anIn = new Map(), add = (mp, n, a) => { if (!mp.has(n)) mp.set(n, []); mp.get(n).push(a); };
  for (const a of song.annotations || []) {
    const m0 = byN.get(a.n0); if (!m0 || a.hidden) continue;
    const m1 = byN.get(a.n1) || m0;
    add(anAt, a.n0, a);
    for (let i = m0._i; i <= Math.max(m0._i, m1._i); i++) add(anIn, song.measures[i].n, a);
  }
  song._anAt = anAt; song._anIn = anIn;
}
/* one color per section type, so repeats of the same part look the same everywhere */
const SEC_COLORS = [[/^intro/i, '#8da2c0'], [/^vers/i, '#4fb3ff'], [/^pre/i, '#2dd4bf'], [/^refr|^chorus/i, '#ffb627'], [/^bro|^bridge/i, '#c084fc'],
  [/^solo|^instr|^mellom/i, '#4cd17a'], [/^outro|^coda|^slutt|^ending/i, '#9ca3af']];
const SEC_PALETTE = ['#f472b6', '#60a5fa', '#fbbf24', '#34d399', '#a78bfa', '#fb923c', '#22d3ee', '#f87171'];
function secColor(label) {
  if (!label) return '';
  for (const [rx, c] of SEC_COLORS) if (rx.test(label)) return c;
  let h = 0; for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SEC_PALETTE[h % SEC_PALETTE.length];
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
    } else if (pos >= a[1] && pos < Math.floor(a[1]) + 1) {
      // extrapolated: only valid until the next map point (else posAt would read it from that point instead)
      const t = a[0] + (pos - a[1]) * localDur(map, i);
      if (!b || t < b[0] - 1e-3) out.push(t);
    }
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
        <div class="meta">${esc(s.part || '')} · ${esc(keyName(s.keySig, s.transpose || 0) || s.keySig || '')} · ${esc(s.timeSig || '')} · ${s.measures.length} takter</div>${s.structure ? `<div class="struct">${esc(s.structure)}</div>` : ''}</div>
      <div class="tags">${tr}${r ? `<span class="tag ${synced ? 'ok' : 'warn'}">${r} lydspor${synced ? ' ✓' : ''}</span>` : '<span class="tag">uten lyd</span>'}${s.edited ? '<span class="tag warn">redigert</span>' : ''}</div>
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
      s.annotations = mergeAnnotations(s.annotations, old.annotations); if (old.notesEdited) s.notesEdited = true;
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
  const songs = S.songs.filter(s => s.edited || s.notesEdited || (s.recordings || []).some(r => r.mapEdited) || s.userCreated);
  if (!songs.length) { toast('Ingen endringer å eksportere'); return; }
  const data = {
    kind: 'korps-edits', version: 1, date: new Date().toISOString(),
    songs: songs.map(s => ({
      id: s.id, title: s.title, part: s.part, keySig: s.keySig, timeSig: s.timeSig, transpose: s.transpose || 0, notes: s.notes,
      measures: strip(s).measures, form: s.form, userCreated: !!s.userCreated, edited: !!s.edited,
      maps: (s.recordings || []).map(r => ({ id: r.id, map: r.map, mapEdited: !!r.mapEdited })),
      annotations: s.notesEdited ? s.annotations || [] : undefined,
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
    if (e.annotations) { s.annotations = mergeAnnotations(s.annotations, e.annotations); s.notesEdited = true; }
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
  renderHeader(); renderChart(); renderRoadmap(); updateNotesBtn(); await renderSheet(); await loadAudio();
  setBpm(estimateBpm(song)); $('#btnMetro').classList.toggle('on', !!settings.metro);
  setSource(song.liveMode != null ? song.liveMode : !rec(song));
  setMode(song.viewMode || (song.measures.some(m => m.chords && m.chords.length) ? 'focus' : 'sheet'));
  updateNow(true);
  wake(true);
}
function closeSong() {
  liveStop(); micStop(); audio.pause(); wake(false);
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
      return `<span class="c${u}" data-b="${b}" style="flex:${w} 1 0">${chordHTML(c, song)}</span>`;
    }).join('');
    const lead = m.chords[0][1] - 1;
    if (lead > 0.01) chords = `<span class="c carry" style="flex:${lead} 1 0">${m._carry ? chordHTML(m._carry, song) : ''}</span>` + chords;
  } else if (m.rest) chords = '<span class="c">–</span>';
  else if (first && m._carry) chords = `<span class="c carry">${chordHTML(m._carry, song)}</span>`;
  else chords = '<span class="c hold">%</span>';
  const pill = m.sec ? `<span class="mk sec" style="background:${m._color}">${esc(m.sec)}${m.mark ? ' · ' + esc(m.mark) : ''}</span>`
    : m.mark ? `<span class="mk" style="background:${m._color || 'var(--accent)'}">${esc(m.mark)}</span>` : '';
  const inAn = (song._anIn.get(m.n) || [])[0];
  return `<div class="m${m.rest ? ' rest' : ''}${first ? ' first' : ''}${(m.chords || []).length >= 3 ? ' many' : ''}${inAn ? ' anin' : ''}" data-n="${m.n}" style="--sc:${m._color || 'transparent'}${inAn ? ';--ac:' + kindOf(inAn)[1] : ''}">
    <span class="mn">${m.n}</span>${pill}
    <div class="cs">${chords}</div>${m.text ? `<div class="tx">${esc(m.text)}</div>` : ''}${anBadges(song._anAt.get(m.n))}<div class="prog"></div></div>`;
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
  const ab = e.target.closest('.an'); if (ab && !S.editing) { showAnnotation(ab.dataset.a); return; }
  const el = e.target.closest('.m'); if (!el) return;
  const c = e.target.closest('.c[data-b]');   // tapped a chord: go straight to it
  onMeasureTap(+el.dataset.n, c ? +c.dataset.b : null);
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
  roadmapProgress(p);
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
      return `<span class="c${/\?$/.test(c) ? ' unsure' : ''}" data-b="${b}" style="flex:${Math.max(0.5, nb - b)} 1 0">${chordHTML(c, s)}</span>`;
    }).join('');
    const lead = m.chords[0][1] - 1, held = chordAt(s, k - 0.001);
    if (lead > 0.01) cs = `<span class="c carry" style="flex:${lead} 1 0">${held ? chordHTML(held, s) : ''}</span>` + cs;
  } else if (m.rest) cs = '<span class="c">–</span>';
  else if (j === 0) { const held = chordAt(s, k); cs = `<span class="c carry">${held ? chordHTML(held, s) : '%'}</span>`; }
  else cs = '<span class="c hold">%</span>';
  const ans = anActive(s, k), inAn = ans[0];
  return `<div class="fm${m.rest ? ' rest' : ''}${(m.chords || []).length >= 3 ? ' many' : ''}${inAn ? ' anin' : ''}" data-k0="${k}" data-k1="${k}" style="--sc:${m._color || 'var(--line)'}${inAn ? ';--ac:' + kindOf(inAn)[1] : ''}"><span class="mn">${m.n}</span>${m.mark ? `<span class="mk">${esc(m.mark)}</span>` : ''}
    <div class="cs">${cs}</div>${m.text ? `<div class="tx">${esc(m.text)}</div>` : ''}${anBadges(ans.filter(a => a.n0 === m.n))}<div class="prog"></div></div>`;
}
function focusLineHTML(s, ln, li, cur) {
  const sc = ln.sec, name = sc.label ? sc.name + (sc.mark ? ' · ' + sc.mark : '') : (sc.jump ? 'tilbake til takt ' : 'takt ') + sc.n0;
  const lbl = !ln.first ? '' : `<span class="fsec${sc.cont ? ' cont' : ''}" style="color:${sc.color || 'var(--accent)'}">${sc.jump ? '↺ ' : ''}${esc(name)}${sc.cont ? ' (forts.)' : ''}</span>`;
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
  const lane = $('#fLane'), li = k == null ? 0 : s._lineOf[k];
  // the whole song is in the lane (it scrolls); S.focusLi = null rebuilds it
  if (S.focusLi == null) {
    lane.innerHTML = s._lines.map((ln, i) => focusLineHTML(s, ln, i, false)).join('') + '<div class="fend">Slutt</div>';
    S.focusLi = -1;
  }
  if (li !== S.focusLi) {
    const far = S.focusLi < 0 || Math.abs(li - S.focusLi) > 2;
    S.focusLi = li;
    Array.from(lane.children).forEach((e, i) => { e.classList.toggle('now', i === li); e.classList.toggle('past', i < li); });
    focusFollow(!far);
  }
  $$('#fLane .fm.cur').forEach(e => { e.classList.remove('cur'); const pr = $('.prog', e); if (pr) pr.style.width = 0; });
  let txt = '';
  if (k != null) {
    const e = $$('.fm[data-k0]', lane.children[li]).find(e => +e.dataset.k0 <= k && k <= +e.dataset.k1);
    if (e) {
      e.classList.add('cur');
      const left = $('.rleft', e); if (left) left.textContent = `${+e.dataset.k1 - k + 1} igjen`;
    }
    const si = s._lsecOf[k], sec = s._lsecs[si], nx = s._lsecs[si + 1];
    $('#fMark').textContent = sec.label ? sec.name + (sec.mark ? ' · ' + sec.mark : '') : 'takt ' + sec.n0 + '–' + sec.n1;
    $('#fMark').style.background = sec.color || 'var(--bg3)'; $('#fMark').style.color = sec.color ? '#111' : 'var(--fg)';
    $('#fMark').classList.remove('hidden');
    $('#fSecPos').textContent = `${k - sec.k0 + 1}/${sec.k1 - sec.k0 + 1} i delen`;
    for (let i = k; i <= k + 2 && i < s._exp.length; i++) {
      const m = s._byN.get(s._exp[i]);
      if (m.text) { txt = i === k ? esc(m.text) : `Snart (takt ${m.n}): ${esc(m.text)}`; break; }
    }
    // warn two measures before the next part starts
    if (nx && sec.k1 - k < 2) {
      const left = sec.k1 - k + 1, nn = nx.label ? nx.name : 'takt ' + nx.n0;
      txt += (txt ? ' · ' : '') + `<span style="color:${nx.color || 'var(--accent)'}">Neste: ${nx.jump ? '↺ ' : ''}${esc(nn)} (takt ${nx.n0})</span> om ${left} takt${left > 1 ? 'er' : ''}`;
    }
    // rehearsal notes: the ones in effect here, and the ones starting within two measures
    const now = anActive(s, k), soon = [];
    for (let i = k + 1; i <= k + 2 && i < s._exp.length; i++) anActive(s, i).forEach(a => { if (a.n0 === s._exp[i] && !now.includes(a) && !soon.some(x => x.a === a)) soon.push({ a, d: i - k }); });
    const lines = now.slice(0, 2).map(a => anLine(a, '')).concat(soon.slice(0, 1).map(x => anLine(x.a, `Om ${x.d} takt${x.d > 1 ? 'er' : ''}: `)));
    if (lines.length) txt = (txt ? `<div>${txt}</div>` : '') + lines.join('');
    else if (txt) txt = `<div>${txt}</div>`;
  } else { $('#fMark').classList.add('hidden'); $('#fSecPos').textContent = ''; }
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
/* keep the playing line second from the top (the line before it stays visible to tap back to),
   unless the lane was scrolled by hand in the last few seconds */
function focusFollow(smooth) {
  const lane = $('#fLane'), cur = lane.children[S.focusLi]; if (!cur || Date.now() < S.fHold) return;
  const prev = lane.children[S.focusLi - 1];
  lane.scrollTo({ top: prev ? prev.offsetTop - 4 : 0, behavior: smooth ? 'smooth' : 'auto' });
}
(function () {
  const lane = $('#fLane');
  lane.addEventListener('touchstart', () => { S.fHold = Infinity; }, { passive: true });
  lane.addEventListener('touchend', () => { S.fHold = Date.now() + 5000; }, { passive: true });
  lane.addEventListener('wheel', () => { S.fHold = Date.now() + 5000; }, { passive: true });
})();
$('#fLane').addEventListener('click', e => {
  const ab = e.target.closest('.an'); if (ab) { showAnnotation(ab.dataset.a); return; }
  const el = e.target.closest('.fm[data-k0]'); if (!el || !S.song) return;
  const k = +el.dataset.k0, c = e.target.closest('.c[data-b]');
  if (S.editing || S.loopPick || (S.syncing && S.anchorPending)) { onMeasureTap(S.song._exp[k]); return; }
  gotoExp(k, c ? +c.dataset.b : null);
});
$('#fText').addEventListener('click', e => { const ab = e.target.closest('[data-a]'); if (ab) showAnnotation(ab.dataset.a); });

/* ---- roadmap: sections in performance order ---- */
/* a timeline of the song: one block per part in play order, width by length, colored by part type */
function renderRoadmap() {
  const s = S.song, el = $('#roadmap');
  S.secI = null;
  if (!s || s._lsecs.length < 2) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = s._lsecs.map((c, i) => {
    const len = c.k1 - c.k0 + 1;
    const name = c.label ? c.name : String(c.n0);
    return `<button class="sec" data-i="${i}" style="--sc:${c.color || 'var(--muted)'};flex:${len} 1 0">
      <b>${c.jump ? '↺ ' : ''}${esc(name)}</b><span>${c.mark ? esc(c.mark) + ' · ' : ''}${c.n0}–${c.n1}</span><i class="sp"></i></button>`;
  }).join('');
}
function markRoadmap(k) {
  const s = S.song; if (!s || !s._lsecs.length) return;
  const i = k == null ? -1 : s._lsecOf[k]; if (i === S.secI) return; S.secI = i;
  const bs = $$('#roadmap .sec');
  bs.forEach((b, j) => { b.classList.toggle('on', j === i); b.classList.toggle('past', j < i); const sp = $('.sp', b); if (sp && j !== i) sp.style.width = j < i ? '100%' : '0'; });
  const b = bs[i], r = $('#roadmap');
  if (b && r.offsetParent && r.scrollWidth > r.clientWidth) r.scrollTo({ left: b.offsetLeft - r.clientWidth / 3, behavior: 'smooth' });
}
function roadmapProgress(p) {
  const s = S.song; if (!s || p == null || S.secI == null || S.secI < 0) return;
  const c = s._lsecs[S.secI], b = $$('#roadmap .sec')[S.secI]; if (!c || !b) return;
  $('.sp', b).style.width = clamp((p - c.k0) / (c.k1 - c.k0 + 1) * 100, 0, 100).toFixed(1) + '%';
}
$('#roadmap').addEventListener('click', e => { const b = e.target.closest('.sec'); if (b && S.song) gotoExp(S.song._lsecs[+b.dataset.i].k0); });
function gotoExp(k, beat) { const s = S.song, n = s._exp[k]; return gotoMeasure(n, occurrences(s, n).indexOf(k), beat); }
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
$('#btnPlay').onclick = () => {
  if (L.on) { if (L.running) liveStop(); else liveStart(); return; }
  ac();   // unlock the click sound on iOS while we have a user gesture
  if (audio.paused) audio.play().catch(e => toast('Kan ikke spille: ' + e.message)); else audio.pause();
};

function tick() { onTime(); if (!audio.paused) requestAnimationFrame(tick); }
function onTime() {
  const s = S.song; if (!s || L.on) return;
  const t = audio.currentTime;
  if (S.loop && !audio.paused && t >= S.loop.t1) { audio.currentTime = S.loop.t0; return; }
  if (!scrubbing) $('#scrub').value = audio.duration ? Math.round(1000 * t / audio.duration) : 0;
  $('#tCur').textContent = fmtT(t);
  const r = rec(s);
  const p = r ? posAt(r.map, t) : null;
  S.pos = p != null && p < s._exp.length ? p : null;
  if (S.pos != null) S.cursor = Math.floor(S.pos);
  // metronome over the recording: click when the playback crosses a beat
  if (settings.metro && !audio.paused && S.pos != null) {
    const k = Math.floor(S.pos), nb = s._byN.get(s._exp[k])._beats, b = Math.floor((S.pos - k) * nb + 1e-3), key = k + ':' + b;
    if (key !== S.clickKey) { if (S.clickKey != null) click(0, b === 0); S.clickKey = key; }
  } else S.clickKey = null;
  updateNow(false);
}
let scrubbing = false;
$('#scrub').addEventListener('input', () => { scrubbing = true; if (audio.duration) { audio.currentTime = audio.duration * $('#scrub').value / 1000; onTime(); } });
$('#scrub').addEventListener('change', () => { scrubbing = false; });

/* jump to measure */
/* beat: jump to that beat of the measure (a tapped chord) instead of its start. Without an explicit occurrence the
   one nearest to where we are now is used, so tapping a chord a bit back or ahead stays in the same pass. */
async function gotoMeasure(n, occIdx, beat) {
  S.fHold = 0;   // a jump brings the focus lane back to following
  const s = S.song; const occ = occurrences(s, n);
  if (!occ.length) { toast('Takt ' + n + ' finnes ikke'); return; }
  const m = s._byN.get(n), off = beat ? clamp((beat - 1) / m._beats, 0, 0.999) + 1e-4 : 0;
  const p = curExpPos() || 0;
  const near = () => occIdx != null && occ[occIdx] != null ? occ[occIdx] : occ.reduce((a, b) => Math.abs(b + off - p) < Math.abs(a + off - p) ? b : a);
  if (L.on) { seekPos(near() + off); return; }   // live: keep the clock running from there
  const r = rec(s);
  if (!r || !r.map || !r.map.length) { S.cursor = near() + off; S.pos = null; updateNow(true); return; }
  await whenReady();
  const t = audio.currentTime;
  // candidate (k, time) pairs
  let cands = [];
  occ.forEach((k, oi) => timesAt(r.map, k + off).forEach(tt => cands.push({ k, oi, t: tt })));
  if (occIdx != null) cands = cands.filter(c => c.oi === occIdx);
  if (!cands.length) {
    toast(`Takt ${n} er ikke med i dette opptaket`);
    S.cursor = occ[0]; S.pos = null; updateNow(true); return;
  }
  // an explicit pass: its first playing in the recording; otherwise the playing nearest to the current time
  const c = occIdx != null ? cands.sort((a, b) => a.t - b.t)[0] : cands.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
  let target = c.t;
  if (settings.preroll && !beat && c.k > 0) { const pre = timesAt(r.map, c.k - 1).filter(x => x < c.t && c.t - x < 12); if (pre.length) target = Math.max(...pre); }
  audio.currentTime = Math.max(0, target);
  S.cursor = c.k + off; onTime();
}
function onMeasureTap(n, beat) {
  if (S.editing) { editMeasure(n); return; }
  if (S.loopPick) { pickLoop(n); return; }
  if (S.syncing && S.anchorPending) { S.anchorPending = false; setAnchorAt(n); return; }
  gotoMeasure(n, null, beat);
}
$('#btnGoto').onclick = async () => {
  const n = await numpad('Gå til takt'); if (n == null) return;
  const occ = occurrences(S.song, n);
  if (occ.length > 1) {
    const i = await choose(`Takt ${n} spilles ${occ.length} ganger`, occ.map((k, i) => `${i + 1}. gang`));
    if (i < 0) return; gotoMeasure(n, i);
  } else gotoMeasure(n);
};
/* move to an expanded position: live clock, recording (via its map), or just the cursor */
function seekPos(p) {
  S.fHold = 0;
  const s = S.song; p = clamp(p, 0, s._exp.length - 0.001);
  if (L.on) {
    if (L.running) { L.p0 = L.pS = p; L.t0 = L.tS = clockNow(); L.sched = null; S.pos = p; }
    else { S.cursor = p; S.pos = null; }
    updateNow(true); return;
  }
  const r = rec(s);
  if (r && r.map && r.map.length) {
    const ts = timesAt(r.map, p), t = audio.currentTime;
    if (ts.length) { ts.sort((a, b) => Math.abs(a - t) - Math.abs(b - t)); audio.currentTime = ts[0]; S.cursor = p; onTime(); return; }
  }
  S.cursor = p; S.pos = null; updateNow(true);
}
/* step chord by chord in play order; going back within the first beat of a chord goes to the previous one */
function stepChord(d) {
  const s = S.song, ev = s._ev.filter(e => e.c), p = curExpPos() || 0;
  if (!ev.length) { seekPos(Math.floor(p) + d); return; }
  let i = -1; for (let j = 0; j < ev.length; j++) { if (ev[j].pos <= p + 1e-4) i = j; else break; }
  let t;
  if (d > 0) t = ev[i + 1];
  else {
    const m = s._byN.get(s._exp[Math.floor(p)]), oneBeat = 1 / (m ? m._beats : 4);
    t = i >= 0 && p - ev[i].pos > oneBeat ? ev[i] : ev[Math.max(0, i - 1)];
  }
  if (t) seekPos(t.pos + 1e-4);
}
$('#btnPrev').onclick = () => stepChord(-1);
$('#btnNext').onclick = () => stepChord(1);

/* ================= Live: tempo/tap-driven cursor + metronome ================= */
const L = { on: false, running: false, bpm: 100, base: 100, t0: 0, p0: 0, tS: 0, pS: 0, taps: [], sched: null };   // base: the tempo set by hand/tapping; tS/pS: the last start
let actx = null;
/* call from a user gesture: creates/unlocks the click sound. iOS suspends or 'interrupts' the audio context when the app
   goes to the background (or another app plays sound) and only lets it start again inside a gesture, so this also runs
   on every touch/key while the click or the microphone is in use. An interrupted context is replaced. */
function ac() {
  if (actx && (actx.state === 'closed' || actx.state === 'interrupted')) { try { actx.close(); } catch (e) { } actx = null; }
  if (!actx) {
    try { if (navigator.audioSession) navigator.audioSession.type = M.on ? 'play-and-record' : 'playback'; } catch (e) { }   // iOS 17: click also with the silent switch on
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
  }
  if (actx.state !== 'running') actx.resume().catch(() => { });
  // a silent buffer started inside the gesture is what unlocks output on older iOS versions
  try { const src = actx.createBufferSource(); src.buffer = actx.createBuffer(1, 1, 22050); src.connect(actx.destination); src.start(0); } catch (e) { }
  return actx;
}
['touchend', 'mousedown', 'keydown'].forEach(ev => document.addEventListener(ev, () => {
  if ((settings.metro || M.on) && (!actx || actx.state !== 'running')) { ac(); $('#btnMetro').classList.remove('warn'); }
  if (M.ctx && M.ctx.state !== 'running') M.ctx.resume().catch(() => { });
}, true));
/* iOS before 17 (no audioSession): web audio is muted in silent mode unless a media element is playing, so a silent loop
   keeps the live click audible */
let keepAlive = null;
function sessionKeepAlive(on) {
  if (navigator.audioSession) return;
  if (on) {
    if (!keepAlive) {
      const n = 4000, b = new Uint8Array(44 + n), v = new DataView(b.buffer), w = (o, t) => [...t].forEach((c, i) => b[o + i] = c.charCodeAt(0));
      w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
      b.fill(128, 44);
      keepAlive = new Audio(URL.createObjectURL(new Blob([b], { type: 'audio/wav' }))); keepAlive.loop = true;
    }
    keepAlive.play().catch(() => { });
  } else if (keepAlive) keepAlive.pause();
}
/* the live clock is the system clock; clicks are converted to the audio clock when scheduled */
function clockNow() { return performance.now() / 1000; }
let clickWarned = 0, clickDead = 0;
function click(when, accent) {   // when: clockNow() seconds (0 = now)
  const a = actx;
  if (!a || a.state !== 'running') {   // iOS has paused the sound (it comes back on the next touch); a fresh one takes a moment
    clickDead = clickDead || Date.now();
    if (Date.now() - clickDead > 1500) {
      $('#btnMetro').classList.add('warn');
      if (Date.now() - clickWarned > 8000) { clickWarned = Date.now(); toast('Klikket er satt på pause av iPaden – trykk hvor som helst på skjermen', 3000); }
    }
    return;
  }
  clickDead = 0;
  when = Math.max(a.currentTime, when ? a.currentTime + (when - clockNow()) : 0);
  const o = a.createOscillator(), g = a.createGain();
  o.frequency.value = accent ? 1760 : 1100;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.5, when + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
  o.connect(g); g.connect(a.destination); o.start(when); o.stop(when + 0.09);
}
/* position after `beats` beats from p (measures can have different beat counts) */
function advance(s, p, beats) {
  let k = Math.floor(p), f = p - k;
  while (k < s._exp.length) {
    const nb = s._byN.get(s._exp[k])._beats, left = (1 - f) * nb;
    if (beats < left - 1e-9) return k + f + beats / nb;
    beats -= left; k++; f = 0;
  }
  return s._exp.length;
}
function livePos(t) { return advance(S.song, L.p0, Math.max(0, (t - L.t0) * L.bpm / 60)); }
function estimateBpm(s) {
  if (s.liveBpm) return s.liveBpm;
  const base = beatsOf(s.timeSig || '4/4');
  for (const r of s.recordings || []) {
    const d = [];
    for (let i = 0; i + 1 < (r.map || []).length; i++) { const a = r.map[i], b = r.map[i + 1]; if (a[1] != null && b[1] === a[1] + 1 && b[0] > a[0]) d.push(b[0] - a[0]); }
    if (d.length > 8) { d.sort((x, y) => x - y); return Math.round(base * 60 / d[d.length >> 1]); }
  }
  return s.tempo || 100;
}
function setBpm(v, save) {
  v = clamp(Math.round(v), 30, 260);
  if (L.running) { const t = clockNow(); L.p0 = L.pS = livePos(t); L.t0 = L.tS = t; L.sched = null; }
  L.bpm = L.base = v; $('#bpmNum').textContent = v;
  if (save && S.song) { S.song.liveBpm = v; DB.put('songs', strip(S.song)); }
}
function setSource(live) {
  L.on = live; liveStop(); if (!live) micStop();
  $$('#srcSeg button').forEach(b => b.classList.toggle('on', (b.dataset.src === 'live') === live));
  $('#transport').classList.toggle('live', live);
  if (live) { audio.pause(); S.pos = null; S.cursor = Math.floor(S.cursor || 0); }
  else onTime();
  if (S.song) { S.song.liveMode = live; DB.put('songs', strip(S.song)); }
  $('#noAudio').classList.toggle('hidden', live || !!rec(S.song));
  updateNow(true);
}
$$('#srcSeg button').forEach(b => b.onclick = () => { ac(); setSource(b.dataset.src === 'live'); });
function liveStart(atTime) {
  const s = S.song; if (!s) return;
  ac();
  const p = Math.floor(curExpPos() || 0), nb = s._byN.get(s._exp[p])._beats;
  L.p0 = p;
  // count-in: one measure of clicks when the metronome is on (unless started by tapping, which is its own count-in)
  L.t0 = atTime != null ? atTime : clockNow() + (settings.metro ? nb * 60 / L.bpm : 0.05);
  L.running = true; L.sched = null; L.lastClick = -1; L.tS = L.t0; L.pS = L.p0;
  if (settings.metro) sessionKeepAlive(true);
  $('#btnPlay').textContent = '❚❚';
  requestAnimationFrame(liveTick);
}
function liveStop() {
  if (!L.running) return;
  L.running = false; L.taps = []; sessionKeepAlive(false);
  const p = livePos(clockNow());
  S.cursor = Math.min(p, S.song ? S.song._exp.length - 0.001 : 0); S.pos = null;
  $('#btnPlay').textContent = '▶'; $('#btnTapLive').textContent = 'TAPP';
  updateNow(true);
}
function liveTick() {
  const s = S.song; if (!L.running || !s) return;
  const t = clockNow();
  if (t < L.t0) {   // counting in
    const left = Math.ceil((L.t0 - t) * L.bpm / 60);
    S.pos = null; S.cursor = L.p0; L.counting = true; $('#fText').textContent = 'Inntelling … ' + left;
  } else {
    if (L.counting) { L.counting = false; S.lastMeasureKey = null; }
    const p = livePos(t);
    if (p >= s._exp.length) { liveStop(); return; }
    S.pos = p;
    if (M.on && t > L.t0 + 1) micFollow(t);
  }
  if (settings.metro) scheduleClicks(t);
  updateNow(false);
  requestAnimationFrame(liveTick);
}
/* schedule metronome clicks slightly ahead on the audio clock, so they are exact even if frames are late */
function scheduleClicks(t) {
  const spb = 60 / L.bpm, s = S.song;
  let b = L.sched == null ? Math.ceil((t - L.t0) / spb - 1e-6) : L.sched + 1;
  const nbStart = s._byN.get(s._exp[Math.floor(L.p0)])._beats;
  for (; L.t0 + b * spb < t + 0.15; b++) {
    const when = L.t0 + b * spb;
    let accent;
    if (b < 0) accent = (b + nbStart * 64) % nbStart === 0;      // count-in: accent on its first beat
    else { const p = advance(s, L.p0, b); accent = Math.abs(p - Math.round(p)) < 1e-6; }
    L.sched = b;
    if (b >= 0 && M.on) continue;   // following the mic: only the count-in clicks (the mic would hear the click)
    if (when < L.lastClick + spb / 2) continue;   // a re-anchored clock must not repeat a click already scheduled
    click(when, accent); L.lastClick = when;
  }
}
/* TAPP: sets the tempo from the last taps; stopped = tap one measure to count in and start on the next beat;
   running = re-sync to the nearest beat (and adopt the tapped tempo) */
function liveTap() {
  const s = S.song; if (!s) return;
  ac();
  const t = clockNow(), pNow = L.running && t >= L.t0 ? livePos(t) : null;   // position at the old tempo
  L.taps = L.taps.filter(x => t - x < 2.5).concat(t).slice(-6);
  const iv = []; for (let i = 1; i < L.taps.length; i++) iv.push(L.taps[i] - L.taps[i - 1]);
  const good = iv.filter(x => x > 0.2 && x < 2.2).slice(-4);
  if (good.length) { const sorted = good.slice().sort((a, b) => a - b); L.bpm = L.base = clamp(Math.round(60 / sorted[sorted.length >> 1]), 30, 260); $('#bpmNum').textContent = L.bpm; }
  if (settings.metro && !(M.on && L.running)) click(0, false);
  if (!L.running) {
    const p = Math.floor(curExpPos() || 0), nb = s._byN.get(s._exp[p])._beats, need = Math.min(nb, 4);
    if (L.taps.length >= need && good.length >= need - 1) { liveStart(t + 60 / L.bpm); L.taps = []; s.liveBpm = L.bpm; DB.put('songs', strip(s)); }
    else $('#btnTapLive').textContent = `TAPP ${L.taps.length}/${need}`;
    return;
  }
  if (pNow == null) return;   // tapping during the count-in only adjusts the tempo
  // running: snap the phase to the nearest beat, keep the measure we are in
  const k = Math.floor(pNow), nb = s._byN.get(s._exp[k])._beats, f = (pNow - k) * nb, fr = Math.round(f);
  L.p0 = Math.abs(f - fr) < 0.45 ? (fr >= nb ? k + 1 : k + fr / nb) : pNow;
  L.t0 = L.tS = t; L.pS = L.p0; L.sched = null;
}
$('#btnTapLive').addEventListener('touchstart', e => { e.preventDefault(); liveTap(); }, { passive: false });
$('#btnTapLive').addEventListener('mousedown', e => { e.preventDefault(); liveTap(); });
$('#bpmMinus').onclick = () => setBpm(L.bpm - 2, true);
$('#bpmPlus').onclick = () => setBpm(L.bpm + 2, true);
$('#bpmVal').onclick = async () => { const v = await numpad('Tempo (slag per minutt)', L.bpm); if (v) setBpm(v, true); };
$('#btnMetro').onclick = () => { ac(); settings.metro = !settings.metro; saveSettings(); $('#btnMetro').classList.toggle('on', settings.metro); L.sched = null; };

/* ================= Live: follow the band's tempo through the microphone (optional) =================
   Onsets (spectral flux) from the mic, then a tempo and beat estimate every half second (micFollow). It never changes
   the measure: start with TAPP / ▶ as usual, the mic only keeps the cursor in step with the band. */
const FN = 1024, FHOP = 512, RING = 1024;
const M = { on: false, ctx: null, stream: null, node: null, sr: 48000, buf: new Float32Array(FN), prev: null, bands: [],
  env: new Float32Array(RING), envN: 0, samples: 0, base: Infinity, last: 0, lock: 0 };
const fftRe = new Float32Array(FN), fftIm = new Float32Array(FN);
const hann = Float32Array.from({ length: FN }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FN));
const fftRev = Uint16Array.from({ length: FN }, (_, i) => { let r = 0; for (let b = 0; b < 10; b++) r |= ((i >> b) & 1) << (9 - b); return r; });
const fftCos = Float32Array.from({ length: FN / 2 }, (_, i) => Math.cos(-2 * Math.PI * i / FN));
const fftSin = Float32Array.from({ length: FN / 2 }, (_, i) => Math.sin(-2 * Math.PI * i / FN));
function fft(re, im) {
  for (let i = 0; i < FN; i++) { const j = fftRev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= FN; size <<= 1) {
    const half = size >> 1, step = FN / size;
    for (let i = 0; i < FN; i += size) for (let j = 0; j < half; j++) {
      const c = fftCos[j * step], sn = fftSin[j * step], a = i + j, b = a + half;
      const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
function micBands() {
  const kmax = Math.min(FN / 2, Math.round(6000 * FN / M.sr)), e = [];
  for (let i = 0; i <= 24; i++) e.push(Math.round(Math.pow(kmax - 1, i / 24)));
  M.bands = [...new Set(e)].map((a, i, u) => [a, u[i + 1]]).slice(0, -1);
  M.prev = new Float32Array(M.bands.length);
}
function micProcess(e) {
  const x = e.inputBuffer.getChannelData(0);
  e.outputBuffer.getChannelData(0).fill(0);
  // clock time of the first sample: the earliest estimate wins (callbacks only ever run late)
  M.base = Math.min(M.base, clockNow() - (M.samples + x.length) / M.sr);
  for (let o = 0; o + FHOP <= x.length; o += FHOP) {
    M.buf.copyWithin(0, FHOP); M.buf.set(x.subarray(o, o + FHOP), FN - FHOP);
    for (let i = 0; i < FN; i++) { fftRe[i] = M.buf[i] * hann[i]; fftIm[i] = 0; }
    fft(fftRe, fftIm);
    let flux = 0;
    M.bands.forEach(([a, b], j) => {
      let sum = 0; for (let k = a; k < b; k++) sum += Math.hypot(fftRe[k], fftIm[k]);
      const m = Math.log(1 + 100 * sum / (b - a));
      if (m > M.prev[j]) flux += m - M.prev[j];
      M.prev[j] = m;
    });
    M.env[M.envN % RING] = flux; M.envN++;
  }
  M.samples += x.length;
}
/* clock time of onset frame i: the middle of the newest hop in its window */
const micT = i => M.base + ((i + 1) * FHOP - FHOP / 2) / M.sr;
/* every half second: (1) tempo = the strongest periodicity of the last 8 s of onsets within ±10 % of the tempo you set
   (beat + eighth harmonic), (2) phase = where the onsets of the last 3 s fall in the cursor's beat; nudged a third of the way.
   Without a clear beat (talk, held chords, rubato) it leaves the cursor running at the last tempo. Tuned offline on
   rehearsal takes (24.10.): within ~0.2 beat where the band plays a clear beat, but it can slip a beat in vague passages. */
function micFollow(t) {
  if (t - M.last < 0.5) return; M.last = t;
  const fr = M.sr / FHOP, N = Math.min(M.envN, Math.round(8 * fr));
  if (N < 3 * fr) return;
  const i0 = M.envN - N, e = new Float32Array(N), h = Math.round(0.2 * fr);
  for (let i = 0; i < N; i++) e[i] = M.env[(i0 + i) % RING];
  // detrend: minus the mean of the surrounding 0.4 s, negatives dropped
  const cs = new Float64Array(N + 1); for (let i = 0; i < N; i++) cs[i + 1] = cs[i] + e[i];
  let w = 0;
  const x = e.map((v, i) => { const a = Math.max(0, i - h), b = Math.min(N, i + h + 1), r = Math.max(0, v - (cs[b] - cs[a]) / (b - a)); w += r; return r; });
  if (w < 1e-6) return;
  // (1) tempo spectrum on a 0.25 bpm grid, by rotating phasors
  const lo = L.base / 1.1, hi = L.base * 1.1, sc = [];
  for (let b = lo; b <= hi; b += 0.25) {
    const f = b / 60 / fr, c1 = Math.cos(2 * Math.PI * f), s1 = Math.sin(2 * Math.PI * f), c2 = c1 * c1 - s1 * s1, s2 = 2 * s1 * c1;
    let ar = 1, ai = 0, br = 1, bi = 0, z1r = 0, z1i = 0, z2r = 0, z2i = 0;
    for (let i = 0; i < N; i++) {
      z1r += x[i] * ar; z1i += x[i] * ai; z2r += x[i] * br; z2i += x[i] * bi;
      const t1 = ar * c1 - ai * s1; ai = ar * s1 + ai * c1; ar = t1;
      const t2 = br * c2 - bi * s2; bi = br * s2 + bi * c2; br = t2;
    }
    sc.push([b, (Math.hypot(z1r, z1i) + 0.5 * Math.hypot(z2r, z2i)) / w]);
  }
  let j = 0; sc.forEach((v, i) => { if (v[1] > sc[j][1]) j = i; });
  const med = sc.map(v => v[1]).sort((a, b) => a - b)[sc.length >> 1], conf = sc[j][1] / med;
  M.dbg = { conf, bpmEst: sc[j][0] };
  if (conf > 2.5 && j > 0 && j < sc.length - 1) {
    // the first seconds after a start: the tapped tempo was a guess, so the cursor is re-derived from the start at the
    // measured tempo (otherwise it locks one beat off); after that the tempo only moves part of the way
    if (t - L.tS < 12) { L.bpm = sc[j][0]; L.p0 = advance(S.song, L.pS, (t - L.tS) * L.bpm / 60); }
    else { L.p0 = livePos(t); L.bpm += 0.4 * (sc[j][0] - L.bpm); }
    L.t0 = t; L.sched = null;
    $('#bpmNum').textContent = Math.round(L.bpm);
  }
  // (2) phase over the last 3 s, by the cursor's clock
  const s = S.song, k = Math.floor(L.p0), off = (L.p0 - k) * s._byN.get(s._exp[k])._beats, bps = L.bpm / 60;
  let zr = 0, zi = 0, ww = 0;
  for (let i = Math.max(0, N - Math.round(3 * fr)); i < N; i++) {
    if (!x[i]) continue;
    const ph = 2 * Math.PI * (off + (micT(i0 + i) - L.t0) * bps);
    zr += x[i] * Math.cos(ph); zi += x[i] * Math.sin(ph); ww += x[i];
  }
  const R = ww ? Math.hypot(zr, zi) / ww : 0, err = Math.atan2(zi, zr) / (2 * Math.PI);   // beats the cursor is ahead (−0.5…0.5)
  M.dbg.R = R; M.dbg.err = err;
  if (R > 0.1 && Math.abs(err) < 0.4) { L.t0 += 0.3 * err / bps; M.lock = t; }
  $('#bpmVal').classList.toggle('lock', t - M.lock < 1.5);
}
async function micToggle() {
  if (M.on) { micStop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Mikrofonen er ikke tilgjengelig her'); return; }
  M.on = true; $('#btnMic').classList.add('on');
  ac();
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) { }
  // created inside the tap so iOS lets it run
  try { M.ctx = new (window.AudioContext || window.webkitAudioContext)(); M.ctx.resume().catch(() => { }); } catch (e) { micStop(); return; }
  try {
    M.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) { micStop(); toast('Fikk ikke bruke mikrofonen: ' + (e.message || e.name), 4000); return; }
  if (!M.on) { micStop(); return; }
  M.sr = M.ctx.sampleRate; M.envN = 0; M.samples = 0; M.base = Infinity; M.last = 0; M.lock = 0; M.buf.fill(0); micBands();
  const src = M.ctx.createMediaStreamSource(M.stream), g = M.ctx.createGain();
  M.node = M.ctx.createScriptProcessor(1024, 1, 1); g.gain.value = 0;
  M.node.onaudioprocess = micProcess;
  src.connect(M.node); M.node.connect(g); g.connect(M.ctx.destination);
  toast('Mikrofonen følger tempoet – start med TAPP eller ▶ som vanlig', 3500);
}
function micStop() {
  const was = M.on || M.stream;
  if (M.stream) M.stream.getTracks().forEach(t => t.stop());
  if (M.node) M.node.onaudioprocess = null;
  if (M.ctx) M.ctx.close().catch(() => { });
  M.on = false; M.stream = M.node = M.ctx = null;
  $('#btnMic').classList.remove('on'); $('#bpmVal').classList.remove('lock');
  if (was) try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { }
}
$('#btnMic').onclick = micToggle;

/* swipe left/right on the focus view = next/previous chord */
(function () {
  let x0 = null, y0 = null;
  $('#focusPane').addEventListener('touchstart', e => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
  $('#focusPane').addEventListener('touchend', e => {
    if (x0 == null) return; const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0; x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 50) stepChord(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

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
  // pedal / keyboard: ← → chord by chord, ↑ ↓ PgUp PgDn line by line, T = tap tempo (live), space = play/stop
  if (e.key === 'ArrowRight') { e.preventDefault(); stepChord(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); stepChord(-1); }
  else if (e.key === 'PageDown' || e.key === 'ArrowDown') { e.preventDefault(); stepRow(1); }
  else if (e.key === 'PageUp' || e.key === 'ArrowUp') { e.preventDefault(); stepRow(-1); }
  else if ((e.key === 't' || e.key === 'T' || e.key === 'Enter') && L.on) { e.preventDefault(); liveTap(); }
  else if (e.key === ' ') { e.preventDefault(); $('#btnPlay').click(); }
});
function stepRow(d) {
  // pedal: move cursor by one system (line)
  const s = S.song, k = Math.floor(curExpPos() || 0), n = s._exp[k];
  if (S.mode === 'focus') { seekPos(s._lines[clamp(s._lineOf[k] + d, 0, s._lines.length - 1)].ks[0]); return; }
  const rows = chartRows(s); const ri = rows.findIndex(r => r.some(m => m.n === n));
  const target = rows[clamp(ri + d, 0, rows.length - 1)][0].n;
  const occ = occurrences(s, target); const nk = d > 0 ? (occ.find(x => x > k) ?? occ[0]) : ([...occ].reverse().find(x => x < k) ?? occ[0]);
  seekPos(nk);
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
      <div class="field" style="flex:1"><label>Del starter (Vers, Refreng …)</label><input type="text" id="eSec" list="secNames" value="${esc(m.sec || '')}">
        <datalist id="secNames">${['Intro', 'Vers', 'Pre-refreng', 'Refreng', 'Bro', 'Solo', 'Mellomspill', 'Outro', 'Coda'].map(x => `<option value="${x}">`).join('')}</datalist></div>
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
      m.mark = $('#eMk', body).value.trim() || undefined; m.sec = $('#eSec', body).value.trim() || undefined; m.text = $('#eTx', body).value.trim() || undefined;
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

/* ================= Øvingsnotater: notes on measure ranges (from the rehearsal agent, or written here) =================
   song.annotations: [{id, n0, n1, kind, text, who, date, occ, quote, clip (file id of the conductor's words), src: 'øving'|'mine', hidden}] */
const KINDS = {
  dynamikk: ['Dynamikk', '#f472b6', '<>'], intensitet: ['Intensitet', '#f87171', '▲'], tempo: ['Tempo', '#60a5fa', '♩'],
  artikulasjon: ['Artikulasjon', '#34d399', '>'], balanse: ['Balanse', '#fbbf24', '⇅'], form: ['Form', '#a78bfa', '↺'],
  innsats: ['Innsats', '#fb923c', '!'], generelt: ['Generelt', '#9ca3af', 'i'], mitt: ['Mitt notat', '#22d3ee', '✎'],
};
const kindOf = a => KINDS[a.kind] || KINDS.generelt;
const fmtDate = d => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d || ''); return m ? `${+m[3]}.${+m[2]}.` : (d || ''); };
const anRange = a => a.n1 != null && a.n1 !== a.n0 ? `t. ${a.n0}–${a.n1}` : `t. ${a.n0}`;
const anFind = id => ((S.song && S.song.annotations) || []).find(a => a.id === id);
/* notes in effect at expanded position k (a note can be for one pass only: occ = 1, 2 …) */
function anActive(s, k) {
  const n = s._exp[k], list = s._anIn.get(n); if (!list) return [];
  let oi = null;
  return list.filter(a => { if (!a.occ) return true; if (oi == null) oi = occurrences(s, n).indexOf(k); return oi === a.occ - 1; });
}
function anBadges(list) {
  if (!list || !list.length) return '';
  return `<span class="ans">${list.slice(0, 3).map(a => { const [, col, g] = kindOf(a); return `<button class="an" data-a="${esc(a.id)}" style="--ac:${col}" aria-label="${esc(kindOf(a)[0])}">${esc(g)}</button>`; }).join('')}</span>`;
}
function anLine(a, pre) {
  const [name, col, g] = kindOf(a), who = a.src === 'mine' ? 'Meg' : 'Dirigent';
  return `<div class="fan" data-a="${esc(a.id)}" style="--ac:${col}"><span class="ang">${esc(g)}</span>${esc(pre)}<b>${esc(a.text)}</b>
    <span class="anm">${esc(anRange(a))} · ${who}${a.date ? ' ' + esc(fmtDate(a.date)) : ''}${a.clip ? ' · ▶' : ''}${a.status === 'forslag' ? ' · forslag' : ''}</span></div>`;
}
function updateNotesBtn() {
  const s = S.song, n = s ? (s.annotations || []).filter(a => !a.hidden).length : 0;
  $('#notesCount').textContent = n ? n : '';
}
/* the conductor's words: a short clip played on its own player (pauses the backing track) */
const clipAudio = new Audio(); let clipUrl = null;
clipAudio.addEventListener('ended', () => $$('[data-clip].on').forEach(b => b.classList.remove('on')));
async function playClip(a, btn) {
  if (!a.clip) return;
  if (!clipAudio.paused && clipAudio.dataset.id === a.id) { clipAudio.pause(); if (btn) btn.classList.remove('on'); return; }
  const f = await DB.get('files', a.clip); if (!f) { toast('Fant ikke lydklippet'); return; }
  if (clipUrl) URL.revokeObjectURL(clipUrl);
  clipUrl = URL.createObjectURL(f.blob); clipAudio.src = clipUrl; clipAudio.dataset.id = a.id;
  if (!audio.paused) audio.pause();
  clipAudio.play().then(() => { if (btn) btn.classList.add('on'); }).catch(e => toast('Kan ikke spille: ' + e.message));
}
function showAnnotation(id) {
  const a = anFind(id); if (!a) return;
  const [name, col, g] = kindOf(a);
  modal(`${name} · ${anRange(a)}`, `
    <div class="anbox" style="--ac:${col}"><span class="ang big">${esc(g)}</span><div>
      <div class="antext">${esc(a.text)}</div>
      <div class="muted small">${a.src === 'mine' ? 'Mitt notat' : 'Dirigent'}${a.date ? ' · øving ' + esc(fmtDate(a.date)) : ''}${a.who ? ' · gjelder ' + esc(a.who) : ''}${a.occ ? ` · ${a.occ}. gang` : ''}</div>
      ${a.quote ? `<div class="anquote">«${esc(a.quote)}»</div>` : ''}</div></div>
    ${a.status === 'forslag' ? `<div class="anprop">Forslag fra øvingsagenten – hør klippet og sjekk teksten og taktene.
      <div class="row2" style="margin-top:8px"><button class="btn primary" id="aOk">✓ Godkjenn</button><button class="btn ghost" id="aNo">Avvis</button></div></div>` : ''}
    <div class="row2" style="margin-top:14px">
      ${a.clip ? '<button class="btn primary" id="aClip" data-clip>▶ Hør dirigenten</button>' : ''}
      <button class="btn" id="aGo">Gå til takt ${a.n0}</button>
      <div class="spacer"></div>
      <button class="btn ghost" id="aEdit">Rediger</button>
    </div>`, body => {
    if (a.clip) $('#aClip', body).onclick = e => playClip(a, e.currentTarget);
    $('#aGo', body).onclick = () => { closeModal(); gotoMeasure(a.n0, a.occ ? a.occ - 1 : null); };
    $('#aEdit', body).onclick = () => editAnnotation(a);
    if (a.status === 'forslag') {
      const done = async () => { a.edited = true; S.song.notesEdited = true; await saveSong(S.song); renderChart(); S.focusLi = null; S.lastMeasureKey = null; updateNow(true); updateNotesBtn(); };
      $('#aOk', body).onclick = async () => { delete a.status; await done(); closeModal(); toast('Godkjent ✓'); };
      $('#aNo', body).onclick = async () => { a.hidden = true; await done(); closeModal(); toast('Avvist'); };
    }
  });
}
$('#btnNotes').onclick = () => openNotes();
function openNotes() {
  const s = S.song; if (!s) return;
  const f = S.noteFilter || (S.noteFilter = { kind: null, date: null });
  const all = (s.annotations || []).filter(a => !a.hidden);
  const ord = a => { const m = s._byN.get(a.n0); return m ? m._i : 1e9; };
  const list = all.filter(a => (!f.kind || a.kind === f.kind) && (!f.date || (a.date || '') === f.date))
    .sort((a, b) => ord(a) - ord(b) || (a.date || '').localeCompare(b.date || ''));
  const kinds = [...new Set(all.map(a => a.kind in KINDS ? a.kind : 'generelt'))], dates = [...new Set(all.map(a => a.date).filter(Boolean))].sort().reverse();
  const chip = (k, v, label, col) => `<button class="chip${f[k] === v ? ' on' : ''}" data-f="${k}" data-v="${esc(v == null ? '' : v)}"${col ? ` style="--ac:${col}"` : ''}>${label}</button>`;
  const sums = (s.rehearsals || []).filter(r => r.summary && (!f.date || r.date === f.date));
  modal(`Øvingsnotater – ${s.title}`, `
    ${sums.map(r => `<div class="ansum"><b>Øving ${esc(fmtDate(r.date))}:</b> ${esc(r.summary)}</div>`).join('')}
    ${all.length ? `<div class="chips">${chip('kind', null, 'Alle')}${kinds.map(k => chip('kind', k, esc(KINDS[k][0]), KINDS[k][1])).join('')}
      ${dates.length > 1 ? '<span class="chipsep"></span>' + chip('date', null, 'Alle øvinger') + dates.map(d => chip('date', d, esc(fmtDate(d)))).join('') : ''}</div>` : ''}
    <div class="anlist">${list.map(a => { const [name, col, g] = kindOf(a); return `<div class="anrow" data-a="${esc(a.id)}" style="--ac:${col}">
      <span class="ang">${esc(g)}</span><span class="anr">${esc(anRange(a))}${a.occ ? `<small>${a.occ}. gang</small>` : ''}</span>
      <span class="ant"><b>${esc(a.text)}</b><small>${esc(name)} · ${a.src === 'mine' ? 'meg' : 'dirigent'}${a.date ? ' ' + esc(fmtDate(a.date)) : ''}${a.who ? ' · ' + esc(a.who) : ''}${a.status === 'forslag' ? ' · <i class="prop">forslag</i>' : ''}</small></span>
      ${a.clip ? '<button class="btn ghost" data-clip>▶</button>' : ''}<button class="btn ghost" data-edit>✎</button></div>`; }).join('')
      || `<div class="empty small">${all.length ? 'Ingen notater med dette filteret.' : 'Ingen notater for denne sangen ennå.<br>Notater fra øvingsopptak kommer med datafila; egne notater legger du til her.'}</div>`}</div>
    <div class="row2" style="margin-top:12px"><button class="btn primary" id="aNew">+ Nytt notat ved takt ${s._exp[Math.floor(curExpPos() || 0)]}</button></div>`, body => {
    $$('[data-f]', body).forEach(b => b.onclick = () => { f[b.dataset.f] = b.dataset.v || null; openNotes(); });
    $$('.anrow', body).forEach(row => row.onclick = e => {
      const a = anFind(row.dataset.a); if (!a) return;
      if (e.target.closest('[data-clip]')) { playClip(a, e.target.closest('[data-clip]')); return; }
      if (e.target.closest('[data-edit]')) { editAnnotation(a); return; }
      closeModal(); gotoMeasure(a.n0, a.occ ? a.occ - 1 : null);
    });
    $('#aNew', body).onclick = () => editAnnotation(null);
  });
}
function editAnnotation(a) {
  const s = S.song, isNew = !a, k = Math.floor(curExpPos() || 0);
  const n0 = a ? a.n0 : s._exp[k], occN = Math.max(1, occurrences(s, n0).length);
  const x = a || { n0, n1: n0, kind: 'mitt', text: '', who: '', occ: null };
  modal(isNew ? 'Nytt notat' : 'Rediger notat', `
    <div class="row2">
      <div class="field" style="flex:1"><label>Fra takt</label><input type="number" id="aN0" value="${x.n0}"></div>
      <div class="field" style="flex:1"><label>Til takt</label><input type="number" id="aN1" value="${x.n1 != null ? x.n1 : x.n0}"></div>
      <div class="field" style="flex:2"><label>Type</label><select id="aK">${Object.entries(KINDS).map(([k, [nm]]) => `<option value="${k}"${k === (x.kind in KINDS ? x.kind : 'generelt') ? ' selected' : ''}>${nm}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Notat</label><textarea id="aT" placeholder="F.eks. «Mer intensitet fra her, bygg mot refrenget»">${esc(x.text)}</textarea></div>
    <div class="row2">
      <div class="field" style="flex:2"><label>Gjelder hvem</label><input type="text" id="aW" value="${esc(x.who || '')}" placeholder="alle / komp / meg"></div>
      <div class="field" style="flex:1"><label>Hvilken gang</label><select id="aO"><option value="">Hver gang</option>${Array.from({ length: Math.max(occN, x.occ || 0) }, (_, i) => `<option value="${i + 1}"${x.occ === i + 1 ? ' selected' : ''}>${i + 1}. gang</option>`).join('')}</select></div>
    </div>
    <div class="row2">
      ${isNew ? '' : '<button class="btn danger" id="aDel">Slett</button>'}
      <div class="spacer"></div><button class="btn primary" id="aSave">Lagre</button>
    </div>`, body => {
    setTimeout(() => $('#aT', body).focus(), 50);
    const done = async () => { s.notesEdited = true; await saveSong(s); renderChart(); S.focusLi = null; S.lastMeasureKey = null; updateNow(true); updateNotesBtn(); };
    $('#aSave', body).onclick = async () => {
      const v = { n0: +$('#aN0', body).value, n1: +$('#aN1', body).value || +$('#aN0', body).value, kind: $('#aK', body).value, text: $('#aT', body).value.trim(), who: $('#aW', body).value.trim(), occ: +$('#aO', body).value || null };
      if (!s._byN.get(v.n0)) { toast(`Takt ${v.n0} finnes ikke`); return; }
      if (!s._byN.get(v.n1) || s._byN.get(v.n1)._i < s._byN.get(v.n0)._i) v.n1 = v.n0;
      if (!v.text) { toast('Skriv et notat'); return; }
      if (isNew) (s.annotations = s.annotations || []).push(Object.assign({ id: 'u-' + Date.now().toString(36), src: 'mine', date: new Date().toISOString().slice(0, 10) }, v));
      else { Object.assign(a, v, { edited: true }); delete a.status; }
      await done(); closeModal(); toast('Notat lagret ✓');
    };
    if (!isNew) $('#aDel', body).onclick = async () => {
      if (!confirm('Slette notatet?')) return;
      // notes from the data file are hidden (so a re-import does not bring them back); my own are removed
      if (a.src === 'mine') s.annotations = s.annotations.filter(y => y !== a); else a.hidden = true;
      await done(); closeModal();
    };
  });
}
/* keep my own notes and my changes to imported ones when a new data file arrives */
function mergeAnnotations(fresh, old) {
  const mine = (old || []).filter(a => a.src === 'mine'), changed = new Map((old || []).filter(a => a.src !== 'mine' && (a.edited || a.hidden)).map(a => [a.id, a]));
  return (fresh || []).map(a => changed.get(a.id) || a).concat(mine);
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
