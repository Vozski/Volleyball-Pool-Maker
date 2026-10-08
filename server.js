#!/usr/bin/env node
/* Pool Builder – Live Draw backend
 *
 *  - Reads a Majestri "teams" page and splits teams by gender + division.
 *  - Looks every player up on https://abvtour.com.au/national-rankings.php
 *  - Team seed points = (top 3 results in the last 365 days) for player 1 + player 2.
 *  - Re-syncs every live draw once an hour and stores everything in ./data/
 *
 *  Run:  npm install   then   node server.js      (needs Node 18 or newer)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch (e) { /* optional: only needed when Majestri builds the page with JavaScript */ }

const PORT = +process.env.PORT || 3000;
/* Hosts like Render set PORT and need the server reachable from outside (0.0.0.0). On your own computer it stays on localhost. */
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const SYNC_MS = 60 * 60 * 1000;          // how often every live draw is refreshed
const RANK_TTL = 55 * 60 * 1000;         // national rankings are re-read at most once an hour
const RESULT_TTL = 6 * 60 * 60 * 1000;   // a player's results page is re-read at most every 6 hours
const DAY = 24 * 60 * 60 * 1000;
const FUZZY = process.env.FUZZY !== '0'; // allow Rob/Robert, Ollie/Oliver style matches
const ABV = 'https://abvtour.com.au';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 PoolBuilderLive/1.0';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');   // point this at a persistent disk on a host
const DRAWS_FILE = path.join(DATA_DIR, 'draws.json');
const CACHE_FILE = path.join(DATA_DIR, 'abv-cache.json');

/* ------------------------------------------------------------------ utils */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

async function fetchText(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-AU,en;q=0.9' },
        signal: ctrl.signal, redirect: 'follow',
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + new URL(url).host);
      return await r.text();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1200 * (i + 1));
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

/* small concurrency limiter so we stay polite to abvtour.com.au */
let active = 0;
const waiters = [];
async function limited(fn) {
  if (active >= 4) await new Promise((r) => waiters.push(r));
  active++;
  try { await sleep(80); return await fn(); }
  finally { active--; const w = waiters.shift(); if (w) w(); }
}

