(function(){
'use strict';
const C = window.FichCore;
const CDN = {
  fsrs: 'vendor/ts-fsrs.umd.js',
  jszip: 'vendor/jszip.min.js',
  fzstd: 'vendor/fzstd.js',
  sql: 'vendor/sql-asm.js'
};
const ROLLOVER_H = 4;
const LEARN_AHEAD = 20 * 60000;
const BUCKETS = 16;
const DAY = 86400000;
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const plainText = s => C.stripHtml(String(s || '').replace(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, '$1').replace(/<br\s*\/?>/gi, ' ')).replace(/\s+/g, ' ').trim();

// ---------- script loading ----------
const loaded = {};
function loadScript(url){
  if (loaded[url]) return loaded[url];
  loaded[url] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url; s.async = true;
    s.onload = () => res();
    s.onerror = () => { delete loaded[url]; rej(new Error('Não consegui baixar um componente do app. Confira a internet e tente de novo.')); };
    document.head.appendChild(s);
  });
  return loaded[url];
}

// ---------- saving files ----------
// Inside Claude the host saves text files; anywhere else (GitHub Pages, installed app) the browser does it.
// On a phone the share sheet is the way to put a file in Arquivos or hand it to Anki.
async function saveFile(filename, data, mime){
  if (typeof data === 'string' && window.claude && window.claude.use) {
    const dl = await window.claude.use('downloads').catch(() => null);
    if (dl) { await dl.save({ filename, data }); return; }
  }
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
  let file = null;
  try { file = new File([blob], filename, { type: blob.type }); } catch(e) {}
  const phone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.platform || ''));
  if (phone && file && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch(e) { if (e && e.name === 'AbortError') { const err = new Error('cancelado'); err.code = 'declined'; throw err; } }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.rel = 'noopener'; link.style.display = 'none';
  document.body.appendChild(link); link.click();
  setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, 15000);
}

// ---------- storage ----------
const Store = (function(){
  let db = null, mem = null;
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Transação cancelada')); });
  const KEY = { pkgs:'id', notes:'id', cards:'id', media:'key', revlog:'id', errors:'id' };
  async function open(){
    try {
      if (!window.indexedDB) throw new Error('sem IndexedDB');
      const r = indexedDB.open('fichario', 3);
      r.onupgradeneeded = () => {
        const d = r.result, has = n => d.objectStoreNames.contains(n);
        if (!has('pkgs')) d.createObjectStore('pkgs', { keyPath:'id' });
        if (!has('notes')) d.createObjectStore('notes', { keyPath:'id' }).createIndex('pkg', 'pkg');
        if (!has('cards')) d.createObjectStore('cards', { keyPath:'id' }).createIndex('pkg', 'pkg');
        if (!has('media')) d.createObjectStore('media', { keyPath:'key' }).createIndex('pkg', 'pkg');
        if (!has('states')) d.createObjectStore('states');
        if (!has('kv')) d.createObjectStore('kv');
        if (!has('revlog')) d.createObjectStore('revlog', { keyPath:'id' }).createIndex('pkg', 'pkg');
        if (!has('errors')) d.createObjectStore('errors', { keyPath:'id' });
      };
      db = await req(r);
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch(e){}
      return true;
    } catch(e) {
      mem = { pkgs:new Map(), notes:new Map(), cards:new Map(), media:new Map(), states:new Map(), kv:new Map(), revlog:new Map(), errors:new Map() };
      return false;
    }
  }
  async function getAll(store){ if (mem) return [...mem[store].values()]; return req(db.transaction(store).objectStore(store).getAll()); }
  async function get(store, key){ if (mem) return mem[store].get(key); return req(db.transaction(store).objectStore(store).get(key)); }
  async function getByIndex(store, pkg){
    if (mem) return [...mem[store].values()].filter(v => v.pkg === pkg);
    return req(db.transaction(store).objectStore(store).index('pkg').getAll(IDBKeyRange.only(pkg)));
  }
  async function putMany(store, recs){
    if (!recs.length) return;
    if (mem) { for (const r of recs) mem[store].set(r[KEY[store]], r); return; }
    const t = db.transaction(store, 'readwrite'); const os = t.objectStore(store);
    for (const r of recs) os.put(r);
    return done(t);
  }
  async function deleteMany(store, keys){
    if (!keys.length) return;
    if (mem) { for (const k of keys) mem[store].delete(k); return; }
    const t = db.transaction(store, 'readwrite'); const os = t.objectStore(store);
    for (const k of keys) os.delete(k);
    return done(t);
  }
  async function allStates(){
    const out = new Map();
    if (mem) { for (const [k,v] of mem.states) out.set(k, v); return out; }
    const os = db.transaction('states').objectStore('states');
    const [keys, vals] = await Promise.all([req(os.getAllKeys()), req(os.getAll())]);
    keys.forEach((k, i) => out.set(k, vals[i]));
    return out;
  }
  async function putStates(entries){
    if (!entries.length) return;
    if (mem) { for (const [k,v] of entries) mem.states.set(k, v); return; }
    const t = db.transaction('states', 'readwrite'); const os = t.objectStore('states');
    for (const [k,v] of entries) os.put(v, k);
    return done(t);
  }
  async function delState(k){ if (mem) { mem.states.delete(k); return; } const t = db.transaction('states', 'readwrite'); t.objectStore('states').delete(k); return done(t); }
  async function kvGet(k){ return get('kv', k); }
  async function kvSet(k, v){ if (mem) { mem.kv.set(k, v); return; } const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); return done(t); }
  function wipe(t, store, pkg, keepLocal){
    return new Promise((res, rej) => {
      const r = t.objectStore(store).index('pkg').openCursor(IDBKeyRange.only(pkg));
      r.onsuccess = () => { const c = r.result; if (!c) return res(); if (!(keepLocal && c.value && c.value.local)) c.delete(); c.continue(); };
      r.onerror = () => rej(r.error);
    });
  }
  async function removePkg(pkg){
    if (mem) { mem.pkgs.delete(pkg); for (const s of ['notes','cards','media','revlog']) for (const [k,v] of mem[s]) if (v.pkg === pkg) mem[s].delete(k); return; }
    const t = db.transaction(['pkgs','notes','cards','media','revlog'], 'readwrite');
    t.objectStore('pkgs').delete(pkg);
    await Promise.all(['notes','cards','media','revlog'].map(s => wipe(t, s, pkg, false)));
    return done(t);
  }
  async function importPkg(pkg, notes, cards, media){
    if (mem) {
      for (const s of ['notes','cards','media']) for (const [k,v] of mem[s]) if (v.pkg === pkg.id && !v.local) mem[s].delete(k);
      mem.pkgs.set(pkg.id, pkg);
      for (const n of notes) mem.notes.set(n.id, n);
      for (const c of cards) mem.cards.set(c.id, c);
      for (const m of media) mem.media.set(m.key, m);
      return;
    }
    const t = db.transaction(['pkgs','notes','cards','media'], 'readwrite');
    await Promise.all(['notes','cards','media'].map(s => wipe(t, s, pkg.id, true)));
    t.objectStore('pkgs').put(pkg);
    const ns = t.objectStore('notes'), cs = t.objectStore('cards'), ms = t.objectStore('media');
    for (const n of notes) ns.put(n);
    for (const c of cards) cs.put(c);
    for (const m of media) ms.put(m);
    return done(t);
  }
  return { open, getAll, get, getByIndex, putMany, deleteMany, allStates, putStates, delState, kvGet, kvSet, importPkg, removePkg, isMemory: () => !!mem };
})();

