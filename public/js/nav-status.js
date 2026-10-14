// Masthead status cell — "LIVE · N SENSORS · M OFFLINE" — for every page that
// carries one except the homepage, which computes the same two figures inside
// renderAll() (index.html) and fills the cell itself.
//
// One file rather than a copy per page. Until October 2026 the History page had
// its own copy with the offline figure hard-coded to 5, and the Brief, the
// Appendix, the Articles index, Set up a monitor and every Dispatch had none at
// all, so their masthead read "LIVE · — SENSORS · — OFFLINE" permanently.
//
// The figures follow the homepage exactly, so a reader moving between pages
// sees the same numbers:
//   live    = stations in /api/live that are neither off:true markers nor stale
//   offline = stale stations + off:true markers + the homepage's embedded
//             long-dark records, less any within 300 m of a live station
//             (index.html suppresses those pins, so does not count them)
(function () {
  'use strict';
  const el = document.getElementById('nav-status');
  if (!el) return;

  // Same rule as every page: same-origin, except a bare static preview on
  // localhost, which has no Functions and reads the deployed API instead.
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'https://baliair.pages.dev' : '';

  // Positions of OFFLINE_HISTORY in index.html (Ubud Rozendal, Balangan,
  // Kopernik). Keep in step with that object.
  const EMBEDDED_OFFLINE = [
    { lat: -8.53036, lon: 115.26932 },
    { lat: -8.8071,  lon: 115.1408 },
    { lat: -8.554,   lon: 115.272 },
  ];

  const metresApart = (a, b) => {
    const dLat = (a.lat - b.lat) * 111320;
    const dLon = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.hypot(dLat, dLon);
  };
  const t = (k, fb) => (window.I18N && window.I18N.t) ? window.I18N.t(k, fb) : fb;

  let counts = null;
  function render() {
    if (!counts) return;
    el.textContent = `${t('status.live', 'Live').toUpperCase()} · ${counts.live} ` +
      `${t('status.sensors', 'sensors').toUpperCase()} · ${counts.offline} ` +
      `${t('status.offline', 'offline').toUpperCase()}`;
  }

  async function pull() {
    try {
      const r = await fetch(API_BASE + '/api/live', { cache: 'no-cache' });
      if (!r.ok) return;
      const d = await r.json();
      const all = Array.isArray(d.stations) ? d.stations : [];
      const markers = all.filter(s => s && s.off);
      const live = all.filter(s => s && !s.off);
      const fresh = live.filter(s => !s.stale);
      const stale = live.length - fresh.length;
      const anchors = fresh
        .filter(s => Number.isFinite(+s.lat) && Number.isFinite(+s.lon))
        .map(s => ({ lat: +s.lat, lon: +s.lon }));
      const embedded = EMBEDDED_OFFLINE.filter(o => !anchors.some(a => metresApart(o, a) < 300)).length;
      counts = { live: fresh.length, offline: embedded + markers.length + stale };
      render();
    } catch (_) { /* keep the placeholder; the page itself is unaffected */ }
  }

  pull();
  setInterval(pull, 5 * 60 * 1000);
  document.addEventListener('i18n:changed', render);
})();
