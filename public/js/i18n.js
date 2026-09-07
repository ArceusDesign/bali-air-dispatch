/* Bali Air Dispatch — i18n runtime swap.
 *
 * Strategy:
 *   - HTML ships in English (default). Elements that should be translatable
 *     get either:
 *        data-i18n="key"          → replaces textContent
 *        data-i18n-html="key"     → replaces innerHTML (preserves <em> etc.)
 *        data-i18n-attr="attrName:key,..."  → sets attribute value(s)
 *   - On page load, this script reads localStorage('bad-lang') and applies
 *     the chosen language by fetching /i18n/{lang}.json.
 *   - The language switcher is rendered into any <div id="lang-switcher">.
 *   - All translation files are same-origin; no third-party calls.
 */
(function(){
  'use strict';

  const SUPPORTED = [
    { code:'en', label:'English' },
    { code:'id', label:'Bahasa Indonesia' }
  ];
  const DEFAULT_LANG = 'en';
  const STORAGE_KEY = 'bad-lang';

  let currentLang = DEFAULT_LANG;
  let dict = {};

  function getStoredLang(){
    try { return localStorage.getItem(STORAGE_KEY); }
    catch(_) { return null; }
  }
  function storeLang(lang){
    try { localStorage.setItem(STORAGE_KEY, lang); } catch(_) {}
  }

  async function loadDict(lang){
    if (lang === DEFAULT_LANG) {
      dict = {};                              // English is the source — no swaps needed
      return;
    }
    try {
      // No `cache:'no-cache'` here any more. It forced a revalidation round
      // trip for every page load, which for id.json means re-downloading
      // 230 KB whenever the validator has nothing to compare against — on the
      // page's largest single asset, for the audience most likely to be on
      // mobile data. Caching is now stated once, in public/_headers
      // (/i18n/* → max-age=3600), where the trade-off is written down; this
      // fetch just honours it. A dictionary that is briefly stale after a
      // deploy loses only the keys added in it, and a missing key falls back
      // to the English already in the HTML.
      const r = await fetch('/i18n/' + lang + '.json');
      if (!r.ok) throw new Error('HTTP '+r.status);
      dict = await r.json();
    } catch(e){
      console.warn('i18n: dictionary load failed', lang, e);
      dict = {};
    }
  }

  function tr(key){
    return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : null;
  }

  function applyTranslations(root){
    root = root || document;
    // Cache original text on first run so we can restore English if user toggles back.
    root.querySelectorAll('[data-i18n]').forEach(el=>{
      if (!el.hasAttribute('data-i18n-default')) {
        el.setAttribute('data-i18n-default', el.textContent);
      }
      const v = tr(el.getAttribute('data-i18n'));
      el.textContent = (v != null) ? v : el.getAttribute('data-i18n-default');
    });
    root.querySelectorAll('[data-i18n-html]').forEach(el=>{
      if (!el.hasAttribute('data-i18n-default')) {
        el.setAttribute('data-i18n-default', el.innerHTML);
      }
      const v = tr(el.getAttribute('data-i18n-html'));
      el.innerHTML = (v != null) ? v : el.getAttribute('data-i18n-default');
    });
    root.querySelectorAll('[data-i18n-attr]').forEach(el=>{
      const spec = el.getAttribute('data-i18n-attr');
      // format: "attrName:key,attrName:key"
      spec.split(',').forEach(pair=>{
        const [attr, key] = pair.split(':').map(s=>s.trim());
        if (!attr || !key) return;
        if (!el.hasAttribute('data-i18n-default-' + attr)) {
          el.setAttribute('data-i18n-default-' + attr, el.getAttribute(attr) || '');
        }
        const v = tr(key);
        if (v != null) el.setAttribute(attr, v);
        else el.setAttribute(attr, el.getAttribute('data-i18n-default-' + attr));
      });
    });
    // Update <html lang> for accessibility
    document.documentElement.setAttribute('lang', currentLang);
    // Notify other code (e.g. dynamically rendered station rolls) to re-render
    document.dispatchEvent(new CustomEvent('i18n:changed', { detail:{ lang: currentLang } }));
  }

  // Public translator for dynamically-injected text (e.g. ticker, station roll)
  window.I18N = {
    t: (key, fallback) => {
      const v = tr(key);
      return v != null ? v : (fallback != null ? fallback : key);
    },
    lang: () => currentLang
  };

  function renderSwitcher(){
    const tgt = document.getElementById('lang-switcher');
    if (!tgt) return;
    tgt.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'lang-sw';
    SUPPORTED.forEach(s=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lang-sw-btn' + (s.code === currentLang ? ' on' : '');
      btn.textContent = s.label;
      btn.setAttribute('aria-pressed', s.code === currentLang ? 'true' : 'false');
      btn.dataset.lang = s.code;
      btn.addEventListener('click', () => setLanguage(s.code));
      wrap.appendChild(btn);
    });
    // (Removed in iter 6: "More languages soon" placeholder — was distracting.
    //  Real additional languages will appear in the same row when added.)
    tgt.appendChild(wrap);
  }

  async function setLanguage(lang){
    if (!SUPPORTED.some(s => s.code === lang)) return;
    currentLang = lang;
    storeLang(lang);
    await loadDict(lang);
    applyTranslations();
    renderSwitcher();
  }

  // Inject switcher CSS once (small, scoped — keeps each page self-contained
  // without needing a shared external stylesheet).
  function injectSwitcherCss(){
    if (document.getElementById('lang-sw-css')) return;
    const s = document.createElement('style');
    s.id = 'lang-sw-css';
    s.textContent = `
      .lang-sw{display:inline-flex;align-items:center;gap:0;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase}
      .lang-sw-btn{appearance:none;background:transparent;border:1px solid var(--rule,#2b2620);color:var(--ink-soft,#34302a);padding:5px 10px;font-family:inherit;font-size:inherit;letter-spacing:inherit;text-transform:inherit;cursor:pointer;border-right-width:0;transition:background .12s,color .12s}
      .lang-sw-btn:last-of-type{border-right-width:1px}
      .lang-sw-btn.on{background:var(--ink,#14110d);color:var(--paper,#f3ece0)}
      .lang-sw-btn:hover:not(.on){background:var(--paper-2,#ebe1ce)}
      .lang-sw-more{margin-left:10px;color:var(--ink-faint,#6a635a);font-size:9.5px;letter-spacing:.12em;cursor:default;user-select:none}
      /* Sit comfortably next to the navbar */
      .navbar .lang-sw{margin-left:auto}
      @media(max-width:760px){
        .lang-sw{font-size:9px}
        .lang-sw-btn{padding:4px 7px}
        .lang-sw-more{font-size:8.5px}
      }
    `;
    document.head.appendChild(s);
  }

  // Boot
  //
  // The language is decided and the dictionary REQUESTED here, at script
  // execution time, rather than inside the DOMContentLoaded handler below. The
  // choice comes from localStorage and needs no DOM at all, and the fetch is
  // the only slow step in this file — starting it now lets it overlap whatever
  // parsing and subresource loading is left instead of beginning after all of
  // it. For a reader on Bahasa Indonesia that is a 230 KB request moved off
  // the end of the load.
  //
  // The APPLY step still waits for DOMContentLoaded, deliberately unchanged:
  // it walks the whole document for [data-i18n] and must not run against a
  // half-parsed one. So this is strictly an earlier start, not an earlier
  // swap, and the visible sequence on every page is what it was.
  const stored = getStoredLang();
  currentLang = stored && SUPPORTED.some(s => s.code === stored) ? stored : DEFAULT_LANG;
  const dictReady = (currentLang !== DEFAULT_LANG) ? loadDict(currentLang) : Promise.resolve();

  document.addEventListener('DOMContentLoaded', async () => {
    injectSwitcherCss();
    await dictReady;          // loadDict swallows its own failures (dict = {})
    applyTranslations();
    renderSwitcher();
  });

})();