// ---------- app state ----------
const A = {
  pkgs: new Map(), cards: new Map(), states: new Map(), errors: new Map(), syncU: new Map(), expanded: {},
  prefs: { retention: 0.9, newPerDay: 20, colors: null, u: 0 },
  daily: { day: '', n: {} },
  stats: {},
  fsrs: null, view: 'home', noteCache: new Map()
};
const dayKey = t => C.dayKeyOf(t || Date.now());
function dayStart(t){ const d = new Date((t || Date.now()) - ROLLOVER_H * 3600e3); d.setHours(0,0,0,0); return d.getTime() + ROLLOVER_H * 3600e3; }
const nextCutoff = t => dayStart(t) + DAY;
function newDone(pkg){ return A.daily.day === dayKey() ? (A.daily.n[pkg] || 0) : 0; }
function bumpNew(pkg, delta){
  const k = dayKey();
  if (A.daily.day !== k) A.daily = { day: k, n: {} };
  A.daily.n[pkg] = Math.max(0, (A.daily.n[pkg] || 0) + delta);
  A.prefs.u = Date.now();
  Store.kvSet('daily', A.daily).catch(()=>{});
  Store.kvSet('prefs', A.prefs).catch(()=>{});
  R.prefsDirty = true; scheduleSync();
}
function makeFsrs(){
  const F = window.FSRS; if (!F) return null;
  A.fsrs = F.fsrs(F.generatorParameters({
    request_retention: A.prefs.retention, maximum_interval: 36500, enable_fuzz: true, enable_short_term: true,
    learning_steps: ['1m','10m'], relearning_steps: ['10m']
  }));
  return A.fsrs;
}
function hashStr(s){ let h = 2166136261; for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const bucketOf = cid => hashStr(String(cid)) % BUCKETS;
function randGuid(){ const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~'; let s = ''; const r = crypto.getRandomValues(new Uint8Array(10)); for (const x of r) s += a[x % a.length]; return s; }

// ---------- caderno de erros: constants ----------
const AREAS = [['CM','Clínica Médica','Clínica'],['CIR','Cirurgia','Cirurgia'],['GO','Ginecologia e Obstetrícia','GO'],['PED','Pediatria','Pediatria'],['PREV','Medicina Preventiva','Preventiva']];
const areaName = k => (AREAS.find(a => a[0] === k) || [k, k || 'Sem área'])[1];
const areaShort = k => (AREAS.find(a => a[0] === k) || [k, '', k || 'Sem área'])[2];
function areaFromText(t){ const n = norm(t || ''); if (!n) return ''; const a = AREAS.find(x => norm(x[1]) === n || norm(x[2]) === n || norm(x[0]) === n) || AREAS.find(x => n.includes(norm(x[2])) || norm(x[1]).includes(n)); return a ? a[0] : ''; }
const MOTIVOS = { conteudo:'Conteúdo', raciocinio:'Raciocínio', leitura:'Leitura', acertei:'Acertei com dúvida' };
const PADROES = [['comando','Comando invertido (exceto, incorreta)'],['dado','Dado do enunciado ignorado'],['pressa','Li rápido e assumi o caso'],['marcacao','Marquei ou troquei a alternativa'],['outro','Outro']];
const padraoName = k => (PADROES.find(p => p[0] === k) || [k, 'Sem tipo'])[1];
const DEFAULT_COLOR_MEANINGS = { '#D0312D':'alerta, contraindicação', '#1F5FBF':'diagnóstico, conceito-chave', '#23843F':'conduta, tratamento', '#D9730D':'números, doses, critérios', '#7B3FB6':'pegadinha de prova' };
function colorMeaning(c){ const m = A.prefs.colors && A.prefs.colors[c]; return (m && String(m).trim()) || DEFAULT_COLOR_MEANINGS[c] || ''; }
const ERR_BUCKETS = 8;
const errBucket = id => hashStr(String(id)) % ERR_BUCKETS;
const newErrId = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmtDate = t => { const d = new Date(t); return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getFullYear()).slice(2); };
function liveErrors(){ return [...A.errors.values()].filter(e => !e.del).sort((a, b) => b.t - a.t); }
function saveError(rec){
  rec.u = Date.now();
  A.errors.set(rec.id, rec);
  Store.putMany('errors', [rec]).catch(() => toast('Não consegui salvar o registro neste aparelho.'));
  R.errDirty.add(errBucket(rec.id)); scheduleSync();
  return rec;
}
const ERR_TEXT = ['q', 'a', 'why'];
function trimErr(e){
  const o = { id:e.id, t:e.t, u:e.u, area:e.area || '', tema:e.tema || '', fonte:e.fonte || '', motivo:e.motivo || '', padrao:e.padrao || '', nota:(e.nota || '').slice(0, 240), pkg:e.pkg || '', cards:e.cards || [], del:!!e.del };
  o.q = (e.q || '').slice(0, 280); o.a = (e.a || '').slice(0, 200); o.why = (e.why || '').slice(0, 200);
  return o;
}
function mergeRemoteErrors(c, changed){
  for (const id in c) {
    const r = c[id]; const l = A.errors.get(id);
    if (l && (r.u || 0) <= (l.u || 0)) continue;
    let m;
    if (l) { m = Object.assign({}, l); for (const k in r) if (!ERR_TEXT.includes(k) || !l[k]) m[k] = r[k]; }
    else m = Object.assign({}, r, { trim:true });
    A.errors.set(id, m); changed.push(m);
  }
}

// ---------- baralho do zero ----------
const NT_BASE_CSS = '.card {\n  font-family: arial;\n  font-size: 20px;\n  text-align: center;\n  color: black;\n  background-color: white;\n}\n';
function scratchNotetypes(){
  return {
    fc: { name: 'Omissão de Palavras', kind: 1, css: NT_BASE_CSS + '\n.cloze {\n  font-weight: bold;\n  color: blue;\n}\n', flds: ['Texto', 'Verso Extra'], tmpls: [{ name: 'Omissão de Palavras', q: '{{cloze:Texto}}', a: '{{cloze:Texto}}<br>\n{{Verso Extra}}' }], scratch: true },
    fb: { name: 'Básico', kind: 0, css: NT_BASE_CSS, flds: ['Frente', 'Verso'], tmpls: [{ name: 'Cartão 1', q: '{{Frente}}', a: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Verso}}' }], scratch: true }
  };
}
async function createScratchPkg(name, opts){
  opts = opts || {};
  const id = 'p' + hashStr(name).toString(36);
  if (A.pkgs.has(id)) return { id, existed: true };
  const now = opts.createdAt || Date.now();
  const pkg = { id, name, notetypes: opts.notetypes || scratchNotetypes(), decks: {}, customDecks: {}, importedAt: now, createdAt: now, count: 0, hist: {}, ntUse: {}, pending: 0, scratch: true };
  if (!opts.remote) { const did = customDid(id, [name]); pkg.decks[did] = [name]; pkg.customDecks[did] = { path: [name], u: now }; }
  A.pkgs.set(id, pkg);
  await Store.putMany('pkgs', [pkg]);
  if (!opts.remote) { R.pkgsDirty = true; R.decksDirty = true; scheduleSync(); }
  return { id, existed: false };
}
function openScratchCreate(){
  $('fsHead').textContent = 'Novo baralho';
  $('fsBody').innerHTML =
    '<label for="scName" style="font-weight:700">Nome do baralho</label><input class="inp" id="scName" value="MEDPRO" autocomplete="off">' +
    '<p class="note" style="margin-top:6px">Use o mesmo nome do baralho no Anki do computador. Se um dia você importar esse .apkg, os dois se juntam e nada criado aqui se perde.</p>' +
    '<div class="stack"><button class="primary" id="scGo">Criar baralho</button><button class="textbtn" id="scCancel" style="justify-self:center">Cancelar</button></div>';
  $('fsheet').hidden = false;
  $('scCancel').addEventListener('click', closeFolderSheet);
  const go_ = async () => {
    const name = $('scName').value.trim().replace(/\s*::\s*/g, ' ').replace(/\s+/g, ' ');
    if (!name) { toast('Dê um nome para o baralho.'); return; }
    const r = await createScratchPkg(name);
    closeFolderSheet();
    toast(r.existed ? 'Esse baralho já existe aqui.' : 'Baralho criado. Agora crie as pastas e os cards.');
    go('deck', { pkg: r.id }, { reset:true }); NAV.unshift({ name: 'home', params: {} });
  };
  $('scGo').addEventListener('click', go_);
  $('scName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go_(); } });
  setTimeout(() => { const i = $('scName'); if (i) { i.focus(); i.select(); } }, 50);
}
$('scratchBtn').addEventListener('click', openScratchCreate);
$('scratchBtn2').addEventListener('click', openScratchCreate);
function mergeRemotePkgs(rp){
  const created = [];
  for (const id in rp) {
    const r = rp[id]; if (!r || r.del) continue;
    const p = A.pkgs.get(id);
    if (!p) { created.push(createScratchPkg(r.name, { remote: true, notetypes: r.notetypes, createdAt: r.createdAt })); continue; }
    let ch = false;
    for (const mid in (r.notetypes || {})) if (!p.notetypes[mid]) { p.notetypes[mid] = r.notetypes[mid]; ch = true; }
    if (ch) Store.putMany('pkgs', [p]).catch(()=>{});
  }
  for (const [id, p] of A.pkgs) { const mine = Object.entries(p.notetypes).filter(([, nt]) => nt.scratch); if (mine.length && !rp[id]) R.pkgsDirty = true; }
  return Promise.all(created).then(x => x.length);
}
async function pullPkgs(){
  if (!R.db) return 0;
  const snap = await R.db.doc('data/users/' + R.uid + '/pkgs').get();
  return mergeRemotePkgs(snap.exists ? ((snap.data() || {}).p || {}) : {});
}

// ---------- pastas (decks criados no app) ----------
function cmpPath(a, b){ for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = a[i].localeCompare(b[i], 'pt-BR', { sensitivity:'base', numeric:true }); if (c) return c; } return a.length - b.length; }
const customDid = (pkg, path) => 'c' + hashStr(pkg + '\x1f' + path.join('\x1f')).toString(36);
function deckIdByPath(pkg, path){ const k = path.join('::'); const o = deckOptions(pkg).find(x => x.path === k); return o ? o.id : null; }
async function ensureDeck(pkg, path){
  const p = A.pkgs.get(pkg); const now = Date.now();
  p.customDecks = p.customDecks || {};
  let did = null, created = 0;
  for (let i = 1; i <= path.length; i++) {
    const sub = path.slice(0, i);
    did = deckIdByPath(pkg, sub);
    if (!did) { did = customDid(pkg, sub); p.decks[did] = sub; p.customDecks[did] = { path: sub, u: now }; created++; }
  }
  if (created) { await Store.putMany('pkgs', [p]); R.decksDirty = true; scheduleSync(); }
  return { did, created };
}
function folderHasCards(pkg, path){ const k = path.join('::'); return pkgCards(pkg).some(c => { const ps = deckPathStr(pkg, c.did); return ps === k || ps.startsWith(k + '::'); }); }
async function deleteFolder(pkg, path){
  const p = A.pkgs.get(pkg); const k = path.join('::'); const now = Date.now();
  for (const did of Object.keys(p.customDecks || {})) {
    const d = p.customDecks[did]; if (d.del || d.anki) continue;
    const ps = d.path.join('::');
    if (ps === k || ps.startsWith(k + '::')) { p.customDecks[did] = { path: d.path, u: now, del: true }; delete p.decks[did]; }
  }
  await Store.putMany('pkgs', [p]); R.decksDirty = true; scheduleSync();
}
function isCustomFolder(pkg, path){ const p = A.pkgs.get(pkg); const k = path.join('::'); const ids = Object.entries(p.decks).filter(([, ps]) => ps.join('::') === k).map(([id]) => id); return ids.length > 0 && ids.every(id => p.customDecks && p.customDecks[id] && !p.customDecks[id].del && !p.customDecks[id].anki); }
function expandedSet(pkg, tree){ if (!A.expanded[pkg]) A.expanded[pkg] = new Set((tree || deckTree(pkg)).filter(n => n.path.length === 1).map(n => n.path.join('\x1f'))); return A.expanded[pkg]; }
function saveExpanded(pkg, set){ A.expanded[pkg] = set; Store.kvSet('expanded', Object.fromEntries(Object.entries(A.expanded).map(([k, v]) => [k, [...v]]))).catch(()=>{}); }
function revealDeck(pkg, did){ const path = A.pkgs.get(pkg).decks[did]; if (!path) return; const ex = expandedSet(pkg); for (let i = 1; i < path.length; i++) ex.add(path.slice(0, i).join('\x1f')); saveExpanded(pkg, ex); }
const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
function drawTree(pkg, tree){
  $('subtree').hidden = !tree.length; $('deckLegend').hidden = !tree.length;
  const keys = tree.map(n => n.path.join('\x1f'));
  const ex = expandedSet(pkg, tree);
  const hasKids = i => keys.some(k => k.startsWith(keys[i] + '\x1f'));
  let html = '';
  tree.forEach((n, i) => {
    for (let d = 1; d < n.path.length; d++) { const k = n.path.slice(0, d).join('\x1f'); if (keys.includes(k) && !ex.has(k)) return; }
    const depth = n.path.length - 1, kids = hasKids(i), open = ex.has(keys[i]);
    html += '<li><div class="trow" style="padding-left:' + (4 + depth * 16) + 'px">' +
      '<button class="tog' + (kids ? '' : ' leaf') + '" data-tog="' + i + '" aria-expanded="' + open + '" aria-label="' + (open ? 'Fechar ' : 'Abrir ') + esc(n.path[depth]) + '"' + (kids ? '' : ' tabindex="-1"') + '>' + CHEV + '</button>' +
      '<button class="deckrow" data-i="' + i + '"><span class="nm"><b>' + esc(n.path[depth]) + '</b>' + (n.total ? '' : '<span class="empty-folder">pasta vazia</span>') + '</span><span class="counts">' + (n.total ? countsHtml(n) : '') + '</span></button>' +
      '<button class="more" data-more="' + i + '" aria-label="Opções de ' + esc(n.path[depth]) + '">⋯</button></div></li>';
  });
  $('subtree').innerHTML = html;
  $('subtree')._tree = tree;
}
const FOLDER_SUGG = {
  '': ['Clínica Médica', 'Cirurgia', 'Ginecologia e Obstetrícia', 'Pediatria', 'Medicina Preventiva'],
  'clinica medica': ['Cardiologia', 'Pneumologia', 'Gastroenterologia', 'Hepatologia', 'Nefrologia', 'Endocrinologia', 'Hematologia', 'Infectologia', 'Reumatologia', 'Neurologia'],
  'cirurgia': ['Cirurgia geral', 'Trauma', 'Cirurgia vascular', 'Urologia', 'Coloproctologia', 'Cirurgia torácica'],
  'ginecologia e obstetricia': ['Ginecologia', 'Obstetrícia', 'Mastologia'],
  'pediatria': ['Neonatologia', 'Puericultura', 'Infectologia pediátrica', 'Emergências pediátricas'],
  'medicina preventiva': ['Epidemiologia', 'Bioestatística', 'SUS e políticas de saúde', 'Ética médica', 'Saúde do trabalhador'],
  'cardiologia': ['Insuficiência cardíaca', 'Síndrome coronariana aguda', 'Arritmias', 'Hipertensão arterial', 'Valvopatias', 'Endocardite']
};
function suggestionsFor(pkg, parent){
  const p = A.pkgs.get(pkg);
  const last = parent.length ? norm(parent[parent.length - 1]) : '';
  const list = FOLDER_SUGG[parent.length <= 1 ? (parent.length === 1 && FOLDER_SUGG[last] ? last : '') : last] || [];
  const taken = new Set(Object.values(p.decks).filter(ps => ps.length === parent.length + 1 && ps.slice(0, parent.length).join('::') === parent.join('::')).map(ps => norm(ps[parent.length])));
  return list.filter(x => !taken.has(norm(x)));
}
function ensureAnkiPaths(p){
  if (p.ankiPaths) return;
  p.ankiPaths = {};
  for (const did in p.decks) { const cd = p.customDecks && p.customDecks[did]; if (!cd || cd.anki) p.ankiPaths[did] = (cd && cd.anki && cd.from ? cd.from : p.decks[did]).slice(); }
}
function pendingMoves(p){
  return Object.entries(p.customDecks || {}).filter(([did, cd]) => cd.anki && !cd.del && p.ankiPaths && p.ankiPaths[did] && p.ankiPaths[did].join('::') !== cd.path.join('::'))
    .map(([did, cd]) => ({ did, from: p.ankiPaths[did].join('::'), to: cd.path.join('::') }));
}
function allFolderPaths(pkg){
  const p = A.pkgs.get(pkg); const seen = new Map();
  for (const path of Object.values(p.decks)) for (let i = 1; i <= path.length; i++) { const sub = path.slice(0, i); seen.set(sub.join('::'), sub); }
  return [...seen.values()].sort(cmpPath);
}
async function moveFolder(pkg, oldPath, newPath){
  const p = A.pkgs.get(pkg);
  const ok = oldPath.join('::'), nk = newPath.join('::');
  if (ok === nk) return 'same';
  if (nk.startsWith(ok + '::')) return 'inside';
  if (allFolderPaths(pkg).some(x => x.join('::') === nk)) return 'exists';
  ensureAnkiPaths(p);
  p.customDecks = p.customDecks || {};
  const now = Date.now();
  for (const did of Object.keys(p.decks)) {
    const path = p.decks[did]; const ps = path.join('::');
    if (ps !== ok && !ps.startsWith(ok + '::')) continue;
    const np = newPath.concat(path.slice(oldPath.length));
    p.decks[did] = np;
    const cd = p.customDecks[did];
    p.customDecks[did] = cd && !cd.anki ? { path: np, u: now } : { path: np, u: now, anki: true };
  }
  await Store.putMany('pkgs', [p]);
  if (newPath.length > 1) await ensureDeck(pkg, newPath.slice(0, -1));
  R.decksDirty = true; scheduleSync();
  for (const n of await Store.getByIndex('notes', pkg)) if (syncable(n)) markNote(n);
  return 'ok';
}
function openFolderMove(pkg, path){
  const options = allFolderPaths(pkg).filter(x => { const k = x.join('::'); return k !== path.join('::') && !k.startsWith(path.join('::') + '::'); });
  const cur = path.slice(0, -1).join('::');
  $('fsHead').textContent = 'Mover ou renomear';
  $('fsBody').innerHTML =
    '<p class="note" style="margin:0 0 12px">' + esc(path.join(' › ')) + '</p>' +
    '<label for="fmParent" style="font-weight:700">Dentro de</label><select class="inp" id="fmParent">' +
      options.map((o, i) => '<option value="' + i + '"' + (o.join('::') === cur ? ' selected' : '') + '>' + esc('\u2003'.repeat(o.length - 1) + o[o.length - 1]) + '</option>').join('') + '</select>' +
    '<label for="fmName" style="display:block;font-weight:700;margin-top:14px">Nome</label><input class="inp" id="fmName" value="' + esc(path[path.length - 1]) + '" autocomplete="off">' +
    '<p class="note" style="margin-top:6px">Para criar níveis novos no caminho, use /. Ex.: Ginecologia e Obstetrícia / Ginecologia / Vulvovaginites</p>' +
    '<p class="note" style="margin-top:6px">Subpastas e cards vão junto. No Anki do computador, a mudança entra pelo botão "Exportar progresso e pastas" do deck.</p>' +
    '<div class="stack"><button class="primary" id="fmGo">Mover</button><button class="textbtn" id="fmCancel" style="justify-self:center">Cancelar</button></div>';
  $('fsheet').hidden = false;
  $('fmCancel').addEventListener('click', closeFolderSheet);
  $('fmGo').addEventListener('click', async () => {
    const parts = $('fmName').value.split(/\s*(?:\/|::)\s*/).map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
    if (!parts.length) { toast('Dê um nome para a pasta.'); return; }
    const dest = options[Number($('fmParent').value)] || [];
    const np = dest.concat(parts);
    const r = await moveFolder(pkg, path, np);
    if (r === 'exists') { toast('Já existe uma pasta com esse nome nesse lugar.'); return; }
    if (r === 'inside') { toast('Uma pasta não pode ir para dentro dela mesma.'); return; }
    closeFolderSheet();
    if (r === 'ok') { revealDeck(pkg, deckIdByPath(pkg, np)); toast('Pasta agora em: ' + np.join(' › ')); }
    RENDER.deck({ pkg, back:true });
  });
}
function closeFolderSheet(){ $('fsheet').hidden = true; $('fsBody').innerHTML = ''; }
$('fsheet').addEventListener('click', e => { if (e.target === $('fsheet')) closeFolderSheet(); });
function openFolderActions(pkg, node){
  const path = node.path; const did = deckIdByPath(pkg, path);
  const k = countsFor(pkgCards(pkg).filter(c => { const ps = deckPathStr(pkg, c.did); return ps === path.join('::') || ps.startsWith(path.join('::') + '::'); }), pkg);
  const due = k.n + k.l + k.r;
  const canDel = isCustomFolder(pkg, path) && !folderHasCards(pkg, path);
  $('fsHead').textContent = 'Pasta';
  $('fsBody').innerHTML = '<h3 style="margin:0 0 4px">' + esc(path[path.length - 1]) + '</h3><p class="note" style="margin:0 0 14px">' + esc(path.join(' › ')) + '</p><div class="stack" style="margin-top:0">' +
    (node.total ? '<button class="primary" data-fa="study"' + (due ? '' : ' disabled') + '>' + (due ? 'Estudar esta pasta' : 'Nada para hoje nesta pasta') + '</button>' : '') +
    '<button class="secondary" data-fa="sub">Nova subpasta</button>' +
    '<div class="row2"><button class="secondary" data-fa="card">Novo card aqui</button><button class="secondary" data-fa="lesson">Cards de uma aula aqui</button></div>' +
    (path.length > 1 ? '<button class="secondary" data-fa="move">Mover ou renomear</button>' : '') +
    (canDel ? '<button class="danger" data-fa="del">Apagar pasta</button>' : '') +
    '<button class="textbtn" data-fa="close" style="justify-self:center">Cancelar</button></div>';
  $('fsheet').hidden = false;
  $('fsBody').querySelectorAll('[data-fa]').forEach(b => b.addEventListener('click', async () => {
    const a = b.dataset.fa;
    if (a === 'close') return closeFolderSheet();
    if (a === 'study') { closeFolderSheet(); return startStudy({ pkg, path }); }
    if (a === 'sub') return openFolderCreate(pkg, path, nd => { revealDeck(pkg, nd); RENDER.deck({ pkg, back:true }); });
    if (a === 'card') { closeFolderSheet(); NC[pkg] = Object.assign({}, NC[pkg] || {}, { did }); return go('newcard', { pkg }); }
    if (a === 'lesson') { closeFolderSheet(); LS[pkg] = did; return go('lesson', { pkg }); }
    if (a === 'move') return openFolderMove(pkg, path);
    if (a === 'del') {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Toque de novo para apagar'; return; }
      await deleteFolder(pkg, path); closeFolderSheet(); toast('Pasta apagada.'); RENDER.deck({ pkg, back:true });
    }
  }));
}
function openFolderCreate(pkg, parent, onCreated, trail){
  let par = parent.slice();
  const tr = (trail && trail.length >= par.length ? trail : par).slice();
  $('fsHead').textContent = 'Nova pasta';
  const draw = () => {
    const sugg = suggestionsFor(pkg, par);
    $('fsBody').innerHTML =
      '<div class="lbl" style="font-weight:700">Dentro de</div><div class="crumbs">' +
        '<button class="chip" data-lv="0" aria-pressed="' + (par.length === 0) + '">Início</button>' +
        tr.map((x, i) => '<span>›</span><button class="chip" data-lv="' + (i + 1) + '" aria-pressed="' + (i === par.length - 1) + '">' + esc(x) + '</button>').join('') + '</div>' +
      '<label for="fsName" style="font-weight:700">Nome</label>' +
      '<input class="inp" id="fsName" placeholder="Ex.: Insuficiência cardíaca" autocomplete="off">' +
      '<p class="note" style="margin-top:6px">Para criar mais de um nível de uma vez, separe com /. Ex.: Cardiologia / Insuficiência cardíaca</p>' +
      (sugg.length ? '<div class="chips" id="fsSugg">' + sugg.map(x => '<button class="chip" data-sg="' + esc(x) + '">' + esc(x) + '</button>').join('') + '</div>' : '') +
      '<div class="stack"><button class="primary" id="fsCreate">Criar pasta</button><button class="textbtn" id="fsCancel" style="justify-self:center">Cancelar</button></div>';
    $('fsBody').querySelectorAll('[data-lv]').forEach(b => b.addEventListener('click', () => { const v = $('fsName').value; par = tr.slice(0, Number(b.dataset.lv)); draw(); $('fsName').value = v; }));
    $('fsBody').querySelectorAll('[data-sg]').forEach(b => b.addEventListener('click', () => { $('fsName').value = b.dataset.sg; $('fsName').focus(); }));
    $('fsCancel').addEventListener('click', closeFolderSheet);
    const create = async () => {
      const parts = $('fsName').value.split(/\s*(?:\/|::)\s*/).map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
      if (!parts.length) { toast('Dê um nome para a pasta.'); $('fsName').focus(); return; }
      const full = par.concat(parts);
      const existed = deckIdByPath(pkg, full);
      const { did } = await ensureDeck(pkg, full);
      closeFolderSheet();
      toast(existed ? 'Essa pasta já existia: ' + full.join(' › ') : 'Pasta criada: ' + full.join(' › '));
      onCreated && onCreated(did);
    };
    $('fsCreate').addEventListener('click', create);
    $('fsName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  };
  draw();
  $('fsheet').hidden = false;
  setTimeout(() => { const i = $('fsName'); if (i) i.focus(); }, 50);
}
function deckSelectHtml(pkg, cur){ return deckOptions(pkg).map(o => '<option value="' + esc(o.id) + '"' + (o.id === cur ? ' selected' : '') + '>' + esc(o.path) + '</option>').join('') + '<option value="__new">+ Nova pasta…</option>'; }
function wireDeckSelect(sel, pkg){
  if (!sel || sel._wired) return; sel._wired = true;
  if (![...sel.options].some(o => o.value === '__new')) sel.insertAdjacentHTML('beforeend', '<option value="__new">+ Nova pasta…</option>');
  sel._prev = sel.value;
  sel.addEventListener('change', () => {
    if (sel.value !== '__new') { sel._prev = sel.value; return; }
    sel.value = sel._prev;
    const base = A.pkgs.get(pkg).decks[sel._prev] || [];
    openFolderCreate(pkg, base.length > 1 ? base.slice(0, -1) : base, did => { revealDeck(pkg, did); sel.innerHTML = deckSelectHtml(pkg, did); sel.value = did; sel.dispatchEvent(new Event('change')); }, base);
  });
}
function mergeRemoteDecks(rp){
  const changed = new Set();
  for (const [pid, p] of A.pkgs) {
    const r = rp[pid] || {}; p.customDecks = p.customDecks || {};
    for (const did in r) {
      const rd = r[did], ld = p.customDecks[did];
      if (ld && (rd.u || 0) <= (ld.u || 0)) continue;
      if (rd.anki) { ensureAnkiPaths(p); if (!p.decks[did]) continue; }
      p.customDecks[did] = rd;
      if (rd.del) { if (!pkgCards(pid).some(c => c.did === did)) delete p.decks[did]; }
      else p.decks[did] = rd.path.slice();
      changed.add(pid);
    }
    for (const did in p.customDecks) if (!r[did] || (p.customDecks[did].u || 0) > (r[did].u || 0)) R.decksDirty = true;
  }
  return changed;
}
async function pullDecks(){
  if (!R.db) return 0;
  const snap = await R.db.doc('data/users/' + R.uid + '/decks').get();
  const changed = mergeRemoteDecks(snap.exists ? ((snap.data() || {}).p || {}) : {});
  if (changed.size) await Store.putMany('pkgs', [...changed].map(id => A.pkgs.get(id)));
  return changed.size;
}

// ---------- note sync (cards created or edited on any device) ----------
const NOTE_BUCKETS = 16;
const noteBucket = id => hashStr('n' + id) % NOTE_BUCKETS;
const syncable = n => !!(n && (n.local || n.dirty || n.exportedAt));
const noteU = n => Math.max(n.mt || 0, n.exportedAt || 0);
let syncUTimer = null;
function saveSyncU(){ clearTimeout(syncUTimer); syncUTimer = setTimeout(() => Store.kvSet('syncU', [...A.syncU.entries()]).catch(()=>{}), 300); }
function markNote(n){
  if (!syncable(n)) return;
  A.syncU.set(n.id, { u: noteU(n), pkg: n.pkg });
  saveSyncU();
  R.noteDirty.add(noteBucket(n.id)); scheduleSync();
}
function localImgNames(n){ const out = new Set(); for (const f of n.flds || []) for (const m of String(f).matchAll(/src="([^"]+)"/g)) out.add(m[1]); return [...out]; }
async function noteRecord(n, cardsByNid){
  if (R.assets) {
    let changed = false;
    for (const name of localImgNames(n)) {
      if (n.assets && n.assets[name]) continue;
      const m = await Store.get('media', n.pkg + '/' + name);
      if (!m || !m.local || !m.blob) continue;
      try { const up = await R.assets.upload(m.blob); n.assets = Object.assign({}, n.assets || {}, { [name]: up.id }); changed = true; } catch(e) {}
    }
    if (changed) await Store.putMany('notes', [n]);
  }
  return { id: n.id, pkg: n.pkg, guid: n.guid, mid: n.mid, flds: n.flds, tags: n.tags || '', local: !!n.local, dirty: !!n.dirty, mt: n.mt || 0, exportedAt: n.exportedAt || 0,
    assets: n.assets || {}, cards: (cardsByNid.get(n.id) || []).map(c => ({ id: c.id, did: c.did, dpath: deckPathStr(n.pkg, c.did), ord: c.ord, pos: c.pos, susp: !!c.susp })), u: noteU(n) };
}
async function recomputePending(pkg){
  const p = A.pkgs.get(pkg); if (!p) return;
  p.pending = (await Store.getByIndex('notes', pkg)).filter(n => n.dirty).length;
  await Store.putMany('pkgs', [p]);
}
async function applyRemoteNotes(recs){
  const byPkg = new Map();
  for (const r of recs) { if (!A.pkgs.has(r.pkg)) continue; if (!byPkg.has(r.pkg)) byPkg.set(r.pkg, []); byPkg.get(r.pkg).push(r); }
  let applied = 0;
  for (const [pkg, list] of byPkg) {
    const p = A.pkgs.get(pkg);
    const existing = await Store.getByIndex('notes', pkg);
    const byId = new Map(existing.map(n => [n.id, n])), guidOf = new Map(existing.map(n => [n.guid, n.id]));
    const notes = [], cards = [], media = [];
    for (const r of list) {
      const l = byId.get(r.id);
      if (l && noteU(l) >= r.u) continue;
      if (!l && guidOf.has(r.guid)) continue;
      if (!p.notetypes[r.mid]) continue;
      const n = Object.assign({}, l || {}, { id: r.id, guid: r.guid, mid: r.mid, flds: r.flds, tags: r.tags, pkg, local: r.local, dirty: r.dirty, mt: r.mt, exportedAt: r.exportedAt, assets: r.assets || {} });
      delete n._norm; notes.push(n);
      for (const rc of r.cards || []) {
        const ex = A.cards.get(rc.id);
        let did = rc.did;
        if (!p.decks[did] && rc.dpath) did = deckIdByPath(pkg, rc.dpath.split('::')) || (await ensureDeck(pkg, rc.dpath.split('::'))).did;
        const c = Object.assign({}, ex || {}, { id: rc.id, nid: r.id, did, ord: rc.ord, pos: rc.pos, susp: !!rc.susp, pkg, tags: r.tags, local: !!r.local });
        if (!ex) p.count++;
        A.cards.set(c.id, c); cards.push(c);
      }
      for (const name in (r.assets || {})) {
        const key = pkg + '/' + name;
        if (await Store.get('media', key)) continue;
        try { const res = await fetch('/_blob/' + r.assets[name]); if (res.ok) { media.push({ key, pkg, blob: await res.blob(), local: true }); mediaCache.delete(key); } } catch(e) {}
      }
      A.syncU.set(r.id, { u: r.u, pkg });
      applied++;
    }
    if (notes.length) {
      await Store.putMany('notes', notes); await Store.putMany('cards', cards); await Store.putMany('media', media);
      A.noteCache.delete(pkg);
      await recomputePending(pkg);
    }
  }
  if (applied) saveSyncU();
  return applied;
}
async function pullNotes(){
  if (!R.db) return 0;
  const snaps = await Promise.all([...Array(NOTE_BUCKETS)].map((_, i) => R.db.doc('data/users/' + R.uid + '/n' + i).get()));
  const remote = snaps.map(s => (s.exists && s.data() && s.data().c) || {});
  const newer = [];
  remote.forEach(c => { for (const id in c) { const l = A.syncU.get(id); if (!l || (c[id].u || 0) > (l.u || 0)) newer.push(c[id]); } });
  for (const [id, l] of A.syncU) { const b = noteBucket(id); const rv = remote[b][id]; if (!rv || (l.u || 0) > (rv.u || 0)) R.noteDirty.add(b); }
  return applyRemoteNotes(newer);
}
async function flushNotes(){
  const b = R.noteDirty.values().next().value; R.noteDirty.delete(b);
  const ref = R.db.doc('data/users/' + R.uid + '/n' + b);
  const snap = await ref.get();
  const c = Object.assign({}, snap.exists ? ((snap.data() || {}).c || {}) : {});
  const newer = Object.values(c).filter(r => { const l = A.syncU.get(r.id); return !l || (r.u || 0) > (l.u || 0); });
  if (newer.length) await applyRemoteNotes(newer);
  const ids = [...A.syncU.keys()].filter(id => noteBucket(id) === b);
  const cardsByNid = new Map();
  for (const cd of A.cards.values()) if (ids.includes(cd.nid)) { if (!cardsByNid.has(cd.nid)) cardsByNid.set(cd.nid, []); cardsByNid.get(cd.nid).push(cd); }
  for (const id of ids) {
    const n = await Store.get('notes', id);
    if (!n || !syncable(n)) continue;
    const rv = c[id];
    if (rv && (rv.u || 0) > noteU(n)) continue;
    c[id] = await noteRecord(n, cardsByNid);
  }
  const body = { c, u: Date.now() };
  if (JSON.stringify(body).length > 250000) { setStatus('full'); return; }
  await ref.set(body);
}

// ---------- stats ----------
function statAdd(pkg, prev, g, wasNew, sign){
  const day = dayKey();
  const p = A.stats[pkg] || (A.stats[pkg] = {});
  const a = p[day] || (p[day] = [0,0,0,0,0]);
  a[0] += sign;
  if (prev && prev.st === 2) { a[1] += sign; if (g > 1) a[2] += sign; }
  if (wasNew) a[3] += sign;
  if (g === 1) a[4] += sign;
  for (let i = 0; i < 5; i++) a[i] = Math.max(0, a[i]);
  Store.kvSet('stats', A.stats).catch(()=>{});
  R.statsDirty = true; scheduleSync();
}
function pruneStats(){
  const cut = Date.now() - 420 * DAY;
  for (const pkg in A.stats) for (const d in A.stats[pkg]) { const [y,m,dd] = d.split('-').map(Number); if (new Date(y, m-1, dd).getTime() < cut) delete A.stats[pkg][d]; }
}

// ---------- remote sync ----------
const R = { db:null, uid:null, assets:null, decksDirty:false, pkgsDirty:false, dirty:new Set(), errDirty:new Set(), noteDirty:new Set(), prefsDirty:false, statsDirty:false, timer:null, busy:false, status:'starting' };
function setStatus(s){
  R.status = s;
  const map = {
    starting: '',
    local: Store.isMemory() ? 'Este navegador não deixa salvar dados. O progresso some ao fechar a página.' : 'Progresso salvo neste aparelho.',
    synced: 'Progresso salvo na sua conta.',
    saving: 'Salvando progresso…',
    offline: 'Sem conexão agora. O progresso fica salvo aqui e sobe depois.',
    full: 'O espaço de sincronização encheu. O progresso segue salvo neste aparelho.'
  };
  for (const id of ['syncStatus','syncStatus2','syncStatus3']) { const el = $(id); if (el) el.textContent = map[s] || ''; }
}
function scheduleSync(ms){ if (!R.db) return; clearTimeout(R.timer); R.timer = setTimeout(flush, ms == null ? 4000 : ms); }
function mergeRemoteBucket(c, changed){
  for (const cid in c) {
    const rs = C.unpackState(c[cid]); const ls = A.states.get(cid);
    if (!ls || (rs.u || 0) > (ls.u || 0)) { A.states.set(cid, rs); changed.push([cid, rs]); }
  }
}
function mergeStats(remote){
  let changed = false, needPush = false;
  for (const pkg in remote) for (const d in remote[pkg]) {
    const ra = remote[pkg][d]; const p = A.stats[pkg] || (A.stats[pkg] = {}); const la = p[d];
    if (!la) { p[d] = ra.slice(); changed = true; continue; }
    for (let i = 0; i < 5; i++) { if ((ra[i]||0) > (la[i]||0)) { la[i] = ra[i]; changed = true; } else if ((la[i]||0) > (ra[i]||0)) needPush = true; }
  }
  for (const pkg in A.stats) for (const d in A.stats[pkg]) if (!remote[pkg] || !remote[pkg][d]) needPush = true;
  return { changed, needPush };
}
async function pullAll(){
  if (!R.db) return 0;
  const snaps = [];
  for (let i = 0; i < BUCKETS; i += 4) snaps.push(...await Promise.all([0,1,2,3].map(j => R.db.doc('data/users/' + R.uid + '/s' + (i + j)).get())));
  const changed = [], remote = [];
  snaps.forEach((snap, i) => { const c = (snap.exists && snap.data() && snap.data().c) || {}; remote[i] = c; mergeRemoteBucket(c, changed); });
  for (const [cid, st] of A.states) { const b = bucketOf(cid); const rv = remote[b] && remote[b][cid]; if (!rv || (st.u || 0) > (rv[10] || 0)) R.dirty.add(b); }
  if (changed.length) await Store.putStates(changed);
  const p = await R.db.doc('data/users/' + R.uid + '/prefs').get();
  if (p.exists) {
    const d = p.data() || {};
    if ((d.u || 0) > (A.prefs.u || 0)) {
      A.prefs = { retention: d.retention || 0.9, newPerDay: d.newPerDay == null ? 20 : d.newPerDay, colors: d.colors || A.prefs.colors || null, u: d.u };
      if (d.daily && d.daily.day) A.daily = d.daily;
      await Store.kvSet('prefs', A.prefs); await Store.kvSet('daily', A.daily);
      makeFsrs();
    } else if ((d.u || 0) < (A.prefs.u || 0)) R.prefsDirty = true;
  } else if (A.prefs.u) R.prefsDirty = true;
  const st = await R.db.doc('data/users/' + R.uid + '/stats').get();
  const m = mergeStats(st.exists ? ((st.data() || {}).p || {}) : {});
  if (m.changed) await Store.kvSet('stats', A.stats);
  if (m.needPush) R.statsDirty = true;
  const es = await Promise.all([...Array(ERR_BUCKETS)].map((_, i) => R.db.doc('data/users/' + R.uid + '/e' + i).get()));
  const eChanged = [], eRemote = [];
  es.forEach((snap, i) => { const c = (snap.exists && snap.data() && snap.data().c) || {}; eRemote[i] = c; mergeRemoteErrors(c, eChanged); });
  for (const [id, e] of A.errors) { const b = errBucket(id); const rv = eRemote[b] && eRemote[b][id]; if (!rv || (e.u || 0) > (rv.u || 0)) R.errDirty.add(b); }
  if (eChanged.length) await Store.putMany('errors', eChanged);
  const pApplied = await pullPkgs();
  const dApplied = await pullDecks();
  const nApplied = await pullNotes();
  return changed.length + (m.changed ? 1 : 0) + eChanged.length + nApplied + dApplied + pApplied;
}
function handleRemoteError(e){
  const code = e && e.code;
  if (code === 'unavailable' || code === 'resource_exhausted') { setStatus('offline'); return 'retry'; }
  if (code === 'quota_exceeded') { setStatus('full'); return 'stop'; }
  R.db = null; setStatus('local'); return 'stop';
}
async function flush(){
  if (!R.db || R.busy) return;
  if (!R.dirty.size && !R.errDirty.size && !R.noteDirty.size && !R.decksDirty && !R.pkgsDirty && !R.prefsDirty && !R.statsDirty) return;
  R.busy = true; setStatus('saving');
  let retry = false;
  try {
    while (R.dirty.size && R.db) {
      const b = R.dirty.values().next().value; R.dirty.delete(b);
      const ref = R.db.doc('data/users/' + R.uid + '/s' + b);
      try {
        const snap = await ref.get(); const changed = [];
        if (snap.exists) mergeRemoteBucket((snap.data() || {}).c || {}, changed);
        if (changed.length) await Store.putStates(changed);
        const c = {};
        for (const [cid, st] of A.states) if (bucketOf(cid) === b) c[cid] = C.packState(st);
        const body = { c, u: Date.now() };
        if (JSON.stringify(body).length > 250000) { setStatus('full'); continue; }
        await ref.set(body);
      } catch(e) { const act = handleRemoteError(e); if (act === 'retry') { R.dirty.add(b); retry = true; } break; }
    }
    if (R.db && R.pkgsDirty && !retry) {
      R.pkgsDirty = false;
      try {
        const ref = R.db.doc('data/users/' + R.uid + '/pkgs');
        const snap = await ref.get(); const rp = snap.exists ? ((snap.data() || {}).p || {}) : {};
        await mergeRemotePkgs(rp); R.pkgsDirty = false;
        const out = Object.assign({}, rp);
        for (const [id, p] of A.pkgs) {
          const nts = {}; for (const [mid, nt] of Object.entries(p.notetypes)) if (nt.scratch) nts[mid] = nt;
          if (Object.keys(nts).length) out[id] = { name: p.name, notetypes: Object.assign({}, (rp[id] || {}).notetypes || {}, nts), createdAt: p.createdAt || p.importedAt, u: Date.now() };
        }
        await ref.set({ p: out, u: Date.now() });
      } catch(e) { R.pkgsDirty = true; if (handleRemoteError(e) === 'retry') retry = true; }
    }
    if (R.db && R.decksDirty && !retry) {
      R.decksDirty = false;
      try {
        const ref = R.db.doc('data/users/' + R.uid + '/decks');
        const snap = await ref.get(); const rp = snap.exists ? ((snap.data() || {}).p || {}) : {};
        const ch = mergeRemoteDecks(rp); R.decksDirty = false;
        if (ch.size) await Store.putMany('pkgs', [...ch].map(id => A.pkgs.get(id)));
        const out = Object.assign({}, rp);
        for (const [pid, p] of A.pkgs) if (p.customDecks && Object.keys(p.customDecks).length) out[pid] = Object.assign({}, rp[pid] || {}, p.customDecks);
        await ref.set({ p: out, u: Date.now() });
      } catch(e) { R.decksDirty = true; if (handleRemoteError(e) === 'retry') retry = true; }
    }
    while (R.noteDirty.size && R.db && !retry) {
      const b = R.noteDirty.values().next().value;
      try { await flushNotes(); }
      catch(e) { const act = handleRemoteError(e); if (act === 'retry') { R.noteDirty.add(b); retry = true; } break; }
    }
    while (R.errDirty.size && R.db && !retry) {
      const b = R.errDirty.values().next().value; R.errDirty.delete(b);
      const ref = R.db.doc('data/users/' + R.uid + '/e' + b);
      try {
        const snap = await ref.get(); const changed = [];
        if (snap.exists) mergeRemoteErrors((snap.data() || {}).c || {}, changed);
        if (changed.length) await Store.putMany('errors', changed);
        const c = {};
        for (const [id, e] of A.errors) if (errBucket(id) === b) c[id] = trimErr(e);
        const body = { c, u: Date.now() };
        if (JSON.stringify(body).length > 250000) { setStatus('full'); continue; }
        await ref.set(body);
      } catch(e) { const act = handleRemoteError(e); if (act === 'retry') { R.errDirty.add(b); retry = true; } break; }
    }
    if (R.db && R.prefsDirty && !retry) {
      R.prefsDirty = false;
      try { await R.db.doc('data/users/' + R.uid + '/prefs').set({ retention: A.prefs.retention, newPerDay: A.prefs.newPerDay, colors: A.prefs.colors || null, daily: A.daily, u: A.prefs.u || Date.now() }); }
      catch(e) { R.prefsDirty = true; if (handleRemoteError(e) === 'retry') retry = true; }
    }
    if (R.db && R.statsDirty && !retry) {
      R.statsDirty = false;
      try {
        const ref = R.db.doc('data/users/' + R.uid + '/stats');
        const snap = await ref.get();
        if (snap.exists) mergeStats((snap.data() || {}).p || {});
        pruneStats();
        await ref.set({ p: A.stats, u: Date.now() });
      } catch(e) { R.statsDirty = true; if (handleRemoteError(e) === 'retry') retry = true; }
    }
    if (R.db && !retry && R.status !== 'full') setStatus('synced');
  } finally {
    R.busy = false;
    if (R.db && (R.dirty.size || R.errDirty.size || R.noteDirty.size || R.decksDirty || R.pkgsDirty || R.prefsDirty || R.statsDirty)) scheduleSync(retry ? 15000 : 1500);
  }
}
async function initRemote(){
  try {
    if (!window.claude || typeof window.claude.use !== 'function') { setStatus('local'); return; }
    const db = await window.claude.use('db');
    if (!db) { setStatus('local'); return; }
    const user = await window.claude.use('user');
    const uid = user ? await user.id() : null;
    if (!uid) { setStatus('local'); return; }
    R.db = db; R.uid = uid;
    try { R.assets = await window.claude.use('assets'); } catch(e) { R.assets = null; }
    setStatus('saving');
    const n = await pullAll();
    setStatus('synced');
    if (R.dirty.size || R.errDirty.size || R.noteDirty.size || R.decksDirty || R.pkgsDirty || R.prefsDirty || R.statsDirty) scheduleSync(800);
    if (n) { if (A.view === 'empty') go('home', {}, { reset:true }); else refresh(); }
  } catch(e) { handleRemoteError(e); if (R.db) scheduleSync(15000); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { if (R.db) { clearTimeout(R.timer); flush(); } }
  else if (R.db && !R.busy && A.view !== 'study' && A.view !== 'edit' && A.view !== 'wrong') pullAll().then(n => { if (n) refresh(); }).catch(()=>{});
});

function setState(cid, st){ A.states.set(cid, st); Store.putStates([[cid, st]]).catch(()=>{}); R.dirty.add(bucketOf(cid)); scheduleSync(); }
function clearState(cid){ A.states.delete(cid); Store.delState(cid).catch(()=>{}); R.dirty.add(bucketOf(cid)); scheduleSync(); }

// ---------- deck math ----------
function pkgCards(pkg){ const out = []; for (const c of A.cards.values()) if (c.pkg === pkg) out.push(c); return out; }
function classify(c, now, cutoff){
  if (c.susp) return null;
  const st = A.states.get(c.id);
  if (!st || st.st === 0) return 'n';
  if (st.st === 2) return st.d < cutoff ? 'r' : null;
  return st.d < cutoff ? 'l' : null;
}
function countsFor(cards, pkg){
  const now = Date.now(), cutoff = nextCutoff(now);
  const k = { n:0, l:0, r:0 };
  for (const c of cards) { const t = classify(c, now, cutoff); if (t) k[t]++; }
  k.n = Math.min(k.n, Math.max(0, A.prefs.newPerDay - newDone(pkg)));
  return k;
}
function countsHtml(k, cur){
  const span = (cls, v) => '<span class="' + (v ? cls : 'z') + (cur === cls ? ' cur' : '') + '">' + v + '</span>';
  return span('n', k.n) + span('l', k.l) + span('r', k.r);
}
const tagList = c => (c.tags || '').split(/\s+/).filter(Boolean);
function hasTag(c, tag){ const t = norm(tag); return tagList(c).some(x => { const y = norm(x); return y === t || y.startsWith(t + '::'); }); }
function deckPathStr(pkg, did){ const p = A.pkgs.get(pkg); return ((p && p.decks[did]) || []).join('::'); }
function deckOptions(pkg){
  const p = A.pkgs.get(pkg);
  const byPath = new Map();
  for (const [id, path] of Object.entries(p.decks)) {
    const k = path.join('::'); const cur = byPath.get(k);
    const custom = !!(p.customDecks && p.customDecks[id]);
    if (!cur || (cur.custom && !custom)) byPath.set(k, { id, path: k, custom });
  }
  return [...byPath.values()].sort((a,b) => cmpPath(a.path.split('::'), b.path.split('::')));
}
function mostUsedDeck(pkg){
  const cnt = {}; for (const c of pkgCards(pkg)) cnt[c.did] = (cnt[c.did] || 0) + 1;
  let best = null, bv = -1; for (const d in cnt) if (cnt[d] > bv) { bv = cnt[d]; best = d; }
  return best || Object.keys(A.pkgs.get(pkg).decks)[0];
}
function stateLabel(c){
  if (c.susp) return 'suspenso';
  const st = A.states.get(c.id);
  if (!st || st.st === 0) return 'novo';
  if (st.st !== 2) return 'aprendendo';
  const days = Math.round((dayStart(st.d) - dayStart()) / DAY);
  if (days < 0) return 'atrasado ' + (-days) + ' d';
  if (days === 0) return 'vence hoje';
  return 'vence em ' + days + ' d';
}

// ---------- navigation ----------
const NAV = [];
const RENDER = {};
function go(name, params, opts){
  opts = opts || {};
  if (opts.reset) NAV.length = 0;
  if (opts.replace) NAV.pop();
  NAV.push({ name, params: params || {} });
  RENDER[name](params || {});
}
function back(){
  const cur = NAV.pop();
  if (cur && cur.name === 'study') endStudy();
  const prev = NAV.pop();
  if (!prev) { go('home', {}, { reset:true }); return; }
  go(prev.name, Object.assign({}, prev.params, { back:true }));
}
function refresh(){ const top = NAV[NAV.length - 1]; if (!top) return; if (['home','deck','tags','stats','errors'].includes(top.name)) RENDER[top.name](Object.assign({}, top.params, { back:true })); }
function show(view, title, small){
  A.view = view;
  for (const v of ['home','empty','deck','tags','browse','edit','wrong','study','stats','settings','errors','errdetail','newcard','lesson']) $(v).hidden = v !== view;
  const root = view === 'home' || view === 'empty';
  $('backBtn').hidden = root;
  $('settingsBtn').hidden = !(root || view === 'deck');
  $('statsBtn').hidden = !(view === 'home' || view === 'deck');
  $('undoBtn').hidden = view !== 'study';
  $('editBtn').hidden = view !== 'study';
  document.body.classList.toggle('in-study', view === 'study');
  $('title').textContent = title || 'Fichário';
  $('title').classList.toggle('small', !!small);
  if (view !== 'study') renderBar(null);
  window.scrollTo(0, 0);
}
$('backBtn').addEventListener('click', back);
$('settingsBtn').addEventListener('click', () => go('settings'));
$('statsBtn').addEventListener('click', () => go('stats', { pkg: A.view === 'deck' ? curDeck() : '' }));
const curDeck = () => { const top = NAV[NAV.length - 1]; return top && top.params.pkg; };

// ---------- toast & overlay ----------
let toastTimer = null;
function toast(msg){ const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 3800); }
function progress(msg, head){ $('overlay').hidden = false; $('ovHead').textContent = head || 'Importando'; $('ovActions').hidden = true; $('ovMsg').className = 'msg'; $('ovMsg').innerHTML = '<span class="spinner" aria-hidden="true"></span>' + esc(msg); }
function progressError(msg){ $('overlay').hidden = false; $('ovActions').hidden = false; $('ovMsg').className = 'msg err'; $('ovMsg').textContent = msg; $('ovClose').focus(); }
const progressHide = () => { $('overlay').hidden = true; };
$('ovClose').addEventListener('click', progressHide);

// ---------- home ----------
RENDER.home = function(){
  if (!A.pkgs.size) { show('empty'); return; }
  show('home');
  const pk = [...A.pkgs.values()].sort((a,b) => a.name.localeCompare(b.name, 'pt-BR'));
  let html = '<div class="legend" style="margin-top:14px"><i class="n">novos</i><i class="l">aprendendo</i><i class="r">revisar</i></div><ul class="decks">';
  for (const p of pk) {
    const k = countsFor(pkgCards(p.id), p.id);
    const pend = p.pending ? ', ' + p.pending + ' para levar ao Anki' : '';
    html += '<li><button class="deckrow" data-pkg="' + esc(p.id) + '"><span class="nm"><b>' + esc(p.name) + '</b><span>' + p.count + ' cards' + pend + '</span></span><span class="counts">' + countsHtml(k) + '</span></button></li>';
  }
  $('homeList').innerHTML = html + '</ul>';
  setStatus(R.status);
};
RENDER.empty = RENDER.home;
$('homeList').addEventListener('click', e => { const b = e.target.closest('[data-pkg]'); if (b) go('deck', { pkg: b.dataset.pkg }); });
$('wrongBtnHome').addEventListener('click', () => go('wrong', { pkg: [...A.pkgs.keys()][0], fresh:true }));

// ---------- deck ----------
function deckTree(pkg){
  const p = A.pkgs.get(pkg), cards = pkgCards(pkg);
  const now = Date.now(), cutoff = nextCutoff(now);
  const nodes = new Map(); const keyOf = path => path.join('\x1f');
  for (const did in p.decks) { const path = p.decks[did]; for (let i = 1; i <= path.length; i++) { const k = keyOf(path.slice(0, i)); if (!nodes.has(k)) nodes.set(k, { path: path.slice(0, i), n:0, l:0, r:0, total:0 }); } }
  for (const c of cards) {
    const path = p.decks[c.did] || ['Sem nome']; const t = classify(c, now, cutoff);
    for (let i = 1; i <= path.length; i++) { const node = nodes.get(keyOf(path.slice(0, i))); if (!node) continue; node.total++; if (t) node[t]++; }
  }
  const left = Math.max(0, A.prefs.newPerDay - newDone(pkg));
  const customKeys = new Set(Object.entries(p.customDecks || {}).filter(([, d]) => !d.del).map(([, d]) => keyOf(d.path)));
  const keep = n => n.total > 0 || [...customKeys].some(k => k === keyOf(n.path) || k.startsWith(keyOf(n.path) + '\x1f'));
  const list = [...nodes.values()].filter(keep).sort((a,b) => cmpPath(a.path, b.path));
  for (const n of list) n.n = Math.min(n.n, left);
  return list;
}
RENDER.deck = function(params){
  const p = A.pkgs.get(params.pkg);
  if (!p) { go('home', {}, { reset:true }); return; }
  show('deck', p.name, true);
  const tree = deckTree(p.id);
  const k = countsFor(pkgCards(p.id), p.id);
  const has = k.n + k.l + k.r;
  $('studyAllBtn').disabled = !has; $('studyAllBtn').textContent = has ? 'Estudar' : 'Nada para hoje';
  drawTree(p.id, tree);
  const reviewed = phoneReviewed(p).length, nMoves = pendingMoves(p).length;
  $('progressBox').hidden = !reviewed && !nMoves;
  $('progressText').textContent = [reviewed ? (reviewed === 1 ? '1 card revisado aqui.' : reviewed + ' cards revisados aqui.') : '', nMoves ? (nMoves === 1 ? '1 pasta do Anki foi movida ou renomeada aqui.' : nMoves + ' pastas do Anki foram movidas ou renomeadas aqui.') : ''].filter(Boolean).join(' ') + ' O arquivo leva isso para o Anki do computador.' +
    (p.progressExportedAt ? ' Última exportação em ' + new Date(p.progressExportedAt).toLocaleDateString('pt-BR') + '.' : '') +
    (p.pending ? ' Antes, exporte os cards novos acima e importe no Anki: o progresso deles só entra depois que eles existirem lá.' : '');
  $('exportBox').hidden = !p.pending;
  $('exportText').textContent = p.pending === 1 ? '1 card criado ou editado aqui ainda não está no Anki do computador.' : p.pending + ' cards criados ou editados aqui ainda não estão no Anki do computador.';
  $('deckMeta').textContent = p.count + (p.count === 1 ? ' card. ' : ' cards. ') + (p.scratch ? 'Criado aqui em ' : 'Importado em ') + new Date(p.importedAt).toLocaleDateString('pt-BR') + '.';
  if (APKG.pkg !== p.id) resetApkg();
  resetDelete();
};
$('subtree').addEventListener('click', e => {
  const tree = $('subtree')._tree; if (!tree) return;
  const t = e.target.closest('[data-tog]');
  if (t) { const k = tree[Number(t.dataset.tog)].path.join('\x1f'); const ex = expandedSet(curDeck(), tree); if (ex.has(k)) ex.delete(k); else ex.add(k); saveExpanded(curDeck(), ex); drawTree(curDeck(), tree); return; }
  const m = e.target.closest('[data-more]');
  if (m) { openFolderActions(curDeck(), tree[Number(m.dataset.more)]); return; }
  const b = e.target.closest('[data-i]'); if (!b) return;
  const node = tree[Number(b.dataset.i)];
  if (!node.total) { openFolderActions(curDeck(), node); return; }
  startStudy({ pkg: curDeck(), path: node.path });
});
$('newFolderBtn').addEventListener('click', () => { const pkg = curDeck(); const roots = deckTree(pkg).filter(n => n.path.length === 1); openFolderCreate(pkg, roots.length === 1 ? roots[0].path : [], did => { revealDeck(pkg, did); RENDER.deck({ pkg, back:true }); }); });
$('studyAllBtn').addEventListener('click', () => startStudy({ pkg: curDeck() }));
$('tagsBtn').addEventListener('click', () => go('tags', { pkg: curDeck() }));
$('browseBtn').addEventListener('click', () => go('browse', { pkg: curDeck(), fresh:true }));
$('wrongBtnDeck').addEventListener('click', () => go('wrong', { pkg: curDeck(), fresh:true }));
$('exportBtn').addEventListener('click', () => exportPending(curDeck()));
$('progressBtn').addEventListener('click', () => exportProgress(curDeck()));
let delTimer = null;
function resetDelete(){ clearTimeout(delTimer); $('deleteBtn').textContent = 'Remover este deck do aparelho'; $('deleteBtn').dataset.armed = ''; }
$('deleteBtn').addEventListener('click', async () => {
  const b = $('deleteBtn');
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Toque de novo para remover'; delTimer = setTimeout(resetDelete, 4000); return; }
  resetDelete();
  const pkg = curDeck();
  await Store.removePkg(pkg);
  for (const [id, c] of A.cards) if (c.pkg === pkg) A.cards.delete(id);
  A.pkgs.delete(pkg); A.noteCache.delete(pkg);
  toast('Deck removido. O progresso continua guardado caso você importe de novo.');
  go('home', {}, { reset:true });
});

// ---------- tags ----------
RENDER.tags = function(params){
  const p = A.pkgs.get(params.pkg);
  show('tags', 'Tags de ' + p.name, true);
  const now = Date.now(), cutoff = nextCutoff(now);
  const map = new Map();
  for (const c of pkgCards(p.id)) {
    if (c.susp) continue;
    const t = classify(c, now, cutoff);
    const seen = new Set();
    for (const tag of tagList(c)) {
      const parts = tag.split('::');
      for (let i = 1; i <= parts.length; i++) {
        const k = parts.slice(0, i).join('::'); if (seen.has(k)) continue; seen.add(k);
        const e = map.get(k) || { tag: k, depth: i - 1, total: 0, due: 0 };
        e.total++; if (t === 'l' || t === 'r') e.due++;
        map.set(k, e);
      }
    }
  }
  $('tagList')._all = [...map.values()].sort((a,b) => a.tag.localeCompare(b.tag, 'pt-BR'));
  if (!params.back) $('tagSearch').value = '';
  drawTags();
};
function drawTags(){
  const q = norm($('tagSearch').value.trim());
  const all = $('tagList')._all || [];
  const list = q ? all.filter(e => norm(e.tag).includes(q)) : all;
  if (!all.length) { $('tagList').innerHTML = '<li><div class="deckrow" style="cursor:default"><span class="nm"><b>Nenhum card deste deck tem tag.</b><span>As tags vêm do Anki ou dos cards que você cria aqui.</span></span></div></li>'; return; }
  $('tagList').innerHTML = list.slice(0, 400).map((e, i) =>
    '<li><button class="deckrow" data-tag="' + esc(e.tag) + '" style="padding-left:' + (16 + (q ? 0 : e.depth * 18)) + 'px"><span class="nm"><b style="font-size:16px;font-weight:' + (e.depth && !q ? 400 : 700) + '">' + esc(q ? e.tag : e.tag.split('::').pop()) + '</b></span><span class="counts"><span class="' + (e.due ? 'l' : 'z') + '">' + e.due + '</span><span style="color:var(--muted)">' + e.total + '</span></span></button></li>').join('') ||
    '<li><div class="deckrow" style="cursor:default"><span class="nm"><b>Nenhuma tag com esse nome.</b></span></div></li>';
}
$('tagSearch').addEventListener('input', drawTags);
$('tagList').addEventListener('click', e => { const b = e.target.closest('[data-tag]'); if (b) openTagSheet(curDeck(), b.dataset.tag); });
function openTagSheet(pkg, tag){
  const cards = pkgCards(pkg).filter(c => !c.susp && hasTag(c, tag));
  const k = countsFor(cards, pkg);
  const due = k.n + k.l + k.r;
  $('sheetTitle').textContent = tag;
  $('sheetNote').textContent = cards.length + (cards.length === 1 ? ' card com esta tag.' : ' cards com esta tag.') + ' A revisão extra não mexe na agenda: serve para repassar o tema antes de um simulado.';
  $('sheetDue').textContent = due ? 'Estudar o que vence hoje (' + due + ')' : 'Nada vence hoje nesta tag';
  $('sheetDue').disabled = !due;
  $('sheetCram').textContent = 'Revisão extra de todos (' + cards.length + ')';
  $('sheetCram').disabled = !cards.length;
  $('sheet').hidden = false;
  $('sheet')._ctx = { pkg, tag };
  (due ? $('sheetDue') : $('sheetCram')).focus();
}
$('sheetClose').addEventListener('click', () => { $('sheet').hidden = true; });
$('sheet').addEventListener('click', e => { if (e.target === $('sheet')) $('sheet').hidden = true; });
$('sheetDue').addEventListener('click', () => { const c = $('sheet')._ctx; $('sheet').hidden = true; startStudy({ pkg: c.pkg, tag: c.tag }); });
$('sheetCram').addEventListener('click', () => { const c = $('sheet')._ctx; $('sheet').hidden = true; startStudy({ pkg: c.pkg, tag: c.tag, cram: true }); });

// ---------- browse ----------
async function notesOf(pkg){
  if (A.noteCache.has(pkg)) return A.noteCache.get(pkg);
  const list = await Store.getByIndex('notes', pkg);
  for (const n of list) n._norm = norm(plainText(n.flds.join(' ')) + ' ' + n.tags);
  A.noteCache.set(pkg, list);
  return list;
}
function cardsByNote(pkg){ const m = new Map(); for (const c of pkgCards(pkg)) { const a = m.get(c.nid); if (a) a.push(c); else m.set(c.nid, [c]); } return m; }
RENDER.browse = async function(params){
  const p = A.pkgs.get(params.pkg);
  show('browse', 'Cards de ' + p.name, true);
  if (params.fresh && !params.back) { $('q').value = ''; $('chipPending').setAttribute('aria-pressed', 'false'); $('chipMine').setAttribute('aria-pressed', 'false'); }
  $('browseMeta').textContent = 'Carregando…'; $('results').innerHTML = '';
  await notesOf(p.id);
  drawResults();
};
let qTimer = null;
$('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(drawResults, 160); });
for (const id of ['chipPending','chipMine']) $(id).addEventListener('click', () => { const b = $(id); b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); drawResults(); });
function drawResults(){
  const pkg = curDeck(); const notes = A.noteCache.get(pkg) || [];
  const terms = norm($('q').value.trim()).split(/\s+/).filter(Boolean);
  const onlyPend = $('chipPending').getAttribute('aria-pressed') === 'true';
  const onlyMine = $('chipMine').getAttribute('aria-pressed') === 'true';
  const byNote = cardsByNote(pkg);
  let list = notes.filter(n => (!onlyPend || n.dirty) && (!onlyMine || n.local) && terms.every(t => n._norm.includes(t)));
  if (onlyPend || onlyMine) list.sort((a,b) => (b.mt || 0) - (a.mt || 0));
  const total = list.length; list = list.slice(0, 150);
  $('browseMeta').textContent = !terms.length && !onlyPend && !onlyMine ? 'Digite para buscar entre ' + notes.length + ' notas.' :
    total ? (total > 150 ? 'Mostrando 150 de ' + total + ' resultados.' : total + (total === 1 ? ' resultado.' : ' resultados.')) : 'Nada encontrado.';
  if (!terms.length && !onlyPend && !onlyMine) { $('results').innerHTML = ''; $('results').hidden = true; return; }
  $('results').hidden = !list.length;
  $('results').innerHTML = list.map(n => {
    const cs = byNote.get(n.id) || [];
    const first = n.flds.map(plainText).find(Boolean) || '(vazio)';
    const sub = cs.length ? (deckPathStr(pkg, cs[0].did).split('::').slice(1).join(' › ') || deckPathStr(pkg, cs[0].did)) + ', ' + stateLabel(cs[0]) : '';
    const flags = (n.local ? '<span class="flag">criado aqui</span>' : '') + (n.dirty ? '<span class="flag">pendente</span>' : '');
    return '<li class="result"><button class="deckrow" data-nid="' + esc(n.id) + '"><span class="nm"><b>' + esc(first.slice(0, 220)) + '</b><span>' + esc(sub) + flags + '</span></span></button></li>';
  }).join('');
}
$('results').addEventListener('click', e => { const b = e.target.closest('[data-nid]'); if (b) go('edit', { pkg: curDeck(), nid: b.dataset.nid }); });

// ---------- media helpers ----------
const mediaCache = new Map();
async function mediaUrl(pkg, name){
  const key = pkg + '/' + name;
  if (mediaCache.has(key)) return mediaCache.get(key);
  const rec = await Store.get('media', key);
  const url = rec ? URL.createObjectURL(rec.blob) : null;
  mediaCache.set(key, url);
  return url;
}
async function shrinkImage(file){
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const max = 1280, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
    const cv = document.createElement('canvas'); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
  } finally { URL.revokeObjectURL(url); }
}
const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });

// ---------- card rendering ----------
function isDark(){
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return true; if (t === 'light') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
const BASE_CSS = ':host{display:block}' +
  '.card{font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.5;text-align:center;color:#17202B;padding:22px 18px 30px;overflow-wrap:anywhere;-webkit-text-size-adjust:100%}' +
  'img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}' +
  '.cloze{font-weight:bold;color:#1F5FBF}.nightMode .cloze{color:#8EC1FF}' +
  'hr#answer{border:0;border-top:1px dashed #C7D0DB;margin:20px 0}.nightMode hr#answer{border-top-color:#3A4656}' +
  'details.hint summary{cursor:pointer;color:#1F5FBF;text-decoration:underline}' +
  '.typed-answer{font-family:ui-monospace,Menlo,monospace;background:rgba(31,95,191,.1);padding:6px 10px;border-radius:4px;display:inline-block}' +
  '.snd{font:inherit;font-size:15px;border:1.5px solid currentColor;background:transparent;color:inherit;border-radius:999px;padding:4px 12px;margin:2px;cursor:pointer;opacity:.8}';
const OVERRIDE_CSS = '.card{background:transparent!important;background-color:transparent!important}.card.nightMode{color:#E3E8EF}';
const deferImgs = html => String(html).replace(/(<img\b[^>]*?\s)src=(["'])(?!https?:|data:|blob:)([^"']*)\2/gi, '$1data-fsrc=$2$3$2');
async function paintInto(root, html, pkg, css){
  const body = deferImgs(html).replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\[sound:([^\]]+)\]/g, (m, f) => '<button class="snd" data-snd="' + esc(f) + '">▶ ouvir</button>');
  root.innerHTML = '<style>' + BASE_CSS + (css || '') + OVERRIDE_CSS + '</style><div class="card' + (isDark() ? ' nightMode night_mode' : '') + '"><div id="qa">' + body + '</div></div>';
  await Promise.all([...root.querySelectorAll('img[data-fsrc]')].map(async img => {
    const raw = img.getAttribute('data-fsrc');
    let name = raw; try { name = decodeURIComponent(raw); } catch(e){}
    const url = await mediaUrl(pkg, name);
    if (url) img.src = url; else img.alt = name;
  }));
}
function soundClicks(root, pkgFn){
  root.addEventListener('click', async e => {
    const b = e.target.closest && e.target.closest('[data-snd]'); if (!b) return;
    e.stopPropagation();
    const url = await mediaUrl(pkgFn(), b.dataset.snd);
    if (url) { try { await new Audio(url).play(); } catch(err){ toast('Não consegui tocar este áudio.'); } }
  });
}
const host = $('cardhost');
const shadow = host.attachShadow({ mode: 'open' });
soundClicks(shadow, () => S.card && S.card.pkg);

// ---------- study (normal + cram) ----------
const S = { mode:'normal', pkg:null, path:null, tag:null, cards:[], card:null, html:null, side:'q', undo:[], revSinceNew:0, lastId:null, reviewed:0, waitTimer:null, queue:[], misses:{}, cramOk:0, cramSeen:0, doneShown:false };
function inPath(c, p, path){
  if (!path) return true;
  const dp = p.decks[c.did] || [];
  if (dp.length < path.length) return false;
  for (let i = 0; i < path.length; i++) if (dp[i] !== path[i]) return false;
  return true;
}
async function startStudy(opts){
  try { await loadScript(CDN.fsrs); } catch(e) { toast(e.message); return; }
  if (!A.fsrs) makeFsrs();
  go('study', opts);
}
RENDER.study = function(params){
  const p = A.pkgs.get(params.pkg);
  if (!p) { go('home', {}, { reset:true }); return; }
  const title = params.tag ? params.tag.split('::').pop() : params.path ? params.path[params.path.length - 1] : p.name;
  if (params.resume && (S.card || S.doneShown)) {
    show('study', title, true);
    if (S.card) showSpecific(S.card, true); else nextCard();
    return;
  }
  Object.assign(S, { mode: params.cram ? 'cram' : 'normal', pkg: p.id, path: params.path || null, tag: params.tag || null, undo: [], revSinceNew: 0, lastId: null, reviewed: 0, misses: {}, cramOk: 0, cramSeen: 0, doneShown: false, card: null });
  S.cards = pkgCards(p.id).filter(c => !c.susp && inPath(c, p, S.path) && (!S.tag || hasTag(c, S.tag)));
  if (S.mode === 'cram') { S.queue = S.cards.slice(); for (let i = S.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [S.queue[i], S.queue[j]] = [S.queue[j], S.queue[i]]; } }
  show('study', title, true);
  $('undoBtn').disabled = true;
  nextCard();
};
function endStudy(){ clearTimeout(S.waitTimer); renderBar(null); S.card = null; S.doneShown = false; }
function pick(){
  const now = Date.now(), cutoff = nextCutoff(now);
  const lrnNow = [], lrnSoon = [], rev = []; let nw = []; let lrnLater = Infinity, lrnToday = 0;
  for (const c of S.cards) {
    const st = A.states.get(c.id);
    if (!st || st.st === 0) { nw.push(c); continue; }
    if (st.st === 2) { if (st.d < cutoff) rev.push(c); continue; }
    if (st.d <= now) lrnNow.push(c);
    else if (st.d <= now + LEARN_AHEAD) lrnSoon.push(c);
    else if (st.d < cutoff) { lrnLater = Math.min(lrnLater, st.d); lrnToday++; }
  }
  const left = Math.max(0, A.prefs.newPerDay - newDone(S.pkg));
  nw.sort((a, b) => a.pos - b.pos); nw = nw.slice(0, left);
  const byDue = (a, b) => A.states.get(a.id).d - A.states.get(b.id).d;
  lrnNow.sort(byDue); rev.sort(byDue); lrnSoon.sort(byDue);
  const counts = { n: nw.length, l: lrnNow.length + lrnSoon.length + lrnToday, r: rev.length };
  const notLast = arr => (arr.length > 1 && arr[0].id === S.lastId) ? arr[1] : arr[0];
  let card = null, kind = null;
  if (lrnNow.length) { card = notLast(lrnNow); kind = 'l'; }
  else if (rev.length || nw.length) {
    const every = nw.length ? Math.max(1, Math.floor(rev.length / nw.length)) : Infinity;
    if (!rev.length || (nw.length && S.revSinceNew >= every)) { card = nw[0]; kind = 'n'; }
    else { card = notLast(rev); kind = 'r'; }
  }
  else if (lrnSoon.length) { card = lrnSoon[0]; kind = 'l'; }
  return { card, kind, counts, waitUntil: lrnLater < Infinity ? lrnLater : null };
}
function headHtml(counts, kind){
  if (S.mode === 'cram') return '<span class="cramleft">Revisão extra, ' + S.queue.length + (S.queue.length === 1 ? ' card restante' : ' cards restantes') + '</span>';
  return '<div class="counts">' + countsHtml(counts, kind) + '</div>';
}
async function nextCard(){
  clearTimeout(S.waitTimer);
  if (S.mode === 'cram') {
    $('studyHead').innerHTML = headHtml();
    if (!S.queue.length) { S.card = null; showDone(null); return; }
    return showSpecific(S.queue[0]);
  }
  const r = pick();
  $('studyHead').innerHTML = headHtml(r.counts, r.kind);
  if (!r.card) { S.card = null; showDone(r.waitUntil); return; }
  return showSpecific(r.card, false, r.kind);
}
async function showSpecific(c, keepSide, kind){
  clearTimeout(S.waitTimer);
  S.doneShown = false;
  $('doneBox').hidden = true; $('fcard').hidden = false; $('editBtn').hidden = false;
  const p = A.pkgs.get(c.pkg);
  const note = await Store.get('notes', c.nid);
  if (!note) { S.cards = S.cards.filter(x => x.id !== c.id); S.queue = S.queue.filter(x => x.id !== c.id); return nextCard(); }
  const nt = p.notetypes[note.mid] || { flds:[], tmpls:[], kind:0, css:'' };
  const st = A.states.get(c.id);
  S.card = c; S.note = note; S.nt = nt;
  S.kind = kind || (!st || st.st === 0 ? 'n' : st.st === 2 ? 'r' : 'l');
  S.html = C.renderCard(note, nt, c, p.decks[c.did]);
  const side = keepSide && S.side === 'a' ? 'a' : 'q';
  S.side = side;
  const dp = p.decks[c.did] || [];
  $('cardDeck').textContent = dp.slice(1).join(' › ') || dp[0] || '';
  $('cardState').textContent = S.mode === 'cram' ? 'Revisão extra' : S.kind === 'n' ? 'Novo' : S.kind === 'l' ? 'Aprendendo' : 'Revisão';
  host.classList.toggle('revealed', side === 'a'); host.classList.remove('flip');
  host.setAttribute('aria-label', side === 'q' ? 'Pergunta. Toque para ver a resposta.' : 'Resposta');
  await paintInto(shadow, side === 'q' ? S.html.q : S.html.a, c.pkg, nt.css);
  if (side === 'q') S.shownAt = Date.now();
  renderBar(side);
}
function reveal(){
  if (!S.card || S.side !== 'q') return;
  S.side = 'a';
  host.classList.add('revealed'); void host.offsetWidth; host.classList.add('flip');
  host.setAttribute('aria-label', 'Resposta');
  paintInto(shadow, S.html.a, S.card.pkg, S.nt.css).then(() => {
    const ans = shadow.getElementById('answer');
    if (ans) { const top = ans.getBoundingClientRect().top; if (top > window.innerHeight * 0.55) window.scrollBy({ top: top - window.innerHeight * 0.3, behavior: 'smooth' }); }
  });
  renderBar('a');
}
function fmtIvl(ms){
  const m = ms / 60000;
  if (m < 60) return Math.max(1, Math.round(m)) + ' min';
  const h = m / 60; if (h < 24) return Math.round(h) + ' h';
  const d = h / 24; if (d < 30) return Math.round(d) + ' d';
  const mo = d / 30.44;
  if (mo < 12) { const v = mo < 10 ? Math.round(mo * 10) / 10 : Math.round(mo); return String(v).replace('.', ',') + (v < 2 ? ' mês' : ' meses'); }
  const y = Math.round(d / 365 * 10) / 10; return String(y).replace('.', ',') + (y < 2 ? ' ano' : ' anos');
}
function currentFsrsCard(now){ const st = A.states.get(S.card.id); return st && st.st !== 0 ? C.toFsrs(st) : window.FSRS.createEmptyCard(new Date(now)); }
function renderBar(side){
  let bar = document.querySelector('.bar');
  if (!side) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.className = 'bar'; bar.innerHTML = '<div class="wrap"></div>'; document.body.appendChild(bar); }
  const w = bar.firstChild;
  if (side === 'q') { const desk = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches; w.innerHTML = '<button class="primary" id="showBtn">Mostrar resposta' + (desk ? ' <span style="font-weight:400;opacity:.75">(espaço)</span>' : '') + '</button>'; $('showBtn').addEventListener('click', reveal); return; }
  let btns;
  if (S.mode === 'cram') {
    btns = '<div class="grades two"><button class="grade g1" data-g="1">Errei</button><button class="grade g3" data-g="3">Acertei</button></div>';
  } else {
    const now = Date.now();
    const rec = A.fsrs.repeat(currentFsrsCard(now), new Date(now));
    const labels = ['Errei', 'Difícil', 'Bom', 'Fácil'];
    btns = '<div class="grades">' + [1,2,3,4].map(g => '<button class="grade g' + g + '" data-g="' + g + '">' + labels[g-1] + '<small>' + fmtIvl(+rec[g].card.due - now) + '</small></button>').join('') + '</div>';
  }
  const desk = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  w.innerHTML = btns + '<p class="swipehint">' + (desk ? 'Atalhos: espaço para ' + (S.mode === 'cram' ? 'acertei' : 'bom') + ', ' + (S.mode === 'cram' ? '1 errei, 3 acertei' : '1 a 4 para os botões') + ', Z desfaz.' : 'Ou deslize o card: esquerda para errei, direita para ' + (S.mode === 'cram' ? 'acertei' : 'bom') + '.') + '</p>';
  w.querySelectorAll('[data-g]').forEach(b => b.addEventListener('click', () => answer(Number(b.dataset.g))));
}
function answer(g){
  if (!S.card || S.side !== 'a') return;
  if (S.mode === 'cram') {
    S.undo.push({ queue: S.queue.slice(), misses: Object.assign({}, S.misses), ok: S.cramOk, seen: S.cramSeen });
    const c = S.queue.shift(); S.cramSeen++;
    if (g > 1) S.cramOk++;
    else if ((S.misses[c.id] || 0) < 2) { S.misses[c.id] = (S.misses[c.id] || 0) + 1; S.queue.splice(Math.min(S.queue.length, 4), 0, c); }
    $('undoBtn').disabled = false;
    nextCard(); return;
  }
  const now = Date.now();
  const prev = A.states.get(S.card.id) || null;
  const res = A.fsrs.next(currentFsrsCard(now), new Date(now), g);
  const st = C.fromFsrs(res.card, now); st.p = 1;
  const wasNew = !prev || prev.st === 0;
  if (wasNew) { bumpNew(S.pkg, 1); S.revSinceNew = 0; } else if (S.kind === 'r') S.revSinceNew++;
  statAdd(S.pkg, prev, g, wasNew, 1);
  const revId = Math.max(now, (A.lastRevId || 0) + 1); A.lastRevId = revId;
  Store.putMany('revlog', [{ id: revId, cid: S.card.id, pkg: S.pkg, ease: g,
    ivl: st.st === 2 ? Math.max(1, st.sd || 1) : -Math.max(60, Math.round((st.d - now) / 1000)),
    lastIvl: !prev || prev.st === 0 ? 0 : prev.st === 2 ? Math.max(1, prev.sd || 1) : -600,
    factor: Math.round(st.f * 100), time: Math.min(60000, Math.max(0, now - (S.shownAt || now))),
    type: !prev || prev.st === 0 || prev.st === 1 ? 0 : prev.st === 2 ? 1 : 2 }]).catch(()=>{});
  S.undo.push({ id: S.card.id, prev, wasNew, g, revId });
  if (S.undo.length > 30) S.undo.shift();
  $('undoBtn').disabled = false;
  setState(S.card.id, st);
  S.lastId = S.card.id; S.reviewed++;
  nextCard();
}
function undo(){
  const u = S.undo.pop(); if (!u) return;
  $('undoBtn').disabled = !S.undo.length;
  if (S.mode === 'cram') { S.queue = u.queue; S.misses = u.misses; S.cramOk = u.ok; S.cramSeen = u.seen; S.side = 'q'; nextCard(); toast('Resposta desfeita.'); return; }
  if (u.prev) setState(u.id, u.prev); else clearState(u.id);
  if (u.revId) Store.deleteMany('revlog', [u.revId]).catch(()=>{});
  if (u.wasNew) bumpNew(S.pkg, -1);
  statAdd(S.pkg, u.prev, u.g, u.wasNew, -1);
  S.reviewed = Math.max(0, S.reviewed - 1);
  const c = A.cards.get(u.id);
  if (!c) return nextCard();
  S.lastId = null; S.side = 'q';
  const r = pick();
  $('studyHead').innerHTML = headHtml(r.counts, null);
  showSpecific(c);
  toast('Resposta desfeita.');
}
$('undoBtn').addEventListener('click', undo);
$('editBtn').addEventListener('click', () => {
  if (!S.card) return;
  const top = NAV[NAV.length - 1]; if (top && top.name === 'study') top.params = Object.assign({}, top.params, { resume: true });
  go('edit', { pkg: S.card.pkg, nid: S.card.nid });
});
function showDone(waitUntil){
  renderBar(null);
  S.doneShown = true;
  $('editBtn').hidden = true;
  $('fcard').hidden = true;
  const box = $('doneBox'); box.hidden = false;
  let html;
  if (S.mode === 'cram') {
    html = '<h2>Revisão extra concluída</h2>';
    if (S.cramSeen) html += '<p>Você acertou ' + S.cramOk + ' de ' + S.cramSeen + ' respostas. A agenda dos cards não mudou.</p>';
  } else {
    html = '<h2>' + (waitUntil ? 'Pausa curta' : 'Por hoje é só') + '</h2>';
    if (S.reviewed) html += '<p>Você respondeu ' + S.reviewed + (S.reviewed === 1 ? ' card' : ' cards') + ' nesta sessão.</p>';
    if (waitUntil) {
      const t = new Date(waitUntil).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
      html += '<p>Ainda há cards em aprendizagem. O próximo volta às ' + t + '. Pode deixar esta tela aberta.</p>';
      S.waitTimer = setTimeout(nextCard, Math.max(15000, Math.min(waitUntil - LEARN_AHEAD - Date.now() + 1000, 60000)));
    } else html += '<p>Nada mais vence até amanhã ' + (S.tag ? 'nesta tag.' : 'neste deck.') + '</p>';
  }
  box.innerHTML = html + '<div class="stack"><button class="secondary" id="doneBack">Voltar</button></div>';
  $('doneBack').addEventListener('click', back);
}
host.addEventListener('click', () => { if (S.side === 'q' && !swipe.moved) reveal(); });
host.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && S.side === 'q') { e.preventDefault(); reveal(); } });
document.addEventListener('keydown', e => {
  if (A.view !== 'study' || !S.card) return;
  if (e.target && (/input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable)) return;
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (S.side === 'q') reveal(); else answer(3); }
  else if (S.side === 'a' && S.mode !== 'cram' && /^[1-4]$/.test(e.key)) answer(Number(e.key));
  else if (S.side === 'a' && S.mode === 'cram' && (e.key === '1' || e.key === '2')) answer(e.key === '1' ? 1 : 3);
  else if (e.key === 'z' && S.undo.length) undo();
});