/* ------------------------------------------------------------ name logic */
function normKey(s) {
  const k = String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’‘`´]/g, "'").replace(/[^a-z' -]/g, ' ').replace(/['-]/g, ' ').replace(/\s+/g, ' ').trim();
  return k || String(s || '').toLowerCase().trim();
}

/* nickname groups – names in the same group count as the same first name */
const NICK_GROUPS = [
  ['robert', 'rob', 'robbie', 'bob', 'bobby'], ['oliver', 'ollie', 'olly', 'oli'], ['benjamin', 'ben', 'benny', 'benji'],
  ['matthew', 'matt'], ['michael', 'mike', 'mick', 'mikey'], ['thomas', 'tom', 'tommy'], ['samuel', 'sam', 'sammy', 'samantha'],
  ['daniel', 'dan', 'danny', 'danielle', 'dani'], ['alexander', 'alex', 'alexandre', 'alexandra', 'lexi'],
  ['nicholas', 'nick', 'nicolas', 'nic'], ['christopher', 'chris', 'christian'], ['william', 'will', 'bill', 'billy'],
  ['joshua', 'josh'], ['joseph', 'joe', 'joey'], ['timothy', 'tim', 'timmy'], ['stephen', 'steven', 'steve', 'stephanie', 'steph'],
  ['andrew', 'andy', 'drew'], ['charles', 'charlie', 'charlotte', 'chuck'], ['edward', 'ed', 'eddie', 'ted', 'teddy'],
  ['james', 'jim', 'jimmy', 'jamie'], ['jonathan', 'jon', 'jonny', 'jonno'], ['jacob', 'jake'], ['nathan', 'nate'],
  ['zachary', 'zach', 'zac', 'zak', 'zack'], ['anthony', 'tony'], ['patrick', 'pat', 'paddy'],
  ['lachlan', 'lachie', 'lochlan'], ['richard', 'rick', 'ricky', 'rich', 'dick'], ['peter', 'pete'],
  ['phillip', 'philip', 'phil'], ['max', 'maximilian', 'maxwell', 'maxx'], ['frederick', 'fred', 'freddie'],
  ['gregory', 'greg'], ['sebastian', 'seb'], ['kenneth', 'ken', 'kenny'], ['dominic', 'dom'],
  ['elizabeth', 'liz', 'lizzie', 'beth', 'betty'], ['katherine', 'catherine', 'kate', 'katie', 'kathryn', 'kat', 'cathy'],
  ['jessica', 'jess', 'jessie'], ['rebecca', 'bec', 'becky', 'becca'], ['victoria', 'vicki', 'vicky', 'tori'],
  ['madeline', 'madeleine', 'maddie', 'maddy'], ['isabella', 'isabelle', 'izzy', 'bella'], ['natalie', 'nat'],
  ['amanda', 'mandy'], ['caitlin', 'kaitlin', 'katelyn', 'caitlyn', 'kaitlyn'], ['emily', 'em', 'emmy'],
  ['olivia', 'liv', 'livvy'], ['abigail', 'abby', 'abbie'], ['melissa', 'mel', 'missy', 'melanie'],
  ['jennifer', 'jen', 'jenny'], ['gabrielle', 'gabby', 'gabi', 'gabriella'], ['rachel', 'rach'], ['alice', 'allie'],
  ['sophie', 'sophia'], ['ashleigh', 'ashley'], ['hannah', 'hanna'],
];
const NICK = new Map();
(function build() {
  let n = 0;
  NICK_GROUPS.forEach((g) => {
    const existing = g.map((x) => NICK.get(x)).find((x) => x != null);
    const id = existing != null ? existing : n++;
    g.forEach((x) => {
      const old = NICK.get(x);
      if (old != null && old !== id) NICK.forEach((v, k) => { if (v === old) NICK.set(k, id); });
      NICK.set(x, id);
    });
  });
})();

function firstMatches(a, b) {
  if (a === b) return true;
  const ga = NICK.get(a), gb = NICK.get(b);
  if (ga != null && ga === gb) return true;
  return Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a));
}
function fuzzyEq(k1, k2) {
  const a = k1.split(' '), b = k2.split(' ');
  if (a.length < 2 || b.length < 2) return false;
  return a[a.length - 1] === b[b.length - 1] && firstMatches(a[0], b[0]);
}
const isQld = (region) => /queensland|\bqld\b/i.test(region || '');

/* ------------------------------------------------------- ABV: rankings */
function parseRankings(html) {
  const $ = cheerio.load(html);
  const out = { men: [], women: [] };
  const tables = $('table').toArray();
  tables.forEach((t, i) => {
    const $t = $(t);
    const head = $t.find('tr').first().text().replace(/\s+/g, ' ').toLowerCase();
    let g = /women|ladies|female/.test(head) ? 'women' : /\bmen|male/.test(head) ? 'men' : null;
    if (!g) {
      const prev = $t.prevAll('h1,h2,h3,h4,h5,p,div').first().text().toLowerCase();
      g = /women|ladies|female/.test(prev) ? 'women' : /\bmen|male/.test(prev) ? 'men' : (i === 0 ? 'men' : 'women');
    }
    $t.find('a[href*="player_id="]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const id = (href.match(/player_id=(\d+)/) || [])[1];
      if (!id) return;
      const txt = $(a).text().replace(/\s+/g, ' ').trim();
      const m = txt.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      const name = (m ? m[1] : txt).trim();
      const region = m ? (m[2].split('/')[1] || '').trim() : '';
      const tds = $(a).closest('tr').find('td');
      const pts = parseFloat($(tds[2]).text().replace(/[^\d.]/g, '')) || 0;
      out[g].push({ id, name, key: normKey(name), region, qld: isQld(region), points: pts });
    });
  });
  return out;
}

function indexRankings(r) {
  const make = (list) => {
    const byKey = new Map();
    list.forEach((p) => { if (!byKey.has(p.key)) byKey.set(p.key, []); byKey.get(p.key).push(p); });
    return { list, byKey };
  };
  return { men: make(r.men), women: make(r.women) };
}

/* --------------------------------------------------- ABV: player results */
function parseResults(html) {
  const $ = cheerio.load(html);
  const events = [];
  $('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 4) return;
    const ev = $(tds[0]).text().replace(/\s+/g, ' ').trim();
    const dates = [...ev.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g)];
    if (!dates.length) return;
    const last = dates[dates.length - 1];
    const end = Date.UTC(+last[3], +last[2] - 1, +last[1]);
    const pts = parseFloat($(tds[tds.length - 1]).text().replace(/[^\d.\-]/g, ''));
    events.push({ name: ev.replace(/\d{1,2}\/\d{1,2}\/\d{4}(\s*-\s*\d{1,2}\/\d{1,2}\/\d{4})?/, '').trim(), end, points: isNaN(pts) ? 0 : pts });
  });
  return events;
}

function top3(events, now = Date.now()) {
  const cutoff = now - 365 * DAY;
  const pts = events.filter((e) => e.end >= cutoff && e.end <= now + DAY).map((e) => e.points)
    .filter((p) => p > 0).sort((a, b) => b - a).slice(0, 3);
  return { points: pts.reduce((a, b) => a + b, 0), used: pts.length };
}

/* ------------------------------------------------------------ ABV cache */
const cache = readJSON(CACHE_FILE, { rankings: null, results: {} });
if (!cache.results) cache.results = {};
const inflight = new Map();
let rankIndex = null, rankIndexT = 0;
const resolved = new Map();
let cacheTimer = null;
function saveCacheSoon() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => { try { writeJSON(CACHE_FILE, cache); } catch (e) { /* ignore */ } }, 1500);
}

async function getRankings() {
  if (rankIndex && Date.now() - rankIndexT < RANK_TTL) return rankIndex;
  let data = null;
  try {
    const html = await fetchText(ABV + '/national-rankings.php');
    const parsed = parseRankings(html);
    if (parsed.men.length + parsed.women.length < 20) throw new Error('The national rankings page looked empty or has changed layout');
    data = parsed;
    cache.rankings = { t: Date.now(), data };
    saveCacheSoon();
    log(`rankings: ${parsed.men.length} men, ${parsed.women.length} women`);
  } catch (e) {
    if (cache.rankings && cache.rankings.data) {
      log('rankings fetch failed, using cached copy:', e.message);
      data = cache.rankings.data;
    } else throw e;
  }
  rankIndex = indexRankings(data);
  rankIndexT = Date.now();
  resolved.clear();
  return rankIndex;
}

async function getResults(id) {
  const c = cache.results[id];
  if (c && Date.now() - c.t < RESULT_TTL) return c.events;
  if (inflight.has(id)) return inflight.get(id);
  const p = limited(async () => {
    try {
      const html = await fetchText(`${ABV}/viewPlayerResults.php?player_id=${id}`);
      const events = parseResults(html);
      cache.results[id] = { t: Date.now(), events };
      saveCacheSoon();
      return events;
    } catch (e) {
      if (c) return c.events;       // stale is better than nothing
      throw e;
    }
  }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/* Find one player on the rankings page and work out their points.
 * Same name twice -> prefer Queensland, then the most recent tournament played. */
async function resolvePlayer(name, gender, idx) {
  const key = normKey(name);
  const rkey = gender + '|' + key;
  if (resolved.has(rkey)) return resolved.get(rkey);
  const pools = gender === 'men' ? [idx.men] : gender === 'women' ? [idx.women] : [idx.men, idx.women];
  let cands = [], how = 'exact';
  pools.forEach((ix) => { cands = cands.concat(ix.byKey.get(key) || []); });
  if (!cands.length && FUZZY) {
    how = 'alias';
    pools.forEach((ix) => ix.list.forEach((p) => { if (fuzzyEq(key, p.key)) cands.push(p); }));
  }
  if (!cands.length) {
    const none = { name, matched: false, points: 0 };
    resolved.set(rkey, none);
    return none;
  }
  const dupes = cands.length;
  const q = cands.filter((c) => c.qld);
  if (q.length) cands = q;
  const withLast = [];
  if (cands.length > 1) {
    for (const c of cands) {
      const ev = await getResults(c.id);
      withLast.push({ c, last: ev.reduce((m, e) => Math.max(m, e.end), 0) });
    }
    withLast.sort((a, b) => (b.last - a.last) || (b.c.points - a.c.points));
    cands = withLast.map((x) => x.c);
  }
  const pick = cands[0];
  const ev = await getResults(pick.id);
  const t = top3(ev);
  const out = { name, matched: true, points: t.points, events: t.used, matchedName: pick.name, region: pick.region, playerId: pick.id, how, dupes };
  resolved.set(rkey, out);
  return out;
}

/* ---------------------------------------------------- Majestri: the page */
const DIV_PATTERNS = [
  [/\bpremier\b/i, () => 'Premier'], [/\bchallenger\b/i, () => 'Challenger'], [/\baspiring\b/i, () => 'Aspiring'],
  [/\bemerging\b/i, () => 'Emerging'], [/\bu\s?-?(1[2-9]|2[0-3])\s?'?s?\b/i, (m) => 'U' + m[1]],
  [/\bunder\s*(1[2-9]|2[0-3])\b/i, (m) => 'U' + m[1]], [/\bmasters?\b/i, () => 'Masters'],
  [/\bopen\b/i, () => 'Open'], [/\bjuniors?\b/i, () => 'Junior'],
];
function divOf(s) {
  for (const [re, f] of DIV_PATTERNS) { const m = s.match(re); if (m) return f(m); }
  return null;
}
function genderOf(s) {
  s = s.replace(/[’‘`´]/g, "'");
  if (/\b(women'?s?|womens|female|ladies|girls?)\b/i.test(s)) return 'women';
  if (/\b(men'?s?|mens|male|boys?)\b/i.test(s)) return 'men';
  if (/\b(mixed|co-?ed)\b/i.test(s)) return 'mixed';
  return null;
}
const HEAD_ALLOWED = new Set(['men', "men's", 'mens', 'women', "women's", 'womens', 'male', 'female', 'ladies', 'girls', 'girl', 'boys', 'boy', 'mixed', 'coed', 'co', 'ed',
  'premier', 'challenger', 'aspiring', 'emerging', 'open', 'masters', 'master', 'junior', 'juniors', 'senior', 'seniors', 'division', 'divisions', 'div',
  'teams', 'team', 'entries', 'entrants', 'registered', 'registrations', 'section', 'list', 'draw', 'seed', 'the', 'all', 'of', 'and', 's', 'pool', 'category', 'age', 'under']);
const HEAD_KEY = new Set(['men', "men's", 'mens', 'women', "women's", 'womens', 'male', 'female', 'ladies', 'girls', 'girl', 'boys', 'boy', 'mixed', 'coed',
  'premier', 'challenger', 'aspiring', 'emerging', 'open', 'masters', 'master', 'junior', 'juniors']);
function isHeadingText(s) {
  const toks = s.toLowerCase().replace(/[’‘`´]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!toks.length || toks.length > 8) return false;
  let key = false;
  for (const t of toks) {
    if (/^u\d{2}('?s)?$/.test(t)) { key = true; continue; }
    if (HEAD_KEY.has(t)) key = true;
    if (!(HEAD_ALLOWED.has(t) || /^\d+$/.test(t))) return false;
  }
  return key;
}

const NOT_NAME = new Set(['team', 'teams', 'player', 'players', 'name', 'names', 'status', 'seed', 'rank', 'entry', 'entries', 'registered', 'division', 'paid', 'unpaid',
  'pending', 'tbc', 'tba', 'tbd', 'total', 'points', 'club', 'partner', 'no', 'yes', 'withdrawn', 'waitlist', 'pool', 'position', 'place', 'event', 'date']);
const STATUS_RE = /^(paid|unpaid|pending|confirmed|registered|approved|complete|completed|yes|no|n\/a|-|–|—)$/i;
const PLACEHOLDER = /^(tbc|tba|tbd|partner(\s+tbc)?|unknown|\?+|-|–)$/i;

function cleanCell(c) {
  return String(c).replace(/\([^)]*\)/g, ' ').replace(/^\s*#?\d+[.)]\s+/, '').replace(/\s+/g, ' ').trim();
}
function isNameLike(s) {
  s = s.trim();
  if (!s || s.length > 45) return false;
  if (!/^[\p{L}][\p{L}\p{M}'’.\- ,]*$/u.test(s)) return false;
  if (s.split(/\s+/).length > 5) return false;
  const low = s.toLowerCase();
  if (NOT_NAME.has(low) || /^(player|team|partner)\s*\d*$/.test(low)) return false;
  if (isHeadingText(s)) return false;
  return true;
}
function fixComma(s) {
  const p = s.split(',');
  return p.length === 2 && p[0].trim() && p[1].trim() ? (p[1].trim() + ' ' + p[0].trim()) : s.replace(/,/g, '').trim();
}
function splitPair(c) {
  const parts = c.split(/\s*\/\s*|\s+&\s+|\s+\+\s+|\s+and\s+/i).map((x) => x.trim());
  if (parts.length !== 2) return null;
  const ok = parts.map(isNameLike), tbc = parts.map((p) => PLACEHOLDER.test(p));
  if (ok[0] && ok[1]) return parts.map(fixComma);
  if (ok[0] && tbc[1]) return [fixComma(parts[0])];
  if (tbc[0] && ok[1]) return [fixComma(parts[1])];
  return null;
}
function extractPlayers(rest) {
  if (!rest.length) return null;
  for (const c of rest) { const p = splitPair(c); if (p) return p; }
  const nm = rest.filter(isNameLike);
  if (rest.length === 2 && nm.length === 2) return nm.map(fixComma);
  if (rest.length === 4 && nm.length === 4 && rest.every((x) => x.split(/\s+/).length === 1)) return [rest[0] + ' ' + rest[1], rest[2] + ' ' + rest[3]];
  return null;
}

/* Majestri "Team Nominations" table: Division | Gender | Player 1 | Player 2 | Player 3 | Player 4 */
function cleanName(s) {
  s = fixComma(String(s || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim());
  return !s || PLACEHOLDER.test(s) || /^\d+$/.test(s) ? '' : s;
}
function divisionFromRaw(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  const std = ['Premier', 'Challenger', 'Aspiring'].filter((n) => new RegExp('\\b' + n + '\\b', 'i').test(t));
  if (std.length === 1) return { division: std[0], combined: false };
  /* "Seniors (Premier/Challenger/Aspiring)" is one entry list - the real divisions are decided later by seed points */
  if (std.length > 1 || !t || /^seniors?$/i.test(t)) return { division: 'Unassigned', combined: true };
  return { division: divOf(t) || t, combined: false };
}
function genderFromCell(s) {
  s = String(s || '').trim();
  if (/^(female|women'?s?|womens|ladies|girls?|f)$/i.test(s)) return 'women';
  if (/^(male|men'?s?|mens|boys?|m)$/i.test(s)) return 'men';
  if (/^(mixed|co-?ed|x)$/i.test(s)) return 'mixed';
  return genderOf(s);
}
function parseNominations($) {
  const out = [], seen = new Set();
  const text = (e) => $(e).text().replace(/\s+/g, ' ').trim();
  const docHeads = $('th').toArray().map(text);
  $('table').each((_, tb) => {
    const $tb = $(tb);
    let heads = $tb.find('thead th').toArray().map(text);
    if (!heads.some((h) => /player\s*1/i.test(h))) heads = $tb.find('tr').first().children('th,td').toArray().map(text);
    if (!heads.some((h) => /player\s*1/i.test(h))) heads = docHeads;   // some table widgets keep the header in a separate table
    if (!heads.some((h) => /player\s*1/i.test(h))) return;
    const col = { div: heads.findIndex((h) => /division/i.test(h)), gen: heads.findIndex((h) => /gender|sex/i.test(h)), pl: [] };
    heads.forEach((h, i) => { if (/player\s*\d/i.test(h)) col.pl.push(i); });
    $tb.find('tr').each((_, tr) => {
      const tds = $(tr).children('td');
      if (tds.length < 3) return;
      const cell = (i) => (i >= 0 && i < tds.length ? text(tds[i]) : '');
      const players = col.pl.map((i) => cleanName(cell(i))).filter(Boolean);
      if (!players.length || players.some((p) => /^player\s*\d$/i.test(p))) return;
      const g = genderFromCell(cell(col.gen)) || 'other', dv = divisionFromRaw(cell(col.div));
      const k = g + '|' + dv.division + '|' + players.map(normKey).sort().join('+');
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ gender: g, division: dv.division, combined: dv.combined, players });
    });
  });
  return out;
}

/* The same nominations list built from <div>s instead of a <table>: read the flat sequence of cells.
   Every row is  Division, Gender, Player 1..4  (empty cells simply produce no text), so the gender word anchors each row. */
const GENDER_WORD = /^(male|female|men'?s?|women'?s?|mens|womens|mixed|boys?|girls?|ladies|co-?ed)$/i;
const DIV_LIKE = /\b(seniors?|premier|challenger|aspiring|juniors?|masters?|open|division|u\s?-?\d{2}|under\s*\d+)\b/i;
function parseNominationTokens(rows) {
  const toks = [];
  rows.forEach((cells) => cells.forEach((c) => { c = String(c).replace(/\s+/g, ' ').trim(); if (c) toks.push(c); }));
  let start = -1;
  toks.forEach((t, i) => { if (/^player\s*\d$/i.test(t)) start = i; });
  if (start < 0) return [];
  const END = /^(terms\b|privacy|©|copyright|majestri$)/i, body = [];
  for (let i = start + 1; i < toks.length; i++) { if (END.test(toks[i])) break; body.push(toks[i]); }
  const anchors = [];
  body.forEach((t, i) => { if (GENDER_WORD.test(t)) anchors.push(i); });
  const out = [], seen = new Set();
  anchors.forEach((a, k) => {
    const prevDiv = a > 0 && DIV_LIKE.test(body[a - 1]) && !(k > 0 && a - 1 <= anchors[k - 1]) ? body[a - 1] : '';
    let end = k + 1 < anchors.length ? anchors[k + 1] : body.length;
    if (k + 1 < anchors.length && end > a + 1 && DIV_LIKE.test(body[end - 1])) end--;
    const players = body.slice(a + 1, end).slice(0, 4).map(cleanName).filter(Boolean);
    if (!players.length) return;
    const dv = divisionFromRaw(prevDiv), g = genderFromCell(body[a]) || 'other';
    const key = g + '|' + dv.division + '|' + players.map(normKey).sort().join('+');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ gender: g, division: dv.division, combined: dv.combined, players });
  });
  return out;
}
function findEventTitle($) {
  const c = [];
  $('h1,h2,h3,h4,h5,h6,p,div,span,small,b,strong,header').each((_, e) => {
    if ($(e).children().length > 3) return;
    const t = $(e).text().replace(/\s+/g, ' ').trim();
    if (t.length < 8 || t.length > 120 || /division|gender|search|terms|conditions/i.test(t)) return;
    if (/qbvt|\bround\s*\d+/i.test(t)) c.push(t);
  });
  const best = (re) => c.filter((t) => re.test(t)).sort((a, b) => a.length - b.length)[0];
  const t = best(/(?=.*qbvt)(?=.*round)/i) || best(/round/i) || c[0] || null;
  return t ? t.replace(/^team nominations\s*[-:]?\s*/i, '').trim() : null;
}

/* flatten the page into rows of cells so tables, lists and cards all look alike */
const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'template', 'nav', 'footer', 'select', 'option', 'button', 'input']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'caption', 'legend']);
function pageRows($) {
  const rows = [];
  let cur = '';
  const flush = () => {
    const cells = cur.replace(/[ \u00a0\r\n]+/g, ' ').split('\t').map((s) => s.trim()).filter(Boolean);
    if (cells.length) rows.push(cells);
    cur = '';
  };
  const walk = (el) => {
    if (el.type === 'text') { cur += el.data; return; }
    if (el.type !== 'tag') return;
    const n = el.name;
    if (SKIP.has(n)) return;
    if (n === 'br') { flush(); return; }
    const block = BLOCK.has(n);
    if (block) flush();
    (el.children || []).forEach(walk);
    if (n === 'td' || n === 'th') cur += '\t'; else if (!block) cur += ' ';
    if (block) flush();
  };
  const body = $('body')[0] || $.root()[0];
  walk(body);
  flush();
  return rows;
}

function pickTitle($, url) {
  const ev = findEventTitle($);
  if (ev) return ev;
  const strip = (s) => s.replace(/\s+/g, ' ').replace(/\s*[|–—]\s*(Majestri|Volleyball Queensland|VQ).*$/i, '').replace(/\s+-\s*Majestri.*$/i, '')
    .replace(/\s*[-–—|:]?\s*(?:BVT\s+)?(?:Registered\s+)?(?:Teams?|Entries)\s*$/i, '').trim();
  const cands = [];
  $('h1').each((_, e) => cands.push($(e).text()));
  cands.push($('meta[property="og:title"]').attr('content') || '');
  $('h2').slice(0, 2).each((_, e) => cands.push($(e).text()));
  cands.push($('title').text());
  const clean = cands.map(strip).filter((s) => s.length > 3 && s.length < 140 && !/^(terms|team nominations)/i.test(s));
  const pref = clean.find((s) => /round|qbvt|tour|cup|champ|series|bvt|open|\d{4}/i.test(s));
  if (pref) return pref;
  if (clean[0]) return clean[0];
  const slug = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'Tournament');
  return slug.replace(/-teams$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseMajestri(html, url) {
  const $ = cheerio.load(html);
  const title = pickTitle($, url);
  const nom = parseNominations($);
  if (nom.length) return { title, teams: nom, warnings: [], diag: { rowCount: nom.length, headings: [], unparsed: [], via: 'nominations table' } };
  const rows = pageRows($);
  const tok = parseNominationTokens(rows);
  if (tok.length) return { title, teams: tok, warnings: [], diag: { rowCount: tok.length, headings: [], unparsed: [], via: 'nominations list' } };
  const diag = { rowCount: rows.length, headings: [], unparsed: [] };
  const ctx = { g: null, d: null };
  let outer = null;
  const applyHeading = (g, d) => {
    diag.headings.length < 40 && diag.headings.push({ gender: g, division: d });
    if (g && d) { ctx.g = g; ctx.d = d; return; }
    if (g) { if (!outer) outer = 'gender'; ctx.g = g; if (outer === 'gender') ctx.d = null; }
    else if (d) { if (!outer) outer = 'division'; ctx.d = d; if (outer === 'division') ctx.g = null; }
  };
  const buckets = new Map();
  const addTeam = (g, d, players) => {
    g = g || 'other'; d = d || 'Unassigned';
    const k = g + '|' + d + '|' + players.map(normKey).sort().join('+');
    if (buckets.has(k)) return;
    buckets.set(k, { gender: g, division: d, players });
  };

  const SKIPLINE = /withdrawn|cancell?ed|refund|removed|declined|wait\s?list/i;
  rows.forEach((cells) => {
    const cs = cells.map(cleanCell).filter(Boolean);
    if (!cs.length) return;
    if (SKIPLINE.test(cs.join(' '))) return;
    if (cs.length === 1 && isHeadingText(cs[0])) { applyHeading(genderOf(cs[0]), divOf(cs[0])); return; }
    let g = null, d = null;
    const rest = [];
    cs.forEach((c) => {
      if (isHeadingText(c)) { g = g || genderOf(c); d = d || divOf(c); return; }
      if (/^#?\d+([.,]\d+)?\.?$/.test(c) || STATUS_RE.test(c)) return;
      rest.push(c);
    });
    const players = extractPlayers(rest);
    if (players && players.length) addTeam(g || ctx.g, d || ctx.d, players);
    else if ((ctx.g || ctx.d) && diag.unparsed.length < 25) diag.unparsed.push(cs.join(' | ').slice(0, 160));
  });

  /* fallback: some layouts put each player on their own line */
  if (!buckets.size) {
    const c2 = { g: null, d: null };
    let pending = null, o2 = null;
    rows.forEach((cells) => {
      const cs = cells.map(cleanCell).filter(Boolean);
      if (cs.length === 1 && isHeadingText(cs[0])) {
        const g = genderOf(cs[0]), d = divOf(cs[0]);
        if (g && d) { c2.g = g; c2.d = d; }
        else if (g) { if (!o2) o2 = 'gender'; c2.g = g; if (o2 === 'gender') c2.d = null; }
        else if (d) { if (!o2) o2 = 'division'; c2.d = d; if (o2 === 'division') c2.g = null; }
        pending = null; return;
      }
      if (/privacy|terms|contact|copyright|powered by|©/i.test(cs.join(' '))) { pending = null; c2.d = null; return; }
      if (cs.length === 1 && (c2.d || c2.g) && isNameLike(cs[0]) && cs[0].split(/\s+/).length >= 2 && !SKIPLINE.test(cs[0])) {
        if (pending) { addTeam(c2.g, c2.d, [pending, fixComma(cs[0])]); pending = null; } else pending = fixComma(cs[0]);
      } else pending = null;
    });
  }

  const teams = [...buckets.values()];
  const warnings = [];
  if (!teams.length) warnings.push('No teams were found on that page yet. It will be checked again at the next sync.');
  else if (teams.some((t) => t.gender === 'other')) warnings.push('Some teams were not labelled men or women on the page, so they are listed under "Other".');
  if (teams.some((t) => t.division === 'Unassigned')) warnings.push('Some teams had no division on the page and are listed as "Unassigned".');
  return { title, teams, warnings, diag };
}

/* ------------------------------------------- Majestri: plain page or real browser */
let browserChain = Promise.resolve();
function renderWithBrowser(url) {
  const run = () => doRender(url);
  const p = browserChain.then(run, run);
  browserChain = p.catch(() => {});
  return p;
}
async function acceptTerms(page) {
  for (let i = 0; i < 2; i++) {
    const clicked = await page.evaluate(() => {
      const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
      document.querySelectorAll('input[type=checkbox]').forEach((c) => {
        const lab = c.closest('label') || (c.id && document.querySelector('label[for="' + c.id + '"]')) || c.parentElement;
        if (vis(c) && !c.checked && lab && /terms|agree|accept|conditions/i.test(lab.innerText || '')) c.click();
      });
      const re = /^(i\s+)?(accept|agree|understand|continue|proceed|ok|okay|got it|confirm|enter)\b/i;
      const b = [...document.querySelectorAll('button,a,input[type=button],input[type=submit]')].find((e) => {
        const t = String(e.innerText || e.value || '').trim();
        return vis(e) && t.length < 40 && re.test(t);
      });
      if (b) { b.click(); return true; }
      return false;
    });
    if (!clicked) break;
    await sleep(1500);
    if (page.waitForNetworkIdle) await page.waitForNetworkIdle({ idleTime: 700, timeout: 10000 }).catch(() => {});
  }
}
async function biggestPageSize(page) {
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('select')].find((x) => /length|per.?page|entries/i.test((x.name || '') + (x.id || '') + (x.className || '') + (x.getAttribute('aria-label') || '')));
    if (!sel) return;
    let best = null, bv = -1;
    [...sel.options].forEach((o) => { const v = +o.value === -1 ? 1e9 : +o.value; if (v > bv) { bv = v; best = o; } });
    if (best) { sel.value = best.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }).catch(() => {});
}
async function clickNext(page) {
  return page.evaluate(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const off = (e) => e.disabled || e.getAttribute('aria-disabled') === 'true' || /disabled/i.test(e.className || '') || (e.parentElement && /disabled/i.test(e.parentElement.className || ''));
    const c = [...document.querySelectorAll('.paginate_button.next, a[rel=next], button[aria-label*="next" i], li.next a, li.page-item.next a, .pagination .next, a, button')]
      .find((e) => vis(e) && !off(e) && (e.matches('.paginate_button.next, a[rel=next], button[aria-label*="next" i], li.next a, li.page-item.next a, .pagination .next') || /^(next|›|»|>)$/i.test((e.innerText || '').trim())));
    if (!c) return false;
    c.click();
    return true;
  }).catch(() => false);
}
async function doRender(url) {
  if (!puppeteer) throw new Error('A real browser is needed for this page. Run  npm install puppeteer  then restart the server.');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await acceptTerms(page);
    await page.waitForFunction(() => /Player\s*1/i.test(document.body.innerText) && /\b(Male|Female)\b/.test(document.body.innerText), { timeout: 20000 }).catch(() => {});
    await biggestPageSize(page);
    await sleep(600);
    const htmls = [];
    let last = '';
    for (let i = 0; i < 80; i++) {
      const html = await page.content();
      const sig = cheerio.load(html)('body').text().replace(/\s+/g, ' ');
      if (sig === last) break;
      last = sig;
      htmls.push(html);
      if (!(await clickNext(page))) break;
      await sleep(500);
    }
    return htmls.length ? htmls : [await page.content()];
  } finally { await browser.close().catch(() => {}); }
}
async function loadMajestri(url) {
  const html = await fetchText(url);
  const plain = parseMajestri(html, url);
  plain.html = html; plain.via = 'plain download';
  /* Only trust the plain download if it contains the real nominations table. Otherwise the text-guessing fallback can
     mistake the terms and conditions for a team, so use a real browser when we have one. */
  if (plain.diag && /^nominations/.test(plain.diag.via || '')) return plain;
  const guessOk = plain.teams.length >= 6;
  if (!puppeteer) {
    if (guessOk) return plain;
    plain.teams = [];
    plain.warnings = ['This Majestri page builds its team list with JavaScript, so a plain download only gets the terms and conditions. Run  npm install puppeteer  and restart node server.js.'];
    return plain;
  }
  const pages = await renderWithBrowser(url);
  const merged = new Map();
  let title = null;
  pages.forEach((h) => {
    const r = parseMajestri(h, url);
    if (!title && r.title && !/^(team nominations|terms and conditions)$/i.test(r.title)) title = r.title;
    r.teams.forEach((t) => { const k = t.gender + '|' + t.division + '|' + t.players.map(normKey).sort().join('+'); if (!merged.has(k)) merged.set(k, t); });
  });
  const first = parseMajestri(pages[0], url);
  if (!merged.size && guessOk) return plain;
  return { title: title || first.title, teams: [...merged.values()], diag: first.diag, html: pages[0], via: 'browser',
    warnings: merged.size ? [] : ['The page opened in a browser but no teams were found on it yet. It will be checked again at the next sync.'] };
}

/* ------------------------------------------------------- wild cards + placement */
const STD_DIVS = ['Premier', 'Challenger', 'Aspiring'];
const rankTeams = (a, b) => (b.points - a.points) || ((a.order || 0) - (b.order || 0)) || ((a.firstSeen || 0) - (b.firstSeen || 0));
/* t.division on a pool team is its natural division. A team can be wild carded one division up or down from there. */
function wildcardOptions(t) {
  const i = STD_DIVS.indexOf(t.division);
  return { up: i > 0, down: i >= 0 && i < STD_DIVS.length - 1 };
}
/* Builds d.teams from d.pool (every scored team, natural divisions) + d.wildcards ({ teamKey: 'up' | 'down' }).
   Divisions always aim to be full (d.size teams), Premier first, then Challenger, then Aspiring. Working top to bottom:
     block = [wild cards moving DOWN in]  +  [teams bumped down from the division above]  +  [the division's own teams, best first]  +  [wild cards moving UP in]
   - A wild card arrival squeezes the lowest team out of the block, and that team moves down to the top of the next division.
   - Whoever is squeezed out of the last division drops off the seed list.
   - A team that leaves (wild card) or a division that is short is topped up from that division's own spare teams first, then from the top of the division below.
   Divisions that are not Premier/Challenger/Aspiring (U18 etc.) are just cut to d.size and have no wild cards. */
function place(d) {
  const size = d.size, wc = d.wildcards || {}, pool = d.pool || [], out = [], lost = {};
  let discounted = 0;
  const emit = (t, dv, k, w) => out.push(Object.assign({}, t, { division: dv, nat: t.division, wild: w || null, pos: k + 1, out: false }));
  [...new Set(pool.map((t) => t.gender))].forEach((g) => {
    const mine = pool.filter((t) => t.gender === g);
    let placed = 0;
    /* other divisions: cut to size */
    [...new Set(mine.filter((t) => STD_DIVS.indexOf(t.division) < 0).map((t) => t.division))].forEach((dv) => {
      mine.filter((t) => t.division === dv).sort(rankTeams).slice(0, size).forEach((t, k) => { emit(t, dv, k); placed++; });
    });
    const std = mine.filter((t) => STD_DIVS.indexOf(t.division) >= 0), move = new Map();
    std.forEach((t) => {
      const o = wildcardOptions(t), i = STD_DIVS.indexOf(t.division);
      if (wc[t.key] === 'up' && o.up) move.set(t, { to: i - 1, w: 'up' });
      else if (wc[t.key] === 'down' && o.down) move.set(t, { to: i + 1, w: 'down' });
    });
    const own = STD_DIVS.map((dv) => std.filter((t) => t.division === dv && !move.has(t)).sort(rankTeams));
    let carry = [];
    STD_DIVS.forEach((dv, k) => {
      const arrive = (w) => std.filter((t) => move.has(t) && move.get(t).to === k && move.get(t).w === w).sort(rankTeams);
      const downs = arrive('down'), ups = arrive('up');
      const slots = Math.max(0, size - downs.length - ups.length);
      const members = carry.concat(own[k].slice(0, size)), spare = own[k].slice(size);
      const take = members.concat(spare).slice(0, slots);
      for (let j = k + 1; j < STD_DIVS.length && take.length < slots; j++) while (own[j].length && take.length < slots) take.push(own[j].shift());
      carry = members.slice(slots);          // squeezed out by wild cards: they move down a division
      const block = downs.concat(take, ups).slice(0, size);
      block.forEach((t, i) => { const m = move.get(t); emit(t, dv, i, m ? m.w : null); placed++; });
    });
    const gone = mine.length - placed;
    if (gone > 0) { lost[g] = gone; discounted += gone; }
  });
  d.teams = out;
  d.discounted = discounted;
  d.warnings = (d.syncWarnings || []).slice();
  Object.keys(lost).forEach((g) => d.warnings.push(`${lost[g]} ${g === 'women' ? "women's" : g === 'men' ? "men's" : g} team${lost[g] > 1 ? 's' : ''} left out. Each division holds ${d.size} teams, picked by most points, then first to sign up.`));
}

/* ----------------------------------------------------------------- state */
let draws = readJSON(DRAWS_FILE, []);
if (!Array.isArray(draws)) draws = [];
draws.forEach((d) => { if (d.status === 'syncing') d.status = 'ok'; });
draws.forEach((d) => {
  if (!d.wildcards) d.wildcards = {};
  if (!d.pool) {
    d.pool = (d.teams || []).map((t) => { const c = Object.assign({}, t); delete c.wild; delete c.pos; delete c.out; delete c.nat; return c; });
    d.syncWarnings = (d.warnings || []).filter((w) => !/left out\./.test(w));
  }
  place(d);
});
let nextSync = Date.now() + SYNC_MS;
const syncing = new Set();
const saveDraws = () => { try { writeJSON(DRAWS_FILE, draws); } catch (e) { log('could not save draws:', e.message); } };

function isMajestri(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)majestri\.com\.au$/i.test(x.hostname); } catch (e) { return false; }
}

async function syncDraw(d) {
  if (syncing.has(d.id)) return;
  syncing.add(d.id);
  d.status = 'syncing'; d.error = null; d.progress = null;
  try {
    const parsed = await loadMajestri(d.url);
    d.title = parsed.title || d.title;
    d.warnings = parsed.warnings.slice();
    let found = parsed.teams;
    if (!found.length && d.pool && d.pool.length) {
      d.warnings = ['Majestri returned no teams this time, so the previous list has been kept.'];
      found = (d.pool || []).map((t) => ({ gender: t.gender, division: t.combined ? 'Unassigned' : t.division, combined: !!t.combined, order: t.order, players: t.players.map((p) => p.name) }));
    }

    found.forEach((t, i) => { if (t.order == null) t.order = i; });   // the page lists teams in sign-up order, newest at the bottom
    const idx = await getRankings();
    const need = new Set();
    found.forEach((t) => t.players.forEach((p) => need.add(t.gender + '|' + p)));
    let done = 0;
    d.progress = { done, total: need.size };

    const scored = new Map();
    let failed = 0;
    for (const t of found) {
      for (const p of t.players) {
        const sk = t.gender + '|' + p;
        if (scored.has(sk)) continue;
        let r;
        try { r = await resolvePlayer(p, t.gender, idx); }
        catch (e) { failed++; r = { name: p, matched: false, points: 0, error: true }; }
        scored.set(sk, r);
        d.progress = { done: ++done, total: need.size };
      }
    }
    if (failed) d.warnings.push(`Could not load points for ${failed} player${failed > 1 ? 's' : ''} (ABV site did not respond). They will be retried next sync.`);

    const old = new Map((d.pool || []).map((t) => [t.key, t]));
    const pool = found.map((t) => {
      const players = t.players.map((p) => Object.assign({}, scored.get(t.gender + '|' + p), { name: p }));
      const key = t.gender + '|' + players.map((p) => normKey(p.name)).sort().join('+');
      const prev = old.get(key);
      return { key, gender: t.gender, division: t.division, combined: !!t.combined, order: t.order, players, points: players.reduce((a, p) => a + (p.points || 0), 0), firstSeen: prev ? prev.firstSeen : Date.now() };
    });
    /* A combined "Seniors (Premier/Challenger/Aspiring)" list is split Premier, then Challenger, then Aspiring, by seed points.
       That gives every team its natural division. Cutting each division to d.size, and applying wild cards, is done in place(). */
    ['men', 'women', 'mixed', 'other'].forEach((g) => {
      pool.filter((t) => t.gender === g && t.combined).sort(rankTeams).forEach((t, i) => { t.division = STD_DIVS[Math.min(2, Math.floor(i / d.size))]; });
    });
    d.pool = pool;
    d.syncWarnings = d.warnings.slice();
    place(d);
    d.lastSync = Date.now();
    d.status = 'ok';
    log(`synced "${d.title}": ${d.teams.length} teams`);
  } catch (e) {
    d.status = 'error';
    d.error = e.message || String(e);
    log(`sync failed for ${d.url}:`, d.error);
  } finally {
    d.progress = null;
    syncing.delete(d.id);
    saveDraws();
    saveCacheSoon();
  }
}

async function syncAll() {
  nextSync = Date.now() + SYNC_MS;
  for (const d of draws.slice()) await syncDraw(d);
}

/* ------------------------------------------------------------------ http */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Client',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 20000) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}
const pub = (d) => ({ id: d.id, url: d.url, size: d.size, title: d.title, status: d.status, error: d.error, progress: d.progress || null,
  warnings: d.warnings || [], wildcards: d.wildcards || {}, discounted: d.discounted || 0, createdAt: d.createdAt, lastSync: d.lastSync || null, teams: d.teams || [] });

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return send(res, 204, {});

    /* Every browser sends its own random id. Live draws belong to the browser that added them, so nobody sees or changes anyone else's. */
    const me = (() => { const v = String(req.headers['x-client'] || ''); return /^[\w-]{8,64}$/.test(v) ? v : ''; })();
    const mine = (d) => d.owner === me;
    if (p.startsWith('/api/draws') && !me) return send(res, 400, { error: 'Missing client id. Reload the page.' });

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const ver = (n) => +((n.match(/v(\d+)/i) || [])[1] || 0);
      const f = fs.readdirSync(__dirname).filter((n) => /^Pool_Builder.*\.html$/i.test(n)).sort((a, b) => ver(a) - ver(b) || fs.statSync(path.join(__dirname, a)).mtimeMs - fs.statSync(path.join(__dirname, b)).mtimeMs).pop();
      if (!f) return send(res, 404, { error: 'Put Pool_Builder_v9.html in the same folder as server.js' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, f)));
    }
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, draws: draws.length });
    if (req.method === 'GET' && p === '/api/draws') {
      let claimed = false;
      draws.forEach((d) => { if (!d.owner) { d.owner = me; claimed = true; } });   // draws saved before this existed go to the first person who opens the site
      if (claimed) saveDraws();
      return send(res, 200, { draws: draws.filter(mine).map(pub), nextSync, serverTime: Date.now() });
    }

    if (req.method === 'POST' && p === '/api/draws') {
      const b = await readBody(req);
      let url = String(b.url || '').trim();
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      if (!isMajestri(url)) return send(res, 400, { error: 'That does not look like a Majestri link (https://vq.majestri.com.au/…).' });
      const clean = new URL(url); clean.hash = '';
      if (draws.some((d) => mine(d) && d.url === clean.href)) return send(res, 409, { error: 'That tournament has already been added.' });
      const size = +b.size === 20 ? 20 : 16;
      const d = { id: uid(), owner: me, url: clean.href, size, title: 'Loading tournament…', status: 'syncing', error: null, warnings: [], createdAt: Date.now(), lastSync: null, teams: [], pool: [], wildcards: {}, syncWarnings: [] };
      draws.push(d); saveDraws();
      syncDraw(d);
      return send(res, 201, { draw: pub(d) });
    }

    let m = p.match(/^\/api\/draws\/([\w-]+)\/wildcard$/);
    if (m && req.method === 'POST') {
      const d = draws.find((x) => x.id === m[1] && mine(x));
      if (!d) return send(res, 404, { error: 'Not found' });
      const b = await readBody(req);
      const t = (d.pool || []).find((x) => x.key === b.key);
      if (!t) return send(res, 404, { error: 'That team is no longer on the Majestri page.' });
      if (b.dir === 'up' || b.dir === 'down') {
        if (!wildcardOptions(t)[b.dir]) return send(res, 400, { error: `A ${t.division} team cannot be wild carded ${b.dir}.` });
        d.wildcards[t.key] = b.dir;
      } else if (b.dir == null || b.dir === 'clear') delete d.wildcards[t.key];
      else return send(res, 400, { error: 'dir must be up, down or clear.' });
      place(d); saveDraws();
      return send(res, 200, { draw: pub(d) });
    }

    m = p.match(/^\/api\/draws\/([\w-]+)(\/refresh)?$/);
    if (m) {
      const d = draws.find((x) => x.id === m[1] && mine(x));
      if (!d) return send(res, 404, { error: 'Not found' });
      if (req.method === 'DELETE' && !m[2]) { draws = draws.filter((x) => x !== d); saveDraws(); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && m[2]) { syncDraw(d); return send(res, 202, { draw: pub(d) }); }
    }

    if (req.method === 'GET' && p === '/api/debug') {
      const url = u.searchParams.get('url') || '';
      if (!isMajestri(url)) return send(res, 400, { error: 'Pass ?url=<a majestri link>' });
      const r = await loadMajestri(url);
      const html = r.html || '';
      const $ = cheerio.load(html);
      const buckets = {};
      r.teams.forEach((t) => { const k = t.gender + ' / ' + t.division; (buckets[k] = buckets[k] || []).push(t.players.join(' / ')); });
      return send(res, 200, { title: r.title, via: r.via, browserInstalled: !!puppeteer, warnings: r.warnings, htmlBytes: html.length, rows: r.diag.rowCount, headings: r.diag.headings, teamsPerBucket: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, { count: v.length, first: v.slice(0, 4) }])),
        unparsedRows: r.diag.unparsed, textStart: $('body').text().replace(/\s+/g, ' ').trim().slice(0, 1500) });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, 500, { error: e.message || 'Server error' });
  }
});

function start() {
  server.listen(PORT, HOST, () => {
    log(`Pool Builder live-draw server running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
    log(`Saved draws: ${draws.length}. Syncing every ${SYNC_MS / 60000} minutes.`);
  });
  setInterval(syncAll, SYNC_MS);
  // catch up on anything stale after a restart
  setTimeout(() => { draws.filter((d) => !d.lastSync || Date.now() - d.lastSync > SYNC_MS * 0.9).forEach((d) => syncDraw(d)); }, 2000);
}

if (require.main === module) start();
module.exports = { place, wildcardOptions, parseNominationTokens, parseNominations, loadMajestri, parseMajestri, parseRankings, parseResults, top3, normKey, fuzzyEq, indexRankings, resolvePlayer, _cache: cache };
