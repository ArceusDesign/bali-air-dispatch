// IQAir station discovery for Bali — the pure half (parsing + decisions).
// The I/O half (Firecrawl, D1, scheduling) lives in index.js.
//
// Why this exists: the scrape list used to be a hand-kept array, so a monitor
// IQAir started publishing never reached the map unless someone noticed. On
// 10 Oct 2026 IQAir listed 33 Bali stations; one native IQAir device (Seminyak
// Beach - Hotel Indigo) was missing for exactly that reason.
//
// How IQAir lays Bali out (verified 10 Oct 2026):
//   state page   /air-quality/indonesia/bali             links to ~40 "cities"
//   city page    /air-quality/indonesia/bali/<city>       links to its stations
//   station page /air-quality/indonesia/bali/<city>/<st>  one device
// Most "cities" have no device at all: their value is IQAir's own estimate.
// City and state pages are AREA VALUES and are never ingested (§8.5) — only
// two-segment <city>/<station> links are candidates, and every candidate must
// then prove on its own page that it is one device before it is admitted.

import { extractStation, pageKind, dataSources, contributorName } from './extract.js';

export const BALI = { latMin: -9.2, latMax: -8.0, lonMin: 114.4, lonMax: 115.8 };

// A candidate within this distance of a station we already publish is not
// added: either it is the same device relayed under another name (IQAir keeps
// its own copy of the coordinates — Seaside Tribe sits 194 m from the
// AirGradient unit it relays), or a second device on the same spot, which the
// map would fold away anyway. Same radius as scrapedIQAirFromD1()'s DEDUP_M in
// functions/api/live.js, so nothing admitted here is then hidden there.
export const COLOCATED_M = 300;

// A device whose newest reading is older than this is not admitted yet; it is
// rechecked later rather than rejected for good.
export const MAX_READING_AGE_MS = 24 * 60 * 60 * 1000;

// Reasons that can change on their own; anything else (a relay, a position
// outside Bali) is final until an operator says otherwise. aggregate_page is
// rechecked because a station address can redirect to its town for a while;
// the checks re-run in full every time, so a recheck can never admit an area
// value.
export const RECHECKABLE = new Set([
  'fetch_failed', 'not_found', 'no_reading', 'not_reporting', 'no_coordinates', 'not_proven_station',
  'colocated', 'aggregate_page',
]);

const PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:air-quality\/)?indonesia\/bali\/([^/?#]+)(?:\/([^/?#]+))?\/?$/i;

function decodeSeg(s) {
  try { return decodeURIComponent(s).toLowerCase(); } catch { return s.toLowerCase(); }
}

// { city, station|null } for any IQAir Bali URL or href, else null.
export function parseBaliPath(href) {
  if (typeof href !== 'string' || !href) return null;
  let path;
  try { path = new URL(href.replace(/&amp;/g, '&'), 'https://www.iqair.com').pathname; } catch { return null; }
  const m = PATH_RE.exec(path);
  if (!m) return null;
  return { city: decodeSeg(m[1]), station: m[2] ? decodeSeg(m[2]) : null };
}

// Stable identity for a station: '<city>/<station>' exactly as IQAir names it.
export function stationKey(href) {
  const p = parseBaliPath(href);
  return p && p.station ? `${p.city}/${p.station}` : null;
}

function hrefs(html) {
  return typeof html === 'string' ? [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]) : [];
}

export function parseCityLinks(html) {
  const out = new Set();
  for (const h of hrefs(html)) {
    const p = parseBaliPath(h);
    if (p && !p.station) out.add(p.city);
  }
  return out;
}

export function parseStationLinks(html) {
  const out = new Set();
  for (const h of hrefs(html)) {
    const k = stationKey(h);
    if (k) out.add(k);
  }
  return out;
}

// "33 stations from 33 contributors" on the state page → 33. Used only as a
// cheap change detector: if the island's count moves, sweep every city now.
export function parseStationCount(html) {
  const m = typeof html === 'string'
    ? html.match(/>\s*(\d+)(?:\s|&nbsp;|&#160;|<!--\s*-->)+stations?(?:\s|&nbsp;|&#160;|<!--\s*-->)+from\b/i)
    : null;
  return m ? parseInt(m[1], 10) : null;
}

export function cityUrl(city) {
  return `https://www.iqair.com/ca/indonesia/bali/${encodeURIComponent(city)}`;
}

export function stationUrl(key) {
  const [city, station] = key.split('/');
  return `https://www.iqair.com/ca/indonesia/bali/${encodeURIComponent(city)}/${encodeURIComponent(station)}`;
}

// Our id is 'iqs-<slug>'; the history/API id charset is [a-zA-Z0-9._ -]{2,80}.
// Built from the STATION segment only — never from the town alone, which would
// read like a town value (iqs-badung). A name with no Latin characters gets a
// short stable hash of its key instead.
export function slugFor(key, taken) {
  const clean = (s, n) => (s || '').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, n).replace(/-+$/, '');
  const [city, station] = key.split('/');
  let h = 0;
  for (const ch of key) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
  const st = clean(station, 60) || `station-${h.toString(36)}`;
  let slug = st;
  if (taken.has(slug)) slug = (clean(city, 20) ? `${clean(city, 20)}-${st}` : st).slice(0, 70).replace(/-+$/, '');
  const base = slug;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  return slug;
}

export function metresBetween(aLat, aLon, bLat, bLon) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function newestReadingMs(ex) {
  const last = ex.hourly && ex.hourly.length ? ex.hourly[ex.hourly.length - 1].ts : null;
  const ms = last ? Date.parse(last) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// Decide one candidate from its rendered page. `known` = every station we
// already publish, any network: [{ id, lat, lon }]. Returns
//   { verdict: 'admit', ex, contributor }  or  { verdict: 'reject', reason, detail }
// In order: is it a page at all; is it ONE device; is it someone else's data;
// does it have its own position, inside Bali; is it reporting; is it already
// on our map under another network or name.
export function classifyCandidate(html, known, nowMs = Date.now()) {
  if (!html || !/<title>[^<]*Air Quality/i.test(html)) return { verdict: 'reject', reason: 'not_found' };
  const kind = pageKind(html);
  if (kind === 'aggregate') return { verdict: 'reject', reason: 'aggregate_page' };
  if (kind !== 'station') return { verdict: 'reject', reason: 'not_proven_station' };
  const sources = dataSources(html);
  if (sources) return { verdict: 'reject', reason: 'relay', detail: sources.join(' via ') };
  const ex = extractStation(html);
  if (!ex) return { verdict: 'reject', reason: 'no_reading' };
  if (ex.rejected) return { verdict: 'reject', reason: ex.rejected };
  if (ex.lat == null || ex.lon == null) return { verdict: 'reject', reason: 'no_coordinates' };
  if (ex.lat < BALI.latMin || ex.lat > BALI.latMax || ex.lon < BALI.lonMin || ex.lon > BALI.lonMax) {
    return { verdict: 'reject', reason: 'outside_bali', detail: `${ex.lat},${ex.lon}` };
  }
  if (ex.currentConcentration == null && !ex.hourly.length) return { verdict: 'reject', reason: 'no_reading' };
  const newest = newestReadingMs(ex);
  if (newest == null || nowMs - newest > MAX_READING_AGE_MS) {
    return { verdict: 'reject', reason: 'not_reporting', detail: newest ? new Date(newest).toISOString() : 'no timestamp' };
  }
  let nearest = null;
  for (const k of known || []) {
    if (!Number.isFinite(k.lat) || !Number.isFinite(k.lon)) continue;
    const d = metresBetween(ex.lat, ex.lon, k.lat, k.lon);
    if (!nearest || d < nearest.d) nearest = { id: k.id, d };
  }
  if (nearest && nearest.d < COLOCATED_M) {
    return { verdict: 'reject', reason: 'colocated', detail: `${nearest.id} ${Math.round(nearest.d)} m` };
  }
  return { verdict: 'admit', ex, contributor: ex.contributor || contributorName(html),
           nearest: nearest ? `${nearest.id} ${Math.round(nearest.d)} m` : null };
}