// ---------- swipe ----------
const fcard = $('fcard');
const swipe = { on:false, moved:false };
fcard.addEventListener('pointerdown', e => {
  swipe.moved = false;
  if (A.view !== 'study' || !S.card || S.side !== 'a') return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  Object.assign(swipe, { on:true, active:false, x:e.clientX, y:e.clientY, id:e.pointerId, dx:0 });
});
fcard.addEventListener('pointermove', e => {
  if (!swipe.on || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) { swipe.active = true; swipe.moved = true; fcard.classList.remove('settle'); try { fcard.setPointerCapture(e.pointerId); } catch(err){} }
    else if (Math.abs(dy) > 12) { swipe.on = false; return; }
    else return;
  }
  swipe.dx = dx;
  fcard.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 45) + 'deg)';
  const dir = dx < -80 ? 'left' : dx > 80 ? 'right' : '';
  fcard.dataset.swipe = dir;
  fcard.dataset.hint = dir === 'left' ? 'Errei' : dir === 'right' ? (S.mode === 'cram' ? 'Acertei' : 'Bom') : '';
});
function endSwipe(){
  if (!swipe.on) return;
  const wasActive = swipe.active, dx = swipe.dx;
  swipe.on = false; swipe.active = false;
  fcard.classList.add('settle'); fcard.style.transform = ''; fcard.dataset.swipe = '';
  if (!wasActive) return;
  if (dx < -80) answer(1); else if (dx > 80) answer(3);
}
fcard.addEventListener('pointerup', endSwipe);
fcard.addEventListener('pointercancel', endSwipe);

