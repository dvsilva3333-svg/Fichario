/* Fichário core — parsing .apkg/.colpkg, rendering Anki templates, FSRS state helpers */
(function (root) {
  'use strict';

  // ---------- minimal protobuf reader ----------
  function pbFields(buf) {
    const out = [];
    let i = 0;
    const varint = () => {
      let r = 0, mul = 1, b;
      do { b = buf[i++]; r += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80 && i < buf.length);
      return r;
    };
    while (i < buf.length) {
      const key = varint();
      const field = Math.floor(key / 8), wt = key & 7;
      if (wt === 0) out.push({ field, wt, value: varint() });
      else if (wt === 2) { const len = varint(); out.push({ field, wt, bytes: buf.subarray(i, i + len) }); i += len; }
      else if (wt === 1) { i += 8; }
      else if (wt === 5) { i += 4; }
      else break;
    }
    return out;
  }
  const td = new TextDecoder();
  const pbString = (fields, n) => { const f = fields.find(x => x.field === n && x.wt === 2); return f ? td.decode(f.bytes) : ''; };
  const pbInt = (fields, n) => { const f = fields.find(x => x.field === n && x.wt === 0); return f ? f.value : 0; };

  function dayKeyOf(t){ const d = new Date(t - 4 * 3600e3); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  const isZstd = (u8) => u8 && u8.length > 4 && u8[0] === 0x28 && u8[1] === 0xb5 && u8[2] === 0x2f && u8[3] === 0xfd;

  function rows(db, sql) {
    const r = db.exec(sql);
    if (!r.length) return [];
    const cols = r[0].columns;
    return r[0].values.map(v => { const o = {}; cols.forEach((c, i) => o[c] = v[i]); return o; });
  }

  // ---------- .apkg parsing ----------
  // libs: { JSZip, fzstd, SQL }
  // ---------- deck em XML (exportação .zip do AnkiApp) ----------
  // O zip traz um .xml com <deck><fields>…<cards>…, uma pasta blobs/ com as imagens e um media.json com o tipo de cada uma.
  const xmlText = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
  const xmlAttr = (tag, name) => { const m = tag.match(new RegExp('\\b' + name + '="([^"]*)"')); return m ? xmlText(m[1]) : ''; };
  const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };
  async function parseXmlDeck(zip, xmlName, onProgress) {
    const prog = onProgress || (() => {});
    prog('Lendo os cards');
    const xml = await zip.file(xmlName).async('string');
    const head = xml.match(/<deck\b[^>]*>/);
    if (!head) throw new Error('Não encontrei um deck dentro deste arquivo.');
    const name = (xmlAttr(head[0], 'name').replace(/^[\s"'“”‘’«»]+|[\s"'“”‘’«»]+$/g, '') || xmlName.replace(/\.xml$/i, '')).trim() || 'Deck importado';
    const fieldsBlock = (xml.match(/<fields>([\s\S]*?)<\/fields>/) || [, ''])[1];
    const fields = [];
    fieldsBlock.replace(/<([a-z-]+)\b([^>]*?)\/?>/gi, (m, kind, attrs) => { const n = xmlAttr(m, 'name'); if (n) fields.push({ name: n, kind: kind.toLowerCase(), sides: xmlAttr(m, 'sides') || '11' }); return m; });
    if (!fields.length) throw new Error('Este arquivo não tem os campos dos cards.');
    let mime = {};
    if (zip.file('media.json')) { try { mime = JSON.parse(await zip.file('media.json').async('string')) || {}; } catch (e) { mime = {}; } }
    const used = new Set();
    const toHtml = (raw, kind) => {
      let h = xmlText(raw).trim();
      if (kind === 'text') h = h.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      h = h.replace(/\{\{blob\s+([0-9a-f]{16,})\}\}/gi, (m, id) => { used.add(id); const t = mime[id] || ''; return /^audio\//.test(t) ? '[sound:' + id + '.' + (MIME_EXT[t] || 'mp3') + ']' : '<img src="' + id + '.' + (MIME_EXT[t] || 'jpg') + '">'; });
      h = h.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
      if (!/<(p|br|div|ul|ol|table|img)\b/i.test(h)) h = h.replace(/\n/g, '<br>');
      return h;
    };
    const front = fields.filter(f => f.sides[0] === '1'), backOnly = fields.filter(f => f.sides[0] !== '1' && f.sides[1] === '1');
    const mid = String(1450000000000 + fnv('xmlnt\x1f' + name + '\x1f' + fields.map(f => f.name + f.sides).join('|')));
    const did = String(1350000000000 + fnv('xmldeck\x1f' + name));
    const wrap = l => l.map(f => '<div class="campo">{{' + f.name + '}}</div>').join('\n');
    const notetypes = {}; notetypes[mid] = { name, kind: 0, flds: fields.map(f => f.name),
      css: '.card {\n  font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;\n  font-size: 20px;\n  line-height: 1.45;\n  text-align: left;\n  color: #1c1c1e;\n  background-color: #ffffff;\n}\n.card.nightMode, .card.night_mode { color: #f2f2f7; background-color: #1c1c1e; }\n.campo { margin: 0 0 10px; }\nimg { max-width: 100%; height: auto; border-radius: 8px; display: block; margin: 0 0 10px; }\n',
      tmpls: [{ name: 'Cartão 1', q: wrap(front.length ? front : fields.slice(0, 1)), a: '{{FrontSide}}\n\n<hr id=answer>\n\n' + wrap(backOnly.length ? backOnly : fields.slice(1)) }] };
    const decks = {}; decks[did] = [name];
    const notes = [], cards = [], seen = new Set();
    const cardRe = /<card\b[^>]*>([\s\S]*?)<\/card>/g;
    let m, pos = 0;
    while ((m = cardRe.exec(xml))) {
      const vals = {};
      m[1].replace(/<([a-z-]+)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (all, kind, attrs, body) => { const n = xmlAttr('<x ' + attrs + '>', 'name'); if (n) vals[n] = toHtml(body, kind.toLowerCase()); return all; });
      const flds = fields.map(f => vals[f.name] || '');
      if (!flds.some(Boolean)) continue;
      // o id sai do texto da frente: reimportar o mesmo arquivo atualiza o card em vez de duplicar
      let key = fnv(name + '\x1f' + stripHtml(flds[0]));
      while (seen.has(key)) key = (key + 1) >>> 0;
      seen.add(key);
      const nid = String(1400000000000 + key);
      notes.push({ id: nid, guid: 'xa' + key.toString(36), mid, flds, tags: '' });
      cards.push({ id: String(1410000000000 + key), nid, did, ord: 0, pos: ++pos, susp: false, sched: null });
    }
    if (!cards.length) throw new Error('Este arquivo não tem nenhum card.');
    prog('Lendo as imagens');
    const media = [];
    for (const id of used) {
      const f = zip.file('blobs/' + id); if (!f) continue;
      const t = mime[id] || '';
      media.push({ name: id + '.' + (MIME_EXT[t] || (/^audio\//.test(t) ? 'mp3' : 'jpg')), bytes: await f.async('uint8array') });
    }
    return { name, notetypes, decks, notes, cards, media, hist: {} };
  }

  async function parseApkg(data, libs, onProgress) {
    const prog = onProgress || (() => {});
    const zip = await libs.JSZip.loadAsync(data);
    let dbBytes = null;
    prog('Lendo o banco de dados');
    if (zip.file('collection.anki21b')) {
      const raw = await zip.file('collection.anki21b').async('uint8array');
      dbBytes = isZstd(raw) ? libs.fzstd.decompress(raw) : raw;
    } else if (zip.file('collection.anki21')) {
      dbBytes = await zip.file('collection.anki21').async('uint8array');
    } else if (zip.file('collection.anki2')) {
      dbBytes = await zip.file('collection.anki2').async('uint8array');
    } else {
      const xmlName = Object.keys(zip.files).find(n => /\.xml$/i.test(n) && !zip.files[n].dir && n.indexOf('/') < 0);
      if (xmlName) return parseXmlDeck(zip, xmlName, prog);
      if (zip.file('manifest.json') && zip.file('data/cards.json')) throw new Error('Este arquivo é um backup do Fichário. Use “Restaurar de um backup”, na tela inicial.');
      throw new Error('Não reconheci este arquivo. O Fichário abre decks do Anki (.apkg, .colpkg) e decks em .zip com XML (AnkiApp).');
    }
    const db = new libs.SQL.Database(dbBytes);
    try {
      const tables = new Set(rows(db, "select name from sqlite_master where type='table'").map(r => r.name));
      const col = rows(db, 'select * from col')[0] || {};
      const crt = Number(col.crt) || 0;
      const notetypes = {};
      let decks = {};

      if (tables.has('notetypes')) {
        for (const r of rows(db, 'select id, name, config from notetypes')) {
          const f = pbFields(r.config || new Uint8Array());
          notetypes[String(r.id)] = { name: r.name, kind: pbInt(f, 1), css: pbString(f, 3), flds: [], tmpls: [] };
        }
        for (const r of rows(db, 'select ntid, ord, name from fields order by ntid, ord')) {
          const nt = notetypes[String(r.ntid)]; if (nt) nt.flds[r.ord] = r.name;
        }
        for (const r of rows(db, 'select ntid, ord, name, config from templates order by ntid, ord')) {
          const nt = notetypes[String(r.ntid)]; if (!nt) continue;
          const f = pbFields(r.config || new Uint8Array());
          nt.tmpls[r.ord] = { name: r.name, q: pbString(f, 1), a: pbString(f, 2) };
        }
        for (const r of rows(db, 'select id, name from decks')) decks[String(r.id)] = String(r.name).split('\x1f');
      } else {
        const models = JSON.parse(col.models || '{}');
        for (const id in models) {
          const m = models[id];
          notetypes[String(id)] = {
            name: m.name, kind: m.type === 1 ? 1 : 0, css: m.css || '',
            flds: (m.flds || []).sort((a, b) => a.ord - b.ord).map(x => x.name),
            tmpls: (m.tmpls || []).sort((a, b) => a.ord - b.ord).map(t => ({ name: t.name, q: t.qfmt || '', a: t.afmt || '' }))
          };
        }
        const dj = JSON.parse(col.decks || '{}');
        for (const id in dj) decks[String(id)] = String(dj[id].name).split('::');
      }

      prog('Lendo as notas');
      const notes = rows(db, 'select id, guid, mid, flds, tags from notes').map(r => ({
        id: String(r.id), guid: String(r.guid || ''), mid: String(r.mid), flds: String(r.flds).split('\x1f'), tags: String(r.tags || '').trim()
      }));
      const noteIds = new Set(notes.map(n => n.id));
      const cardRows = rows(db, 'select id, nid, did, odid, ord, type, queue, due, odue, ivl, reps, lapses, data from cards order by did, due, id');
      const cards = [];
      let pos = 0;
      for (const r of cardRows) {
        if (!noteIds.has(String(r.nid))) continue;
        const did = String(r.odid && Number(r.odid) ? r.odid : r.did);
        cards.push({
          id: String(r.id), nid: String(r.nid), did, ord: r.ord, pos: pos++,
          susp: r.queue === -1,
          sched: importSched(r, crt)
        });
      }
      // keep only decks used by cards (plus their parents)
      const used = new Set(cards.map(c => c.did));
      const keep = {};
      const pathKey = p => p.join('\x1f');
      const byPath = {};
      for (const id in decks) byPath[pathKey(decks[id])] = id;
      for (const id of used) {
        const p = decks[id] || ['Sem nome'];
        if (!decks[id]) decks[id] = p;
        for (let k = 1; k <= p.length; k++) {
          const pid = byPath[pathKey(p.slice(0, k))];
          if (pid) keep[pid] = decks[pid];
        }
        keep[id] = decks[id];
      }
      decks = keep;
      const usedNt = new Set(notes.map(n => n.mid));
      for (const id of Object.keys(notetypes)) if (!usedNt.has(id)) delete notetypes[id];

      // ---------- media ----------
      prog('Lendo imagens e áudios');
      const media = [];
      const mf = zip.file('media');
      if (mf) {
        const raw = await mf.async('uint8array');
        let names = [];
        let parsed = false;
        if (!isZstd(raw)) {
          try { const j = JSON.parse(td.decode(raw)); names = Object.keys(j).map(k => [k, j[k]]); parsed = true; } catch (e) { /* not json */ }
        }
        if (!parsed) {
          const buf = isZstd(raw) ? libs.fzstd.decompress(raw) : raw;
          const entries = pbFields(buf).filter(f => f.field === 1 && f.wt === 2);
          names = entries.map((e, i) => {
            const f = pbFields(e.bytes);
            const legacy = f.find(x => x.field === 255 && x.wt === 0);
            return [String(legacy ? legacy.value : i), pbString(f, 1)];
          });
        }
        for (const [zipName, name] of names) {
          const zf = zip.file(zipName);
          if (!zf || !name) continue;
          let bytes = await zf.async('uint8array');
          if (isZstd(bytes)) bytes = libs.fzstd.decompress(bytes);
          media.push({ name, bytes });
        }
      }

      // review history aggregated per day: [answers, reviewAnswers, reviewOk, newCards, again]
      const hist = {};
      if (tables.has('revlog')) {
        const cardSet = new Set(cards.map(c => c.id));
        const seenNew = new Set();
        const rl = db.exec('select id, cid, ease, type from revlog order by id');
        if (rl.length) for (const [id, cid, ease, type] of rl[0].values) {
          const c = String(cid);
          if (!cardSet.has(c) || !(ease > 0) || type > 3) continue;
          const day = dayKeyOf(Number(id));
          const a = hist[day] || (hist[day] = [0, 0, 0, 0, 0]);
          a[0]++;
          if (type === 1 || type === 3) { a[1]++; if (ease > 1) a[2]++; }
          if (type === 0 && !seenNew.has(c)) { seenNew.add(c); a[3]++; }
          if (ease === 1) a[4]++;
        }
      }

      // package name = common top-level deck(s)
      const tops = [...new Set(cards.map(c => (decks[c.did] || ['Sem nome'])[0]))];
      const name = tops.length === 1 ? tops[0] : tops.slice(0, 3).join(' + ') + (tops.length > 3 ? '…' : '');
      return { name, notetypes, decks, notes, cards, media, hist };
    } finally {
      db.close();
    }
  }

  // Anki card row -> compact FSRS state (or null for new)
  function importSched(r, crt) {
    let data = {};
    try { data = r.data ? JSON.parse(r.data) : {}; } catch (e) { data = {}; }
    const type = r.type;
    const s = Number(data.s), d = Number(data.d);
    const now = Date.now();
    if (type === 0) return null;
    if (type === 2) {
      const ivl = Math.max(1, Number(r.ivl) || 1);
      const dueDays = Number(r.odue) || Number(r.due);
      const due = (crt + dueDays * 86400) * 1000;
      const lr = data.lrt ? data.lrt * 1000 : due - ivl * 86400000;
      return { d: due, s: s > 0 ? s : ivl, f: d > 0 ? d : 5, e: 0, sd: ivl, ls: 0, r: Number(r.reps) || 1, l: Number(r.lapses) || 0, st: 2, lr, u: 0 };
    }
    if (type === 1 || type === 3) {
      if (!(s > 0)) return null;
      const due = Number(r.due) > 1e9 ? Number(r.due) * 1000 : now;
      return { d: due, s, f: d > 0 ? d : 5, e: 0, sd: 0, ls: 0, r: Number(r.reps) || 1, l: Number(r.lapses) || 0, st: type, lr: data.lrt ? data.lrt * 1000 : now, u: 0 };
    }
    return null;
  }

  // compact <-> ts-fsrs card
  function toFsrs(st, now) {
    if (!st) return null;
    return {
      due: new Date(st.d), stability: st.s, difficulty: st.f, elapsed_days: st.e || 0,
      scheduled_days: st.sd || 0, learning_steps: st.ls || 0, reps: st.r || 0, lapses: st.l || 0,
      state: st.st, last_review: st.lr ? new Date(st.lr) : undefined
    };
  }
  function fromFsrs(c, now) {
    return {
      d: +c.due, s: c.stability, f: c.difficulty, e: c.elapsed_days || 0, sd: c.scheduled_days || 0,
      ls: c.learning_steps || 0, r: c.reps, l: c.lapses, st: c.state, lr: c.last_review ? +c.last_review : 0, u: now
    };
  }
  const packState = st => [st.d, +st.s.toFixed(4), +st.f.toFixed(4), st.e, st.sd, st.ls, st.r, st.l, st.st, st.lr, st.u, st.p ? 1 : 0];
  const unpackState = a => { const o = { d: a[0], s: a[1], f: a[2], e: a[3], sd: a[4], ls: a[5], r: a[6], l: a[7], st: a[8], lr: a[9], u: a[10] }; if (a[11]) o.p = 1; return o; };

  // ---------- template rendering ----------
  const stripHtml = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

  function renderCloze(text, ord, side) {
    return String(text || '').replace(CLOZE_RE, (m, n, body, hint) => {
      if (Number(n) !== ord) return '<span class="cloze-inactive">' + body + '</span>';
      if (side === 'q') return '<span class="cloze" data-cloze>[' + (hint ? esc(hint) : '…') + ']</span>';
      return '<span class="cloze">' + body + '</span>';
    });
  }
  function clozeNumbers(text) {
    const s = new Set(); let m; const re = new RegExp(CLOZE_RE.source, 'g');
    while ((m = re.exec(String(text || '')))) s.add(Number(m[1]));
    return s;
  }

  function renderTemplate(tpl, fieldMap, ctx) {
    let out = String(tpl || '');
    const sectionRe = /\{\{([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;
    let guard = 0, m;
    while ((m = sectionRe.exec(out)) && guard++ < 500) {
      const key = m[2];
      let nonEmpty;
      if (key.indexOf(':') >= 0) { const [, fld] = key.split(':'); nonEmpty = clozeNumbers(fieldMap[fld.trim()]).has(ctx.clozeOrd); }
      else nonEmpty = stripHtml(fieldMap[key]).length > 0 || /<img/i.test(fieldMap[key] || '');
      const show = m[1] === '#' ? nonEmpty : !nonEmpty;
      out = out.slice(0, m.index) + (show ? m[3] : '') + out.slice(m.index + m[0].length);
    }
    out = out.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (all, inner) => {
      const parts = inner.split(':').map(s => s.trim());
      const name = parts.pop();
      const filters = parts;
      let val;
      switch (name) {
        case 'FrontSide': return ctx.front || '';
        case 'Tags': val = ctx.tags || ''; break;
        case 'Deck': val = ctx.deck || ''; break;
        case 'Subdeck': val = (ctx.deck || '').split('::').pop(); break;
        case 'Card': val = ctx.cardName || ''; break;
        case 'Type': val = ctx.typeName || ''; break;
        case 'CardFlag': val = ''; break;
        default:
          if (!(name in fieldMap)) {
            if (filters.length) return '';
            return '';
          }
          val = fieldMap[name];
      }
      for (let i = filters.length - 1; i >= 0; i--) {
        const f = filters[i];
        if (f === 'cloze') val = renderCloze(val, ctx.clozeOrd, ctx.side);
        else if (f === 'cloze-only') {
          const parts2 = []; let mm; const re = new RegExp(CLOZE_RE.source, 'g');
          while ((mm = re.exec(String(val)))) if (Number(mm[1]) === ctx.clozeOrd) parts2.push(mm[2]);
          val = parts2.join(', ');
        }
        else if (f === 'text') val = stripHtml(val);
        else if (f === 'hint') {
          if (!stripHtml(val)) val = '';
          else val = '<details class="hint"><summary>Dica</summary>' + val + '</details>';
        }
        else if (f === 'type' || f.startsWith('type')) {
          val = ctx.side === 'a' ? '<div class="typed-answer">' + val + '</div>' : '';
        }
        else if (f.startsWith('tts')) val = '';
        else if (f === 'furigana' || f === 'kanji') val = String(val).replace(/ ?([^ >]+?)\[(.+?)\]/g, f === 'kanji' ? '$1' : '<ruby>$1<rt>$2</rt></ruby>');
        else if (f === 'kana') val = String(val).replace(/ ?([^ >]+?)\[(.+?)\]/g, '$2');
      }
      return val == null ? '' : val;
    });
    return out;
  }

  // note, nt (notetype), card {ord}, side 'q' | 'a'
  function renderCard(note, nt, card, deckPath) {
    const fieldMap = {};
    (nt.flds || []).forEach((n, i) => { fieldMap[n] = note.flds[i] || ''; });
    const isCloze = nt.kind === 1;
    const tmpl = isCloze ? nt.tmpls[0] : (nt.tmpls[card.ord] || nt.tmpls[0]);
    if (!tmpl) {
      return { q: note.flds[0] || '', a: (note.flds[0] || '') + '<hr id="answer">' + (note.flds[1] || '') };
    }
    const ctx = {
      clozeOrd: isCloze ? card.ord + 1 : 0, tags: note.tags, deck: (deckPath || []).join('::'),
      cardName: tmpl.name, typeName: nt.name
    };
    const q = renderTemplate(tmpl.q, fieldMap, Object.assign({}, ctx, { side: 'q' }));
    const a = renderTemplate(tmpl.a, fieldMap, Object.assign({}, ctx, { side: 'a', front: q.replace(/\[sound:[^\]]+\]/g, '') }));
    return { q, a };
  }

  // ---------- .apkg writing ----------
  // Writes the legacy layout (collection.anki2, schema 11), which every Anki version imports.
  // data: { name, notetypes, decks: {did: [path]}, notes, cards, states: Map(cid -> compact state),
  //         revlog, media: [{name, bytes}], withProgress, now }
  // libs: { JSZip, SQL }
  const APKG_SCHEMA = [
    'CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null)',
    'CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null)',
    'CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null)',
    'CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null)',
    'CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null)',
    'CREATE INDEX ix_notes_usn on notes (usn)', 'CREATE INDEX ix_cards_usn on cards (usn)', 'CREATE INDEX ix_revlog_usn on revlog (usn)',
    'CREATE INDEX ix_cards_nid on cards (nid)', 'CREATE INDEX ix_cards_sched on cards (did, queue, due)', 'CREATE INDEX ix_revlog_cid on revlog (cid)',
    'CREATE INDEX ix_notes_csum on notes (csum)'
  ];
  function fnv(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  // ids created inside the app are not numeric; Anki needs integers, and the same key must always give the same id
  const numId = key => /^\d+$/.test(String(key)) ? Number(key) : 1500000000000 + fnv(String(key));
  async function sha1Int(text) {
    try {
      const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;
      if (!subtle) return 0;
      const h = new Uint8Array(await subtle.digest('SHA-1', new TextEncoder().encode(text)));
      return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
    } catch (e) { return 0; }
  }
  // 4:00 local time, the hour the app (and Anki by default) turns the day
  function dayAnchor(t) { const d = new Date(t); d.setHours(4, 0, 0, 0); if (+d > t) d.setDate(d.getDate() - 1); return Math.floor(+d / 1000); }

  // compact FSRS state -> Anki card columns
  function exportSched(st, crt, position) {
    const fresh = { type: 0, queue: 0, due: position, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, data: '{}' };
    if (!st || !st.st || !(st.s > 0)) return fresh;
    const data = JSON.stringify({ s: +(+st.s).toFixed(4), d: +(+st.f).toFixed(3), lrt: Math.floor((st.lr || st.u || st.d) / 1000) });
    const reps = Math.max(1, st.r || 1), lapses = st.l || 0;
    if (st.st === 2) {
      const ivl = Math.max(1, st.sd || Math.round((st.d - (st.lr || st.d)) / 86400000) || 1);
      return { type: 2, queue: 2, due: Math.floor((st.d / 1000 - crt) / 86400), ivl, factor: 2500, reps, lapses, left: 0, data };
    }
    return { type: st.st === 3 ? 3 : 1, queue: 1, due: Math.floor(st.d / 1000), ivl: st.st === 3 ? Math.max(1, st.sd || 1) : 0, factor: st.st === 3 ? 2500 : 0, reps, lapses, left: 1001, data };
  }

  async function buildApkg(data, libs, onProgress) {
    const prog = onProgress || (() => {});
    const now = data.now || Date.now();
    const nowS = Math.floor(now / 1000);
    const crt = dayAnchor(now - 400 * 86400000);
    const states = data.states || new Map();
    const getState = id => (states.get ? states.get(id) : states[id]) || null;

    prog('Montando os baralhos');
    const deckJson = {
      '1': { id: 1, name: 'Default', mod: nowS, usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], collapsed: false, browserCollapsed: true, desc: '', dyn: 0, conf: 1, extendNew: 0, extendRev: 0 }
    };
    const deckNum = {};
    const usedDecks = new Set(data.cards.map(c => String(c.did)));
    for (const did of usedDecks) {
      const path = (data.decks[did] || [data.name || 'Fichário']).map(s => String(s).replace(/::/g, ':').trim() || 'Sem nome');
      let id = numId(did); if (id === 1) id = 1500000000001;
      deckNum[did] = id;
      deckJson[String(id)] = { id, name: path.join('::'), mod: nowS, usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], collapsed: false, browserCollapsed: true, desc: '', dyn: 0, conf: 1, extendNew: 0, extendRev: 0 };
    }
    const firstDeck = Object.values(deckNum)[0] || 1;

    const models = {};
    const midNum = {};
    const usedNt = new Set(data.notes.map(n => String(n.mid)));
    for (const key of usedNt) {
      const nt = data.notetypes[key]; if (!nt) continue;
      const id = numId(key); midNum[key] = id;
      const flds = []; for (let i = 0; i < (nt.flds || []).length; i++) flds.push({ name: nt.flds[i] || ('Campo ' + (i + 1)), ord: i, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] });
      const tmpls = (nt.tmpls || []).filter(Boolean).map((t, i) => ({ name: t.name || ('Cartão ' + (i + 1)), ord: i, qfmt: t.q || '', afmt: t.a || '', did: null, bqfmt: '', bafmt: '' }));
      models[String(id)] = {
        id, name: nt.name || 'Fichário', type: nt.kind === 1 ? 1 : 0, mod: nowS, usn: -1, sortf: 0, did: firstDeck, tmpls, flds, css: nt.css || '',
        latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
        latexPost: '\\end{document}', latexsvg: false,
        req: nt.kind === 1 ? [[0, 'any', [0]]] : tmpls.map((t, i) => [i, 'any', [0]]), tags: [], vers: []
      };
    }
    const dconf = { '1': { id: 1, name: 'Default', mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
      new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 },
      rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
      lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 } } };

    const db = new libs.SQL.Database();
    let dbBytes;
    try {
      for (const s of APKG_SCHEMA) db.run(s);
      db.run('BEGIN');
      prog('Gravando as notas');
      const keptNotes = new Set();
      const insN = db.prepare('insert into notes values (?,?,?,?,?,?,?,?,?,?,?)');
      for (const n of data.notes) {
        const mid = midNum[String(n.mid)]; if (!mid) continue;
        const flds = (n.flds || []).map(f => String(f == null ? '' : f));
        const sfld = stripHtml(flds[0] || '');
        const tags = String(n.tags || '').trim();
        insN.run([Number(n.id), n.guid || ('fich' + n.id), mid, Math.floor((n.mt || now) / 1000), -1, tags ? ' ' + tags.split(/\s+/).join(' ') + ' ' : '', flds.join('\x1f'), sfld, await sha1Int(sfld), 0, '']);
        keptNotes.add(String(n.id));
      }
      insN.free();

      prog('Gravando os cards');
      const ordered = data.cards.filter(c => keptNotes.has(String(c.nid))).slice().sort((a, b) => (a.pos || 0) - (b.pos || 0) || Number(a.id) - Number(b.id));
      const insC = db.prepare('insert into cards values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const keptCards = new Set();
      let position = 0, withState = 0;
      for (const c of ordered) {
        position++;
        const st = data.withProgress ? getState(c.id) : null;
        const s = exportSched(st, crt, position);
        if (s.type) withState++;
        const mod = st && st.u > 1e12 ? Math.floor(st.u / 1000) : nowS;
        insC.run([Number(c.id), Number(c.nid), deckNum[String(c.did)] || firstDeck, c.ord || 0, mod, -1, s.type, c.susp ? -1 : s.queue, s.due, s.ivl, s.factor, s.reps, s.lapses, s.left, 0, 0, 0, s.data]);
        keptCards.add(String(c.id));
      }
      insC.free();

      let nRev = 0;
      if (data.withProgress && data.revlog && data.revlog.length) {
        const insR = db.prepare('insert or ignore into revlog values (?,?,?,?,?,?,?,?,?)');
        for (const r of data.revlog) {
          if (!keptCards.has(String(r.cid))) continue;
          insR.run([Number(r.id), Number(r.cid), -1, r.ease || 1, Math.round(r.ivl || 0), Math.round(r.lastIvl || 0), Math.round(r.factor || 0), Math.round(r.time || 0), r.type || 0]);
          nRev++;
        }
        insR.free();
      }
      const conf = { activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true, curModel: null, nextPos: position + 1, sortType: 'noteFld', sortBackwards: false, addToCur: true, schedVer: 2, rollover: 4 };
      db.run('insert into col values (1,?,?,?,11,0,0,0,?,?,?,?,?)', [crt, now, now, JSON.stringify(conf), JSON.stringify(models), JSON.stringify(deckJson), JSON.stringify(dconf), '{}']);
      db.run('COMMIT');
      dbBytes = db.export();

      prog('Juntando imagens e áudios');
      const zip = new libs.JSZip();
      zip.file('collection.anki2', dbBytes);
      const map = {};
      let i = 0;
      for (const m of data.media || []) {
        if (!m || !m.name || !m.bytes) continue;
        map[String(i)] = m.name;
        zip.file(String(i), m.bytes);
        i++;
      }
      zip.file('media', JSON.stringify(map));
      prog('Fechando o arquivo');
      const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      return { bytes, notes: keptNotes.size, cards: keptCards.size, media: i, withState, revlog: nRev };
    } finally {
      db.close();
    }
  }

  // ---------- questão de múltipla escolha colada como texto ----------
  // Separa enunciado, alternativas (A a E), gabarito e comentário de um texto colado.
  function parseMcq(text) {
    let t = String(text || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').trim();
    const out = { stem: '', opts: {}, ans: '', exp: '' };
    if (!t) return out;
    const expM = t.match(/\n\s*(coment[áa]rio|explica[çc][ãa]o|justificativa)\s*[:\-–]\s*([\s\S]*)$/i);
    if (expM) { out.exp = expM[2].trim(); t = t.slice(0, expM.index); }
    const ansM = t.match(/(?:^|\s)(?:gabarito|resposta(?: correta)?|alternativa correta|gab\.?)\s*[:\-–]?\s*(?:letra\s*)?\(?([A-Ea-e])\)?[.\s]*(?=\n|$)/i);
    if (ansM) { out.ans = ansM[1].toUpperCase(); t = (t.slice(0, ansM.index) + t.slice(ansM.index + ansM[0].length)).trim(); }
    const mark = /^[ \t]*\(?([A-Ea-e])[)\.\-–:][ \t]+/;
    let lines = t.split('\n');
    if (!lines.some(l => mark.test(l))) {
      // alternativas na mesma linha: "... A) x B) y C) z"
      t = t.replace(/\s+(?=\(?[A-Ea-e]\)\s)/g, '\n');
      lines = t.split('\n');
    }
    const want = ['A', 'B', 'C', 'D', 'E'];
    let cur = null, next = 0;
    const stem = [];
    for (const line of lines) {
      const m = line.match(mark);
      if (m && m[1].toUpperCase() === want[next]) { cur = want[next++]; out.opts[cur] = line.replace(mark, '').trim(); }
      else if (cur) out.opts[cur] += (line.trim() ? '\n' + line.trim() : '');
      else stem.push(line);
    }
    out.stem = stem.join('\n').trim();
    for (const k in out.opts) out.opts[k] = out.opts[k].trim();
    return out;
  }

  const api = { dayKeyOf, clozeNumbers, parseMcq, parseApkg, buildApkg, exportSched, importSched, toFsrs, fromFsrs, packState, unpackState, renderCard, renderTemplate, renderCloze, stripHtml, pbFields };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FichCore = api;
})(typeof self !== 'undefined' ? self : this);

