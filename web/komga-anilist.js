/* Komga ⇄ AniList — shows related series (sequels/prequels/...) above the volumes
 * and similar titles at the bottom of each series page. Reads the AniList link from
 * the series metadata, queries the AniList GraphQL API, and links series you already
 * own to their local Komga page. Served no-cache, so a reload picks up changes.
 * Console helper: kalRefresh() rebuilds the in-browser library map.
 */
(function () {
  'use strict';

  const TAG = '[KAL]';
  const ANILIST = 'https://graphql.anilist.co';
  const OWNED_KEY = 'kal_owned';
  const OWNED_TTL = 10 * 60 * 1000;
  const SEC_REL = 'kal-related';
  const SEC_REC = 'kal-similar';

  // Read Komga's current UI language from its Vue store (it doesn't update <html lang>).
  function komgaLocale() {
    try {
      const v = document.getElementById('app') && document.getElementById('app').__vue__;
      const loc = v && ((v.$i18n && v.$i18n.locale) ||
        (v.$store && v.$store.state && v.$store.state.persistedState && v.$store.state.persistedState.locale));
      if (loc) return loc;
    } catch (e) {}
    return document.documentElement.lang || navigator.language || 'en';
  }
  const lang = () => ((komgaLocale() || '').toLowerCase().startsWith('it') ? 'it' : 'en');

  const I18N = {
    it: {
      related: 'Serie collegate', similar: 'Simili (da AniList)', inLibrary: 'In libreria', editions: 'edizioni', otherEditions: 'Altre edizioni',
      rel: { PREQUEL: 'Prequel', SEQUEL: 'Sequel', SIDE_STORY: 'Side story', PARENT: 'Principale',
        SPIN_OFF: 'Spin-off', ALTERNATIVE: 'Alternativa', ADAPTATION: 'Adattamento',
        CHARACTER: 'Personaggio', SOURCE: 'Originale', SUMMARY: 'Riassunto',
        CONTAINS: 'Contiene', OTHER: 'Altro', COMPILATION: 'Raccolta' },
    },
    en: {
      related: 'Related series', similar: 'Similar (from AniList)', inLibrary: 'In library', editions: 'editions', otherEditions: 'Other editions',
      rel: { PREQUEL: 'Prequel', SEQUEL: 'Sequel', SIDE_STORY: 'Side story', PARENT: 'Parent',
        SPIN_OFF: 'Spin-off', ALTERNATIVE: 'Alternative', ADAPTATION: 'Adaptation',
        CHARACTER: 'Character', SOURCE: 'Source', SUMMARY: 'Summary',
        CONTAINS: 'Contains', OTHER: 'Other', COMPILATION: 'Compilation' },
    },
  };
  const T = () => I18N[lang()] || I18N.en;
  const relLabel = (t) => (T().rel[t] || t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' '));
  const REL_ORDER = ['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE',
                     'SOURCE', 'ADAPTATION', 'CHARACTER', 'COMPILATION', 'CONTAINS', 'SUMMARY', 'OTHER'];

  const seriesIdFromPath = () => (location.pathname.match(/\/series\/([^/?#]+)/) || [])[1] || null;
  const log = (...a) => console.debug(TAG, ...a);
  const contentWrap = () => document.querySelector('.v-main__wrap') || document.querySelector('main')
    || document.querySelector('.v-main') || document.body;

  async function komga(path) {
    const r = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('Komga ' + r.status + ' ' + path);
    return r.json();
  }
  async function gql(query, variables) {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(ANILIST, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      if (r.ok) {
        const j = await r.json();
        if (j.errors) throw new Error('AniList: ' + JSON.stringify(j.errors));
        return j.data;
      }
      // AniList throws transient 5xx and the odd 429 — retry with a small backoff.
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        const ra = parseInt(r.headers.get('Retry-After') || '0', 10);
        await new Promise((res) => setTimeout(res, (ra ? ra * 1000 : 0) + 800 * (attempt + 1)));
        continue;
      }
      throw new Error('AniList ' + r.status);
    }
  }
  const anilistIdFromLinks = (links) => {
    for (const l of links || []) {
      const m = (l.url || '').match(/anilist\.co\/(?:anime|manga)\/(\d+)/i);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  };
  // Every AniList id of a series (a single Komga series can bundle several works).
  const anilistIdsFromLinks = (links) => {
    const out = [];
    for (const l of links || []) {
      const m = (l.url || '').match(/anilist\.co\/(?:anime|manga)\/(\d+)/i);
      if (m) out.push(parseInt(m[1], 10));
    }
    return out;
  };

  // { anilistId -> [{ id, title }] } for every owned series, cached in localStorage.
  async function ownedMap(force) {
    if (!force) {
      try {
        const c = JSON.parse(localStorage.getItem(OWNED_KEY) || 'null');
        if (c && Date.now() - c.ts < OWNED_TTL) return c.map;
      } catch (e) {}
    }
    const d = await komga('/api/v1/series?unpaged=true');
    const map = {};
    for (const s of d.content) {
      for (const id of anilistIdsFromLinks(s.metadata && s.metadata.links)) {
        (map[id] = map[id] || []).push({ id: s.id, title: s.metadata.title });
      }
    }
    try { localStorage.setItem(OWNED_KEY, JSON.stringify({ ts: Date.now(), map })); } catch (e) {}
    return map;
  }

  const MEDIA_BODY = `
    type format
    title { romaji english }
    relations { edges { relationType(version: 2)
      node { id type format title { romaji english } coverImage { medium } siteUrl } } }
    recommendations(sort: RATING_DESC, perPage: 16) { nodes {
      mediaRecommendation { id type format title { romaji english } coverImage { medium } siteUrl } } }`;

  // Fetch all the series' AniList ids, aliased in chunks to stay under the query complexity limit.
  async function fetchMedias(ids) {
    const out = [];
    const CHUNK = 5;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const q = 'query{' + slice.map((id, k) => `m${k}: Media(id:${id}){${MEDIA_BODY}}`).join(' ') + '}';
      const data = await gql(q);
      for (const k of Object.keys(data)) if (data[k]) out.push(data[k]);
    }
    return out;
  }

  // Merge relations + recommendations across works, dedupe by id, drop the works themselves.
  function mergeMedias(medias, selfIds) {
    const rank = (t) => { const i = REL_ORDER.indexOf(t); return i < 0 ? 99 : i; };
    const relByNode = new Map();
    for (const m of medias) for (const e of m.relations.edges) {
      const n = e.node;
      if (selfIds.has(n.id)) continue;
      const prev = relByNode.get(n.id);
      if (!prev || rank(e.relationType) < rank(prev.relationType)) relByNode.set(n.id, { relationType: e.relationType, node: n });
    }
    const recById = new Map();
    for (const m of medias) for (const nd of m.recommendations.nodes) {
      const mr = nd.mediaRecommendation;
      if (!mr || selfIds.has(mr.id) || relByNode.has(mr.id) || recById.has(mr.id)) continue;
      recById.set(mr.id, nd);
    }
    return { relations: { edges: [...relByNode.values()] }, recommendations: { nodes: [...recById.values()] } };
  }

  function ensureStyle() {
    if (document.getElementById('kal-style')) return;
    const s = document.createElement('style');
    s.id = 'kal-style';
    s.textContent = `
      .kal-sec{padding:8px 12px 16px;width:100%;flex:1 1 100%;box-sizing:border-box;clear:both}
      #${SEC_REC}{padding-bottom:48px}
      .kal-sec h2{font-size:1.1rem;margin:8px 0 8px;opacity:.85}
      .kal-rowwrap{position:relative}
      .kal-row{display:flex;flex-wrap:nowrap;align-items:flex-start;gap:12px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none}
      .kal-group{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid;border-radius:8px}
      .kal-group.kal-owned{border-color:rgba(102,187,106,.4);background:rgba(102,187,106,.09)}
      .kal-group.kal-anilist{border-color:rgba(66,165,245,.4);background:rgba(66,165,245,.08)}
      .kal-group .kal-glabel{font-size:.62rem;text-transform:uppercase;letter-spacing:.04em;font-weight:700;white-space:nowrap;text-align:center}
      .kal-group.kal-owned .kal-glabel{color:#66bb6a}
      .kal-group.kal-anilist .kal-glabel{color:#42a5f5}
      .kal-group .kal-gcards{display:flex;gap:10px;justify-content:center}
      .kal-row::-webkit-scrollbar{display:none}
      .kal-arrow{position:absolute;top:112px;transform:translateY(-50%);width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;border:none;cursor:pointer;font-size:1.5rem;line-height:1;padding-bottom:3px;border-radius:50%;opacity:0;transition:opacity .15s;z-index:2;box-shadow:0 1px 5px rgba(0,0,0,.45)}
      .kal-arrow:hover{background:rgba(0,0,0,.8)}
      .kal-left{left:4px}
      .kal-right{right:4px}
      .kal-rowwrap:hover .kal-arrow{opacity:.9}
      .kal-arrow.kal-hidden{display:none}
      .kal-card{flex:0 0 120px;width:120px;text-decoration:none;color:inherit;position:relative}
      .kal-card img{width:120px;height:170px;object-fit:cover;border-radius:6px;display:block;background:#222}
      .kal-card .kal-rel{font-size:.62rem;text-transform:uppercase;letter-spacing:.04em;color:#42a5f5;font-weight:700;margin-top:5px}
      .kal-card .kal-t{font-size:.78rem;line-height:1.2;margin-top:7px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .kal-card .kal-meta{font-size:.68rem;opacity:.55}
      .kal-card .kal-badge{position:absolute;top:6px;left:6px;background:rgba(30,136,229,.78);color:#fff;font-size:.62rem;padding:2px 6px;border-radius:4px;font-weight:600}
      .kal-card .kal-ext{position:absolute;top:6px;right:6px;background:rgba(0,0,0,.6);color:#fff;font-size:.6rem;padding:2px 5px;border-radius:4px}`;
    (document.head || document.documentElement).appendChild(s);
  }

  function card(media, owned, relType) {
    const a = document.createElement('a');
    const ownedKomgaId = owned && owned.id;
    // Owned series use their local Komga title/cover/link; everything else points to AniList.
    const title = (owned && owned.title) || media.title.english || media.title.romaji || '???';
    if (ownedKomgaId) {
      a.href = '/series/' + ownedKomgaId;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        history.pushState({}, '', '/series/' + ownedKomgaId);
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
    } else {
      a.href = media.siteUrl; a.target = '_blank'; a.rel = 'noopener';
    }
    a.className = 'kal-card';
    a.title = title;
    const cover = ownedKomgaId
      ? ('/api/v1/series/' + ownedKomgaId + '/thumbnail')
      : ((media.coverImage && media.coverImage.medium) || '');
    const pretty = (s) => s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : '';
    const meta = (media.format && media.format !== media.type)
      ? pretty(media.type) + ' · ' + pretty(media.format) : pretty(media.type);
    a.innerHTML =
      `<img loading="lazy" src="${cover}" alt="">` +
      `<div class="kal-t">${title.replace(/</g, '&lt;')}</div>` +
      `<div class="kal-meta">${meta}</div>`;
    return a;
  }

  // Wrap a row with side arrows that only appear where there's something to scroll.
  function makeScroller(row) {
    const wrap = document.createElement('div'); wrap.className = 'kal-rowwrap';
    const left = document.createElement('button'); left.type = 'button'; left.className = 'kal-arrow kal-left'; left.textContent = '‹';
    const right = document.createElement('button'); right.type = 'button'; right.className = 'kal-arrow kal-right'; right.textContent = '›';
    wrap.appendChild(left); wrap.appendChild(row); wrap.appendChild(right);
    const update = () => {
      const max = row.scrollWidth - row.clientWidth - 1;
      const noOverflow = row.scrollWidth <= row.clientWidth + 1;
      left.classList.toggle('kal-hidden', noOverflow || row.scrollLeft <= 0);
      right.classList.toggle('kal-hidden', noOverflow || row.scrollLeft >= max);
    };
    // Even out title heights within this row only (the two sections stay independent).
    const equalize = () => {
      const ts = row.querySelectorAll('.kal-t');
      let max = 0;
      ts.forEach((t) => { t.style.height = 'auto'; });
      ts.forEach((t) => { if (t.offsetHeight > max) max = t.offsetHeight; });
      ts.forEach((t) => { t.style.height = max + 'px'; });
    };
    const refresh = () => { equalize(); update(); };
    const step = () => Math.max(row.clientWidth * 0.85, 200);
    left.addEventListener('click', () => row.scrollBy({ left: -step(), behavior: 'smooth' }));
    right.addEventListener('click', () => row.scrollBy({ left: step(), behavior: 'smooth' }));
    row.addEventListener('scroll', update, { passive: true });
    // No vertical-wheel hijack: vertical scrolls the page, horizontal (trackpad/tilt) scrolls the row.
    if (window.ResizeObserver) new ResizeObserver(refresh).observe(row);
    setTimeout(refresh, 0); setTimeout(refresh, 300); setTimeout(refresh, 1200); // re-check after covers load
    return wrap;
  }

  // One box per work. Label is "[relation ·] source", source = "In library" / "N editions" / "AniList".
  function itemFor(media, ownedList, relType) {
    const eds = (ownedList && ownedList.length)
      ? ownedList.slice().sort((a, b) => a.title.localeCompare(b.title)) : null;
    const multi = eds && eds.length >= 2;
    const g = document.createElement('div'); g.className = 'kal-group ' + (eds ? 'kal-owned' : 'kal-anilist');
    const src = eds ? (multi ? eds.length + ' ' + T().editions : T().inLibrary) : 'AniList';
    const lab = document.createElement('div'); lab.className = 'kal-glabel';
    lab.textContent = (relType ? relLabel(relType) + ' · ' : '') + src;
    g.appendChild(lab);
    const cc = document.createElement('div'); cc.className = 'kal-gcards';
    if (eds) for (const o of eds) cc.appendChild(card(media, o, null));
    else cc.appendChild(card(media, null, null));
    g.appendChild(cc);
    return g;
  }

  function buildRelated(data, owned, otherEd, media0) {
    const edges = data.relations.edges.slice().sort((a, b) => {
      const ia = REL_ORDER.indexOf(a.relationType), ib = REL_ORDER.indexOf(b.relationType);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    if (!edges.length && !(otherEd && otherEd.length)) return null;
    const sec = document.createElement('div'); sec.id = SEC_REL; sec.className = 'kal-sec';
    const h = document.createElement('h2'); h.textContent = T().related; sec.appendChild(h);
    const row = document.createElement('div'); row.className = 'kal-row';
    // Other editions of this same series that you own go first.
    if (otherEd && otherEd.length) {
      const g = document.createElement('div'); g.className = 'kal-group kal-owned';
      const lab = document.createElement('div'); lab.className = 'kal-glabel'; lab.textContent = T().otherEditions; g.appendChild(lab);
      const cc = document.createElement('div'); cc.className = 'kal-gcards';
      const fake = media0 || { title: {}, type: '', format: null };
      for (const o of otherEd) cc.appendChild(card(fake, o, null));
      g.appendChild(cc); row.appendChild(g);
    }
    for (const e of edges) row.appendChild(itemFor(e.node, owned[e.node.id], e.relationType));
    sec.appendChild(makeScroller(row));
    return sec;
  }
  function buildSimilar(data, owned) {
    const recs = data.recommendations.nodes.map(n => n.mediaRecommendation).filter(Boolean);
    if (!recs.length) return null;
    const sec = document.createElement('div'); sec.id = SEC_REC; sec.className = 'kal-sec';
    const h = document.createElement('h2'); h.textContent = T().similar; sec.appendChild(h);
    const row = document.createElement('div'); row.className = 'kal-row';
    for (const m of recs) row.appendChild(itemFor(m, owned[m.id], null));
    sec.appendChild(makeScroller(row));
    return sec;
  }

  // The volumes grid = smallest element that contains all the /book/ links.
  function booksGrid() {
    const links = document.querySelectorAll('a[href*="/book/"]');
    if (!links.length) return null;
    let el = links[0];
    while (el && el.querySelectorAll('a[href*="/book/"]').length < links.length) el = el.parentElement;
    return el || null;
  }

  let cur = null;
  let fetching = false, rendering = false, dbnc = null;

  const removeSections = () => { for (const id of [SEC_REL, SEC_REC]) { const n = document.getElementById(id); if (n) n.remove(); } };

  function render() {
    if (!cur) return;
    ensureStyle();
    rendering = true;
    try {
      removeSections();
      const wrap = contentWrap();
      const grid = booksGrid();
      if (cur.hasRel) {
        const rel = buildRelated(cur.data, cur.owned, cur.otherEd, cur.media0);
        if (grid && grid.parentElement) grid.parentElement.insertBefore(rel, grid);
        else if (wrap) wrap.insertBefore(rel, wrap.firstChild);
        else document.body.appendChild(rel);
      }
      if (cur.hasSim) {
        const sim = buildSimilar(cur.data, cur.owned);
        if (grid && grid.parentElement) grid.parentElement.insertBefore(sim, grid.nextSibling);
        else (wrap || document.body).appendChild(sim);
      }
    } finally { rendering = false; }
  }

  // True when the DOM is already in the wanted state (stops the observer loop).
  function correct() {
    if (!cur) return true;
    const rel = document.getElementById(SEC_REL), sim = document.getElementById(SEC_REC);
    if (cur.hasRel && !rel) return false;
    if (cur.hasSim && !sim) return false;
    if (rel) { const g = booksGrid(); if (g && rel.nextElementSibling !== g) return false; }
    return true;
  }
  function scheduleRender() {
    clearTimeout(dbnc);
    dbnc = setTimeout(() => { if (cur && cur.sid === seriesIdFromPath() && !correct() && !rendering) render(); }, 150);
  }

  async function load(forceMap) {
    const sid = seriesIdFromPath();
    if (!sid) { if (cur) { cur = null; removeSections(); } return; }
    if (fetching || (cur && cur.sid === sid && !forceMap)) { scheduleRender(); return; }
    fetching = true;
    try {
      const series = await komga('/api/v1/series/' + sid);
      if (seriesIdFromPath() !== sid) return;
      const ids = anilistIdsFromLinks(series.metadata.links);
      if (!ids.length) { cur = null; removeSections(); log('series without AniList link:', sid); return; }
      log('series', sid, '-> AniList', ids, '| lang', lang());
      const selfIds = new Set(ids);
      const [medias, owned] = await Promise.all([fetchMedias(ids), ownedMap(forceMap)]);
      if (seriesIdFromPath() !== sid) return;
      const data = mergeMedias(medias, selfIds);
      const media0 = medias[0] || null;
      // Other editions of this same series you own (same AniList id, excluding the open one).
      const seenK = new Set([sid]);
      const otherEd = [];
      for (const id of ids) for (const o of (owned[id] || [])) {
        if (!seenK.has(o.id)) { seenK.add(o.id); otherEd.push(o); }
      }
      cur = {
        sid, data, owned, media0, otherEd,
        hasRel: data.relations.edges.length > 0 || otherEd.length > 0,
        hasSim: data.recommendations.nodes.length > 0,
      };
      render();
      log('render ok');
    } catch (e) {
      console.error(TAG, e);
    } finally {
      fetching = false;
    }
  }

  // Rebuild the library map (call from the console after adding AniList links).
  window.kalRefresh = function () { localStorage.removeItem(OWNED_KEY); cur = null; removeSections(); load(true); };

  // Komga is a Vue SPA — hook navigation so we re-run on route changes.
  function tick() { setTimeout(load, 400); }
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function () { const r = orig.apply(this, arguments); tick(); return r; };
  }
  window.addEventListener('popstate', tick);

  new MutationObserver(() => {
    const sid = seriesIdFromPath();
    if (!sid) { if (cur) { cur = null; removeSections(); } return; }
    if (!cur || cur.sid !== sid) { load(); return; }
    if (!correct()) scheduleRender();
  }).observe(document.body, { childList: true, subtree: true });

  ensureStyle();
  log('loaded');
  tick();
})();