// ---------- editor ----------
const COLORS = [['#D0312D','vermelho'],['#1F5FBF','azul'],['#23843F','verde'],['#D9730D','laranja'],['#7B3FB6','roxo']];
let edSeq = 0;
function ntOptions(pkg, kindPref){
  const p = A.pkgs.get(pkg);
  const use = p.ntUse || {};
  return Object.entries(p.notetypes).map(([id, nt]) => ({ id, nt, use: use[id] || 0 }))
    .sort((a, b) => (kindPref != null ? (b.nt.kind === kindPref) - (a.nt.kind === kindPref) : 0) || b.use - a.use || a.nt.name.localeCompare(b.nt.name));
}
// draft: {mid, flds[], tags, did, image?:{name, blob}, angle?} ; existing: {note}
function mountEditor(container, opts){
  const id = 'ed' + (++edSeq);
  const pkg = opts.pkg; const p = A.pkgs.get(pkg);
  const isNew = !opts.note;
  const d = isNew ? opts.draft : { mid: opts.note.mid, flds: opts.note.flds.slice(), tags: opts.note.tags };
  const box = document.createElement('div');
  box.className = 'paper editor'; box.id = id;
  let head = '<div class="head"><span>' + esc(opts.title || (isNew ? 'Card novo' : 'Editar card')) + '</span><span>' + esc(isNew ? '' : (p.notetypes[d.mid] || {}).name || '') + '</span></div>';
  if (opts.angle) head += '<div style="padding:12px 16px 0"><p class="angle">' + esc(opts.angle) + '</p></div>';
  box.innerHTML = head +
    '<div class="tools" role="toolbar" aria-label="Formatação">' +
      '<button data-cmd="bold" aria-label="Negrito">B</button>' +
      COLORS.map(([c, n]) => '<button class="sw" data-color="' + c + '" aria-label="Cor ' + n + ': ' + esc(colorMeaning(c)) + '" title="' + esc(colorMeaning(c)) + '"><i style="background:' + c + '"></i></button>').join('') +
      '<button data-cmd="cloze" aria-label="Transformar seleção em lacuna">[…]</button>' +
      '<button data-cmd="clear" aria-label="Limpar formatação">Limpar</button>' +
    '</div>' +
    '<div class="colorleg">' + COLORS.map(([c]) => '<span><i style="background:' + c + '"></i>' + esc(colorMeaning(c)) + '</span>').join('') + '</div>' +
    (isNew ? '<div class="fld"><div class="lbl">Tipo de nota</div><select class="inp" data-role="nt" style="margin-top:0">' +
      ntOptions(pkg).map(o => '<option value="' + esc(o.id) + '"' + (o.id === d.mid ? ' selected' : '') + '>' + esc(o.nt.name) + (o.nt.kind === 1 ? ' (lacunas)' : '') + '</option>').join('') + '</select></div>' +
      '<div class="fld"><div class="lbl">Baralho</div><select class="inp" data-role="deck" style="margin-top:0">' +
      deckOptions(pkg).map(o => '<option value="' + esc(o.id) + '"' + (o.id === d.did ? ' selected' : '') + '>' + esc(o.path) + '</option>').join('') + '</select></div>' : '') +
    '<div data-role="fields"></div>' +
    '<div class="fld"><div class="lbl">Tags</div><input class="inp" data-role="tags" style="margin-top:0" autocapitalize="off" autocorrect="off" spellcheck="false"></div>' +
    '<div class="edfoot">' +
      '<button class="secondary" data-role="pv">Ver prévia</button>' +
      '<div class="preview" data-role="pvbox" hidden></div>' +
      '<button class="primary" data-role="save">' + (isNew ? 'Salvar card' : 'Salvar alterações') + '</button>' +
      '<button class="danger" data-role="cancel">' + (isNew ? 'Descartar' : 'Cancelar') + '</button>' +
    '</div>';
  container.appendChild(box);
  const q = sel => box.querySelector(sel);
  if (isNew) wireDeckSelect(box.querySelector('[data-role=deck]'), pkg);
  q('[data-role=tags]').value = d.tags || '';
  const objUrls = [];
  async function drawFields(){
    const nt = p.notetypes[d.mid] || { flds: ['Frente', 'Verso'] };
    const wrap = q('[data-role=fields]');
    wrap.innerHTML = nt.flds.map((name, i) => '<div class="fld"><div class="lbl" id="' + id + 'l' + i + '">' + esc(name) + '</div><div contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="' + id + 'l' + i + '" data-i="' + i + '"></div></div>').join('');
    wrap.querySelectorAll('[contenteditable]').forEach(el => { el.innerHTML = deferImgs(d.flds[Number(el.dataset.i)] || ''); });
    for (const img of wrap.querySelectorAll('img[data-fsrc]')) {
      const raw = img.getAttribute('data-fsrc');
      img.removeAttribute('data-fsrc');
      let name = raw; try { name = decodeURIComponent(raw); } catch(e){}
      img.dataset.src = raw;
      let url = null;
      if (d.image && d.image.name === name) { url = URL.createObjectURL(d.image.blob); objUrls.push(url); }
      else url = await mediaUrl(pkg, name);
      if (url) img.src = url;
    }
  }
  function readFields(){
    const out = [];
    q('[data-role=fields]').querySelectorAll('[contenteditable]').forEach(el => {
      const t = document.createElement('template'); t.innerHTML = el.innerHTML;
      t.content.querySelectorAll('img[data-src]').forEach(img => { img.setAttribute('src', img.dataset.src); img.removeAttribute('data-src'); });
      out[Number(el.dataset.i)] = t.innerHTML.replace(/(<br\s*\/?>\s*)+$/i, '').replace(/^\s+|\s+$/g, '');
    });
    return out;
  }
  drawFields();
  if (isNew) {
    q('[data-role=nt]').addEventListener('change', e => { const cur = readFields(); d.mid = e.target.value; d.flds = cur; drawFields(); });
  }
  let lastEditable = null;
  box.addEventListener('focusin', e => { if (e.target.isContentEditable) lastEditable = e.target.closest('[contenteditable]'); });
  const tools = q('.tools');
  tools.addEventListener('pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); });
  tools.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const ed = lastEditable;
    if (!ed) { toast('Toque primeiro no texto que quer formatar.'); return; }
    ed.focus();
    try { document.execCommand('styleWithCSS', false, true); } catch(err){}
    if (b.dataset.color) document.execCommand('foreColor', false, b.dataset.color);
    else if (b.dataset.cmd === 'bold') document.execCommand('bold');
    else if (b.dataset.cmd === 'clear') document.execCommand('removeFormat');
    else if (b.dataset.cmd === 'cloze') {
      const s = window.getSelection();
      if (!s.rangeCount || s.isCollapsed) { toast('Selecione a palavra que vai virar lacuna.'); return; }
      const r = s.getRangeAt(0);
      if (!ed.contains(r.commonAncestorContainer)) return;
      const tmp = document.createElement('div'); tmp.appendChild(r.cloneContents());
      let n = 0; for (const f of readFields()) for (const x of C.clozeNumbers(f)) n = Math.max(n, x);
      document.execCommand('insertHTML', false, '{{c' + (n + 1) + '::' + tmp.innerHTML + '}}');
    }
  });
  function collect(){
    const tags = q('[data-role=tags]').value.trim().split(/\s+/).filter(Boolean).join(' ');
    const did = isNew ? q('[data-role=deck]').value : null;
    return { mid: d.mid, flds: readFields(), tags, did };
  }
  q('[data-role=pv]').addEventListener('click', async () => {
    const box2 = q('[data-role=pvbox]');
    if (!box2.hidden) { box2.hidden = true; q('[data-role=pv]').textContent = 'Ver prévia'; return; }
    const v = collect(); const nt = p.notetypes[v.mid];
    const nums = nt.kind === 1 ? [...new Set(v.flds.flatMap(f => [...C.clozeNumbers(f)]))].sort((a,b) => a - b) : [1];
    const ord = nt.kind === 1 ? (nums[0] || 1) - 1 : 0;
    const out = C.renderCard({ flds: v.flds, tags: v.tags }, nt, { ord }, p.decks[v.did || (opts.note && opts.cardDid)] || []);
    box2.innerHTML = '<div class="lbl" style="padding:12px 16px 0;font-size:13px;color:var(--muted);font-weight:700">Frente</div><div class="pv" data-pv="q"></div><div class="lbl" style="padding:0 16px;font-size:13px;color:var(--muted);font-weight:700">Verso</div><div class="pv" data-pv="a"></div>';
    for (const side of ['q','a']) {
      const h = box2.querySelector('[data-pv=' + side + ']'); const root = h.attachShadow({ mode: 'open' });
      let html = out[side];
      if (d.image) html = html.split(d.image.name).join(objUrls[0] || d.image.name);
      await paintInto(root, html, pkg, nt.css);
    }
    box2.hidden = false; q('[data-role=pv]').textContent = 'Esconder prévia';
  });
  q('[data-role=save]').addEventListener('click', async () => {
    const v = collect();
    if (!v.flds.some(f => plainText(f) || /<img/i.test(f))) { toast('O card está vazio.'); return; }
    const btn = q('[data-role=save]'); btn.disabled = true;
    try {
      let res = null;
      if (isNew) res = await saveNewNote(pkg, v, d.image);
      else await saveEdit(pkg, opts.note, v);
      objUrls.forEach(u => URL.revokeObjectURL(u));
      opts.onSaved && opts.onSaved(box, res);
    } catch(e) { toast(e.message || 'Não consegui salvar.'); btn.disabled = false; }
  });
  q('[data-role=cancel]').addEventListener('click', () => { objUrls.forEach(u => URL.revokeObjectURL(u)); opts.onCancel && opts.onCancel(box); });
  return box;
}
function renderOrds(pkg, nt, flds, tags){
  if (nt.kind === 1) {
    const s = new Set(); for (const f of flds) for (const n of C.clozeNumbers(f)) s.add(n);
    return [...s].sort((a, b) => a - b).map(n => n - 1);
  }
  const ords = [];
  nt.tmpls.forEach((t, i) => { const r = C.renderCard({ flds, tags }, nt, { ord: i }, []); if (plainText(r.q) || /<img/i.test(r.q)) ords.push(i); });
  return ords;
}
function uniqueId(base, taken){ let x = base; while (taken(String(x))) x++; return x; }
async function saveNewNote(pkg, v, image){
  const p = A.pkgs.get(pkg); const nt = p.notetypes[v.mid];
  const ords = renderOrds(pkg, nt, v.flds, v.tags);
  if (!ords.length) throw new Error(nt.kind === 1 ? 'Marque pelo menos uma lacuna: selecione a palavra e toque em […].' : 'A frente do card ficou vazia.');
  const now = Date.now();
  const nidNum = uniqueId(now, x => A.cards.has(x));
  const note = { id: String(nidNum), guid: randGuid(), mid: v.mid, flds: nt.flds.map((_, i) => v.flds[i] || ''), tags: v.tags, pkg, local: true, dirty: true, mt: now };
  let next = nidNum + 1;
  const cards = ords.map(ord => { const cid = uniqueId(next, x => A.cards.has(x) || x === note.id); next = cid + 1; return { id: String(cid), nid: note.id, did: v.did, ord, pos: now - 1e14, susp: false, pkg, tags: v.tags, local: true }; });
  const media = [];
  if (image && note.flds.some(f => f.includes(image.name))) media.push({ key: pkg + '/' + image.name, pkg, blob: image.blob, local: true });
  await Store.putMany('notes', [note]); await Store.putMany('cards', cards); await Store.putMany('media', media);
  for (const c of cards) A.cards.set(c.id, c);
  p.count += cards.length; p.pending = (p.pending || 0) + 1;
  await Store.putMany('pkgs', [p]);
  A.noteCache.delete(pkg); mediaCache.delete(pkg + '/' + (image && image.name));
  markNote(note);
  return { cards: cards.map(c => c.id), did: v.did, mid: v.mid, tags: v.tags };
}
async function saveEdit(pkg, note, v){
  const p = A.pkgs.get(pkg); const nt = p.notetypes[note.mid];
  const wasDirty = !!note.dirty;
  const n = Object.assign({}, note, { flds: nt.flds.map((_, i) => v.flds[i] || ''), tags: v.tags, dirty: true, mt: Date.now() });
  delete n._norm;
  const mine = pkgCards(pkg).filter(c => c.nid === note.id);
  const ords = renderOrds(pkg, nt, n.flds, n.tags);
  const changed = [];
  for (const c of mine) { const susp = !ords.includes(c.ord); if (c.tags !== n.tags || c.susp !== susp) { c.tags = n.tags; c.susp = susp; changed.push(c); } }
  let next = Date.now();
  for (const ord of ords) if (!mine.some(c => c.ord === ord)) {
    const cid = uniqueId(next, x => A.cards.has(x)); next = cid + 1;
    const c = { id: String(cid), nid: n.id, did: mine[0] ? mine[0].did : mostUsedDeck(pkg), ord, pos: Date.now() - 1e14, susp: false, pkg, tags: n.tags, local: true };
    A.cards.set(c.id, c); changed.push(c); p.count++;
  }
  await Store.putMany('notes', [n]); await Store.putMany('cards', changed);
  if (!wasDirty) p.pending = (p.pending || 0) + 1;
  await Store.putMany('pkgs', [p]);
  A.noteCache.delete(pkg);
  markNote(n);
}
RENDER.edit = async function(params){
  const p = A.pkgs.get(params.pkg);
  show('edit', 'Editar card', true);
  const mount = $('editMount'); mount.innerHTML = '';
  const note = await Store.get('notes', params.nid);
  if (!note) { mount.innerHTML = '<p class="note">Este card não existe mais.</p>'; return; }
  const c0 = pkgCards(p.id).find(c => c.nid === note.id);
  mountEditor(mount, { pkg: p.id, note, cardDid: c0 && c0.did,
    onSaved: () => { toast('Alterações salvas.'); back(); },
    onCancel: () => back() });
};

// ---------- wrong question → card ----------
let wImage = null, wAbort = null;
const W = { ctx:null, recId:null, area:'', pat:'' };
const wType = () => document.querySelector('input[name=wType]:checked').value;
function drawWChips(){
  $('wArea').innerHTML = AREAS.map(a => '<button class="chip" data-area="' + a[0] + '" aria-pressed="' + (W.area === a[0]) + '">' + esc(a[2]) + '</button>').join('');
  $('wPat').innerHTML = PADROES.map(p => '<button class="chip" data-pat="' + p[0] + '" aria-pressed="' + (W.pat === p[0]) + '">' + esc(p[1]) + '</button>').join('');
}
$('wArea').addEventListener('click', e => { const b = e.target.closest('[data-area]'); if (!b) return; W.area = W.area === b.dataset.area ? '' : b.dataset.area; drawWChips(); });
$('wPat').addEventListener('click', e => { const b = e.target.closest('[data-pat]'); if (!b) return; W.pat = W.pat === b.dataset.pat ? '' : b.dataset.pat; drawWChips(); });
function updateWrongMode(){
  const leit = wType() === 'leitura';
  $('wMethod').hidden = !leit;
  $('wImgInCard').closest('label').hidden = leit;
  $('wManual').hidden = leit;
  $('wForce').hidden = !leit || !sampleFn;
  $('wGo').textContent = leit ? 'Registrar no catálogo' : 'Gerar card';
  $('wGo').hidden = leit ? false : !sampleFn;
}
document.querySelectorAll('input[name=wType]').forEach(r => r.addEventListener('change', () => { $('wOut').innerHTML = ''; updateWrongMode(); }));
function captureCtx(){
  W.ctx = { pkg: $('wPkg').value, q: $('wQ').value.trim(), a: $('wA').value.trim(), why: $('wWhy').value.trim(), fonte: $('wSrc').value.trim(),
    area: W.area, tema: '', motivo: wType(), padrao: W.pat, nota: $('wLesson').value.trim(), photo: wImage ? wImage.blob : null };
  W.recId = null;
  return W.ctx;
}
function errFromCtx(ctx, cards){
  return { id: newErrId(), t: Date.now(), pkg: ctx.pkg, q: ctx.q, a: ctx.a, why: ctx.why, fonte: ctx.fonte, area: ctx.area, tema: ctx.tema,
    motivo: ctx.motivo, padrao: ctx.motivo === 'leitura' ? ctx.padrao : '', nota: ctx.nota, photo: ctx.photo || null, cards: cards || [] };
}
function linkCards(res){
  if (!W.ctx || !res) return;
  if (!W.ctx.tema) { const dk = deckOptions(W.ctx.pkg).find(o => o.id === res.did); if (dk) W.ctx.tema = dk.path.split('::').pop(); }
  if (W.recId && A.errors.has(W.recId)) { const r = A.errors.get(W.recId); r.cards = (r.cards || []).concat(res.cards); saveError(r); }
  else { const r = saveError(errFromCtx(W.ctx, res.cards)); W.recId = r.id; }
}
function registerReading(){
  if (!W.pat) { toast('Escolha o tipo de erro de leitura.'); return; }
  const ctx = captureCtx();
  if (!ctx.q && !ctx.photo && !ctx.nota) { toast('Cole a questão ou escreva a lição.'); $('wQ').focus(); return; }
  const r = saveError(errFromCtx(ctx, []));
  W.recId = r.id;
  $('wOut').innerHTML = '<div class="paper" style="margin-top:16px"><div class="head"><span>Catálogo de método</span><span>' + esc(padraoName(r.padrao)) + '</span></div><div class="body"><p style="margin:0">Registrado. Ele aparece no Caderno de erros, na aba Catálogo de método.</p></div></div>';
  afterDraft();
}
RENDER.wrong = function(params){
  show('wrong', 'Questão errada', true);
  const sel = $('wPkg');
  sel.innerHTML = [...A.pkgs.values()].map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
  if (params.pkg && A.pkgs.has(params.pkg)) sel.value = params.pkg;
  $('wrongPkgField').hidden = A.pkgs.size < 2;
  if (params.fresh && !params.back) resetWrong();
  drawWChips();
  checkSample().then(updateWrongMode);
};
function resetWrong(){
  $('wQ').value = ''; $('wA').value = ''; $('wWhy').value = ''; $('wSrc').value = ''; $('wLesson').value = '';
  document.querySelector('input[name=wType][value=conteudo]').checked = true;
  W.pat = ''; W.ctx = null; W.recId = null; drawWChips();
  setWImage(null); $('wOut').innerHTML = ''; $('wGo').disabled = false; updateWrongMode();
}
function setWImage(img){
  if (wImage && wImage.url) URL.revokeObjectURL(wImage.url);
  wImage = img;
  $('wThumb').hidden = !img; $('wImgPickWrap').hidden = !!img;
  if (img) $('wThumbImg').src = img.url;
}
$('wImgPick').addEventListener('click', () => { $('imgFile').value = ''; $('imgFile').click(); });
$('wImgClear').addEventListener('click', () => setWImage(null));
$('imgFile').addEventListener('change', async () => {
  const f = $('imgFile').files[0]; if (!f) return;
  try { const blob = await shrinkImage(f); setWImage({ blob, url: URL.createObjectURL(blob) }); }
  catch(e) { toast('Não consegui abrir esta imagem. Tente uma foto em JPG ou PNG.'); }
});
let sampleFn = null, sampleImages = false;
async function checkSample(){
  if (sampleFn !== null) return sampleFn;
  try {
    sampleFn = (window.claude && window.claude.use) ? await window.claude.use('sample') : false;
    if (sampleFn) { const lim = await sampleFn.limits().catch(() => null); sampleImages = !!(lim && lim.images); }
  } catch(e) { sampleFn = false; }
  if (!sampleFn) { if (wType() !== 'leitura') { $('wGo').hidden = true; if (!$('wOut').innerHTML) $('wOut').innerHTML = '<p class="note">Gerar com o Claude não está disponível aqui. Escreva o card você mesmo; ele segue as mesmas regras de tipo de nota e baralho.</p>'; } }
  return sampleFn;
}
function buildPrompt(pkg, info){
  const p = A.pkgs.get(pkg);
  const nts = ntOptions(pkg).slice(0, 8).map(o => ({
    nome: o.nt.name, tipo: o.nt.kind === 1 ? 'lacunas (cloze)' : 'frente/verso',
    campos: o.nt.flds, frente_template: (o.nt.tmpls[0] || {}).q ? o.nt.tmpls[0].q.slice(0, 260) : ''
  }));
  const decks = deckOptions(pkg).map(o => o.path).slice(0, 200);
  const sit = { conteudo: 'Errou por falta de conteúdo.', raciocinio: 'Sabia o conteúdo, mas errou o raciocínio: o card deve cobrar o passo de decisão que falhou.', acertei: 'Acertou com dúvida e quer fixar o ponto.', leitura: 'Errou por leitura, mas pediu o card mesmo assim.' }[info.type];
  const legend = COLORS.map(([c, n]) => c + ' (' + n + ') = ' + colorMeaning(c)).join('; ');
  return [
    'Transforme esta questão de prova de residência médica em flashcard para o caderno de erros do estudante no Anki.',
    '',
    'Regras do molde dele (siga à risca):',
    '- 1 card por questão. Só faça 2 se houver um segundo ângulo realmente cobrável e diferente. Nunca mais de 2.',
    '- Atomicidade: cada card cobra um único fato ou decisão.',
    '- Regra dos 15 segundos: a resposta precisa sair em até 15 segundos. Card curto, nada denso.',
    '- A frente é uma cena clínica curta ou uma pergunta de decisão (ex.: "Gestante de 28 semanas com … → conduta?").',
    '- Em lacunas, use o formato (Assunto) + Comando + omissão: comece com o tema entre parênteses, depois o comando, e omita só a palavra decisiva com {{c1::resposta}} (dica opcional: {{c1::resposta::dica}}).',
    '- Pode usar frente/verso em vez de lacunas quando isso fixar melhor.',
    '- Mire no conceito que causou o erro, não em detalhes laterais da questão.',
    '- Destaque a palavra-chave com <b>…</b>. Use só HTML simples (<b>, <i>, <br>, <span style="color:#HEX">).',
    '- Cores com significado fixo: pinte de 1 a 3 palavras-chave por card com <span style="color:#HEX">…</span>, só quando o significado se aplicar: ' + legend + '. Nunca pinte dentro da lacuna {{c1::…}}. Se nenhuma cor se aplicar, não pinte.',
    '- Tags: 3 a 5, sem espaços (use _). Inclua a fonte se aparecer (ex.: USP_2024_Q61), o tema e caderno_de_erros.',
    '- Português do Brasil, linguagem de prova.',
    '',
    'Tipos de nota disponíveis (use o nome exato e preencha os campos pelo nome exato; campos que não fizerem sentido ficam vazios):',
    JSON.stringify(nts),
    '',
    'Baralhos disponíveis (escolha o caminho exato do tema mais adequado):',
    JSON.stringify(decks),
    '',
    'Questão:', info.q.slice(0, 6000),
    '',
    'Gabarito e comentário:', (info.a || '(não informado)').slice(0, 6000),
    '',
    'O que o estudante marcou e por quê:', (info.why || '(não informado)').slice(0, 2000),
    '',
    'Situação: ' + sit,
    'Fonte informada pelo estudante: ' + (info.fonte || '(não informada)'),
    'Grande área informada pelo estudante: ' + (info.area ? areaName(info.area) : '(não informada, classifique)'),
    info.hasImage ? ('A imagem anexada faz parte da questão.' + (info.imgInCard ? ' Coloque o marcador [[IMAGEM]] no campo onde a imagem deve aparecer no card (normalmente na frente).' : ' Não coloque a imagem no card.')) : '',
    '',
    'Responda só com JSON neste formato:',
    '{"registro":{"area":"uma de: ' + AREAS.map(a => a[1]).join(', ') + '","tema":"tema curto da questão, ex.: Vulvovaginites","fonte":"banca ano e número da questão, se aparecerem; senão vazio"},"cards":[{"notetype":"nome exato","deck":"caminho exato","fields":{"Campo":"html"},"tags":["tag1","tag2"],"angulo":"o que este card cobra, em uma frase"}]}'
  ].join('\n');
}
function sampleErrorText(code){
  return ({
    not_granted: 'Você não permitiu o uso do Claude nesta página. Dá para escrever o card você mesmo.',
    rate_limited: 'Muitos pedidos seguidos. Espere um minuto e tente de novo.',
    invalid_json: 'A resposta veio fora do formato. Toque em gerar de novo.',
    refused: 'O Claude não quis gerar este card. Tente reformular ou escreva você mesmo.',
    image_rejected: 'A imagem não foi aceita. Tente outra foto ou gere sem imagem.',
    images_unavailable: 'Enviar imagens não está disponível aqui. Tire a foto e gere de novo.',
    prompt_too_large: 'A questão ficou longa demais. Corte o comentário e tente de novo.',
    session_expired: 'Sua sessão expirou. Recarregue a página.',
    sampling_disabled: 'O uso do Claude está desligado nesta conta. Escreva o card você mesmo.'
  })[code] || 'Não consegui gerar o card agora. Tente de novo.';
}
$('wGo').addEventListener('click', () => generateCards(false));
$('wForce').addEventListener('click', () => generateCards(true));
$('wManual').addEventListener('click', () => {
  const pkg = $('wPkg').value; const ntOpt = ntOptions(pkg, 1)[0];
  captureCtx();
  $('wOut').innerHTML = '';
  const img = wImage && $('wImgInCard').checked ? { name: 'fichario-' + Date.now() + '.jpg', blob: wImage.blob } : null;
  const flds = ntOpt.nt.flds.map(() => '');
  if (img) flds[0] = '<img src="' + img.name + '">';
  addDraftEditor(pkg, { mid: ntOpt.id, flds, tags: 'caderno_de_erros', did: mostUsedDeck(pkg), image: img }, null, 1, 1);
});
async function generateCards(force){
  const pkg = $('wPkg').value;
  const type = wType();
  if (type === 'leitura' && !force) { registerReading(); return; }
  const info = { q: $('wQ').value.trim(), a: $('wA').value.trim(), why: $('wWhy').value.trim(), type, hasImage: !!wImage && sampleImages, imgInCard: $('wImgInCard').checked, fonte: $('wSrc').value.trim(), area: W.area };
  if (!info.q && !wImage) { toast('Cole o enunciado ou escolha a foto da questão.'); $('wQ').focus(); return; }
  captureCtx();
  if (!info.q) info.q = '(enunciado na imagem anexada)';
  const out = $('wOut');
  const sample = await checkSample();
  if (!sample) return;
  if (wAbort) wAbort.abort();
  wAbort = new AbortController();
  out.innerHTML = '<div class="thinking"><span class="spinner" aria-hidden="true"></span><span>Montando o card no seu molde…</span><button class="textbtn" id="wStop">Parar</button></div>';
  $('wStop').addEventListener('click', () => wAbort && wAbort.abort());
  $('wGo').disabled = true;
  const imgName = 'fichario-' + Date.now() + '.jpg';
  try {
    const opts = { signal: wAbort.signal, modelTier: 'default' };
    if (info.hasImage) opts.images = [wImage.blob];
    const res = await sample.json(buildPrompt(pkg, info), opts);
    const cards = (res && Array.isArray(res.cards) ? res.cards : []).slice(0, 2);
    const reg = res && res.registro && typeof res.registro === 'object' ? res.registro : {};
    if (W.ctx) {
      if (!W.ctx.area) W.ctx.area = areaFromText(reg.area);
      if (!W.ctx.fonte && reg.fonte) W.ctx.fonte = String(reg.fonte).trim();
      if (reg.tema) W.ctx.tema = String(reg.tema).trim();
    }
    out.innerHTML = '';
    if (!cards.length) { out.innerHTML = '<p class="note">Nenhum card veio na resposta. Tente de novo ou escreva você mesmo.</p>'; return; }
    const p = A.pkgs.get(pkg);
    const decks = deckOptions(pkg);
    cards.forEach((c, i) => {
      const opt = ntOptions(pkg).find(o => o.nt.name === c.notetype) || ntOptions(pkg).find(o => norm(o.nt.name) === norm(c.notetype)) || ntOptions(pkg, 1)[0];
      const nt = opt.nt;
      const fields = c.fields && typeof c.fields === 'object' ? c.fields : {};
      let flds = nt.flds.map(name => { const k = Object.keys(fields).find(x => x === name) || Object.keys(fields).find(x => norm(x) === norm(name)); return k ? String(fields[k] || '') : ''; });
      if (!flds.some(Boolean)) { const vals = Object.values(fields).map(String); flds = nt.flds.map((_, j) => vals[j] || ''); }
      let image = null;
      if (wImage && info.imgInCard) {
        image = { name: imgName, blob: wImage.blob };
        const tag = '<img src="' + imgName + '">';
        if (flds.some(f => f.includes('[[IMAGEM]]'))) flds = flds.map(f => f.split('[[IMAGEM]]').join(tag));
        else if (i === 0) flds[0] = (flds[0] ? flds[0] + '<br>' : '') + tag;
      } else flds = flds.map(f => f.split('[[IMAGEM]]').join(''));
      const deck = decks.find(o => o.path === c.deck) || decks.find(o => norm(o.path) === norm(c.deck)) || decks.find(o => o.id === mostUsedDeck(pkg));
      const tags = (Array.isArray(c.tags) ? c.tags : String(c.tags || '').split(/\s+/)).map(t => String(t).trim().replace(/\s+/g, '_')).filter(Boolean).join(' ');
      addDraftEditor(pkg, { mid: opt.id, flds, tags, did: deck.id, image }, c.angulo || c.angle, i + 1, cards.length);
    });
  } catch(e) {
    if (e && e.code === 'cancelled') { out.innerHTML = ''; return; }
    out.innerHTML = '<p class="note" style="color:var(--again)">' + esc(sampleErrorText(e && e.code)) + '</p>';
    if (e && e.code === 'not_granted') { sampleFn = false; $('wGo').hidden = true; }
  } finally { $('wGo').disabled = false; wAbort = null; }
}
function addDraftEditor(pkg, draft, angle, i, total){
  const out = $('wOut');
  mountEditor(out, { pkg, draft, angle, title: total > 1 ? 'Card ' + i + ' de ' + total : 'Card proposto',
    onSaved: (box, res) => { box.remove(); linkCards(res); toast('Card salvo e ligado ao erro. Ele entra primeiro na fila de novos.'); afterDraft(); },
    onCancel: box => { box.remove(); afterDraft(); } });
}
function afterDraft(){
  if ($('wOut').querySelector('.editor')) return;
  const keep = $('wOut').querySelector('.paper');
  const offer = W.ctx && !W.recId;
  $('wOut').innerHTML = (keep ? keep.outerHTML : '') + '<div class="stack">' + (offer ? '<button class="secondary" id="wRegOnly">Registrar o erro sem card</button>' : '') + '<button class="primary" id="wAgain">Outra questão</button><button class="secondary" id="wBack">Voltar</button></div>';
  if (offer) $('wRegOnly').addEventListener('click', () => { const r = saveError(errFromCtx(W.ctx, [])); W.recId = r.id; toast('Erro registrado no caderno.'); afterDraft(); });
  $('wAgain').addEventListener('click', () => { resetWrong(); window.scrollTo(0, 0); $('wQ').focus(); });
  $('wBack').addEventListener('click', () => { resetWrong(); back(); });
}

// ---------- export to Anki (text file) ----------
async function exportPending(pkg){
  const p = A.pkgs.get(pkg);
  const notes = (await Store.getByIndex('notes', pkg)).filter(n => n.dirty);
  if (!notes.length) { p.pending = 0; await Store.putMany('pkgs', [p]); RENDER.deck({ pkg }); return; }
  if (notes.some(n => !n.guid)) { toast('Importe o .apkg deste deck de novo uma vez para liberar a exportação.'); return; }
  progress('Preparando o arquivo', 'Exportando');
  try {
    const byNote = cardsByNote(pkg);
    const qv = s => '"' + String(s).replace(/"/g, '""') + '"';
    const lines = ['#separator:tab', '#html:true', '#guid column:1', '#notetype column:2', '#deck column:3', '#tags column:4'];
    let imgs = 0;
    for (const n of notes) {
      const nt = p.notetypes[n.mid]; if (!nt) continue;
      const cs = byNote.get(n.id) || [];
      const deck = cs.length ? deckPathStr(pkg, cs[0].did) : '';
      const flds = [];
      for (const f of n.flds) {
        let out = f;
        const names = [...f.matchAll(/<img[^>]+src="([^"]+)"/gi)].map(m => m[1]);
        for (const name of names) {
          if (/^(https?:|data:)/i.test(name)) continue;
          const rec = await Store.get('media', pkg + '/' + name);
          if (rec && rec.local) { out = out.split('src="' + name + '"').join('src="' + await blobToDataUrl(rec.blob) + '"'); imgs++; }
        }
        flds.push(out);
      }
      lines.push([n.guid, nt.name, deck, n.tags].concat(flds).map(qv).join('\t'));
    }
    const d = new Date();
    const fname = 'fichario-' + norm(p.name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0') + '.txt';
    progressHide();
    await saveFile(fname, lines.join('\n') + '\n', 'text/plain');
    const now = Date.now();
    for (const n of notes) { n.dirty = false; n.exportedAt = now; delete n._norm; }
    await Store.putMany('notes', notes);
    for (const n of notes) markNote(n);
    p.pending = 0; await Store.putMany('pkgs', [p]);
    A.noteCache.delete(pkg);
    RENDER.deck({ pkg });
    toast('Arquivo salvo. No Anki do computador: Arquivo › Importar e escolha o arquivo.' + (imgs ? ' As imagens vão dentro do arquivo.' : ''));
  } catch(e) {
    progressHide();
    if (e && e.code === 'declined') return;
    toast(e && e.code === 'rate_limited' ? 'Já há um arquivo esperando sua confirmação.' : 'Não consegui salvar o arquivo.');
  }
}


// ---------- progress back to Anki (debug-console script) ----------
function phoneReviewed(p){
  const out = [];
  for (const c of pkgCards(p.id)) { const st = A.states.get(c.id); if (st && st.st > 0 && (st.p || (st.u || 0) > (p.importedAt || 0))) out.push([c, st]); }
  return out;
}
const PY = [
'# Fichário → Anki: progresso das revisões e pastas reorganizadas no celular',
'# Como usar no Anki do computador:',
'#   1. Faça um backup: Arquivo › Criar backup.',
'#   2. Abra o Console de Depuração: Ctrl+Shift+; (Windows e Linux) ou Cmd+Shift+; (Mac).',
'#   3. Cole TODO este texto na caixa de cima e aperte Ctrl+Enter (Cmd+Enter no Mac).',
'# Se você também exportou cards novos (.txt), importe esse arquivo no Anki antes de rodar este.',
'# Cards revisados depois no computador são pulados. Rodar duas vezes não duplica nada.',
'import json',
"DATA = json.loads(r'" + "''__DATA__''" + "')",
'col = mw.col',
'try:',
'    from anki.cards import FSRSMemoryState',
'except Exception:',
'    FSRSMemoryState = None',
'cutoff = col.sched.day_cutoff',
'today = col.sched.today',
'def day_of(ts):',
'    if ts < cutoff:',
'        return today - int((cutoff - ts - 1) // 86400)',
'    return today + 1 + int((ts - cutoff) // 86400)',
'def find(e):',
"    row = col.db.first('select c.id from cards c join notes n on n.id = c.nid where c.id = ? and n.guid = ?', int(e['c']), e['g'])",
'    if row:',
'        return row[0]',
"    row = col.db.first('select c.id from cards c join notes n on n.id = c.nid where n.guid = ? and c.ord = ?', e['g'], e['o'])",
'    return row[0] if row else None',
'moved = 0',
'move_err = []',
"for m in sorted(DATA.get('moves', []), key=lambda m: m['to'].count('::')):",
'    try:',
'        d = None',
"        if str(m['did']).isdigit():",
"            d = col.decks.get(int(m['did']), default=False)",
'        if not d:',
"            d = col.decks.by_name(m['from'])",
"        if not d or d['name'] == m['to']:",
'            continue',
"        target = col.decks.by_name(m['to'])",
"        if target and target['id'] != d['id']:",
"            cids = col.decks.cids(d['id'], children=False)",
'            if cids:',
"                col.set_deck(cids, target['id'])",
"            if not col.decks.children(d['id']) and not col.decks.cids(d['id'], children=True):",
"                col.decks.remove([d['id']])",
'        else:',
"            col.decks.rename(d, m['to'])",
'        moved += 1',
'    except Exception as ex:',
"        move_err.append(m['to'] + ': ' + str(ex))",
'applied = skipped = missing = added = 0',
'idmap = {}',
'changed = []',
"for e in DATA['cards']:",
'    cid = find(e)',
'    if not cid:',
'        missing += 1',
'        continue',
"    idmap[str(e['c'])] = cid",
"    last = col.db.scalar('select max(id) from revlog where cid = ? and type < 4', cid) or 0",
'    card = col.get_card(cid)',
"    last = max(last, (getattr(card, 'last_review_time', 0) or 0) * 1000)",
"    if last >= e['lr'] - 1000:",
'        skipped += 1',
'        continue',
'    susp = card.queue == -1',
'    if card.odid:',
'        card.did = card.odid',
'        card.odid = 0',
'        card.odue = 0',
"    if e['st'] == 2:",
'        card.type = 2',
'        card.queue = 2',
"        card.ivl = max(1, int(e['sd']))",
"        card.due = day_of(e['lr'] / 1000) + card.ivl",
'        card.left = 0',
'        if not card.factor:',
'            card.factor = 2500',
'    else:',
"        card.type = 1 if e['st'] == 1 else 3",
'        card.queue = 1',
"        card.due = int(e['d'] / 1000)",
'        card.left = 1',
"        if e['st'] == 1:",
'            card.ivl = 0',
'    if susp:',
'        card.queue = -1',
"    card.reps = max(card.reps, int(e['r']))",
"    card.lapses = max(card.lapses, int(e['l']))",
"    if FSRSMemoryState and e.get('s'):",
"        card.memory_state = FSRSMemoryState(stability=float(e['s']), difficulty=float(e['f']))",
"    if hasattr(card, 'last_review_time'):",
"        card.last_review_time = int(e['lr'] / 1000)",
'    changed.append(card)',
'    applied += 1',
"for r in DATA['revlog']:",
'    cid = idmap.get(str(r[1]))',
'    if not cid:',
'        continue',
"    if col.db.scalar('select count() from revlog where id = ?', r[0]):",
'        continue',
"    col.db.execute('insert into revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type) values (?, ?, -1, ?, ?, ?, ?, ?, ?)', r[0], cid, r[2], r[3], r[4], r[5], r[6], r[7])",
'    added += 1',
'if changed:',
'    col.update_cards(changed)',
'try:',
'    mw.reset()',
'except Exception:',
'    pass',
"print('Fichário: %d pastas reorganizadas, %d cards atualizados, %d já estavam mais novos no computador, %d não encontrados, %d revisões adicionadas ao histórico.' % (moved, applied, skipped, missing, added))",
'for e in move_err:',
"    print('Pasta não movida: ' + e)",
''].join('\n');
async function exportProgress(pkg){
  const p = A.pkgs.get(pkg);
  const list = phoneReviewed(p);
  const moves = pendingMoves(p);
  if (!list.length && !moves.length) { toast('Nenhum card revisado nem pasta reorganizada aqui ainda.'); return; }
  const notes = await Store.getByIndex('notes', pkg); const byId = new Map(notes.map(n => [n.id, n]));
  if (list.some(([c]) => { const n = byId.get(c.nid); return n && !n.guid; })) { toast('Importe o .apkg deste deck de novo uma vez para liberar a exportação.'); return; }
  const cards = [];
  for (const [c, st] of list) {
    const n = byId.get(c.nid); if (!n) continue;
    cards.push({ c: c.id, g: n.guid, o: c.ord, st: st.st, d: st.d, s: +(+st.s).toFixed(4), f: +(+st.f).toFixed(4), sd: st.sd || 0, r: st.r || 0, l: st.l || 0, lr: st.lr || st.u });
  }
  const revlog = (await Store.getByIndex('revlog', pkg)).sort((a, b) => a.id - b.id).map(r => [r.id, r.cid, r.ease, r.ivl, r.lastIvl, r.factor, r.time, r.type]);
  const script = PY.replace('__DATA__', JSON.stringify({ cards, revlog, moves }));
  const d = new Date();
  const fname = 'fichario-progresso-' + norm(p.name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0') + '.txt';
  try {
    await saveFile(fname, script, 'text/plain');
    p.progressExportedAt = Date.now(); await Store.putMany('pkgs', [p]);
    RENDER.deck({ pkg });
    toast('Arquivo salvo. No computador, siga os 3 passos escritos no topo do arquivo.');
  } catch(e) {
    if (e && e.code === 'declined') return;
    toast(e && e.code === 'rate_limited' ? 'Já há um arquivo esperando sua confirmação.' : 'Não consegui salvar o arquivo.');
  }
}

// ---------- import ----------
const MIME = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', avif:'image/avif', bmp:'image/bmp',
  mp3:'audio/mpeg', m4a:'audio/mp4', ogg:'audio/ogg', oga:'audio/ogg', wav:'audio/wav', opus:'audio/ogg', aac:'audio/aac', mp4:'video/mp4', webm:'video/webm' };
const mimeOf = n => MIME[(String(n).split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
let sqlPromise = null;
function pickFile(){ $('file').value = ''; $('file').click(); }
for (const id of ['importBtn','importBtn2','reimportBtn']) $(id).addEventListener('click', pickFile);
$('file').addEventListener('change', () => { const f = $('file').files[0]; if (f) importFile(f); });
async function importFile(file){
  try {
    progress('Preparando o leitor de decks');
    await Promise.all([loadScript(CDN.jszip), loadScript(CDN.fzstd), loadScript(CDN.sql)]);
    if (!sqlPromise) sqlPromise = window.initSqlJs();
    const SQL = await sqlPromise;
    progress('Abrindo ' + file.name);
    const buf = await file.arrayBuffer();
    let r;
    try { r = await C.parseApkg(buf, { JSZip: window.JSZip, fzstd: window.fzstd, SQL }, m => progress(m)); }
    catch(e) { throw new Error(/Anki/.test(e && e.message || '') ? e.message : 'Não consegui ler este arquivo. No Anki do computador, exporte de novo como Pacote de baralho do Anki (.apkg).'); }
    if (!r.cards.length) throw new Error('O arquivo não tem nenhum card.');
    progress('Guardando ' + r.cards.length + ' cards');
    const pkgId = 'p' + hashStr(r.name).toString(36);
    const old = A.pkgs.get(pkgId);
    const notes = r.notes.map(n => ({ id: n.id, guid: n.guid, mid: n.mid, flds: n.flds, tags: n.tags, pkg: pkgId }));
    const noteById = new Map(notes.map(n => [n.id, n])), noteByGuid = new Map(notes.map(n => [n.guid, n]));
    const cards = r.cards.map(c => ({ id: c.id, nid: c.nid, did: c.did, ord: c.ord, pos: c.pos, susp: c.susp, pkg: pkgId, tags: (noteById.get(c.nid) || {}).tags || '' }));
    const media = r.media.map(m => ({ key: pkgId + '/' + m.name, pkg: pkgId, blob: new Blob([m.bytes], { type: mimeOf(m.name) }) }));
    const ntUse = {}; for (const n of notes) ntUse[n.mid] = (ntUse[n.mid] || 0) + 1;
    const pkg = { id: pkgId, name: r.name, notetypes: r.notetypes, decks: r.decks, ankiPaths: JSON.parse(JSON.stringify(r.decks)), importedAt: Date.now(), count: cards.length, hist: r.hist || {}, ntUse, pending: 0 };
    const remapped = [];
    const states = []; let brought = 0;
    for (const c of r.cards) {
      if (!c.sched) continue;
      const s = Object.assign({}, c.sched, { u: c.sched.lr || 1 });
      const ex = A.states.get(c.id);
      if (!ex || (ex.u || 0) < s.u) { states.push([c.id, s]); brought++; }
    }
    // keep what was created or edited on the phone
    const dropNotes = [], dropCards = [], keptCards = [];
    let pending = 0;
    if (old) {
      const oldNotes = await Store.getByIndex('notes', pkgId);
      const target = new Map();
      for (const on of oldNotes) {
        if (on.local) {
          const match = on.guid && noteByGuid.get(on.guid);
          if (match) { target.set(on.id, match.id); dropNotes.push(on.id); if (on.dirty && (on.mt || 0) > (on.exportedAt || 0)) { match.flds = on.flds; match.tags = on.tags; match.dirty = true; match.mt = on.mt; pending++; } }
          else {
            target.set(on.id, on.id); if (on.dirty) pending++;
            const ont = old.notetypes[on.mid];
            if (!pkg.notetypes[on.mid] && ont && ont.scratch) {
              const tgt = Object.entries(pkg.notetypes).filter(([, nt]) => nt.kind === ont.kind && !nt.scratch).sort((a, b) => (ntUse[b[0]] || 0) - (ntUse[a[0]] || 0))[0];
              if (tgt) {
                const nf = tgt[1].flds.map((_, i) => on.flds[i] || '');
                if (on.flds.length > nf.length && nf.length) nf[nf.length - 1] = [nf[nf.length - 1]].concat(on.flds.slice(nf.length)).filter(Boolean).join('<br>');
                on.flds = nf; on.mid = tgt[0]; on.mt = Date.now(); on.dirty = true; delete on._norm; remapped.push(on);
              } else pkg.notetypes[on.mid] = ont;
            } else if (!pkg.notetypes[on.mid] && ont) pkg.notetypes[on.mid] = ont;
          }
        } else if (on.dirty) {
          const m = noteById.get(on.id);
          if (m) { m.flds = on.flds; m.tags = on.tags; m.dirty = true; m.mt = on.mt; pending++; }
        }
      }
      for (const oc of pkgCards(pkgId).filter(c => c.local)) {
        const tn = target.has(oc.nid) ? target.get(oc.nid) : oc.nid;
        const nc = cards.find(c => c.nid === tn && c.ord === oc.ord);
        if (nc) {
          const st = A.states.get(oc.id);
          const ex = states.find(x => x[0] === nc.id); const cur = ex ? ex[1] : A.states.get(nc.id);
          if (st && (!cur || (cur.u || 0) < (st.u || 0))) { states.push([nc.id, st]); }
          dropCards.push(oc.id);
        } else {
          keptCards.push(oc);
          if (!pkg.decks[oc.did] && old.decks[oc.did]) pkg.decks[oc.did] = old.decks[oc.did];
        }
      }
      for (const n of notes) if (n.dirty) for (const c of cards) if (c.nid === n.id) c.tags = n.tags;
    }
    pkg.pending = pending;
    pkg.count = cards.length + keptCards.length;
    if (old && old.customDecks) {
      pkg.customDecks = {};
      for (const did in old.customDecks) {
        const cd = old.customDecks[did];
        if (cd.anki) { if (pkg.decks[did]) { pkg.customDecks[did] = cd; if (!cd.del) pkg.decks[did] = cd.path.slice(); } continue; }
        pkg.customDecks[did] = cd;
        if (cd.del) continue;
        const ps = cd.path.join('::');
        const ankiDid = Object.keys(pkg.decks).find(d => !(old.customDecks[d] && !old.customDecks[d].anki) && pkg.ankiPaths[d] && pkg.ankiPaths[d].join('::') === ps);
        if (ankiDid) { for (const c of keptCards) if (c.did === did) c.did = ankiDid; }
        else pkg.decks[did] = cd.path.slice();
      }
    }
    await Store.importPkg(pkg, notes, cards, media);
    if (keptCards.length) await Store.putMany('cards', keptCards);
    if (remapped.length) { await Store.putMany('notes', remapped); for (const n of remapped) markNote(n); }
    await Store.deleteMany('notes', dropNotes); await Store.deleteMany('cards', dropCards);
    await Store.putStates(states);
    for (const [id, c] of A.cards) if (c.pkg === pkgId) A.cards.delete(id);
    for (const c of cards.concat(keptCards)) A.cards.set(c.id, c);
    for (const [cid, s] of states) { A.states.set(cid, s); R.dirty.add(bucketOf(cid)); }
    A.pkgs.set(pkgId, pkg);
    A.noteCache.delete(pkgId); mediaCache.clear();
    scheduleSync(1500);
    progressHide();
    toast(cards.length + ' cards importados' + (brought ? ', com o progresso que já vinha do Anki.' : '.'));
    go('deck', { pkg: pkgId }, { reset:true });
    NAV.unshift({ name: 'home', params: {} });
    if (R.db) { R.decksDirty = true; scheduleSync(); }
    if (R.db) pullDecks().then(d => pullNotes().then(n => { if (n) toast(n === 1 ? '1 card dos seus outros aparelhos entrou neste deck.' : n + ' cards dos seus outros aparelhos entraram neste deck.'); if (n || d) refresh(); })).catch(()=>{});
  } catch(e) { progressError((e && e.message) || 'Algo deu errado na importação.'); }
}

// ---------- export as .apkg ----------
// Two taps on purpose: building the file takes a moment, and the phone only opens the
// share sheet right after a tap. First tap builds, second tap saves.
const APKG = { pkg: null, blob: null, name: '' };
function resetApkg(){ APKG.pkg = null; APKG.blob = null; APKG.name = ''; $('apkgBtn').textContent = 'Preparar arquivo .apkg'; $('apkgNote').textContent = ''; }
async function exportApkg(pkg){
  if (APKG.blob && APKG.pkg === pkg) {
    try { await saveFile(APKG.name, APKG.blob, 'application/octet-stream'); toast('Pronto. Abra o arquivo no Anki, ou importe aqui no Fichário de outro aparelho.'); }
    catch(e) { if (!(e && e.code === 'declined')) toast('Não consegui salvar o arquivo.'); }
    return;
  }
  const p = A.pkgs.get(pkg); if (!p) return;
  try {
    progress('Preparando o gerador de decks', 'Exportando');
    await Promise.all([loadScript(CDN.jszip), loadScript(CDN.sql)]);
    if (!sqlPromise) sqlPromise = window.initSqlJs();
    const SQL = await sqlPromise;
    const withProgress = $('apkgProgress').checked;
    const notes = await Store.getByIndex('notes', pkg);
    const cards = pkgCards(pkg);
    if (!cards.length) throw new Error('Este deck ainda não tem cards para exportar.');
    const decks = {};
    for (const c of cards) if (!decks[c.did]) { const path = deckPathStr(pkg, c.did); decks[c.did] = path ? path.split('::') : [p.name]; }
    const revlog = withProgress ? await Store.getByIndex('revlog', pkg) : [];
    progress('Lendo imagens e áudios', 'Exportando');
    const media = [];
    for (const m of await Store.getByIndex('media', pkg)) {
      if (!m.blob) continue;
      media.push({ name: m.key.slice(pkg.length + 1), bytes: new Uint8Array(await m.blob.arrayBuffer()) });
    }
    const out = await C.buildApkg({ name: p.name, notetypes: p.notetypes, decks, notes, cards, states: A.states, revlog, media, withProgress },
      { JSZip: window.JSZip, SQL }, m => progress(m, 'Exportando'));
    const d = new Date();
    APKG.pkg = pkg;
    APKG.blob = new Blob([out.bytes], { type: 'application/octet-stream' });
    APKG.name = (norm(p.name).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'fichario').toUpperCase() + '_' + d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0') + '.apkg';
    progressHide();
    $('apkgBtn').textContent = 'Salvar ' + APKG.name;
    $('apkgNote').textContent = out.cards + (out.cards === 1 ? ' card' : ' cards') + ' em ' + out.notes + (out.notes === 1 ? ' nota' : ' notas') +
      (out.media ? ', ' + out.media + (out.media === 1 ? ' imagem ou áudio' : ' imagens e áudios') : '') +
      (withProgress ? ', ' + out.withState + ' com progresso' : ', sem progresso') + '. Toque de novo para salvar.';
  } catch(e) { progressError((e && e.message) || 'Não consegui montar o arquivo.'); }
}
$('apkgBtn').addEventListener('click', () => exportApkg(curDeck()));
$('apkgProgress').addEventListener('change', resetApkg);

// ---------- stats ----------
function histFor(pkgIds){
  const out = {};
  const add = (h) => { for (const d in h) { const a = out[d] || (out[d] = [0,0,0,0,0]); for (let i = 0; i < 5; i++) a[i] += h[d][i] || 0; } };
  for (const id of pkgIds) { const p = A.pkgs.get(id); if (p && p.hist) add(p.hist); if (A.stats[id]) add(A.stats[id]); }
  return out;
}
function barSvg(values, label, color){
  const W = 330, H = 110, n = values.length, max = Math.max(1, ...values), gap = 2, bw = (W - gap * (n - 1)) / n;
  let bars = '';
  values.forEach((v, i) => {
    const h = v ? Math.max(2, Math.round((v / max) * (H - 4))) : 1;
    bars += '<rect x="' + (i * (bw + gap)).toFixed(1) + '" y="' + (H - h) + '" width="' + bw.toFixed(1) + '" height="' + h + '" rx="1.5" style="fill:' + (v ? color : 'var(--line)') + '"><title>' + v + '</title></rect>';
  });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(label) + '">' + bars + '</svg>';
}
RENDER.stats = function(params){
  show('stats', 'Estatísticas', true);
  const sel = $('statsScope');
  const pk = [...A.pkgs.values()].sort((a,b) => a.name.localeCompare(b.name, 'pt-BR'));
  sel.innerHTML = '<option value="">Todos os decks</option>' + pk.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
  sel.value = params.pkg && A.pkgs.has(params.pkg) ? params.pkg : '';
  $('statsScopeField').hidden = pk.length < 2;
  if (params.tab) ST.tab = params.tab; else if (!params.back) { ST.tab = 'geral'; ST.trail = []; }
  if (params.trail) ST.trail = params.trail.slice();
  document.querySelector('input[name=statTab][value=' + ST.tab + ']').checked = true;
  drawStats();
};
$('statsScope').addEventListener('change', () => { const top = NAV[NAV.length - 1]; if (top) top.params.pkg = $('statsScope').value; ST.trail = []; drawStats(); });
// ---------- estatísticas por área e erros ----------
const ST = { tab:'geral', trail:[] };
document.querySelectorAll('input[name=statTab]').forEach(r => r.addEventListener('change', () => { ST.tab = r.value; ST.trail = []; const top = NAV[NAV.length - 1]; if (top) { top.params.tab = ST.tab; top.params.trail = []; } drawStats(); window.scrollTo(0, 0); }));
const AREA_ALIASES = { 'ginecologia': 'GO', 'obstetricia': 'GO', 'gineco': 'GO', 'gineco e obstetricia': 'GO', 'ginecologia obstetricia': 'GO', 'clinica': 'CM', 'preventiva': 'PREV', 'saude coletiva': 'PREV', 'medicina social': 'PREV', 'pediatria e neonatologia': 'PED' };
function areaOfPath(path){
  for (let i = 0; i < path.length; i++) {
    const n = norm(path[i]);
    const a = AREAS.find(x => norm(x[1]) === n || norm(x[2]) === n || norm(x[0]) === n);
    if (a) return { key: a[0], i };
    if (AREA_ALIASES[n]) return { key: AREA_ALIASES[n], i };
  }
  return { key: '', i: 0 };
}
const pctClass = (r, target) => r == null ? 'na' : r >= target ? 'ok' : r >= target - 0.05 ? 'warn' : 'bad';
const fmtPct = r => r == null ? '–' : Math.round(r * 100) + '%';
function cardInfos(ids){
  const now = Date.now(), cutoff = nextCutoff(now), F = A.fsrs, out = [];
  for (const pid of ids) {
    const p = A.pkgs.get(pid); if (!p) continue;
    for (const c of pkgCards(pid)) {
      if (c.susp) continue;
      const path = p.decks[c.did] || [p.name];
      const ar = areaOfPath(path);
      const rest = ar.key ? path.slice(ar.i + 1) : path.slice(1);
      const st = A.states.get(c.id);
      let R = null;
      if (st && st.st !== 0 && F) { try { R = Number(F.get_retrievability(C.toFsrs(st, now), new Date(now), false)); if (!isFinite(R)) R = null; } catch(e) { R = null; } }
      const t = classify(c, now, cutoff);
      out.push({ c, pid, area: ar.key, rest, prefix: path.slice(0, ar.key ? ar.i + 1 : 1), R, due: t === 'r' || t === 'l', hard: !!(st && (st.l || 0) >= 4), studied: !!(st && st.st !== 0) });
    }
  }
  return out;
}
function aggregate(list){
  const st = list.filter(x => x.R != null);
  return { total: list.length, studied: list.filter(x => x.studied).length, due: list.filter(x => x.due).length, hard: list.filter(x => x.hard).length, R: st.length ? st.reduce((a, x) => a + x.R, 0) / st.length : null, nR: st.length };
}
function nodeRow(name, g, attrs, target){
  const sub = [g.studied + ' de ' + g.total + ' estudados', g.due ? g.due + ' para hoje' : '', g.hard ? g.hard + (g.hard === 1 ? ' difícil' : ' difíceis') : ''].filter(Boolean).join(' · ');
  return '<li><button class="deckrow" ' + attrs + '><span class="nm"><b>' + esc(name) + '</b><span>' + esc(sub) + '</span></span><span class="pct ' + pctClass(g.nR >= 5 ? g.R : null, target) + '">' + (g.nR >= 5 ? fmtPct(g.R) : '–') + '<small>' + (g.nR >= 5 ? 'lembrança' : 'poucos dados') + '</small></span></button></li>';
}
function realPaths(list){ const m = new Map(); for (const x of list) { const k = x.pid + '\x1f' + x.prefixKey; if (!m.has(k)) m.set(k, { pid: x.pid, path: x.fullPrefix }); } return [...m.values()]; }
function openTopicSheet(name, list){
  const paths = realPaths(list);
  const g = aggregate(list);
  $('fsHead').textContent = 'Tema';
  const one = paths.length === 1 ? paths[0] : null;
  $('fsBody').innerHTML = '<h3 style="margin:0 0 4px">' + esc(name) + '</h3><p class="note" style="margin:0 0 14px">' + esc(one ? one.path.join(' › ') : paths.length + ' pastas com este nome') + '</p>' +
    '<p style="margin:0 0 14px">Lembrança estimada de ' + fmtPct(g.R) + ' em ' + g.nR + ' cards estudados' + (g.hard ? ', ' + g.hard + (g.hard === 1 ? ' card difícil' : ' cards difíceis') + ' (esquecidos 4 vezes ou mais)' : '') + '.</p>' +
    '<div class="stack" style="margin-top:0">' +
      (one ? '<button class="primary" data-ta="study"' + (g.due ? '' : ' disabled') + '>' + (g.due ? 'Estudar (' + g.due + ' para hoje)' : 'Nada para hoje neste tema') + '</button>' +
             '<button class="secondary" data-ta="cram">Revisão extra deste tema</button><p class="note" style="margin:-4px 2px 0">A revisão extra passa por todos os cards sem mexer na agenda. Boa para a véspera de um simulado.</p>' : '<p class="note" style="margin:0">Esse tema existe em mais de um lugar. Abra a pasta pelo deck para estudar.</p>') +
      '<button class="textbtn" data-ta="close" style="justify-self:center">Fechar</button></div>';
  $('fsheet').hidden = false;
  $('fsBody').querySelectorAll('[data-ta]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.ta; closeFolderSheet();
    if (a === 'study') startStudy({ pkg: one.pid, path: one.path });
    if (a === 'cram') startStudy({ pkg: one.pid, path: one.path, cram: true });
  }));
}
async function drawAreaStats(ids){
  const body = $('statsBody');
  if (!A.fsrs) { body.innerHTML = '<p class="note">Carregando…</p>'; try { await loadScript(CDN.fsrs); makeFsrs(); } catch(e) { body.innerHTML = '<p class="note">' + esc(e.message) + '</p>'; return; } }
  const target = A.prefs.retention;
  const all = cardInfos(ids);
  if (!all.length) { body.innerHTML = '<p class="note">Ainda não há cards para medir.</p>'; return; }
  const trail = ST.trail;
  // cards under the current trail: trail[0] = area key ('' = sem área), trail[1..] = folders below the area
  const inTrail = all.filter(x => x.area === (trail.length ? trail[0] : x.area) && trail.slice(1).every((t, i) => x.rest[i] === t));
  let html = '';
  if (trail.length) {
    html += '<div class="crumbs" style="margin-top:12px"><button class="chip" data-tr="0">Áreas</button>' + trail.map((t, i) => '<span>›</span><button class="chip" data-tr="' + (i + 1) + '" aria-pressed="' + (i === trail.length - 1) + '">' + esc(i === 0 ? (t ? areaShort(t) : 'Sem área') : t) + '</button>').join('') + '</div>';
  } else {
    const weak = new Map();
    for (const x of all) { if (!x.rest.length) continue; const k = x.pid + '\x1f' + x.prefix.concat(x.rest).join('::'); if (!weak.has(k)) weak.set(k, { name: x.rest[x.rest.length - 1], list: [] }); weak.get(k).list.push(x); }
    const ranked = [...weak.values()].map(w => Object.assign(w, { g: aggregate(w.list) })).filter(w => w.g.nR >= 8 && w.g.R < target).sort((a, b) => a.g.R - b.g.R).slice(0, 5);
    const g0 = aggregate(all);
    html += '<div class="statgrid"><div class="stat"><b class="' + pctClass(g0.R, target) + '">' + fmtPct(g0.R) + '</b><span>lembrança média</span></div><div class="stat"><b>' + g0.due + '</b><span>para revisar hoje</span></div><div class="stat"><b>' + g0.hard + '</b><span>cards difíceis</span></div></div>' +
      '<p class="note">Lembrança é a chance de você acertar hoje cada card já estudado, calculada pelo FSRS. Fica perto do alvo de ' + Math.round(target * 100) + '% com as revisões em dia e cai quando elas atrasam.</p>';
    if (ranked.length) {
      html += '<p class="sectionlabel">Temas mais fracos</p><ul class="decks" id="weakList">' + ranked.map((w, i) => nodeRow(w.name, w.g, 'data-weak="' + i + '"', target)).join('') + '</ul>';
      ST._weak = ranked;
    } else ST._weak = [];
    html += '<p class="sectionlabel">Grandes áreas</p>';
  }
  // children of current level
  const kids = new Map();
  for (const x of inTrail) {
    let key, name;
    if (!trail.length) { key = x.area; name = x.area ? areaName(x.area) : 'Sem área'; }
    else { const nm = x.rest[trail.length - 1]; if (nm === undefined) { key = '\x00'; name = 'Nesta pasta'; } else { key = nm; name = nm; } }
    if (!kids.has(key)) kids.set(key, { key, name, list: [] });
    kids.get(key).list.push(x);
  }
  const order = !trail.length ? AREAS.map(a => a[0]).concat(['']) : null;
  const rows = [...kids.values()].map(k => Object.assign(k, { g: aggregate(k.list) }))
    .sort((a, b) => order ? order.indexOf(a.key) - order.indexOf(b.key) : ((a.g.nR >= 5 ? a.g.R : 2) - (b.g.nR >= 5 ? b.g.R : 2)) || a.name.localeCompare(b.name, 'pt-BR'));
  ST._rows = rows;
  html += '<ul class="decks">' + rows.map((r, i) => nodeRow(r.name, r.g, 'data-node="' + i + '"', target)).join('') + '</ul>';
  if (!trail.length && kids.has('')) html += '<p class="note">"Sem área" reúne os cards em pastas fora das cinco grandes áreas. Organize as pastas por área (⋯ › Mover ou renomear, na tela do deck) para elas entrarem no lugar certo.</p>';
  if (trail.length) html += '<p class="note">Os temas mais fracos aparecem primeiro. Toque num tema para descer um nível ou para estudar.</p>';
  body.innerHTML = html;
}
function errStatsHtml(ids){
  const errs = liveErrors().filter(e => !e.pkg || ids.includes(e.pkg) || !A.pkgs.has(e.pkg));
  if (!errs.length) return '<p class="note">Nenhuma questão registrada no caderno de erros ainda. Quando você registrar questões em "Card de questão errada", esta aba mostra onde e por que você erra.</p>';
  const now = Date.now(), d30 = now - 30 * DAY;
  const recent = errs.filter(e => e.t >= d30).length;
  const MC = { conteudo: 'var(--again)', raciocinio: 'var(--hard)', leitura: 'var(--new)', acertei: 'var(--muted)' };
  const leg = Object.keys(MOTIVOS).map(k => '<span><em style="background:' + MC[k] + '"></em>' + esc(MOTIVOS[k]) + '</span>').join('');
  let html = '<div class="statgrid"><div class="stat"><b>' + errs.length + '</b><span>questões registradas</span></div><div class="stat"><b>' + recent + '</b><span>nos últimos 30 dias</span></div><div class="stat"><b>' + Math.round(errs.filter(e => e.motivo === 'leitura').length / errs.length * 100) + '%</b><span>de leitura</span></div></div>';
  html += '<p class="sectionlabel">Por grande área</p><div class="paper" style="margin-top:8px"><div class="body" style="padding-top:6px;padding-bottom:12px">';
  const keys = AREAS.map(a => a[0]).concat(['']);
  for (const k of keys) {
    const l = errs.filter(e => (e.area || '') === k); if (!l.length) continue;
    const by = m => l.filter(e => e.motivo === m).length;
    const lei = by('leitura') / l.length;
    let tip = '';
    if (l.length >= 5 && lei >= 0.3) tip = Math.round(lei * 100) + '% dos erros aqui foram de leitura: o ganho nesta área é de método, mais do que de conteúdo.';
    else if (l.length >= 5 && by('raciocinio') / l.length >= 0.3) tip = 'Muitos erros de raciocínio: você sabe o conteúdo, mas tropeça na decisão. Vale treinar mais questões do que reler teoria.';
    html += '<div class="erow"><div class="top">' + esc(k ? areaName(k) : 'Sem área') + '<span>' + l.length + (l.length === 1 ? ' questão' : ' questões') + '</span></div>' +
      '<div class="stack3">' + Object.keys(MOTIVOS).map(m => by(m) ? '<i style="width:' + (by(m) / l.length * 100).toFixed(1) + '%;background:' + MC[m] + '" title="' + esc(MOTIVOS[m]) + ' ' + by(m) + '"></i>' : '').join('') + '</div>' +
      '<p>' + Object.keys(MOTIVOS).filter(m => by(m)).map(m => esc(MOTIVOS[m]) + ' ' + by(m)).join(' · ') + '</p>' + (tip ? '<p style="color:var(--ink)">' + esc(tip) + '</p>' : '') + '</div>';
  }
  html += '<div class="mixlegend" style="margin-top:4px">' + leg + '</div></div></div>';
  const temas = new Map();
  for (const e of errs) { if (e.motivo === 'acertei') continue; const t = (e.tema || '').trim(); if (!t) continue; const k = norm(t); if (!temas.has(k)) temas.set(k, { t, n: 0, area: e.area }); temas.get(k).n++; }
  const top = [...temas.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  if (top.length) html += '<p class="sectionlabel">Temas em que você mais erra</p><ul class="decks">' + top.map(x => '<li><div class="deckrow" style="cursor:default"><span class="nm"><b>' + esc(x.t) + '</b><span>' + esc(x.area ? areaShort(x.area) : 'Sem área') + '</span></span><span class="pct">' + x.n + '<small>' + (x.n === 1 ? 'erro' : 'erros') + '</small></span></div></li>').join('') + '</ul>';
  // do error cards stick?
  const ecIds = new Set(errs.flatMap(e => e.cards || []));
  if (ecIds.size && A.fsrs) {
    const infos = cardInfos(ids);
    const ec = aggregate(infos.filter(x => ecIds.has(x.c.id))), rest = aggregate(infos.filter(x => !ecIds.has(x.c.id)));
    if (ec.nR >= 5) {
      const diff = rest.nR >= 5 ? ec.R - rest.R : null;
      html += '<p class="sectionlabel">Os cards do caderno de erros estão fixando?</p><div class="field" style="margin-top:8px"><div class="retline"><span class="big" style="color:' + ({ ok:'var(--rev)', warn:'var(--hard)', bad:'var(--again)', na:'var(--muted)' })[pctClass(ec.R, A.prefs.retention)] + '">' + fmtPct(ec.R) + '</span><span>lembrança dos ' + ec.nR + ' cards que vieram de erros' + (diff != null ? ', contra ' + fmtPct(rest.R) + ' no resto' : '') + '</span></div>' +
        '<p>' + (diff == null ? 'Ainda há poucos cards de outras origens para comparar.' : diff < -0.05 ? 'Os cards de erros estão segurando menos que o resto. Vale olhar se estão densos ou se cobram o ponto certo do erro.' : 'Os cards de erros estão segurando tão bem quanto o resto: o caderno está cumprindo o papel.') + '</p></div>';
    }
  }
  return html;
}
function drawStats(){
  const scope = $('statsScope').value;
  const ids = scope ? [scope] : [...A.pkgs.keys()];
  if (ST.tab === 'areas') { if (!ids.length) { $('statsBody').innerHTML = '<p class="note">Importe ou crie um deck para ver as estatísticas.</p>'; return; } drawAreaStats(ids); return; }
  if (ST.tab === 'erros') { $('statsBody').innerHTML = errStatsHtml(ids); if (!A.fsrs) loadScript(CDN.fsrs).then(() => { makeFsrs(); if (ST.tab === 'erros') $('statsBody').innerHTML = errStatsHtml(ids); }).catch(()=>{}); return; }
  drawGeneralStats();
}
$('statsBody').addEventListener('click', e => {
  const tr = e.target.closest('[data-tr]');
  if (tr) { ST.trail = ST.trail.slice(0, Number(tr.dataset.tr)); const top = NAV[NAV.length - 1]; if (top) top.params.trail = ST.trail.slice(); drawStats(); return; }
  const w = e.target.closest('[data-weak]');
  if (w) { const x = ST._weak[Number(w.dataset.weak)]; for (const i of x.list) { i.fullPrefix = i.prefix.concat(i.rest); i.prefixKey = i.fullPrefix.join('::'); } openTopicSheet(x.name, x.list); return; }
  const n = e.target.closest('[data-node]');
  if (n) {
    const r = ST._rows[Number(n.dataset.node)];
    const deeper = r.key !== '\x00' && r.list.some(x => x.rest.length > ST.trail.length);
    if (!ST.trail.length || deeper) { ST.trail = ST.trail.concat([r.key]); const top = NAV[NAV.length - 1]; if (top) top.params.trail = ST.trail.slice(); drawStats(); window.scrollTo(0, 0); return; }
    for (const x of r.list) { x.fullPrefix = x.prefix.concat(x.rest.slice(0, r.key === '\x00' ? ST.trail.length - 1 : ST.trail.length)); x.prefixKey = x.fullPrefix.join('::'); }
    openTopicSheet(r.key === '\x00' ? ST.trail[ST.trail.length - 1] : r.name, r.list);
  }
});
function drawGeneralStats(){
  const scope = $('statsScope').value;
  const ids = scope ? [scope] : [...A.pkgs.keys()];
  if (!ids.length) { $('statsBody').innerHTML = '<p class="note">Importe um deck para ver as estatísticas.</p>'; return; }
  const hist = histFor(ids);
  const today = dayStart();
  const days = [];
  for (let i = 29; i >= 0; i--) { const t = today - i * DAY + 3600e3 * 6; days.push(dayKey(t)); }
  const last30 = days.map(d => hist[d] || [0,0,0,0,0]);
  const t = last30[29];
  const answers = last30.map(a => a[0]);
  const studied = answers.filter(Boolean).length;
  const avgRaw = answers.reduce((s, x) => s + x, 0) / 30; const avg = avgRaw >= 10 || avgRaw === 0 ? String(Math.round(avgRaw)) : String(Math.round(avgRaw * 10) / 10).replace('.', ',');
  let streak = 0; for (let i = 29; i >= 0; i--) { if (answers[i]) streak++; else if (i === 29) continue; else break; }
  const revN = last30.reduce((s, a) => s + a[1], 0), revOk = last30.reduce((s, a) => s + a[2], 0);
  const real = revN ? revOk / revN : null;
  const target = A.prefs.retention;
  let verdict;
  if (!revN || revN < 30) verdict = 'Ainda há poucas revisões nos últimos 30 dias para medir com segurança.';
  else if (real < target - 0.03) verdict = 'Abaixo do alvo. Vale olhar se os cards que você mais erra estão densos demais.';
  else if (real > target + 0.03) verdict = 'Acima do alvo. Dá para baixar a retenção desejada e revisar menos.';
  else verdict = 'Dentro do esperado para o alvo que você escolheu.';
  // forecast
  const cards = [].concat(...ids.map(pkgCards));
  const fc = new Array(30).fill(0);
  let nNew = 0, nLrn = 0, nYoung = 0, nMature = 0, nSusp = 0;
  for (const c of cards) {
    if (c.susp) { nSusp++; continue; }
    const st = A.states.get(c.id);
    if (!st || st.st === 0) { nNew++; continue; }
    if (st.st === 2) { if ((st.sd || 0) >= 21) nMature++; else nYoung++; } else nLrn++;
    const idx = Math.max(0, Math.floor((dayStart(st.d) - today) / DAY));
    if (idx < 30) fc[idx]++;
  }
  const total = Math.max(1, nNew + nLrn + nYoung + nMature + nSusp);
  const fcTotal = fc.reduce((s, x) => s + x, 0);
  const fmtD = d => { const [, m, dd] = d.split('-'); return dd + '/' + m; };
  const seg = (v, c) => v ? '<i style="width:' + (v / total * 100).toFixed(2) + '%;background:' + c + '"></i>' : '';
  const li = (c, l, v) => '<span><em style="background:' + c + '"></em>' + l + '<b>' + v + '</b></span>';
  $('statsBody').innerHTML =
    '<p class="sectionlabel">Hoje</p>' +
    '<div class="statgrid">' +
      '<div class="stat"><b>' + t[0] + '</b><span>respostas</span></div>' +
      '<div class="stat"><b>' + (t[1] ? Math.round(t[2] / t[1] * 100) + '%' : '–') + '</b><span>acerto em revisões</span></div>' +
      '<div class="stat"><b>' + t[3] + '</b><span>novos vistos</span></div>' +
    '</div>' +
    '<div class="chart"><div class="paper"><div class="head"><span>Últimos 30 dias</span><span>média de ' + avg + ' por dia</span></div><div class="body">' +
      barSvg(answers, 'Respostas por dia nos últimos 30 dias', 'var(--accent)') +
      '<div class="axis"><span>' + fmtD(days[0]) + '</span><span>hoje</span></div>' +
      '<p class="note" style="margin-top:8px">Estudou em ' + studied + ' de 30 dias' + (streak ? ', sequência atual de ' + streak + (streak === 1 ? ' dia.' : ' dias.') : '.') + '</p>' +
    '</div></div></div>' +
    '<div class="field"><div class="lbl">Retenção real em revisões, 30 dias</div>' +
      '<div class="retline" style="margin-top:8px"><span class="big" style="color:var(--ink)">' + (real == null ? '–' : Math.round(real * 100) + '%') + '</span><span>alvo de ' + Math.round(target * 100) + '%' + (revN ? ', em ' + revN + ' revisões' : '') + '</span></div>' +
      '<p>' + verdict + '</p></div>' +
    '<div class="chart"><div class="paper"><div class="head"><span>Próximos 30 dias</span><span>' + fcTotal + ' revisões</span></div><div class="body">' +
      barSvg(fc, 'Revisões previstas para os próximos 30 dias', 'var(--rev)') +
      '<div class="axis"><span>hoje</span><span>' + fmtD(dayKey(today + 29 * DAY + 3600e3 * 6)) + '</span></div>' +
      '<p class="note" style="margin-top:8px">Hoje inclui o que está atrasado. Se a barra de daqui a uma semana estiver alta, segure os novos por dia.</p>' +
    '</div></div></div>' +
    '<div class="field"><div class="lbl">Seus cards</div>' +
      '<div class="mix">' + seg(nNew, 'var(--new)') + seg(nLrn, 'var(--lrn)') + seg(nYoung, 'var(--hard)') + seg(nMature, 'var(--rev)') + seg(nSusp, 'var(--muted)') + '</div>' +
      '<div class="mixlegend">' + li('var(--new)', 'Novos', nNew) + li('var(--lrn)', 'Aprendendo', nLrn) + li('var(--hard)', 'Jovens', nYoung) + li('var(--rev)', 'Maduros', nMature) + (nSusp ? li('var(--muted)', 'Suspensos', nSusp) : '') + '</div>' +
      '<p>Maduro é o card com intervalo de 21 dias ou mais.</p></div>';
}

// ---------- novo card ----------
const NC = {};
RENDER.newcard = function(params){
  const p = A.pkgs.get(params.pkg); if (!p) { go('home', {}, { reset:true }); return; }
  show('newcard', 'Novo card', true);
  mountNewEditor(p.id);
};
function mountNewEditor(pkg){
  const mount = $('newMount'); mount.innerHTML = '';
  const last = NC[pkg] || {};
  const p = A.pkgs.get(pkg);
  const mid = last.mid && p.notetypes[last.mid] ? last.mid : ntOptions(pkg, 1)[0].id;
  const did = last.did && p.decks[last.did] ? last.did : mostUsedDeck(pkg);
  mountEditor(mount, { pkg, draft: { mid, flds: p.notetypes[mid].flds.map(() => ''), tags: last.tags || '', did }, title: 'Card novo',
    onSaved: (box, res) => { if (res) NC[pkg] = { mid: res.mid, did: res.did, tags: res.tags }; toast('Card salvo. Pode escrever o próximo.'); mountNewEditor(pkg); window.scrollTo(0, 0); },
    onCancel: () => back() });
}
$('newCardBtn').addEventListener('click', () => go('newcard', { pkg: curDeck() }));

// ---------- cards de uma aula ----------
const LS = { abort:null };
RENDER.lesson = function(params){
  const p = A.pkgs.get(params.pkg); if (!p) { go('home', {}, { reset:true }); return; }
  show('lesson', 'Cards de uma aula', true);
  const sel = $('lDeck');
  const want = LS[p.id] && p.decks[LS[p.id]] ? LS[p.id] : mostUsedDeck(p.id);
  sel.innerHTML = deckSelectHtml(p.id, want); sel.value = want; sel._prev = want;
  wireDeckSelect(sel, p.id);
  lessonCount();
  checkSample().then(fn => { $('lGo').disabled = !fn; if (!fn && !$('lOut').innerHTML) $('lOut').innerHTML = '<p class="note">Gerar com o Claude não está disponível aqui. Use "Novo card" para escrever à mão.</p>'; });
};
const LESSON_MAX = 60000;
function lessonCount(){ const n = $('lText').value.length; $('lCount').textContent = n ? n.toLocaleString('pt-BR') + ' caracteres' + (n > LESSON_MAX ? '. Passa do limite: só os primeiros ' + LESSON_MAX.toLocaleString('pt-BR') + ' serão usados. Divida a aula em partes.' : '.') : ''; }
$('lText').addEventListener('input', lessonCount);
$('lDeck').addEventListener('change', () => { if ($('lDeck').value !== '__new') LS[curDeck()] = $('lDeck').value; });
async function buildLessonPrompt(pkg, did, text, focus, max){
  const p = A.pkgs.get(pkg);
  const path = deckPathStr(pkg, did);
  const nts = ntOptions(pkg).slice(0, 8).map(o => ({ nome: o.nt.name, tipo: o.nt.kind === 1 ? 'lacunas (cloze)' : 'frente/verso', campos: o.nt.flds }));
  const notes = await notesOf(pkg); const byId = new Map(notes.map(n => [n.id, n]));
  const seen = new Set(); const existing = [];
  for (const c of pkgCards(pkg)) { if (c.did !== did || seen.has(c.nid)) continue; seen.add(c.nid); const n = byId.get(c.nid); if (n) existing.push(plainText(n.flds[0] || '').slice(0, 110)); if (existing.length >= 120) break; }
  const legend = COLORS.map(([c, n]) => c + ' (' + n + ') = ' + colorMeaning(c)).join('; ');
  return [
    'Transforme esta aula em flashcards para um estudante que se prepara para prova de residência médica. Os cards vão para o baralho "' + path + '".',
    '',
    'Regras do molde dele (siga à risca):',
    '- Faça no máximo ' + max + ' cards. Menos é melhor se a aula tiver poucos pontos cobráveis.',
    '- Escolha o que cai em prova: condutas, critérios diagnósticos, exames de escolha, contraindicações, números e diferenciais clássicos. Ignore história, curiosidades e o que é óbvio.',
    '- Atomicidade: cada card cobra um único fato ou decisão. Nada de listas longas.',
    '- Regra dos 15 segundos: a resposta precisa sair em até 15 segundos. Card curto.',
    '- A frente é uma cena clínica curta ou uma pergunta de decisão (ex.: "Gestante de 28 semanas com … → conduta?").',
    '- Em lacunas, use o formato (Assunto) + Comando + omissão: tema entre parênteses, depois o comando, e omita só a palavra decisiva com {{c1::resposta}}. Um card de lacuna usa só c1.',
    '- Misture lacunas e frente/verso conforme o que fixar melhor.',
    '- Destaque a palavra-chave com <b>…</b>. Use só HTML simples (<b>, <i>, <br>, <span style="color:#HEX">).',
    '- Cores com significado fixo: pinte de 1 a 3 palavras-chave por card com <span style="color:#HEX">…</span>, só quando o significado se aplicar: ' + legend + '. Nunca pinte dentro da lacuna.',
    '- Tags: 2 a 4, sem espaços (use _), com o tema e aula.',
    '- Não repita o que já existe neste baralho (lista abaixo).',
    '- Português do Brasil, linguagem de prova.',
    focus ? '- Foco pedido pelo estudante: ' + focus.slice(0, 300) : '',
    '',
    'Tipos de nota disponíveis (use o nome exato e preencha os campos pelo nome exato):',
    JSON.stringify(nts),
    '',
    'Cards que já existem neste baralho (início da frente):',
    existing.length ? JSON.stringify(existing) : '(nenhum)',
    '',
    'Aula:', text.slice(0, LESSON_MAX),
    '',
    'Responda só com JSON neste formato:',
    '{"cards":[{"notetype":"nome exato","fields":{"Campo":"html"},"tags":["tag1","tag2"],"angulo":"o que este card cobra, em uma frase"}]}'
  ].join('\n');
}
function lessonDraftsLeft(){ return $('lOut').querySelectorAll('.editor').length; }
function lessonHeader(total){
  const left = lessonDraftsLeft();
  const h = $('lOut').querySelector('[data-role=lhead]');
  if (!h) return;
  if (!left) { h.innerHTML = '<p class="note" style="margin:0 0 4px">Pronto. Os cards salvos entram primeiro na fila de novos.</p><div class="stack" style="margin-top:8px"><button class="secondary" data-role="lnew">Outra aula</button></div>'; h.querySelector('[data-role=lnew]').addEventListener('click', () => { $('lText').value = ''; $('lFocus').value = ''; lessonCount(); $('lOut').innerHTML = ''; window.scrollTo(0, 0); }); return; }
  h.querySelector('[data-role=lleft]').textContent = left + (left === 1 ? ' card proposto' : ' cards propostos') + '. Revise, edite ou descarte cada um.';
  h.querySelector('[data-role=lall]').textContent = 'Salvar ' + (left === 1 ? 'o card' : 'todos os ' + left);
}
$('lGo').addEventListener('click', async () => {
  const pkg = curDeck(); const did = $('lDeck').value;
  const text = $('lText').value.trim(), focus = $('lFocus').value.trim();
  const max = Number(document.querySelector('input[name=lSize]:checked').value);
  if (text.length < 200) { toast('Cole a aula ou um resumo com pelo menos alguns parágrafos.'); $('lText').focus(); return; }
  const sample = await checkSample(); if (!sample) return;
  if (LS.abort) LS.abort.abort();
  LS.abort = new AbortController();
  const out = $('lOut');
  out.innerHTML = '<div class="thinking"><span class="spinner" aria-hidden="true"></span><span>Lendo a aula e montando os cards…</span><button class="textbtn" id="lStop">Parar</button></div>';
  $('lStop').addEventListener('click', () => LS.abort && LS.abort.abort());
  $('lGo').disabled = true;
  try {
    const res = await sample.json(await buildLessonPrompt(pkg, did, text, focus, max), { signal: LS.abort.signal, modelTier: 'default' });
    const cards = (res && Array.isArray(res.cards) ? res.cards : []).slice(0, max);
    if (!cards.length) { out.innerHTML = '<p class="note">Nenhum card veio na resposta. Tente de novo.</p>'; return; }
    out.innerHTML = '<div class="paper" data-role="lhead" style="margin-top:16px"><div class="body"><p class="note" data-role="lleft" style="margin:0"></p><div class="stack" style="margin-top:12px"><button class="primary" data-role="lall"></button></div></div></div>';
    out.querySelector('[data-role=lall]').addEventListener('click', saveAllLesson);
    cards.forEach((c, i) => {
      const opt = ntOptions(pkg).find(o => o.nt.name === c.notetype) || ntOptions(pkg).find(o => norm(o.nt.name) === norm(c.notetype)) || ntOptions(pkg, 1)[0];
      const fields = c.fields && typeof c.fields === 'object' ? c.fields : {};
      let flds = opt.nt.flds.map(name => { const k = Object.keys(fields).find(x => x === name) || Object.keys(fields).find(x => norm(x) === norm(name)); return k ? String(fields[k] || '') : ''; });
      if (!flds.some(Boolean)) { const vals = Object.values(fields).map(String); flds = opt.nt.flds.map((_, j) => vals[j] || ''); }
      const tags = (Array.isArray(c.tags) ? c.tags : String(c.tags || '').split(/\s+/)).map(t => String(t).trim().replace(/\s+/g, '_')).filter(Boolean).join(' ');
      mountEditor(out, { pkg, draft: { mid: opt.id, flds, tags, did }, angle: c.angulo || c.angle, title: 'Card ' + (i + 1) + ' de ' + cards.length,
        onSaved: box => { box.remove(); lessonHeader(); },
        onCancel: box => { box.remove(); lessonHeader(); } });
    });
    lessonHeader();
  } catch(e) {
    if (e && e.code === 'cancelled') { out.innerHTML = ''; return; }
    const msg = e && e.code === 'prompt_too_large' ? 'A aula ficou longa demais. Cole o resumo em vez da transcrição, ou divida em partes.' : sampleErrorText(e && e.code);
    out.innerHTML = '<p class="note" style="color:var(--again)">' + esc(msg) + '</p>';
  } finally { $('lGo').disabled = false; LS.abort = null; }
});
async function saveAllLesson(){
  const btn = $('lOut').querySelector('[data-role=lall]'); if (btn) btn.disabled = true;
  let saved = 0;
  for (const box of [...$('lOut').querySelectorAll('.editor')]) {
    box.querySelector('[data-role=save]').click();
    for (let t = 0; t < 60 && box.isConnected && box.querySelector('[data-role=save]').disabled; t++) await new Promise(r => setTimeout(r, 50));
    if (box.isConnected) { box.scrollIntoView({ block: 'center' }); break; }
    saved++;
  }
  if (saved) toast(saved === 1 ? '1 card salvo.' : saved + ' cards salvos.');
  const b2 = $('lOut').querySelector('[data-role=lall]'); if (b2) b2.disabled = false;
}
$('lessonBtn').addEventListener('click', () => go('lesson', { pkg: curDeck() }));

// ---------- teclado (Mac) ----------
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || A.view !== 'study' || !S.card || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (S.side === 'q') { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); reveal(); } return; }
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); answer(3); return; }
  if (/^[1-4]$/.test(e.key)) { e.preventDefault(); const g = Number(e.key); answer(S.mode === 'cram' ? (g === 1 ? 1 : 3) : g); return; }
  if (e.key === 'z' || e.key === 'u') { e.preventDefault(); undo(); }
});

// ---------- caderno de erros: screens ----------
const E = { tab:'lista', area:'' };
RENDER.errors = function(params){
  show('errors', 'Caderno de erros', true);
  if (params.tab) E.tab = params.tab;
  document.querySelector('input[name=errTab][value=' + E.tab + ']').checked = true;
  drawErrors();
};
document.querySelectorAll('input[name=errTab]').forEach(r => r.addEventListener('change', () => { E.tab = r.value; const top = NAV[NAV.length - 1]; if (top) top.params.tab = E.tab; drawErrors(); }));
function errTitle(e){ return e.fonte || e.tema || (plainText(e.q || '').slice(0, 70) || 'Questão sem texto'); }
function drawErrors(){
  const all = liveErrors();
  const body = $('errBody');
  if (!all.length) {
    body.innerHTML = '<div class="paper" style="margin-top:16px"><div class="head"><span>Nada registrado ainda</span></div><div class="body"><p style="margin:0 0 12px">Cada questão que você registrar em "Card de questão errada" aparece aqui, com área, motivo e os cards que gerou. Erros de leitura vão para o catálogo de método.</p><button class="primary" id="errNew">Registrar uma questão</button></div></div>';
    $('errNew').addEventListener('click', () => go('wrong', { pkg: [...A.pkgs.keys()][0], fresh:true }));
    return;
  }
  if (E.tab === 'metodo') { drawMethod(all.filter(e => e.motivo === 'leitura')); return; }
  const cnt = k => all.filter(e => (e.area || '') === k).length;
  const list = !E.area ? all : E.area === '-' ? all.filter(e => !e.area) : all.filter(e => e.area === E.area);
  const byMot = k => list.filter(e => e.motivo === k).length;
  let html = '<div class="statgrid">' +
    '<div class="stat"><b>' + list.length + '</b><span>registrados</span></div>' +
    '<div class="stat"><b>' + list.filter(e => (e.cards || []).length).length + '</b><span>viraram card</span></div>' +
    '<div class="stat"><b>' + byMot('leitura') + '</b><span>de leitura</span></div></div>';
  html += '<div class="chips"><button class="chip" data-farea="" aria-pressed="' + (!E.area) + '">Todas</button>' +
    AREAS.filter(a => cnt(a[0])).map(a => '<button class="chip" data-farea="' + a[0] + '" aria-pressed="' + (E.area === a[0]) + '">' + esc(a[2]) + ' ' + cnt(a[0]) + '</button>').join('') +
    (cnt('') ? '<button class="chip" data-farea="-" aria-pressed="' + (E.area === '-') + '">Sem área ' + cnt('') + '</button>' : '') + '</div>';
  html += '<p class="note">' + Object.keys(MOTIVOS).map(k => MOTIVOS[k] + ' ' + byMot(k)).join(' · ') + '</p>';
  html += '<ul class="decks">' + list.slice(0, 300).map(e =>
    '<li><button class="deckrow" data-err="' + esc(e.id) + '"><span class="nm"><b>' + esc(errTitle(e)) + '</b><span>' +
    esc([areaShort(e.area), e.tema, MOTIVOS[e.motivo] || '', fmtDate(e.t)].filter(Boolean).join(' · ')) +
    ((e.cards || []).length ? ' · ' + e.cards.length + (e.cards.length === 1 ? ' card' : ' cards') : '') + '</span></span></button></li>').join('') + '</ul>';
  if (list.length > 300) html += '<p class="note">Mostrando os 300 mais recentes.</p>';
  body.innerHTML = html;
}
function drawMethod(items){
  const body = $('errBody');
  if (!items.length) { body.innerHTML = '<p class="note" style="margin-top:16px">Nenhum erro de leitura registrado. Quando marcar "Errei por leitura" numa questão, ele entra aqui agrupado pelo tipo de erro.</p>'; return; }
  const groups = new Map();
  for (const e of items) { const k = e.padrao || 'outro'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const max = sorted[0][1].length;
  let html = '<p class="note">' + items.length + (items.length === 1 ? ' erro de leitura' : ' erros de leitura') + '. O tipo que mais se repete está no topo: é ele que vale atacar primeiro.</p>';
  for (const [k, list] of sorted) {
    html += '<div class="paper" style="margin-top:14px"><div class="head"><span>' + esc(padraoName(k)) + '</span><span>' + list.length + '</span></div><div class="body" style="padding-top:8px">' +
      '<div class="hbar"><i style="width:' + Math.round(list.length / max * 100) + '%"></i></div><ul class="lessons" style="margin-top:6px">' +
      list.map(e => '<li><button data-err="' + esc(e.id) + '">' + esc(e.nota || plainText(e.q || '').slice(0, 90) || 'Sem lição escrita') +
        '<small>' + esc([e.fonte, areaShort(e.area) === 'Sem área' ? '' : areaShort(e.area), fmtDate(e.t)].filter(Boolean).join(' · ')) + '</small></button></li>').join('') +
      '</ul></div></div>';
  }
  body.innerHTML = html;
}
$('errBody').addEventListener('click', e => {
  const f = e.target.closest('[data-farea]');
  if (f) { E.area = f.dataset.farea; drawErrors(); return; }
  const b = e.target.closest('[data-err]'); if (b) go('errdetail', { id: b.dataset.err });
});
let errDelTimer = null, errPhotoUrl = null;
RENDER.errdetail = function(params){
  show('errdetail', 'Erro registrado', true);
  const e = A.errors.get(params.id);
  const box = $('errDetailBody');
  if (errPhotoUrl) { URL.revokeObjectURL(errPhotoUrl); errPhotoUrl = null; }
  if (!e || e.del) { box.innerHTML = '<p class="note">Este registro não existe mais.</p>'; return; }
  const opt = (pairs, cur) => pairs.map(([k, n]) => '<option value="' + esc(k) + '"' + (k === cur ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
  const cards = (e.cards || []).map(id => A.cards.get(id)).filter(Boolean);
  const gone = (e.cards || []).length - cards.length;
  if (e.photo instanceof Blob) errPhotoUrl = URL.createObjectURL(e.photo);
  box.innerHTML =
    '<div class="field"><label for="edArea">Grande área</label><select class="inp" id="edArea"><option value="">Sem área</option>' + opt(AREAS.map(a => [a[0], a[1]]), e.area) + '</select></div>' +
    '<div class="field"><label for="edMot">Motivo</label><select class="inp" id="edMot">' + opt(Object.entries(MOTIVOS), e.motivo) + '</select>' +
      '<div id="edPatWrap"' + (e.motivo === 'leitura' ? '' : ' hidden') + '><label for="edPat" style="display:block;font-weight:700;margin-top:14px">Tipo de erro de leitura</label><select class="inp" id="edPat"><option value="">Sem tipo</option>' + opt(PADROES, e.padrao) + '</select></div></div>' +
    '<div class="field"><label for="edTema">Tema</label><input class="inp" id="edTema" value="' + esc(e.tema || '') + '" autocomplete="off">' +
      '<label for="edFonte" style="display:block;font-weight:700;margin-top:14px">Fonte</label><input class="inp" id="edFonte" value="' + esc(e.fonte || '') + '" autocomplete="off">' +
      '<label for="edNota" style="display:block;font-weight:700;margin-top:14px">Lição em uma frase</label><input class="inp" id="edNota" value="' + esc(e.nota || '') + '" autocomplete="off"></div>' +
    '<div class="stack"><button class="primary" id="edSave">Salvar alterações</button></div>' +
    '<p class="sectionlabel">A questão</p>' +
    '<div class="paper" style="margin-top:8px"><div class="head"><span>' + esc(e.fonte || 'Sem fonte') + '</span><span>' + fmtDate(e.t) + '</span></div><div class="body">' +
      (e.q ? '<div class="lbl" style="font-weight:700">Enunciado</div><p class="errq">' + esc(e.q) + '</p>' : '') +
      (e.a ? '<div class="lbl" style="font-weight:700;margin-top:14px">Gabarito e comentário</div><p class="errq">' + esc(e.a) + '</p>' : '') +
      (e.why ? '<div class="lbl" style="font-weight:700;margin-top:14px">O que você marcou</div><p class="errq">' + esc(e.why) + '</p>' : '') +
      (errPhotoUrl ? '<div class="errphoto"><img src="' + errPhotoUrl + '" alt="Foto da questão"></div>' : '') +
      (e.trim ? '<p class="note">Este registro veio de outro aparelho: o texto aparece resumido e a foto fica só no aparelho onde foi tirada.</p>' : '') +
      (!e.q && !e.a && !e.why && !errPhotoUrl ? '<p class="note" style="margin:0">Sem texto da questão.</p>' : '') +
    '</div></div>' +
    '<p class="sectionlabel">Cards deste erro</p>' +
    (cards.length ? '<ul class="decks">' + cards.map(c => '<li><button class="deckrow" data-ecard="' + esc(c.id) + '"><span class="nm"><b>' + esc(deckPathStr(c.pkg, c.did).split('::').pop() || 'Card') + '</b><span>' + esc(stateLabel(c)) + ' · toque para abrir</span></span></button></li>').join('') + '</ul>'
      : '<p class="note">' + (e.motivo === 'leitura' ? 'Erro de leitura: pela sua regra, sem card.' : 'Nenhum card ligado a este erro.') + '</p>') +
    (gone ? '<p class="note">' + gone + (gone === 1 ? ' card foi removido' : ' cards foram removidos') + ' do aparelho.</p>' : '') +
    '<div class="stack"><button class="danger" id="edDel">Apagar este registro</button></div>' +
    '<p class="note">Apagar o registro não apaga os cards.</p>';
  $('edMot').addEventListener('change', () => { $('edPatWrap').hidden = $('edMot').value !== 'leitura'; });
  $('edSave').addEventListener('click', () => {
    Object.assign(e, { area: $('edArea').value, motivo: $('edMot').value, padrao: $('edMot').value === 'leitura' ? $('edPat').value : '', tema: $('edTema').value.trim(), fonte: $('edFonte').value.trim(), nota: $('edNota').value.trim() });
    saveError(e); toast('Registro atualizado.'); back();
  });
  box.querySelectorAll('[data-ecard]').forEach(b => b.addEventListener('click', () => { const c = A.cards.get(b.dataset.ecard); if (c) go('edit', { pkg: c.pkg, nid: c.nid }); }));
  $('edDel').addEventListener('click', () => {
    const b = $('edDel');
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Toque de novo para apagar'; clearTimeout(errDelTimer); errDelTimer = setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Apagar este registro'; }, 4000); return; }
    clearTimeout(errDelTimer);
    e.del = true; delete e.photo; saveError(e); toast('Registro apagado.'); back();
  });
};
$('errorsBtnHome').addEventListener('click', () => go('errors', { tab:'lista' }));

// ---------- settings ----------
RENDER.settings = function(){
  show('settings', 'Ajustes', true);
  $('ret').value = Math.round(A.prefs.retention * 100);
  $('retOut').textContent = Math.round(A.prefs.retention * 100) + '%';
  $('newPer').value = A.prefs.newPerDay;
  $('colorMeanings').innerHTML = COLORS.map(([c, n]) => '<div class="cmrow"><i style="background:' + c + '"></i><input class="inp" data-cm="' + c + '" value="' + esc(colorMeaning(c)) + '" aria-label="Significado da cor ' + n + '" autocomplete="off"></div>').join('');
  setStatus(R.status);
};
$('colorMeanings').addEventListener('input', e => {
  const i = e.target.closest('[data-cm]'); if (!i) return;
  A.prefs.colors = Object.assign({}, A.prefs.colors || {}, { [i.dataset.cm]: i.value.slice(0, 60) });
  savePrefs();
});
let prefTimer = null;
function savePrefs(){
  A.prefs.u = Date.now(); makeFsrs();
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => { Store.kvSet('prefs', A.prefs).catch(()=>{}); R.prefsDirty = true; scheduleSync(1500); }, 400);
}
$('ret').addEventListener('input', () => { A.prefs.retention = Number($('ret').value) / 100; $('retOut').textContent = $('ret').value + '%'; savePrefs(); });
function setNewPer(v){ v = Math.max(0, Math.min(500, Math.round(Number(v) || 0))); A.prefs.newPerDay = v; $('newPer').value = v; savePrefs(); }
$('newPer').addEventListener('change', () => setNewPer($('newPer').value));
$('newMinus').addEventListener('click', () => setNewPer(A.prefs.newPerDay - 5));
$('newPlus').addEventListener('click', () => setNewPer(A.prefs.newPerDay + 5));

window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').addEventListener && window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (A.view === 'study' && S.card) paintInto(shadow, S.side === 'q' ? S.html.q : S.html.a, S.card.pkg, S.nt.css);
});

// ---------- boot ----------
(async function boot(){
  await Store.open();
  try {
    const [pk, cards, states, prefs, daily, stats, errs] = await Promise.all([Store.getAll('pkgs'), Store.getAll('cards'), Store.allStates(), Store.kvGet('prefs'), Store.kvGet('daily'), Store.kvGet('stats'), Store.getAll('errors').catch(() => [])]);
    for (const p of pk) A.pkgs.set(p.id, p);
    for (const c of cards) A.cards.set(c.id, c);
    A.states = states;
    if (prefs) A.prefs = Object.assign(A.prefs, prefs);
    if (daily) A.daily = daily;
    if (stats) A.stats = stats;
    for (const e of errs || []) A.errors.set(e.id, e);
    const exp = await Store.kvGet('expanded'); if (exp) for (const k in exp) A.expanded[k] = new Set(exp[k]);
    const su = await Store.kvGet('syncU');
    if (Array.isArray(su)) A.syncU = new Map(su);
    else { for (const n of await Store.getAll('notes')) if (syncable(n)) A.syncU.set(n.id, { u: noteU(n), pkg: n.pkg }); await Store.kvSet('syncU', [...A.syncU.entries()]); }
    // one-time: copy note tags onto cards saved by the first version
    const missing = cards.filter(c => c.tags === undefined);
    if (missing.length) {
      const pkgsToFix = new Set(missing.map(c => c.pkg));
      for (const pid of pkgsToFix) {
        const ns = await Store.getByIndex('notes', pid); const byId = new Map(ns.map(n => [n.id, n]));
        const fix = []; for (const c of missing) if (c.pkg === pid) { c.tags = (byId.get(c.nid) || {}).tags || ''; fix.push(c); }
        await Store.putMany('cards', fix);
        const p = A.pkgs.get(pid);
        if (p && !p.ntUse) { p.ntUse = {}; for (const n of ns) p.ntUse[n.mid] = (p.ntUse[n.mid] || 0) + 1; await Store.putMany('pkgs', [p]); }
      }
    }
  } catch(e) {}
  go('home', {}, { reset:true });
  loadScript(CDN.fsrs).then(makeFsrs).catch(()=>{});
  initRemote();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(()=>{});
})();
})();

