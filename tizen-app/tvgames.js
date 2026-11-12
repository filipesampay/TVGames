/*
 * Play TV for Samsung (Tizen): the TVGames library on top of Moonlight Tizen.
 *
 * Loaded after Moonlight's own scripts (see build.ps1 / build.sh). It does not
 * replace any streaming code: it swaps Moonlight's app grid for a console-style
 * interface fed by `tvgames serve` on the PC (port 47900), and starts games with
 * Moonlight's own startGame().
 *
 * Screens (each one is a "page" on a stack; the top page gets the keys):
 *   who      - "Quem vai jogar?" user screen after the splash
 *   home     - top bar, row of games (focused tile pinned at the keyline), the
 *              focused game's art as background with a delayed cross-fade, hero
 *              (title, Jogar, "...", side card) and a hub below it
 *   library  - grid of every game with shelves as tabs and sorting
 *   search   - on-screen keyboard + results
 *   trophies - games with trophies (list), trophies of a game (cards) and the
 *              side detail panel
 *   profile  - summary cards, games tab, avatar picker
 *   settings - categories + two-column options
 *   downloads- Steam / Epic owned games, folder choice, progress, Hydra button
 *   quick    - quick menu over the home (gamepad Start)
 *   menu / dialog - dropdown menus and confirmation dialogs
 *
 * Hooks into Moonlight Tizen v1.20.0 globals: showApps, showAppsMode,
 * showHostsMode, showSettingsMode, restoreUiAfterWasmLoad, hostChosen,
 * startGame, hosts, Views.Apps, showStreamMode, handleMessage. If the TVGames
 * API is not reachable, Moonlight's original app grid is shown instead.
 *
 * Kept light for TV CPUs: no blur, no shadows, animations only on transform
 * and opacity, covers loaded lazily.
 *
 * Licensed GPL-3.0 like Moonlight Tizen.
 */
/* global $, hosts, showApps:writable, restoreUiAfterWasmLoad:writable, showAppsMode, hostChosen,
   startGame, Views, tizen */

var TVGames = (function() {
  'use strict';

  var VERSION = '3.0';
  var API_PORT = 47900;
  var AUTO_OPEN_TIMEOUT_MS = 15000;
  var MAX_RECENT = 40;
  var HOME_MAX_GAMES = 18;

  // Home row geometry (px on the 1920x1080 page). Every tile has the same
  // layout box; the focused one grows with a scale and the next ones slide.
  var KEYLINE = 172;
  var TILE_STEP = 104 + 14;

  // Hero timing: the tile name changes at once, the background follows after
  // a short delay (no flashing while scrolling fast), then the texts, then the card.
  var BG_DELAY_MS = 300;
  var TEXT_DELAY_MS = 320;
  var CARD_DELAY_MS = 470;

  var SPLASH_MIN_MS = 2600;
  var SPLASH_MAX_MS = 25000;
  var LAUNCH_FAILSAFE_MS = 120000;
  var LAUNCH_FADE_MS = 650;
  var HOLD_RESUME_MS = 800;
  var HOLD_EMULATOR_MS = 4000;
  var HOLD_PC_MS = 9000;
  var PC_CATEGORIES = ['steam', 'pc', 'epic', 'gog', 'heroic', 'hydra', 'windows', 'apps'];
  var SOUND_DIR = 'platform/sounds/';
  var LAMBDA = '\u039b';

  var DL_POLL_FAST_MS = 2000;
  var DL_POLL_SLOW_MS = 15000;

  // ---------------------------------------------------------------- icons --
  // Simple line icons drawn here (no third-party icon set).

  var SVG = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    download: '<path d="M12 3v12M7 10.5l5 5 5-5M4 20h16"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
    dots: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
    medal: '<circle cx="12" cy="14.5" r="5.5"/><path d="M8.5 9.8L6 3h4l2 5M15.5 9.8L18 3h-4l-2 5"/>',
    home: '<path d="M4 11l8-7 8 7v9h-5.5v-6h-5v6H4z"/>',
    user: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5c1-4 4-6 7.5-6s6.5 2 7.5 6"/>',
    power: '<path d="M12 3v8"/><path d="M7 6.2a7.5 7.5 0 1 0 10 0"/>',
    play: '<path d="M8 5l11 7-11 7z"/>',
    lock: '<rect x="5.5" y="10.5" width="13" height="10" rx="2"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7"/>',
    pencil: '<path d="M4 20l1-4.5L16 4.5l3.5 3.5L8.5 19z"/><path d="M14 6.5l3.5 3.5"/>',
    sort: '<path d="M7 4v16M3.5 16.5L7 20l3.5-3.5M17 20V4M13.5 7.5L17 4l3.5 3.5"/>',
    pc: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    drive: '<rect x="3" y="6" width="18" height="12" rx="2.5"/><circle cx="17" cy="12" r="1.2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    brush: '<path d="M14.5 4.5l5 5-8 8-5-5z"/><path d="M6.5 12.5c-2 0-3 1.5-3 3.5S2 20 2 20s4 0 5.5-1.5 1-3.5 1-3.5"/>',
    back: '<path d="M10 6l-6 6 6 6M4 12h16"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    star: '<path d="M12 3.5l2.6 5.5 6 .8-4.4 4.1 1.1 5.9L12 17l-5.3 2.8 1.1-5.9L3.4 9.8l6-.8z"/>',
  };

  function icon(name, cls) {
    var s = document.createElement('span');
    s.className = 'tvg-ico' + (cls ? ' ' + cls : '');
    s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (SVG[name] || '') + '</svg>';
    return s;
  }

  // ---------------------------------------------------------------- state --

  var state = {
    active: false,
    host: null,
    base: '',
    library: null,
    recent: loadRecent(),
    settings: loadSettings(),
    pages: [],
    home: null,
    whoShown: false,
    downloads: [],
    dlTimer: 0,
    dlFast: false,
    dlPage: null,
    stores: undefined, // undefined = not asked yet, null = PC has no downloads API
    toastTimer: 0,
    clockTimer: 0,
    launching: null,
    launchAppId: 0,
    launch: null,
  };

  function loadRecent() {
    try {
      var r = JSON.parse(localStorage.getItem('tvgamesRecent') || '[]');
      if (Array.isArray(r)) return r;
    } catch (e) { /* ignore */ }
    var last = null;
    try { last = localStorage.getItem('tvgamesLastPlayed'); } catch (e) { /* ignore */ }
    return last ? [last] : [];
  }

  function rememberPlayed(id) {
    state.recent = [id].concat(state.recent.filter(function(x) { return x !== id; })).slice(0, MAX_RECENT);
    saveRecent();
  }

  function forgetPlayed(id) {
    state.recent = state.recent.filter(function(x) { return x !== id; });
    saveRecent();
  }

  function saveRecent() {
    try {
      localStorage.setItem('tvgamesRecent', JSON.stringify(state.recent));
      localStorage.setItem('tvgamesLastPlayed', state.recent[0] || '');
    } catch (e) { /* ignore */ }
  }

  function loadSettings() {
    var d = { sounds: true, reduceMotion: false, whoScreen: true, sort: 'recent', avatar: '', background: 'art' };
    try {
      var s = JSON.parse(localStorage.getItem('playtvSettings') || '{}');
      Object.keys(d).forEach(function(k) { if (s.hasOwnProperty(k)) d[k] = s[k]; });
    } catch (e) { /* ignore */ }
    return d;
  }

  function saveSettings() {
    try { localStorage.setItem('playtvSettings', JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
    applySettings();
  }

  function applySettings() {
    document.body.classList.toggle('tvg-reduce', !!state.settings.reduceMotion);
  }

  // -------------------------------------------------------------- helpers --

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function add(parent, child) { parent.appendChild(child); return child; }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function noop() {}

  function percent(a) { return a && a.total ? Math.floor(a.earned * 100 / a.total) : 0; }

  function fold(s) {
    var t = String(s || '').toLowerCase();
    return t.normalize ? t.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : t;
  }

  function url(u) {
    if (!u) return '';
    return /^https?:/.test(u) ? u : state.base + u;
  }

  function img(src, cls, lazy) {
    var i = el('img', cls);
    i.onerror = function() { i.classList.add('tvg-broken'); };
    if (src) {
      if (lazy) i.setAttribute('data-src', url(src));
      else i.src = url(src);
    }
    return i;
  }

  function loadLazy(container) {
    if (!container || !container.querySelectorAll) return;
    var list = container.querySelectorAll('img[data-src]');
    for (var i = 0; i < list.length; i++) {
      list[i].src = list[i].getAttribute('data-src');
      list[i].removeAttribute('data-src');
    }
  }

  function bytes(n) {
    if (!n && n !== 0) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return String(n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)).replace('.', ',') + ' ' + u[i];
  }

  function duration(s) {
    if (!s || s < 0) return '';
    if (s < 60) return Math.round(s) + ' s';
    if (s < 3600) return Math.round(s / 60) + ' min';
    return Math.floor(s / 3600) + ' h ' + pad2(Math.round((s % 3600) / 60)) + ' min';
  }

  function dateText(unix) {
    if (!unix) return '';
    var d = new Date(unix * 1000);
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function restart(elm, cls) {
    elm.classList.remove(cls);
    void elm.offsetWidth;
    elm.classList.add(cls);
  }

  // ------------------------------------------------------------------ api --

  function apiBase(host) {
    var addr = String(host.address || '');
    // "1.2.3.4:47989" -> "1.2.3.4"; IPv6 gets brackets.
    if (addr.indexOf('[') === 0) {
      addr = addr.slice(1, addr.indexOf(']'));
    } else if ((addr.match(/:/g) || []).length === 1) {
      addr = addr.split(':')[0];
    }
    if (addr.indexOf(':') !== -1) addr = '[' + addr + ']';
    return 'http://' + addr + ':' + API_PORT;
  }

  function request(method, path, body, base, timeout) {
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, (base || state.base) + path, true);
      xhr.timeout = timeout || 8000;
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(xhr.responseText ? JSON.parse(xhr.responseText) : null);
          } catch (e) {
            reject(e);
          }
        } else {
          var err = new Error('HTTP ' + xhr.status);
          err.status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = function() { reject(new Error('sem conex\u00e3o com o PC')); };
      xhr.ontimeout = function() { reject(new Error('o PC demorou para responder')); };
      if (body !== undefined) {
        // text/plain keeps it a "simple" CORS request (no preflight).
        xhr.setRequestHeader('Content-Type', 'text/plain');
        xhr.send(JSON.stringify(body));
      } else {
        xhr.send();
      }
    });
  }

  function fetchLibrary(base) { return request('GET', '/api/library', undefined, base, 6000); }

  function refreshLibrary() {
    return fetchLibrary(state.base).then(function(lib) {
      state.library = lib;
      if (state.home) state.home.rebuild();
    }, noop);
  }

  // ---------------------------------------------------------------- games --

  function allGames() { return state.library && state.library.games ? state.library.games : []; }

  function categoryOf(g) { return g.launcher ? 'Apps' : (g.category || 'Outros'); }

  function isHydraApp(g) { return g.id === 'hydra' || (!!g.launcher && /hydra/i.test(g.title || '')); }

  function hydraApp() { return allGames().filter(isHydraApp)[0] || null; }

  function sortGames(list, mode) {
    var rank = {};
    state.recent.forEach(function(id, i) { rank[id] = i; });
    return list.slice().sort(function(a, b) {
      if (mode !== 'az') {
        var ra = rank.hasOwnProperty(a.id) ? rank[a.id] : 1e6;
        var rb = rank.hasOwnProperty(b.id) ? rank[b.id] : 1e6;
        if (ra !== rb) return ra - rb;
      }
      return String(a.title).localeCompare(String(b.title));
    });
  }

  /** Shelves for the library: every category, the biggest first; apps last. */
  function shelves() {
    var count = {};
    allGames().forEach(function(g) {
      if (isHydraApp(g)) return;
      var c = categoryOf(g);
      count[c] = (count[c] || 0) + 1;
    });
    var cats = Object.keys(count).filter(function(c) { return c !== 'Apps'; })
      .sort(function(a, b) { return count[b] - count[a] || a.localeCompare(b); });
    var out = [{ id: '*', name: 'Sua cole\u00e7\u00e3o', n: allGames().filter(function(g) { return !g.launcher; }).length }];
    cats.forEach(function(c) { out.push({ id: c, name: c, n: count[c] }); });
    if (count.Apps) out.push({ id: 'Apps', name: 'Apps', n: count.Apps });
    return out;
  }

  function shelfGames(id) {
    var list = allGames().filter(function(g) { return !isHydraApp(g); });
    if (id === '*') list = list.filter(function(g) { return !g.launcher; });
    else list = list.filter(function(g) { return categoryOf(g) === id; });
    return sortGames(list, state.settings.sort);
  }

  function isRunning(g) {
    return !!(state.host && g && g.app_id && String(state.host.currentGame) === String(g.app_id));
  }

  // ------------------------------------------------------------- trophies --
  // Medals are our own (bronze / silver / gold, plus "Maestria" for 100%),
  // graded by rarity when the PC knows it, otherwise by RetroAchievements points.

  var TIERS = { gold: 'Ouro', silver: 'Prata', bronze: 'Bronze', master: 'Maestria' };

  function hasRarity(b) { return b.rarity !== undefined && b.rarity !== null; }

  function tierOf(b) {
    if (hasRarity(b)) return b.rarity < 10 ? 'gold' : b.rarity < 35 ? 'silver' : 'bronze';
    var p = b.points || 0;
    return p >= 25 ? 'gold' : p >= 10 ? 'silver' : 'bronze';
  }

  function rarityName(r) {
    return r < 5 ? 'Ultra rara' : r < 15 ? 'Muito rara' : r < 50 ? 'Rara' : 'Comum';
  }

  function medal(tier, cls) {
    var m = el('span', 'tvg-medal tvg-medal-' + tier + (cls ? ' ' + cls : ''));
    m.appendChild(el('i'));
    return m;
  }

  function gameTiers(g) {
    var t = { gold: 0, silver: 0, bronze: 0, master: 0 };
    var a = g.achievements;
    if (!a || !a.total) return t;
    (a.badges || []).forEach(function(b) { if (b.earned) t[tierOf(b)]++; });
    if (a.earned === a.total) t.master = 1;
    return t;
  }

  function totals() {
    var s = { games: 0, withCheevos: 0, earned: 0, total: 0, complete: 0, gold: 0, silver: 0, bronze: 0, master: 0 };
    allGames().forEach(function(g) {
      if (!g.launcher) s.games++;
      var a = g.achievements;
      if (a && a.total) {
        s.withCheevos++;
        s.earned += a.earned;
        s.total += a.total;
        var t = gameTiers(g);
        s.gold += t.gold; s.silver += t.silver; s.bronze += t.bronze; s.master += t.master;
        if (a.earned === a.total) s.complete++;
      }
    });
    // Our own level: grows with every medal, gold weighs more.
    var xp = s.bronze * 15 + s.silver * 30 + s.gold * 90 + s.master * 300;
    s.level = 1 + Math.floor(Math.sqrt(xp / 20));
    return s;
  }

  function trophyGames() {
    var rank = {};
    state.recent.forEach(function(id, i) { rank[id] = i; });
    return allGames().filter(function(g) { return g.achievements && g.achievements.total; })
      .sort(function(a, b) {
        var ra = rank.hasOwnProperty(a.id) ? rank[a.id] : 1e6;
        var rb = rank.hasOwnProperty(b.id) ? rank[b.id] : 1e6;
        return ra - rb || percent(b.achievements) - percent(a.achievements);
      });
  }

  function tierCounts(t, big) {
    var box = el('div', 'tvg-tiers' + (big ? ' tvg-tiers-big' : ''));
    ['master', 'gold', 'silver', 'bronze'].forEach(function(k) {
      var c = add(box, el('span', 'tvg-tier'));
      c.appendChild(medal(k));
      c.appendChild(el('b', null, String(t[k] || 0)));
    });
    return box;
  }

  function levelChip(level) {
    var c = el('span', 'tvg-level');
    c.appendChild(el('i', null, String(level)));
    return c;
  }

  /** "Small label above, big thin value below": the pattern used all over. */
  function labelValue(label, value, cls) {
    var b = el('div', 'tvg-lv' + (cls ? ' ' + cls : ''));
    b.appendChild(el('div', 'tvg-lv-label', label));
    b.appendChild(el('div', 'tvg-lv-value', value));
    return b;
  }

  function thinBar(pct, cls) {
    var bar = el('div', 'tvg-thin' + (cls ? ' ' + cls : ''));
    add(bar, el('i')).style.width = pct + '%';
    return bar;
  }

  // -------------------------------------------------------------- profile --

  function profile() {
    var p = (state.library && state.library.profile) || {};
    var steam = p.steam || {};
    return {
      name: steam.name || p.user || 'Jogador',
      avatar: state.settings.avatar || steam.avatar || p.avatar || '',
      ra: p.user ? { user: p.user, points: (p.points || 0) + (p.softcore_points || 0) } : null,
      steam: steam.name ? steam : null,
    };
  }

  function avatar(cls) {
    var pr = profile();
    var a = el('div', 'tvg-avatar ' + (cls || ''));
    a.appendChild(el('span', 'tvg-avatar-initial', pr.name.charAt(0).toUpperCase()));
    if (pr.avatar) a.appendChild(img(pr.avatar));
    return a;
  }

  function pcName() {
    var lib = state.library;
    return (lib && lib.host && lib.host.name) || (state.host && state.host.hostname) || 'PC';
  }

  // ---------------------------------------------------------------- pages --
  // A page: { el, keys: {up, down, left, right, accept, back, option, menu},
  // onShow(), onReturn(), onClose() }. The home is the bottom of the stack.

  function root() {
    var r = document.getElementById('tvgames-view');
    if (!r) {
      r = el('div');
      r.id = 'tvgames-view';
      (document.getElementById('main-content') || document.body).appendChild(r);
    }
    return r;
  }

  function topPage() { return state.pages[state.pages.length - 1] || null; }

  function newPage(cls) { return { el: el('div', 'tvg-page ' + cls), keys: {} }; }

  function push(page) {
    var prev = topPage();
    state.pages.push(page);
    root().appendChild(page.el);
    void page.el.offsetWidth;
    page.el.classList.add('tvg-in');
    // Pages that cover the screen hide the one below once they are in (less to paint).
    if (prev && page.cover !== false) {
      clearTimeout(prev.hideTimer);
      prev.hideTimer = setTimeout(function() { prev.el.classList.add('tvg-hidden'); }, 320);
    }
    if (page.onShow) page.onShow();
    return page;
  }

  function reveal(p) {
    if (!p) return;
    clearTimeout(p.hideTimer);
    p.el.classList.remove('tvg-hidden');
  }

  function pop(page) {
    page = page || topPage();
    var i = state.pages.indexOf(page);
    if (i <= 0) return;
    state.pages.splice(i, 1);
    page.el.classList.remove('tvg-in');
    page.el.classList.add('tvg-out');
    setTimeout(function() { if (page.el.parentNode) page.el.parentNode.removeChild(page.el); }, 300);
    if (page.onClose) page.onClose();
    // Every page down to the next covering one must be visible again.
    for (var k = state.pages.length - 1; k >= 0; k--) {
      reveal(state.pages[k]);
      if (state.pages[k].cover !== false) break;
    }
    var t = topPage();
    if (t && t.onReturn) t.onReturn();
  }

  /** Close every page above the home. */
  function popToHome() {
    while (state.pages.length > 1) {
      var p = state.pages.pop();
      if (p.onClose) p.onClose();
      if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    }
    if (state.home) {
      reveal(state.home.page);
      if (state.home.page.onReturn) state.home.page.onReturn();
    }
  }

  function dispatch(name) {
    var p = topPage();
    if (!p) return false;
    var k = p.keys[name];
    if (k) {
      k();
      return true;
    }
    if (name === 'back' && state.pages.length > 1) {
      pop(p);
      return true;
    }
    return name !== 'menu' && name !== 'option';
  }

  function setFocus(p, target) {
    if (p.focused === target) return;
    if (p.focused) p.focused.classList.remove('tvg-focus');
    if (target) target.classList.add('tvg-focus');
    p.focused = target;
  }

  /** Moves inside a grid; returns the new index or -1 when leaving it. */
  function gridMove(i, n, cols, dir) {
    if (dir === 'left') return i % cols === 0 ? -1 : i - 1;
    if (dir === 'right') return i % cols === cols - 1 || i + 1 >= n ? -1 : i + 1;
    if (dir === 'up') return i - cols < 0 ? -1 : i - cols;
    if (dir === 'down') {
      if (i + cols < n) return i + cols;
      var lastRow = Math.floor((n - 1) / cols);
      return Math.floor(i / cols) < lastRow ? n - 1 : -1;
    }
    return -1;
  }

  function hints(list) {
    var h = el('div', 'tvg-hints');
    list.forEach(function(t) {
      var s = add(h, el('span', 'tvg-hint'));
      s.appendChild(el('b', null, t[0]));
      s.appendChild(document.createTextNode(t[1]));
    });
    return h;
  }

  function pageHead(p, iconName, title) {
    var h = add(p.el, el('div', 'tvg-head'));
    var ic = add(h, el('div', 'tvg-head-icon'));
    ic.appendChild(icon(iconName));
    h.appendChild(el('div', 'tvg-head-title', title));
    return h;
  }

  /** Backgrounds: 'spot' = stage with a spotlight, 'waves' = abstract light, 'flat' = charcoal. */
  function stage(p, kind) {
    p.el.classList.add('tvg-bg-' + kind);
    if (kind !== 'flat') p.el.appendChild(el('div', 'tvg-light'));
  }

  // ---------------------------------------------------------------- toast --

  function toast(title, text, iconName) {
    var t = document.getElementById('tvg-toast');
    if (!t) {
      t = el('div');
      t.id = 'tvg-toast';
      document.body.appendChild(t);
    }
    t.innerHTML = '';
    t.appendChild(icon(iconName || 'info'));
    var b = add(t, el('div', 'tvg-toast-text'));
    b.appendChild(el('div', 'tvg-toast-title', title));
    if (text) b.appendChild(el('div', 'tvg-toast-sub', text));
    restart(t, 'tvg-on');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function() { t.classList.remove('tvg-on'); }, 4200);
  }

  // ---------------------------------------------------------------- clock --

  function clockText() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function updateClock() {
    var list = document.querySelectorAll('.tvg-clock');
    var t = clockText();
    for (var i = 0; i < list.length; i++) list[i].textContent = t;
  }

  function brand() {
    var b = el('div', 'tvg-brand');
    b.appendChild(el('span', null, 'PL'));
    b.appendChild(el('span', 'tvg-lambda', LAMBDA));
    b.appendChild(el('span', null, 'Y'));
    b.appendChild(el('span', 'tvg-brand-tv', 'TV'));
    return b;
  }

  // =================================================================== WHO --
  // "Quem vai jogar?": the entrance screen after the splash.

  function openWho() {
    var p = newPage('tvg-who-page');
    // Our own entrance motif: a slow drifting wall of the library's covers.
    var wall = add(p.el, el('div', 'tvg-wall'));
    var covers = sortGames(allGames().filter(function(g) { return g.cover && !g.launcher; }), 'recent').slice(0, 24);
    for (var r = 0; r < 2; r++) {
      var line = add(wall, el('div', 'tvg-wall-line' + (r ? ' tvg-wall-rev' : '')));
      for (var k = 0; k < 2; k++) {
        covers.forEach(function(g, i) { if (i % 2 === r) line.appendChild(img(g.cover)); });
      }
    }
    p.el.appendChild(el('div', 'tvg-who-shade'));
    p.el.appendChild(el('div', 'tvg-who-title', 'Bem-vindo de volta ao Play TV'));
    p.el.appendChild(el('div', 'tvg-who-sub', 'Quem vai jogar?'));
    var row = add(p.el, el('div', 'tvg-who-row'));
    var me = add(row, el('div', 'tvg-who-item'));
    me.appendChild(avatar('tvg-avatar-who'));
    me.appendChild(el('div', 'tvg-who-name', profile().name));
    var pc = add(row, el('div', 'tvg-who-item tvg-who-pc'));
    add(pc, el('div', 'tvg-who-circle')).appendChild(icon('pc'));
    pc.appendChild(el('div', 'tvg-who-name', 'Trocar de PC'));
    p.el.appendChild(el('div', 'tvg-clock tvg-who-clock', clockText()));
    p.el.appendChild(hints([['OK', 'Entrar'], ['Voltar', 'Lista de PCs']]));
    var items = [me, pc];
    var idx = 0;
    function focus() {
      items.forEach(function(it, i) { it.classList.toggle('tvg-dim', i !== idx); });
      setFocus(p, items[idx]);
    }
    p.keys = {
      left: function() { if (idx > 0) { idx--; focus(); } },
      right: function() { if (idx < items.length - 1) { idx++; focus(); } },
      up: noop,
      down: noop,
      accept: function() {
        if (idx === 0) {
          playSound('playtv-start.wav');
          pop(p);
        } else {
          leaveToHosts();
        }
      },
      back: function() { leaveToHosts(); },
    };
    me.addEventListener('click', function() { idx = 0; p.keys.accept(); });
    pc.addEventListener('click', function() { idx = 1; p.keys.accept(); });
    focus();
    push(p);
    return p;
  }

  function leaveToHosts() {
    hide();
    if (window.showHostsMode) window.showHostsMode();
  }

  // ================================================================== HOME --

  function buildHome() {
    var p = newPage('tvg-home');
    p.el.classList.add('tvg-in');
    var h = {
      page: p,
      zone: 'row', // 'top' | 'row' | 'actions' | 'hub'
      index: 0,
      top: 0,
      action: 0,
      hubRow: 0,
      hubCol: [],
      hubRows: [],
      items: [],
      tiles: [],
      heroFor: undefined,
      bgSrc: '',
      timers: [],
    };

    // Background: two layers that cross-fade.
    h.bgs = [add(p.el, el('img', 'tvg-bg')), add(p.el, el('img', 'tvg-bg'))];
    h.bgs.forEach(function(b) { b.onerror = function() { b.classList.remove('tvg-on'); }; });
    add(p.el, el('div', 'tvg-abstract'));
    add(p.el, el('div', 'tvg-shade-left'));
    add(p.el, el('div', 'tvg-shade-bottom'));
    add(p.el, el('div', 'tvg-hub-shade'));

    // Top bar.
    var top = add(p.el, el('div', 'tvg-topbar'));
    top.appendChild(brand());
    var tabs = add(top, el('div', 'tvg-tabs'));
    h.tabGames = add(tabs, el('div', 'tvg-tab tvg-selected', 'Jogos'));
    h.tabDl = add(tabs, el('div', 'tvg-tab', 'Downloads'));
    h.dlBadge = add(h.tabDl, el('span', 'tvg-badge-count'));
    h.dlBadge.style.display = 'none';
    var right = add(top, el('div', 'tvg-status'));
    function iconBtn(name, label) {
      var b = add(right, el('div', 'tvg-icon-btn'));
      b.appendChild(icon(name));
      b.appendChild(el('span', 'tvg-icon-label', label));
      return b;
    }
    h.btnSearch = iconBtn('search', 'Buscar');
    h.btnSettings = iconBtn('gear', 'Configura\u00e7\u00f5es');
    h.btnAvatar = add(right, el('div', 'tvg-icon-btn tvg-avatar-btn'));
    h.btnAvatar.appendChild(avatar('tvg-avatar-sm'));
    h.btnAvatar.appendChild(el('span', 'tvg-icon-label', 'Perfil'));
    add(right, el('span', 'tvg-clock', clockText()));
    h.topItems = [h.tabGames, h.tabDl, h.btnSearch, h.btnSettings, h.btnAvatar];
    h.topItems.forEach(function(t, i) {
      t.addEventListener('click', function() { h.zone = 'top'; h.top = i; topAccept(h); });
    });

    // Row of tiles.
    var rowBox = add(p.el, el('div', 'tvg-row-box'));
    h.row = add(rowBox, el('div', 'tvg-row'));
    h.name = add(p.el, el('div', 'tvg-tile-name'));

    // Hero.
    h.hero = add(p.el, el('div', 'tvg-hero'));
    h.heroText = add(h.hero, el('div', 'tvg-hero-text'));
    h.kicker = add(h.heroText, el('div', 'tvg-kicker'));
    h.logo = add(h.heroText, el('img', 'tvg-logo'));
    h.logo.onerror = function() { h.heroText.classList.remove('tvg-has-logo'); };
    h.logo.onload = function() { if (h.logo.getAttribute('data-for') === h.logo.src) h.heroText.classList.add('tvg-has-logo'); };
    h.title = add(h.heroText, el('div', 'tvg-title'));
    h.desc = add(h.heroText, el('div', 'tvg-desc'));
    h.actions = add(h.hero, el('div', 'tvg-actions'));
    h.btnPlay = add(h.actions, el('div', 'tvg-pill tvg-play', 'Jogar'));
    h.btnMore = add(h.actions, el('div', 'tvg-round'));
    h.btnMore.appendChild(icon('dots'));
    h.btnPlay.addEventListener('click', function() { h.zone = 'actions'; h.action = 0; actionAccept(h); });
    h.btnMore.addEventListener('click', function() { h.zone = 'actions'; h.action = 1; actionAccept(h); });
    h.preview = add(p.el, el('div', 'tvg-preview'));
    h.side = add(p.el, el('div', 'tvg-side'));
    h.sideCard = add(h.side, el('div', 'tvg-side-card'));
    h.sideCard.addEventListener('click', function() { h.zone = 'actions'; h.action = 2; actionAccept(h); });
    h.sideInfo = add(h.side, el('div', 'tvg-side-info'));

    // Hub (scroll down from the hero).
    h.hubHead = add(p.el, el('div', 'tvg-hub-head'));
    h.hub = add(p.el, el('div', 'tvg-hub'));

    p.el.appendChild(hints([['OK', 'Selecionar'], ['Y', 'Op\u00e7\u00f5es'], ['Start', 'Menu r\u00e1pido']]));

    p.keys = {
      up: function() { homeMove(h, 'up'); },
      down: function() { homeMove(h, 'down'); },
      left: function() { homeMove(h, 'left'); },
      right: function() { homeMove(h, 'right'); },
      accept: function() { homeAccept(h); },
      back: function() {
        if (h.zone === 'hub') { h.zone = 'actions'; h.action = 0; h.hub.style.transform = ''; homeFocus(h); return; }
        if (h.zone === 'actions' || h.zone === 'top') { h.zone = 'row'; homeFocus(h); return; }
        if (h.index > 0) { h.index = 0; homeFocus(h); return; }
        if (state.settings.whoScreen) openWho();
        else leaveToHosts();
      },
      option: function() { var it = h.items[h.index]; if (it && it.game) openGameMenu(it.game); },
      menu: function() { openQuick(); },
    };
    p.onReturn = function() {
      var old = h.btnAvatar.querySelector('.tvg-avatar');
      if (old) h.btnAvatar.replaceChild(avatar('tvg-avatar-sm'), old);
      updateDlBadge();
      homeFocus(h);
    };
    h.page = p;
    h.rebuild = function() { homeRows(h); };
    state.home = h;
    homeRows(h);
    return p;
  }

  /** Items of the row: recent games first, then the system tiles. */
  function homeRows(h) {
    var keep = h.items[h.index];
    var games = sortGames(allGames().filter(function(g) { return !isHydraApp(g); }), 'recent').slice(0, HOME_MAX_GAMES);
    h.items = games.map(function(g) { return { game: g }; });
    h.items.push({ sys: 'downloads', title: 'Downloads', icon: 'download' });
    h.items.push({ sys: 'library', title: 'Biblioteca', icon: 'grid' });
    h.row.innerHTML = '';
    h.tiles = h.items.map(function(it, i) {
      var t = add(h.row, el('div', 'tvg-tile' + (it.sys ? ' tvg-tile-sys' : '')));
      if (it.game) {
        t.appendChild(el('div', 'tvg-placeholder', it.game.title));
        if (it.game.cover) t.appendChild(img(it.game.cover, 'tvg-cover', true));
      } else {
        t.appendChild(icon(it.icon));
      }
      t.addEventListener('click', function() {
        if (h.zone === 'row' && h.index === i) homeAccept(h);
        else { h.zone = 'row'; h.index = i; homeFocus(h); }
      });
      return t;
    });
    var again = -1;
    if (keep) {
      h.items.forEach(function(it, i) {
        if ((keep.game && it.game && it.game.id === keep.game.id) || (keep.sys && keep.sys === it.sys)) again = i;
      });
    }
    h.index = again >= 0 ? again : 0;
    h.current = null;
    h.heroFor = undefined;
    h.bgSrc = '';
    restart(h.page.el, 'tvg-loaded');
    homeFocus(h);
  }

  function homeFocus(h) {
    var p = h.page;
    h.row.style.transform = 'translate3d(' + (KEYLINE - h.index * TILE_STEP) + 'px,0,0)';
    for (var i = Math.max(0, h.index - 2); i < Math.min(h.tiles.length, h.index + 16); i++) loadLazy(h.tiles[i]);
    var cur = h.tiles[h.index] || null;
    if (h.current !== cur) {
      if (h.current) h.current.classList.remove('tvg-current');
      if (cur) cur.classList.add('tvg-current');
      h.current = cur;
    }
    var it = h.items[h.index] || null;
    // The name next to the tile changes right away.
    h.name.textContent = it ? (it.game ? it.game.title : it.title) : '';
    if (h.heroFor !== it) scheduleHero(h, it);
    var target = null;
    if (h.zone === 'row') target = cur;
    else if (h.zone === 'top') target = h.topItems[h.top];
    else if (h.zone === 'actions') target = actionList(h)[h.action] || null;
    else if (h.zone === 'hub') target = hubTarget(h);
    p.el.classList.toggle('tvg-zone-top', h.zone === 'top');
    p.el.classList.toggle('tvg-zone-actions', h.zone === 'actions');
    p.el.classList.toggle('tvg-zone-hub', h.zone === 'hub');
    setFocus(p, target);
    if (h.zone === 'hub') hubScroll(h);
  }

  function actionList(h) {
    var it = h.items[h.index];
    if (!it) return [];
    if (it.sys) return [h.btnPlay];
    var list = [h.btnPlay, h.btnMore];
    if (h.side.style.display !== 'none') list.push(h.sideCard);
    return list;
  }

  function scheduleHero(h, it) {
    h.timers.forEach(clearTimeout);
    h.timers = [];
    var first = h.heroFor === undefined;
    h.heroFor = it;
    h.heroText.classList.remove('tvg-in');
    h.actions.classList.remove('tvg-in');
    h.side.classList.remove('tvg-in');
    h.preview.classList.remove('tvg-in');
    h.hub.innerHTML = '';
    h.hubRows = [];
    var k = first || state.settings.reduceMotion ? 0 : 1;
    h.timers.push(setTimeout(function() { setBackground(h, it); }, k * BG_DELAY_MS));
    h.timers.push(setTimeout(function() { fillHero(h, it); }, k * TEXT_DELAY_MS));
    h.timers.push(setTimeout(function() {
      h.side.classList.add('tvg-in');
      h.preview.classList.add('tvg-in');
    }, k * CARD_DELAY_MS));
  }

  function setBackground(h, it) {
    var g = it && it.game;
    var src = g && state.settings.background !== 'plain' ? url(g.hero || g.cover || '') : '';
    h.page.el.classList.toggle('tvg-sys-bg', !!(it && it.sys));
    if (h.bgSrc === src) return;
    h.bgSrc = src;
    var on = h.bgs[0].classList.contains('tvg-on') ? h.bgs[0] : h.bgs[1].classList.contains('tvg-on') ? h.bgs[1] : null;
    var next = on === h.bgs[0] ? h.bgs[1] : h.bgs[0];
    if (on) on.classList.remove('tvg-on');
    if (!src) return;
    next.className = 'tvg-bg' + (g.hero ? ' tvg-wide' : '');
    next.onload = function() { if (h.bgSrc === src) next.classList.add('tvg-on'); };
    next.src = src;
  }

  function fillHero(h, it) {
    var g = it && it.game;
    h.preview.innerHTML = '';
    h.side.style.display = 'none';
    h.sideCard.innerHTML = '';
    h.sideInfo.innerHTML = '';
    h.hubHead.innerHTML = '';
    h.actions.style.visibility = it ? 'visible' : 'hidden';
    if (!g) h.heroText.classList.remove('tvg-has-logo');
    if (!it) {
      h.kicker.textContent = '';
      h.title.textContent = 'Nada aqui ainda';
      h.desc.textContent = 'Rode tvgames sync no PC.';
    } else if (g) {
      h.kicker.textContent = g.launcher ? 'APP' : String(categoryOf(g)).toUpperCase();
      h.title.textContent = g.title;
      h.heroText.classList.remove('tvg-has-logo');
      h.logo.removeAttribute('src');
      if (g.logo) {
        h.logo.setAttribute('data-for', url(g.logo));
        h.logo.src = url(g.logo);
      }
      var bits = (g.tags || []).slice(0, 3);
      if (state.recent.indexOf(g.id) === 0) bits.unshift('Jogado por \u00faltimo');
      h.desc.textContent = g.description || bits.join('  \u00b7  ');
      h.btnPlay.textContent = isRunning(g) ? 'Voltar ao jogo' : 'Jogar';
      // Side card: the cover, plus the trophy progress under it.
      h.side.style.display = '';
      if (g.cover) h.sideCard.appendChild(img(g.cover));
      else h.sideCard.appendChild(el('div', 'tvg-placeholder', g.title));
      h.sideCard.appendChild(el('div', 'tvg-chip', g.launcher ? 'App' : categoryOf(g)));
      var a = g.achievements;
      if (a && a.total) {
        h.sideInfo.appendChild(medal(a.earned === a.total ? 'master' : 'gold'));
        h.sideInfo.appendChild(labelValue('Progresso', percent(a) + '%'));
        h.sideInfo.appendChild(labelValue('Obtidas', a.earned + '/' + a.total));
      }
      var hh = add(h.hubHead, el('div', 'tvg-hub-icon'));
      if (g.cover) hh.appendChild(img(g.cover));
      h.hubHead.appendChild(el('div', 'tvg-hub-name', g.title));
      buildHub(h, g);
    } else {
      h.kicker.textContent = '';
      h.btnPlay.textContent = 'Abrir';
      if (it.sys === 'library') {
        h.title.textContent = 'Todos os seus jogos em um s\u00f3 lugar';
        h.desc.textContent = '';
        // Preview of the grid, before going in.
        var shown = shelfGames('*');
        var meta = add(h.preview, el('div', 'tvg-preview-meta'));
        meta.appendChild(el('span', null, 'Todos: ' + shown.length));
        meta.appendChild(el('span', null, 'Ordenar: ' + (state.settings.sort === 'az' ? 'A-Z' : 'Mais recentes')));
        var grid = add(h.preview, el('div', 'tvg-preview-grid'));
        shown.slice(0, 10).forEach(function(x) {
          var c = add(grid, el('div', 'tvg-preview-tile'));
          if (x.cover) c.appendChild(img(x.cover));
          else c.appendChild(el('div', 'tvg-placeholder', x.title));
        });
      } else {
        var n = activeDownloads().length;
        h.title.textContent = n ? n + (n === 1 ? ' download em andamento' : ' downloads em andamento') : 'Instale jogos no PC pela TV';
        h.desc.textContent = 'Steam e Epic Games: jogos da sua conta. Hydra: abre no PC.';
      }
    }
    restart(h.heroText, 'tvg-in');
    restart(h.actions, 'tvg-in');
    if (h.zone === 'actions') homeFocus(h);
  }

  // ---- hub: the page below the hero (trophy cards and details) ----

  function buildHub(h, g) {
    h.hub.innerHTML = '';
    h.hubRows = [];
    var a = g.achievements;
    if (a && a.total) {
      var badges = (a.badges || []).slice();
      var next = badges.filter(function(b) { return !b.earned && !b.hidden; })
        .sort(function(x, y) { return (y.rarity || 0) - (x.rarity || 0); }).slice(0, 6);
      var recent = badges.filter(function(b) { return b.earned; })
        .sort(function(x, y) { return (y.earned_at || 0) - (x.earned_at || 0); }).slice(0, 6);
      var pick = next.length ? next : recent;
      var sec = hubSection(h, next.length ? 'Pr\u00f3ximas conquistas' : 'Conquistas recentes');
      pick.forEach(function(b) {
        var c = add(sec.row, trophyCard(b));
        sec.items.push({ el: c, act: function() { openGameTrophies(g, b); } });
      });
      var all = add(sec.row, el('div', 'tvg-tcard tvg-card-more'));
      all.appendChild(icon('medal'));
      all.appendChild(el('div', 'tvg-tcard-title', 'Ver todas (' + a.total + ')'));
      sec.items.push({ el: all, act: function() { openGameTrophies(g); } });
    }
    var info = hubSection(h, 'Sobre o jogo');
    function infoCard(label, value, sub, act) {
      var c = add(info.row, el('div', 'tvg-info-card'));
      c.appendChild(labelValue(label, value));
      if (sub) c.appendChild(el('div', 'tvg-info-sub', sub));
      info.items.push({ el: c, act: act || noop });
    }
    infoCard('Plataforma', g.launcher ? 'Aplicativo' : categoryOf(g), (g.tags || []).slice(0, 3).join(' \u00b7 '));
    if (g.developer || g.publisher) infoCard('Desenvolvedora', g.developer || g.publisher, g.publisher && g.publisher !== g.developer ? 'Publicado por ' + g.publisher : '');
    var pos = state.recent.indexOf(g.id);
    infoCard('Atividade', pos === 0 ? 'Jogado por \u00faltimo' : pos > 0 ? 'Jogado recentemente' : 'Ainda n\u00e3o jogado', 'pelo Play TV');
    if (a && a.total) {
      var t = gameTiers(g);
      infoCard('Conquistas', percent(a) + '%', t.gold + ' ouro \u00b7 ' + t.silver + ' prata \u00b7 ' + t.bronze + ' bronze', function() { openGameTrophies(g); });
    }
    h.hubCol = h.hubRows.map(function() { return 0; });
    h.hubRow = 0;
  }

  function hubSection(h, title) {
    var s = add(h.hub, el('div', 'tvg-hub-sec'));
    s.appendChild(el('div', 'tvg-sec-title', title));
    var row = add(add(s, el('div', 'tvg-hub-rowbox')), el('div', 'tvg-hub-row'));
    var sec = { el: s, row: row, items: [] };
    h.hubRows.push(sec);
    return sec;
  }

  function hubTarget(h) {
    var sec = h.hubRows[h.hubRow];
    var it = sec && sec.items[h.hubCol[h.hubRow] || 0];
    return it ? it.el : null;
  }

  function hubScroll(h) {
    var sec = h.hubRows[h.hubRow];
    if (!sec) return;
    var y = 0;
    for (var i = 0; i < h.hubRow; i++) y += h.hubRows[i].el.offsetHeight + 40;
    h.hub.style.transform = 'translate3d(0,' + (-y) + 'px,0)';
    var it = sec.items[h.hubCol[h.hubRow] || 0];
    var x = it ? Math.max(0, it.el.offsetLeft - 700) : 0;
    sec.row.style.transform = 'translate3d(' + (-x) + 'px,0,0)';
  }

  function homeMove(h, dir) {
    var it = h.items[h.index];
    if (h.zone === 'top') {
      if (dir === 'left' && h.top > 0) h.top--;
      else if (dir === 'right' && h.top < h.topItems.length - 1) h.top++;
      else if (dir === 'down') h.zone = 'row';
    } else if (h.zone === 'row') {
      if (dir === 'left' && h.index > 0) h.index--;
      else if (dir === 'right' && h.index < h.items.length - 1) h.index++;
      else if (dir === 'up') { h.zone = 'top'; h.top = 0; }
      else if (dir === 'down' && it) { h.zone = 'actions'; h.action = 0; }
    } else if (h.zone === 'actions') {
      var n = actionList(h).length;
      if (dir === 'left' && h.action > 0) h.action--;
      else if (dir === 'right' && h.action < n - 1) h.action++;
      else if (dir === 'up') h.zone = 'row';
      else if (dir === 'down' && it && it.game && h.hubRows.length) { h.zone = 'hub'; h.hubRow = 0; }
    } else if (h.zone === 'hub') {
      var sec = h.hubRows[h.hubRow];
      var col = h.hubCol[h.hubRow] || 0;
      if (dir === 'left' && col > 0) h.hubCol[h.hubRow] = col - 1;
      else if (dir === 'right' && col < sec.items.length - 1) h.hubCol[h.hubRow] = col + 1;
      else if (dir === 'up') {
        if (h.hubRow > 0) h.hubRow--;
        else { h.zone = 'actions'; h.action = 0; h.hub.style.transform = ''; }
      } else if (dir === 'down' && h.hubRow < h.hubRows.length - 1) h.hubRow++;
    }
    homeFocus(h);
  }

  function homeAccept(h) {
    var it = h.items[h.index];
    if (h.zone === 'top') return topAccept(h);
    if (h.zone === 'hub') {
      var sec = h.hubRows[h.hubRow];
      var x = sec && sec.items[h.hubCol[h.hubRow] || 0];
      if (x) x.act();
      return undefined;
    }
    if (h.zone === 'actions') return actionAccept(h);
    if (!it) return undefined;
    if (it.sys) return openSystem(it.sys);
    return launchFromHome(h, it.game);
  }

  function topAccept(h) {
    var t = h.topItems[h.top];
    if (t === h.tabGames) { h.zone = 'row'; homeFocus(h); }
    else if (t === h.tabDl) openDownloads();
    else if (t === h.btnSearch) openSearch();
    else if (t === h.btnSettings) openSettings();
    else if (t === h.btnAvatar) openAvatarMenu();
  }

  function actionAccept(h) {
    var it = h.items[h.index];
    var b = actionList(h)[h.action];
    if (!it) return;
    if (it.sys) { openSystem(it.sys); return; }
    if (b === h.btnPlay) launchFromHome(h, it.game);
    else if (b === h.btnMore) openGameMenu(it.game);
    else if (b === h.sideCard) {
      if (it.game.achievements && it.game.achievements.total) openGameTrophies(it.game);
      else openDetails(it.game);
    }
  }

  function openSystem(sys) {
    if (sys === 'library') openLibrary();
    else if (sys === 'downloads') openDownloads();
  }

  /** "The art becomes the game": the home fades to the bare art before the stream. */
  function launchFromHome(h, g) {
    if (!g) return;
    if (state.settings.reduceMotion) { play(g); return; }
    h.page.el.classList.add('tvg-launching');
    setTimeout(function() {
      play(g);
      setTimeout(function() { h.page.el.classList.remove('tvg-launching'); }, 1500);
    }, LAUNCH_FADE_MS);
  }

  // ============================================================== MENUS ----

  /** Dropdown menu: a dark list over a dimmed page. items: [{label, icon, value, act}] */
  function openMenu(items, opts) {
    opts = opts || {};
    var p = newPage('tvg-menu-page');
    p.cover = false;
    var box = add(p.el, el('div', 'tvg-menu'));
    if (opts.x !== undefined) box.style.left = opts.x + 'px';
    if (opts.right !== undefined) { box.style.right = opts.right + 'px'; box.style.left = 'auto'; }
    if (opts.y !== undefined) box.style.top = opts.y + 'px';
    if (opts.title) box.appendChild(el('div', 'tvg-menu-title', opts.title));
    var idx = 0;
    var els = items.map(function(it, i) {
      var r = add(box, el('div', 'tvg-menu-item'));
      if (it.icon) r.appendChild(icon(it.icon));
      r.appendChild(el('span', 'tvg-menu-label', it.label));
      if (it.value) r.appendChild(el('span', 'tvg-menu-value', it.value));
      r.addEventListener('click', function() { idx = i; p.keys.accept(); });
      return r;
    });
    function focus() { setFocus(p, els[idx]); }
    p.keys = {
      up: function() { if (idx > 0) { idx--; focus(); } },
      down: function() { if (idx < els.length - 1) { idx++; focus(); } },
      left: noop,
      right: noop,
      accept: function() {
        pop(p);
        if (items[idx].act) items[idx].act();
      },
      option: function() { pop(p); },
    };
    focus();
    push(p);
    return p;
  }

  /** Centered dialog with pill buttons; the last one is the primary. */
  function openDialog(title, text, buttons) {
    var p = newPage('tvg-menu-page');
    p.cover = false;
    var box = add(p.el, el('div', 'tvg-dialog'));
    box.appendChild(el('div', 'tvg-dialog-title', title));
    if (text) box.appendChild(el('div', 'tvg-dialog-text', text));
    var row = add(box, el('div', 'tvg-dialog-btns'));
    var idx = buttons.length - 1;
    var els = buttons.map(function(b, i) {
      var e = add(row, el('div', 'tvg-pill' + (i === buttons.length - 1 ? ' tvg-primary' : ''), b.label));
      e.addEventListener('click', function() { idx = i; p.keys.accept(); });
      return e;
    });
    function focus() { setFocus(p, els[idx]); }
    p.keys = {
      left: function() { if (idx > 0) { idx--; focus(); } },
      right: function() { if (idx < els.length - 1) { idx++; focus(); } },
      up: noop,
      down: noop,
      accept: function() {
        pop(p);
        if (buttons[idx].act) buttons[idx].act();
      },
    };
    focus();
    push(p);
    return p;
  }

  function openGameMenu(g) {
    var items = [];
    if (isRunning(g)) items.push({ label: 'Fechar jogo', icon: 'x', act: function() { closeGame(g); } });
    if (g.achievements && g.achievements.total) {
      items.push({ label: 'Ver conquistas', icon: 'medal', act: function() { openGameTrophies(g); } });
    }
    items.push({ label: 'Detalhes', icon: 'info', act: function() { openDetails(g); } });
    if (state.recent.indexOf(g.id) >= 0) {
      items.push({ label: 'Remover dos recentes', icon: 'back', act: function() {
        forgetPlayed(g.id);
        if (state.home) state.home.rebuild();
        toast('Removido dos recentes', g.title, 'check');
      } });
    }
    if (g.cover) {
      items.push({ label: 'Usar capa como avatar', icon: 'user', act: function() {
        state.settings.avatar = g.cover;
        saveSettings();
        if (state.home) state.home.page.onReturn();
        toast('Avatar atualizado', g.title, 'check');
      } });
    }
    openMenu(items, { x: 560, y: 600, title: g.title });
  }

  function openAvatarMenu() {
    var t = totals();
    openMenu([
      { label: 'Perfil', icon: 'user', act: function() { openProfile(); } },
      { label: 'Conquistas', icon: 'medal', value: 'N\u00edvel ' + t.level, act: function() { openTrophyList(); } },
      { label: 'Trocar de usu\u00e1rio', icon: 'back', act: function() { openWho(); } },
      { label: 'Energia', icon: 'power', act: function() { openPowerMenu(); } },
    ], { right: 150, y: 110, title: profile().name });
  }

  function openDetails(g) {
    var lines = [categoryOf(g)];
    if (g.developer) lines.push(g.developer);
    if (g.description) lines.push(g.description);
    if (g.tags && g.tags.length) lines.push(g.tags.join(', '));
    if (g.app_name) lines.push('No PC: ' + g.app_name);
    openDialog(g.title, lines.join('  \u00b7  '), [{ label: 'OK' }]);
  }

  function exitApp() {
    openDialog('Sair do Play TV?', 'O PC continua ligado.', [
      { label: 'Cancelar' },
      { label: 'Sair', act: function() {
        try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
      } },
    ]);
  }

  function powerAction(action, title, text) {
    openDialog(title, text, [
      { label: 'Cancelar' },
      { label: 'Confirmar', act: function() {
        request('POST', '/api/power', { action: action }).then(function() {
          toast(title.replace('?', ''), 'O PC vai fazer isso em alguns segundos', 'power');
        }, function(e) { toast('N\u00e3o deu', e.message, 'x'); });
      } },
    ]);
  }

  var POWER = [
    { label: 'Colocar o PC em repouso', icon: 'power', action: 'sleep', title: 'Colocar o PC em repouso?', text: 'O streaming vai cair. Para voltar, acorde o PC.' },
    { label: 'Reiniciar o PC', icon: 'back', action: 'restart', title: 'Reiniciar o PC?', text: 'Jogos abertos ser\u00e3o fechados.' },
    { label: 'Desligar o PC', icon: 'x', action: 'shutdown', title: 'Desligar o PC?', text: 'Jogos abertos ser\u00e3o fechados.' },
  ];

  function powerItems(wrap) {
    var items = POWER.map(function(x) {
      return { label: x.label, icon: x.icon, act: function() { wrap(); powerAction(x.action, x.title, x.text); } };
    });
    items.push({ label: 'Trocar de PC', icon: 'pc', act: function() { wrap(); leaveToHosts(); } });
    items.push({ label: 'Sair do Play TV', icon: 'power', act: function() { wrap(); exitApp(); } });
    return items;
  }

  function openPowerMenu(opts) {
    openMenu(powerItems(noop), opts || { right: 150, y: 300, title: 'Energia' });
  }

  /** "Fechando..." screen while the PC quits the running game. */
  function closeGame(g) {
    var p = newPage('tvg-closing');
    stage(p, 'spot');
    var box = add(p.el, el('div', 'tvg-closing-box'));
    var ic = add(box, el('div', 'tvg-closing-icon'));
    if (g && g.cover) ic.appendChild(img(g.cover));
    box.appendChild(el('div', 'tvg-closing-name', g ? g.title : ''));
    box.appendChild(el('div', 'tvg-closing-text', 'Fechando este jogo...'));
    add(box, el('div', 'tvg-closing-bar')).appendChild(el('i'));
    p.keys = { up: noop, down: noop, left: noop, right: noop, accept: noop, back: noop };
    push(p);
    var host = state.host;
    var done = function(ok) {
      setTimeout(function() {
        pop(p);
        if (ok) {
          if (host) host.currentGame = 0;
          toast('Jogo fechado', g ? g.title : '', 'check');
        } else {
          toast('N\u00e3o deu para fechar o jogo', 'Feche pelo PC', 'x');
        }
        if (state.home) state.home.rebuild();
      }, 900);
    };
    // The PC closes the running app itself; Moonlight's quitApp is the fallback.
    request('POST', '/api/session/close', {}).then(function(r) {
      if (r && r.ok === false) throw new Error(r.error || 'erro');
      done(true);
    }).catch(function() {
      if (host && host.quitApp) host.quitApp().then(function() { done(true); }, function() { done(false); });
      else done(false);
    });
  }

  // ============================================================ LIBRARY --

  function openLibrary(shelfId) {
    var p = newPage('tvg-library');
    stage(p, 'waves');
    pageHead(p, 'grid', 'Biblioteca');
    var sh = shelves();
    var tabs = add(p.el, el('div', 'tvg-tabs tvg-page-tabs'));
    var tabEls = sh.map(function(s) {
      var t = add(tabs, el('div', 'tvg-tab'));
      t.appendChild(document.createTextNode(s.name));
      t.appendChild(el('sup', null, String(s.n)));
      return t;
    });
    var meta = add(p.el, el('div', 'tvg-lib-meta'));
    var count = add(meta, el('span'));
    var sortTxt = add(meta, el('span', 'tvg-lib-sort'));
    var sortBtn = add(p.el, el('div', 'tvg-round tvg-lib-sortbtn'));
    sortBtn.appendChild(icon('sort'));
    var box = add(p.el, el('div', 'tvg-grid-box'));
    var grid = add(box, el('div', 'tvg-grid tvg-grid-6'));
    p.el.appendChild(hints([['OK', 'Jogar'], ['Y', 'Op\u00e7\u00f5es'], ['Voltar', 'In\u00edcio']]));
    var shelf = 0;
    sh.forEach(function(s, i) { if (s.id === shelfId) shelf = i; });
    var zone = 'grid';
    var idx = 0;
    var games = [];
    var tiles = [];
    var COLS = 6;

    function fill() {
      tabEls.forEach(function(t, i) { t.classList.toggle('tvg-selected', i === shelf); });
      games = shelfGames(sh[shelf].id);
      count.textContent = (shelf === 0 ? 'Todos' : sh[shelf].name) + ': ' + games.length;
      sortTxt.textContent = 'Ordenar: ' + (state.settings.sort === 'az' ? 'A-Z' : 'Mais recentes');
      grid.innerHTML = '';
      tiles = games.map(function(g, i) {
        var t = add(grid, el('div', 'tvg-gtile'));
        t.appendChild(el('div', 'tvg-placeholder', g.title));
        if (g.cover) t.appendChild(img(g.cover, 'tvg-cover', true));
        var over = add(t, el('div', 'tvg-gtile-over'));
        over.appendChild(el('div', 'tvg-chip', g.launcher ? 'App' : categoryOf(g)));
        over.appendChild(el('div', 'tvg-gtile-name', g.title));
        if (g.achievements && g.achievements.total && g.achievements.earned === g.achievements.total) {
          t.appendChild(medal('master', 'tvg-gtile-medal'));
        }
        t.addEventListener('click', function() { zone = 'grid'; idx = i; accept(); });
        return t;
      });
      if (!games.length) {
        var empty = add(grid, el('div', 'tvg-empty tvg-empty-center'));
        empty.appendChild(el('div', 'tvg-empty-title', 'N\u00e3o tem nada aqui ainda'));
        var b = add(empty, el('div', 'tvg-pill', 'Ver todos'));
        b.addEventListener('click', function() { shelf = 0; fill(); });
        tiles = [b];
      }
      idx = Math.min(idx, Math.max(0, tiles.length - 1));
      focus();
    }

    function focus() {
      setFocus(p, zone === 'tabs' ? tabEls[shelf] : zone === 'sort' ? sortBtn : tiles[idx]);
      var rowI = Math.floor(idx / COLS);
      grid.style.transform = 'translate3d(0,' + (-Math.max(0, rowI - 1) * 346) + 'px,0)';
      var first = Math.max(0, (rowI - 1) * COLS);
      for (var i = first; i < Math.min(tiles.length, first + COLS * 4); i++) loadLazy(tiles[i]);
    }

    function accept() {
      if (zone === 'tabs') { zone = 'grid'; focus(); return; }
      if (zone === 'sort') {
        state.settings.sort = state.settings.sort === 'az' ? 'recent' : 'az';
        saveSettings();
        fill();
        return;
      }
      var g = games[idx];
      if (!g) { shelf = 0; zone = 'grid'; fill(); return; }
      play(g);
    }

    p.keys = {
      left: function() {
        if (zone === 'tabs') { if (shelf > 0) { shelf--; idx = 0; fill(); } return; }
        if (zone === 'grid') {
          var n = gridMove(idx, tiles.length, COLS, 'left');
          if (n < 0) zone = 'sort'; else idx = n;
        }
        focus();
      },
      right: function() {
        if (zone === 'tabs') { if (shelf < sh.length - 1) { shelf++; idx = 0; fill(); } return; }
        if (zone === 'sort') zone = 'grid';
        else { var n = gridMove(idx, tiles.length, COLS, 'right'); if (n >= 0) idx = n; }
        focus();
      },
      up: function() {
        if (zone === 'grid') { var n = gridMove(idx, tiles.length, COLS, 'up'); if (n < 0) zone = 'tabs'; else idx = n; }
        else if (zone === 'sort') zone = 'tabs';
        focus();
      },
      down: function() {
        if (zone === 'tabs') zone = 'grid';
        else if (zone === 'grid') { var n = gridMove(idx, tiles.length, COLS, 'down'); if (n >= 0) idx = n; }
        focus();
      },
      accept: accept,
      option: function() { var g = games[idx]; if (zone === 'grid' && g) openGameMenu(g); },
    };
    fill();
    push(p);
    return p;
  }

  // ============================================================== SEARCH --

  function openSearch() {
    var p = newPage('tvg-search');
    stage(p, 'spot');
    var field = add(p.el, el('div', 'tvg-search-field'));
    field.appendChild(icon('search'));
    var text = add(field, el('span', 'tvg-search-text'));
    add(field, el('i', 'tvg-caret'));
    var kb = add(p.el, el('div', 'tvg-kb'));
    var keys = 'abcdefghijklmnopqrstuvwxyz1234567890'.split('').map(function(k) { return { label: k, put: k }; });
    keys.push({ label: 'Espa\u00e7o', put: ' ', wide: true });
    keys.push({ label: '\u2190', del: true });
    keys.push({ label: 'Limpar', clear: true, wide: true });
    var COLS = 6;
    var RCOLS = 4;
    var q = '';
    var zone = 'kb';
    var ki = 0;
    var ri = 0;
    var found = [];
    var cards = [];
    var keyEls = keys.map(function(k, i) {
      var e = add(kb, el('div', 'tvg-key' + (k.wide ? ' tvg-key-wide' : ''), k.label));
      e.addEventListener('click', function() { zone = 'kb'; ki = i; press(); });
      return e;
    });
    var resTitle = add(p.el, el('div', 'tvg-sec-title tvg-search-title'));
    var resBox = add(p.el, el('div', 'tvg-search-res'));
    var res = add(resBox, el('div', 'tvg-grid tvg-grid-4'));
    p.el.appendChild(hints([['OK', 'Digitar / abrir'], ['Voltar', 'In\u00edcio']]));

    function search() {
      text.textContent = q || 'Buscar jogos e apps';
      text.classList.toggle('tvg-ph', !q);
      var f = fold(q).trim();
      var pool = allGames().filter(function(g) { return !isHydraApp(g); });
      if (!f) {
        resTitle.textContent = 'Jogados recentemente';
        found = sortGames(pool, 'recent').slice(0, 8);
      } else {
        found = sortGames(pool.filter(function(g) {
          return fold(g.title).indexOf(f) >= 0 || fold(categoryOf(g)).indexOf(f) >= 0;
        }), 'recent');
        resTitle.textContent = found.length ? 'Resultados (' + found.length + ')' : 'Nenhum resultado para "' + q + '"';
      }
      res.innerHTML = '';
      cards = found.slice(0, 24).map(function(g, i) {
        var c = add(res, el('div', 'tvg-rcard'));
        var art = add(c, el('div', 'tvg-rcard-art'));
        if (g.hero || g.cover) art.appendChild(img(g.hero || g.cover));
        var t = add(c, el('div', 'tvg-rcard-text'));
        t.appendChild(el('div', 'tvg-rcard-title', g.title));
        t.appendChild(el('div', 'tvg-rcard-sub', categoryOf(g)));
        c.addEventListener('click', function() { zone = 'res'; ri = i; p.keys.accept(); });
        return c;
      });
      if (ri >= cards.length) ri = Math.max(0, cards.length - 1);
      if (!cards.length && zone === 'res') zone = 'kb';
    }

    function press() {
      var k = keys[ki];
      if (k.del) q = q.slice(0, -1);
      else if (k.clear) q = '';
      else if (q.length < 30) q += k.put;
      search();
      focus();
    }

    function focus() {
      setFocus(p, zone === 'kb' ? keyEls[ki] : cards[ri]);
      var y = zone === 'res' ? Math.max(0, Math.floor(ri / RCOLS) - 1) * 300 : 0;
      res.style.transform = 'translate3d(0,' + (-y) + 'px,0)';
    }

    function move(dir) {
      if (zone === 'kb') {
        var n = gridMove(ki, keys.length, COLS, dir);
        if (n >= 0) ki = n;
        else if (dir === 'right' && cards.length) { zone = 'res'; ri = 0; }
      } else {
        var m = gridMove(ri, cards.length, RCOLS, dir);
        if (m >= 0) ri = m;
        else if (dir === 'left') zone = 'kb';
      }
      focus();
    }

    p.keys = {
      left: function() { move('left'); },
      right: function() { move('right'); },
      up: function() { move('up'); },
      down: function() { move('down'); },
      accept: function() {
        if (zone === 'kb') press();
        else if (found[ri]) play(found[ri]);
      },
    };
    // Typing on a real keyboard also works.
    p.onKey = function(e) {
      if (e.key && e.key.length === 1 && /[a-z0-9 ]/i.test(e.key)) { q += e.key.toLowerCase(); search(); focus(); return true; }
      if (e.keyCode === 8) { q = q.slice(0, -1); search(); focus(); return true; }
      return false;
    };
    search();
    focus();
    push(p);
    return p;
  }

  // ============================================================ TROPHIES --

  function trophyIcon(b, size) {
    var c = el('div', 'tvg-tro-icon' + (size ? ' tvg-tro-icon-' + size : ''));
    if (!b.earned && b.hidden) {
      c.classList.add('tvg-locked');
      c.appendChild(icon('lock'));
      return c;
    }
    var src = b.url;
    if (!b.earned) {
      if (b.url_locked) src = b.url_locked;
      else if (/retroachievements/.test(b.url || '')) src = String(b.url).replace(/\.png$/, '_lock.png');
      c.classList.add('tvg-locked');
    }
    c.appendChild(img(src));
    if (!b.earned) c.appendChild(icon('lock', 'tvg-tro-lock'));
    return c;
  }

  function trophyCard(b) {
    var c = el('div', 'tvg-tcard' + (b.earned ? '' : ' tvg-locked'));
    c.appendChild(trophyIcon(b));
    var t = add(c, el('div', 'tvg-tcard-text'));
    if (!b.earned && b.hidden) {
      t.appendChild(el('div', 'tvg-tcard-title', 'Conquista oculta'));
      return c;
    }
    var tier = add(t, el('div', 'tvg-tcard-tier'));
    tier.appendChild(medal(tierOf(b)));
    tier.appendChild(document.createTextNode(TIERS[tierOf(b)]));
    t.appendChild(el('div', 'tvg-tcard-title', b.title));
    t.appendChild(el('div', 'tvg-tcard-desc', b.description || ''));
    return c;
  }

  function gameRow(g, withTiers) {
    var a = g.achievements;
    var r = el('div', 'tvg-trow');
    var cov = add(r, el('div', 'tvg-trow-cover'));
    if (g.cover) cov.appendChild(img(g.cover));
    var mid = add(r, el('div', 'tvg-trow-main'));
    mid.appendChild(el('div', 'tvg-trow-title', g.title));
    mid.appendChild(el('span', 'tvg-chip', categoryOf(g)));
    if (a && a.total) {
      var pct = add(r, el('div', 'tvg-trow-pct'));
      if (a.earned === a.total) pct.appendChild(medal('master'));
      var num = add(pct, el('div', 'tvg-trow-num'));
      num.appendChild(el('span', null, percent(a) + '%'));
      num.appendChild(thinBar(percent(a)));
      if (withTiers) r.appendChild(tierCounts(gameTiers(g)));
    }
    return r;
  }

  /** 6a: every game with trophies, with the overall summary on top. */
  function openTrophyList(onlyComplete) {
    var p = newPage('tvg-tlist');
    stage(p, 'spot');
    var head = add(p.el, el('div', 'tvg-tlist-head'));
    head.appendChild(el('div', 'tvg-head-title', onlyComplete ? 'Maestrias' : 'Conquistas'));
    var t = totals();
    var sum = add(head, el('div', 'tvg-tlist-sum'));
    sum.appendChild(levelChip(t.level));
    sum.appendChild(labelValue('Total', String(t.earned)));
    sum.appendChild(tierCounts(t, true));
    var box = add(p.el, el('div', 'tvg-list-box'));
    var list = add(box, el('div', 'tvg-list'));
    var games = trophyGames();
    if (onlyComplete) games = games.filter(function(g) { return g.achievements.earned === g.achievements.total; });
    var rows = games.map(function(g) {
      var r = add(list, gameRow(g, true));
      r.addEventListener('click', function() { openGameTrophies(g); });
      return r;
    });
    if (!rows.length) {
      var e = add(list, el('div', 'tvg-empty'));
      e.appendChild(el('div', 'tvg-empty-title', onlyComplete ? 'Nenhuma maestria ainda' : 'Nenhum jogo com conquistas ainda'));
      e.appendChild(el('div', 'tvg-empty-sub', 'As conquistas da Steam e do RetroAchievements aparecem aqui.'));
    }
    p.el.appendChild(hints([['OK', 'Ver conquistas'], ['Voltar', 'Sair']]));
    // Layered loading: rows and counts first, the percentages a moment later.
    p.el.classList.add('tvg-loading');
    setTimeout(function() { p.el.classList.remove('tvg-loading'); }, 350);
    var idx = 0;
    function focus() {
      setFocus(p, rows[idx]);
      list.style.transform = 'translate3d(0,' + (-Math.max(0, idx - 3) * 150) + 'px,0)';
    }
    p.keys = {
      up: function() { if (idx > 0) { idx--; focus(); } },
      down: function() { if (idx < rows.length - 1) { idx++; focus(); } },
      left: noop,
      right: noop,
      accept: function() { if (games[idx]) openGameTrophies(games[idx]); },
    };
    focus();
    push(p);
    return p;
  }

  var SORTS = [
    { id: 'game', name: 'Padr\u00e3o do jogo' },
    { id: 'earned', name: 'Obtidas primeiro' },
    { id: 'rare', name: 'Mais raras' },
    { id: 'recent', name: 'Mais recentes' },
    { id: 'locked', name: 'Faltando primeiro' },
  ];

  function sortBadges(list, how) {
    var l = list.map(function(b, i) { return { b: b, i: i }; });
    l.sort(function(x, y) {
      var a = x.b;
      var b = y.b;
      if (how === 'earned') return (b.earned ? 1 : 0) - (a.earned ? 1 : 0) || x.i - y.i;
      if (how === 'locked') return (a.earned ? 1 : 0) - (b.earned ? 1 : 0) || x.i - y.i;
      if (how === 'rare') return (hasRarity(a) ? a.rarity : 101) - (hasRarity(b) ? b.rarity : 101) || x.i - y.i;
      if (how === 'recent') return (b.earned_at || 0) - (a.earned_at || 0) || (b.earned ? 1 : 0) - (a.earned ? 1 : 0) || x.i - y.i;
      return x.i - y.i;
    });
    return l.map(function(x) { return x.b; });
  }

  /** 6b: one game's trophies as a horizontal row of cards. */
  function openGameTrophies(g, focusBadge) {
    var a = g.achievements;
    if (!a || !a.total) { openDetails(g); return null; }
    var p = newPage('tvg-gtro');
    stage(p, 'spot');
    var head = add(p.el, el('div', 'tvg-gtro-head'));
    var hi = add(head, el('div', 'tvg-gtro-icon'));
    if (g.cover) hi.appendChild(img(g.cover));
    head.appendChild(el('div', 'tvg-head-title', g.title));
    var sum = add(p.el, el('div', 'tvg-gtro-sum'));
    var prog = add(sum, labelValue('Progresso', percent(a) + '%', 'tvg-lv-progress'));
    prog.appendChild(thinBar(percent(a)));
    sum.appendChild(labelValue('Obtidas', a.earned + '/' + a.total));
    var pts = 0;
    (a.badges || []).forEach(function(b) { if (b.earned) pts += b.points || 0; });
    if (pts) sum.appendChild(labelValue('Pontos', String(pts)));
    sum.appendChild(tierCounts(gameTiers(g), true));
    var sortRow = add(p.el, el('div', 'tvg-sortrow'));
    sortRow.appendChild(el('span', 'tvg-sort-label', 'Ordenar por'));
    var sortField = add(sortRow, el('div', 'tvg-sort-field'));
    var sortName = add(sortField, el('span'));
    sortField.appendChild(el('span', 'tvg-sort-arrow', '\u25be'));
    var box = add(p.el, el('div', 'tvg-tcards-box'));
    var row = add(box, el('div', 'tvg-tcards'));
    var scroll = add(p.el, el('div', 'tvg-scrollbar'));
    var thumb = add(scroll, el('i'));
    p.el.appendChild(hints([['OK', 'Informa\u00e7\u00f5es'], ['\u25b2', 'Ordenar'], ['Voltar', 'Sair']]));
    var sortI = 0;
    var list = [];
    var cards = [];
    var idx = 0;
    var zone = 'cards';
    var STEP = 330 + 28;

    function openPanel() { openTrophyPanel(g, list, idx, function(n) { idx = n; focus(); }); }

    function fill(keep) {
      sortName.textContent = SORTS[sortI].name;
      list = sortBadges(a.badges || [], SORTS[sortI].id);
      row.innerHTML = '';
      cards = list.map(function(b, i) {
        var c = add(row, trophyCard(b));
        c.addEventListener('click', function() { zone = 'cards'; idx = i; focus(); openPanel(); });
        return c;
      });
      idx = 0;
      if (keep) {
        var k = list.indexOf(keep);
        if (k >= 0) idx = k;
      }
      focus();
    }

    function focus() {
      setFocus(p, zone === 'sort' ? sortField : cards[idx]);
      row.style.transform = 'translate3d(' + (-Math.max(0, idx - 2) * STEP) + 'px,0,0)';
      var w = Math.max(30, Math.min(170, 170 * 4.5 / Math.max(1, list.length)));
      thumb.style.width = w + 'px';
      thumb.style.transform = 'translate3d(' + ((170 - w) * (list.length > 1 ? idx / (list.length - 1) : 0)) + 'px,0,0)';
    }

    p.keys = {
      left: function() { if (zone === 'cards' && idx > 0) { idx--; focus(); } },
      right: function() { if (zone === 'cards' && idx < cards.length - 1) { idx++; focus(); } },
      up: function() { zone = 'sort'; focus(); },
      down: function() { zone = 'cards'; focus(); },
      accept: function() {
        if (zone === 'sort') {
          sortI = (sortI + 1) % SORTS.length;
          fill(list[idx]);
          return;
        }
        openPanel();
      },
    };
    // Skeleton first: empty cards in their final shape, then the content.
    p.el.classList.add('tvg-loading');
    setTimeout(function() { p.el.classList.remove('tvg-loading'); }, 300);
    fill(focusBadge);
    push(p);
    if (focusBadge) setTimeout(openPanel, 380);
    return p;
  }

  /** 6c: side panel with every detail of one trophy (left/right = next one). */
  function openTrophyPanel(g, list, start, onMove) {
    var p = newPage('tvg-panel-page');
    p.cover = false;
    var panel = add(p.el, el('div', 'tvg-panel'));
    var i = start;
    function line(ic, value, label) {
      var r = add(panel, el('div', 'tvg-panel-line'));
      r.appendChild(ic);
      var t = add(r, el('div'));
      t.appendChild(el('div', 'tvg-panel-value', value));
      t.appendChild(el('div', 'tvg-panel-small', label));
    }
    function fill() {
      var b = list[i];
      panel.innerHTML = '';
      panel.appendChild(el('div', 'tvg-panel-label', 'Informa\u00e7\u00f5es'));
      panel.appendChild(trophyIcon(b, 'lg'));
      var hidden = !b.earned && b.hidden;
      panel.appendChild(el('div', 'tvg-panel-name', hidden ? 'Conquista oculta' : b.title));
      panel.appendChild(el('div', 'tvg-panel-desc', hidden ? 'Os detalhes aparecem quando voc\u00ea conseguir.' : (b.description || '')));
      line(icon(b.earned ? 'check' : 'lock'), b.earned ? 'Obtida' + (b.earned_at ? '  |  ' + dateText(b.earned_at) : '') : 'Ainda n\u00e3o obtida', 'Status');
      var tier = tierOf(b);
      line(medal(tier), TIERS[tier] + (b.points ? ' \u00b7 ' + b.points + ' pts' : '') + (b.hidden ? ' (oculta)' : ''), 'Grau');
      if (hasRarity(b)) {
        line(icon('star'), rarityName(b.rarity) + '  |  ' + String(Math.round(b.rarity * 10) / 10).replace('.', ',') + '% dos jogadores', 'Raridade');
      }
      var setIc = el('div', 'tvg-panel-set');
      if (g.cover) setIc.appendChild(img(g.cover));
      line(setIc, g.title, 'Conjunto de conquistas');
    }
    p.keys = {
      up: noop,
      down: noop,
      left: function() { if (i > 0) { i--; fill(); onMove(i); } },
      right: function() { if (i < list.length - 1) { i++; fill(); onMove(i); } },
      accept: function() { pop(p); },
    };
    fill();
    push(p);
    return p;
  }

  // ============================================================= PROFILE --

  function openProfile() {
    var p = newPage('tvg-profile');
    stage(p, 'flat');
    var pr = profile();
    var t = totals();
    var head = add(p.el, el('div', 'tvg-prof-head'));
    var av = add(head, el('div', 'tvg-prof-av'));
    av.appendChild(avatar('tvg-avatar-md'));
    av.appendChild(el('i', 'tvg-online'));
    var nm = add(head, el('div'));
    nm.appendChild(el('div', 'tvg-prof-name', pr.name));
    nm.appendChild(el('div', 'tvg-prof-sub', 'Online no ' + pcName()));
    var tabsRow = add(p.el, el('div', 'tvg-prof-tabs'));
    var tabEls = ['Vis\u00e3o geral', 'Jogos', 'Conquistas'].map(function(n) { return add(tabsRow, el('div', 'tvg-tab', n)); });
    var tools = add(tabsRow, el('div', 'tvg-prof-tools'));
    var editBtn = add(tools, el('div', 'tvg-round'));
    editBtn.appendChild(icon('pencil'));
    var setBtn = add(tools, el('div', 'tvg-round'));
    setBtn.appendChild(icon('gear'));
    var body = add(p.el, el('div', 'tvg-prof-body'));
    p.el.appendChild(hints([['OK', 'Abrir'], ['Voltar', 'In\u00edcio']]));
    var topEls = tabEls.concat([editBtn, setBtn]);
    var tab = 0;
    var zone = 'cards';
    var ti = 0;
    var ci = 0;
    var cards = [];
    var acts = [];

    function card(row, cls, build, label, value, act) {
      var c = add(row, el('div', 'tvg-pcard ' + cls));
      build(add(c, el('div', 'tvg-pcard-top')));
      c.appendChild(labelValue(label, value));
      cards.push(c);
      acts.push(act);
    }

    function overview() {
      var row = add(body, el('div', 'tvg-pcards'));
      card(row, 'tvg-pcard-tro', function(top) {
        var l = add(top, el('div', 'tvg-pcard-level'));
        l.appendChild(levelChip(t.level));
        l.appendChild(el('span', null, 'N\u00edvel ' + t.level));
        top.appendChild(tierCounts(t));
      }, 'Conquistas obtidas:', String(t.earned), function() { openTrophyList(); });
      card(row, 'tvg-pcard-master', function(top) {
        var done = trophyGames().filter(function(g) { return g.achievements.earned === g.achievements.total; });
        if (!done.length) {
          top.appendChild(medal('master', 'tvg-medal-xl tvg-medal-off'));
          return;
        }
        var m = add(top, el('div', 'tvg-mosaic'));
        done.slice(0, 3).forEach(function(g) {
          var c = add(m, el('div', 'tvg-mosaic-tile'));
          if (g.cover) c.appendChild(img(g.cover));
        });
      }, 'Maestrias:', t.complete ? String(t.complete) : 'Nenhuma ainda', function() { openTrophyList(true); });
      card(row, 'tvg-pcard-games', function(top) {
        var m = add(top, el('div', 'tvg-mosaic'));
        sortGames(allGames().filter(function(g) { return !g.launcher && g.cover; }), 'recent').slice(0, 3).forEach(function(g) {
          add(m, el('div', 'tvg-mosaic-tile')).appendChild(img(g.cover));
        });
      }, 'Jogos:', String(t.games), function() { openLibrary(); });
      var steamLevel = pr.steam && pr.steam.level;
      card(row, 'tvg-pcard-pts', function(top) {
        var r = add(top, el('div', 'tvg-pcard-accounts'));
        r.appendChild(el('div', 'tvg-acc' + (pr.steam ? ' tvg-on' : ''), 'Steam'));
        r.appendChild(el('div', 'tvg-acc' + (pr.ra ? ' tvg-on' : ''), 'RetroAchievements'));
      }, steamLevel ? 'N\u00edvel Steam:' : 'Pontos RetroAchievements:', steamLevel ? String(steamLevel) : pr.ra ? String(pr.ra.points) : '\u2014', function() { openSettings('conta'); });
      body.appendChild(el('div', 'tvg-sec-title', 'Sobre'));
      add(body, el('div', 'tvg-about')).textContent = 'Jogando no PC ' + pcName() + '  \u00b7  ' + state.recent.length + ' jogos abertos pelo Play TV  \u00b7  ' + t.withCheevos + ' jogos com conquistas';
    }

    function gamesTab() {
      var box = add(body, el('div', 'tvg-list-box tvg-prof-list'));
      var list = add(box, el('div', 'tvg-list'));
      var games = state.recent.map(function(id) { return allGames().filter(function(g) { return g.id === id; })[0]; }).filter(Boolean);
      if (!games.length) list.appendChild(el('div', 'tvg-empty-title', 'Nenhum jogo aberto pelo Play TV ainda.'));
      games.forEach(function(g) {
        cards.push(add(list, gameRow(g, false)));
        acts.push(function() { play(g); });
      });
      p.list = list;
    }

    function fill() {
      tabEls.forEach(function(e, i) { e.classList.toggle('tvg-selected', i === tab); });
      body.innerHTML = '';
      cards = [];
      acts = [];
      p.list = null;
      if (tab === 0) overview();
      else gamesTab();
      ci = 0;
      if (!cards.length) zone = 'top';
      restart(p.el, 'tvg-loading');
      setTimeout(function() { p.el.classList.remove('tvg-loading'); }, 250);
      focus();
    }

    function focus() {
      setFocus(p, zone === 'top' ? topEls[ti] : cards[ci]);
      if (p.list) p.list.style.transform = 'translate3d(0,' + (-Math.max(0, ci - 3) * 150) + 'px,0)';
    }

    p.keys = {
      left: function() {
        if (zone === 'top') { if (ti > 0) ti--; }
        else if (tab === 0 && ci > 0) ci--;
        focus();
      },
      right: function() {
        if (zone === 'top') { if (ti < topEls.length - 1) ti++; }
        else if (tab === 0 && ci < cards.length - 1) ci++;
        focus();
      },
      up: function() {
        if (zone === 'cards' && (tab === 0 || ci === 0)) { zone = 'top'; ti = tab; }
        else if (zone === 'cards') ci--;
        focus();
      },
      down: function() {
        if (zone === 'top' && cards.length) zone = 'cards';
        else if (zone === 'cards' && tab === 1 && ci < cards.length - 1) ci++;
        focus();
      },
      accept: function() {
        if (zone === 'top') {
          var e = topEls[ti];
          if (e === editBtn) return openAvatarPicker();
          if (e === setBtn) return openSettings('conta');
          if (ti === 2) return openTrophyList();
          tab = ti;
          zone = 'cards';
          fill();
          return undefined;
        }
        if (acts[ci]) acts[ci]();
        return undefined;
      },
    };
    p.onReturn = function() {
      var a = av.querySelector('.tvg-avatar');
      if (a) av.replaceChild(avatar('tvg-avatar-md'), a);
    };
    fill();
    push(p);
    return p;
  }

  /** Avatar picker: game covers as round avatars, grouped like shelves. */
  function openAvatarPicker() {
    var p = newPage('tvg-avpick');
    stage(p, 'spot');
    p.el.appendChild(el('div', 'tvg-head-title tvg-avpick-title', 'Avatar'));
    var withCover = allGames().filter(function(g) { return g.cover; });
    var groups = [{ name: 'Todos', list: withCover }];
    var played = withCover.filter(function(g) { return state.recent.indexOf(g.id) >= 0; });
    if (played.length) groups.push({ name: 'Jogados', list: sortGames(played, 'recent') });
    shelves().slice(1).forEach(function(s) {
      var l = withCover.filter(function(g) { return categoryOf(g) === s.id; });
      if (l.length) groups.push({ name: s.name, list: l });
    });
    var std = { name: 'Padr\u00e3o', list: [] };
    groups.push(std);
    var tabs = add(p.el, el('div', 'tvg-tabs tvg-page-tabs'));
    var tabEls = groups.map(function(gr) {
      var t = add(tabs, el('div', 'tvg-tab'));
      t.appendChild(document.createTextNode(gr.name));
      if (gr.list.length) t.appendChild(el('sup', null, String(gr.list.length)));
      return t;
    });
    var box = add(p.el, el('div', 'tvg-grid-box tvg-av-box'));
    var grid = add(box, el('div', 'tvg-grid tvg-grid-av'));
    p.el.appendChild(hints([['OK', 'Usar'], ['Voltar', 'Cancelar']]));
    var gi = 0;
    var zone = 'grid';
    var idx = 0;
    var circles = [];
    var COLS = 8;
    function fill() {
      tabEls.forEach(function(t, i) { t.classList.toggle('tvg-selected', i === gi); });
      grid.innerHTML = '';
      if (groups[gi] === std) {
        var c = add(grid, el('div', 'tvg-avc tvg-avc-std'));
        c.appendChild(el('span', 'tvg-avatar-initial', profile().name.charAt(0).toUpperCase()));
        circles = [c];
      } else {
        circles = groups[gi].list.map(function(g) {
          return add(add(grid, el('div', 'tvg-avc')), img(g.cover, null, true)).parentNode;
        });
      }
      idx = Math.min(idx, circles.length - 1);
      focus();
    }
    function focus() {
      setFocus(p, zone === 'tabs' ? tabEls[gi] : circles[idx]);
      var rowI = Math.floor(idx / COLS);
      grid.style.transform = 'translate3d(0,' + (-Math.max(0, rowI - 1) * 196) + 'px,0)';
      for (var i = Math.max(0, (rowI - 1) * COLS); i < Math.min(circles.length, (rowI + 4) * COLS); i++) loadLazy(circles[i]);
    }
    p.keys = {
      left: function() {
        if (zone === 'tabs') { if (gi > 0) { gi--; idx = 0; fill(); } return; }
        var n = gridMove(idx, circles.length, COLS, 'left'); if (n >= 0) idx = n; focus();
      },
      right: function() {
        if (zone === 'tabs') { if (gi < groups.length - 1) { gi++; idx = 0; fill(); } return; }
        var n = gridMove(idx, circles.length, COLS, 'right'); if (n >= 0) idx = n; focus();
      },
      up: function() {
        if (zone === 'grid') { var n = gridMove(idx, circles.length, COLS, 'up'); if (n < 0) zone = 'tabs'; else idx = n; }
        focus();
      },
      down: function() {
        if (zone === 'tabs') zone = 'grid';
        else { var n = gridMove(idx, circles.length, COLS, 'down'); if (n >= 0) idx = n; }
        focus();
      },
      accept: function() {
        if (zone === 'tabs') { zone = 'grid'; focus(); return; }
        var gr = groups[gi];
        state.settings.avatar = gr === std ? '' : (gr.list[idx] && gr.list[idx].cover) || '';
        saveSettings();
        pop(p);
        toast('Avatar atualizado', '', 'check');
      },
    };
    fill();
    push(p);
    return p;
  }

  // ============================================================ SETTINGS --

  function onOff(v) { return v ? 'Ligado' : 'Desligado'; }

  function settingsCategories() {
    var s = state.settings;
    return [
      { id: 'aparencia', name: 'Apar\u00eancia', icon: 'brush', options: function() { return [
        { label: 'Sons do sistema', value: onOff(s.sounds), act: function() { s.sounds = !s.sounds; saveSettings(); } },
        { label: 'Reduzir anima\u00e7\u00f5es', value: onOff(s.reduceMotion), act: function() { s.reduceMotion = !s.reduceMotion; saveSettings(); } },
        { label: 'Fundo do in\u00edcio', value: s.background === 'plain' ? 'Escuro' : 'Arte do jogo', act: function() {
          s.background = s.background === 'plain' ? 'art' : 'plain';
          saveSettings();
          if (state.home) state.home.rebuild();
        } },
        { label: 'Tela "Quem vai jogar?" ao abrir', value: onOff(s.whoScreen), act: function() { s.whoScreen = !s.whoScreen; saveSettings(); } },
        { label: 'Ordem da biblioteca', value: s.sort === 'az' ? 'A-Z' : 'Mais recentes', act: function() { s.sort = s.sort === 'az' ? 'recent' : 'az'; saveSettings(); } },
      ]; } },
      { id: 'pc', name: 'PC e conex\u00e3o', icon: 'pc', options: function() { return [
        { label: 'PC', value: pcName() },
        { label: 'Endere\u00e7o', value: state.base.replace('http://', '') },
        { label: 'Status', value: 'Conectado' },
        { label: 'Atualizar biblioteca', act: function() {
          refreshLibrary().then(function() { toast('Biblioteca atualizada', allGames().length + ' itens', 'check'); });
        } },
        { label: 'Trocar de PC', act: leaveToHosts },
        { label: 'Energia do PC', value: 'Repouso, reiniciar, desligar', act: function() { openPowerMenu({ x: 900, y: 300, title: 'Energia' }); } },
        { label: 'Configura\u00e7\u00f5es de streaming', value: 'Moonlight', act: function() { hide(); window.showSettingsMode(); } },
      ]; } },
      { id: 'armazenamento', name: 'Armazenamento', icon: 'drive', storage: true },
      { id: 'downloads', name: 'Downloads', icon: 'download', options: function() {
        var n = activeDownloads().length;
        var out = [{ label: 'Abrir Downloads', value: n ? n + ' em andamento' : '', act: function() { openDownloads(); } }];
        (state.stores || []).forEach(function(st) {
          out.push({ label: st.name, value: st.ready ? 'Pronta' : (st.note || 'Indispon\u00edvel') });
        });
        out.push({ label: 'Hydra', value: hydraApp() ? 'Abre no PC (Big Picture)' : 'N\u00e3o configurado' });
        return out;
      } },
      { id: 'conta', name: 'Conta e perfil', icon: 'user', options: function() {
        var pr = profile();
        return [
          { label: 'Nome', value: pr.name },
          { label: 'Avatar', value: s.avatar ? 'Capa de jogo' : 'Padr\u00e3o', act: openAvatarPicker },
          { label: 'Steam', value: pr.steam ? pr.steam.name + (pr.steam.level ? '  \u00b7  n\u00edvel ' + pr.steam.level : '') : 'N\u00e3o conectada' },
          { label: 'RetroAchievements', value: pr.ra ? pr.ra.user + '  \u00b7  ' + pr.ra.points + ' pts' : 'N\u00e3o conectado' },
        ];
      } },
      { id: 'sobre', name: 'Sobre', icon: 'info', options: function() { return [
        { label: 'Play TV', value: 'Vers\u00e3o ' + VERSION },
        { label: 'Streaming', value: 'Moonlight Tizen (GPL-3.0)' },
        { label: 'Fonte', value: 'Inter (SIL OFL)' },
        { label: 'Sair do Play TV', act: exitApp },
      ]; } },
    ];
  }

  function openSettings(startId) {
    var p = newPage('tvg-settings');
    stage(p, 'spot');
    var title = add(p.el, el('div', 'tvg-head-title tvg-set-title', 'Configura\u00e7\u00f5es'));
    var cats = settingsCategories();
    var mode = 'root'; // 'root' | 'cats' | 'opts'
    var ci = 0;
    var oi = 0;
    var opts = [];
    var optEls = [];
    var rootList = add(p.el, el('div', 'tvg-set-root'));
    var rootEls = cats.map(function(c, i) {
      var r = add(rootList, el('div', 'tvg-set-item'));
      r.appendChild(icon(c.icon));
      r.appendChild(el('span', null, c.name));
      r.addEventListener('click', function() { ci = i; openCat(); });
      return r;
    });
    var two = add(p.el, el('div', 'tvg-set-two'));
    var left = add(two, el('div', 'tvg-set-left'));
    var right = add(two, el('div', 'tvg-set-right'));
    var leftEls = cats.map(function(c) { return add(left, el('div', 'tvg-set-cat', c.name)); });
    p.el.appendChild(hints([['OK', 'Selecionar'], ['Voltar', 'Voltar']]));

    function renderOpts() {
      right.innerHTML = '';
      var c = cats[ci];
      title.textContent = mode === 'root' ? 'Configura\u00e7\u00f5es' : c.name;
      leftEls.forEach(function(e, i) { e.classList.toggle('tvg-selected', i === ci); });
      opts = [];
      optEls = [];
      if (c.storage) { storagePane(right); return; }
      opts = c.options();
      optEls = opts.map(function(o, i) {
        var r = add(right, el('div', 'tvg-set-opt' + (o.act ? '' : ' tvg-static')));
        r.appendChild(el('span', null, o.label));
        r.appendChild(el('span', 'tvg-set-val', o.value || (o.act ? '\u203a' : '')));
        r.addEventListener('click', function() { mode = 'opts'; oi = i; act(); });
        return r;
      });
    }

    function focus() {
      p.el.classList.toggle('tvg-set-sub', mode !== 'root');
      if (mode === 'root') setFocus(p, rootEls[ci]);
      else if (mode === 'cats') setFocus(p, leftEls[ci]);
      else setFocus(p, optEls[oi]);
    }

    function openCat() {
      mode = 'cats';
      renderOpts();
      if (optEls.length) { mode = 'opts'; oi = 0; }
      focus();
    }

    function act() {
      var o = opts[oi];
      if (!o || !o.act) return;
      o.act();
      if (topPage() === p) { renderOpts(); focus(); }
    }

    p.keys = {
      up: function() {
        if (mode === 'root' && ci > 0) ci--;
        else if (mode === 'cats' && ci > 0) { ci--; renderOpts(); }
        else if (mode === 'opts' && oi > 0) oi--;
        focus();
      },
      down: function() {
        if (mode === 'root' && ci < cats.length - 1) ci++;
        else if (mode === 'cats' && ci < cats.length - 1) { ci++; renderOpts(); }
        else if (mode === 'opts' && oi < optEls.length - 1) oi++;
        focus();
      },
      left: function() { if (mode === 'opts') { mode = 'cats'; focus(); } },
      right: function() { if (mode === 'cats' && optEls.length) { mode = 'opts'; oi = 0; focus(); } },
      accept: function() {
        if (mode === 'root') openCat();
        else if (mode === 'cats') { if (optEls.length) { mode = 'opts'; oi = 0; focus(); } }
        else act();
      },
      back: function() {
        if (mode === 'root') { pop(p); return; }
        mode = 'root';
        title.textContent = 'Configura\u00e7\u00f5es';
        focus();
      },
    };
    p.onReturn = function() { if (mode !== 'root') { renderOpts(); focus(); } };
    loadStores();
    push(p);
    if (startId) {
      cats.forEach(function(c, i) { if (c.id === startId) ci = i; });
      openCat();
    } else {
      focus();
    }
    return p;
  }

  /** The PC's drives, as thin segmented bars. */
  function storagePane(box) {
    box.appendChild(el('div', 'tvg-sec-title', 'Discos do PC'));
    var holder = add(box, el('div', 'tvg-storage'));
    holder.appendChild(el('div', 'tvg-empty-sub', 'Carregando...'));
    request('GET', '/api/system').then(function(sys) {
      holder.innerHTML = '';
      var drives = (sys && sys.drives) || [];
      drives.forEach(function(d) { holder.appendChild(driveRow(d)); });
      if (!drives.length) holder.appendChild(el('div', 'tvg-empty-sub', 'O PC n\u00e3o informou nenhum disco.'));
    }, function() {
      holder.innerHTML = '';
      holder.appendChild(el('div', 'tvg-empty-sub', 'Atualize o tvgames no PC para ver os discos.'));
    });
  }

  function driveRow(d, extra) {
    var r = el('div', 'tvg-drive');
    var top = add(r, el('div', 'tvg-drive-top'));
    top.appendChild(icon('drive'));
    top.appendChild(el('span', 'tvg-drive-name', d.label || d.path));
    if (d.total_bytes) top.appendChild(el('span', 'tvg-drive-free', bytes(d.free_bytes) + ' livres de ' + bytes(d.total_bytes)));
    var bar = add(r, el('div', 'tvg-seg'));
    var used = d.total_bytes ? (d.total_bytes - d.free_bytes) / d.total_bytes : 0;
    add(bar, el('i', 'tvg-seg-used')).style.width = Math.round(used * 100) + '%';
    if (extra && d.total_bytes) add(bar, el('i', 'tvg-seg-new')).style.width = Math.max(1, Math.min(100, Math.round(extra / d.total_bytes * 100))) + '%';
    if (d.path) r.appendChild(el('div', 'tvg-drive-path', d.path + (d['new'] ? '   (pasta nova, ser\u00e1 criada)' : '')));
    return r;
  }

  // =========================================================== DOWNLOADS --

  function activeDownloads() {
    return state.downloads.filter(function(d) { return d.state !== 'done' && d.state !== 'error'; });
  }

  function loadStores() {
    return request('GET', '/api/stores').then(function(s) {
      state.stores = s || [];
      return state.stores;
    }, function() {
      state.stores = null;
      return null;
    });
  }

  function pollDownloads() {
    clearTimeout(state.dlTimer);
    if (!state.active) return;
    function schedule() {
      var fast = state.dlFast || activeDownloads().length > 0;
      state.dlTimer = setTimeout(pollDownloads, fast ? DL_POLL_FAST_MS : DL_POLL_SLOW_MS);
    }
    request('GET', '/api/downloads').then(function(list) {
      var before = {};
      state.downloads.forEach(function(d) { before[d.store + ':' + d.id] = d.state; });
      state.downloads = list || [];
      var finished = false;
      state.downloads.forEach(function(d) {
        var was = before[d.store + ':' + d.id];
        if (was && was !== 'done' && d.state === 'done') {
          finished = true;
          toast('Pronto para jogar', d.title + ' foi instalado e j\u00e1 est\u00e1 na biblioteca', 'check');
        } else if (was && was !== 'error' && d.state === 'error') {
          toast('Erro no download', d.title + (d.error ? ': ' + d.error : ''), 'x');
        }
      });
      if (finished) refreshLibrary();
      updateDlBadge();
      if (state.dlPage) state.dlPage.refresh();
      schedule();
    }, schedule);
  }

  function updateDlBadge() {
    var h = state.home;
    if (!h) return;
    var n = activeDownloads().length;
    h.dlBadge.textContent = n ? String(n) : '';
    h.dlBadge.style.display = n ? '' : 'none';
  }

  function dlStateText(d) {
    var pct = Math.floor((d.progress || 0) * 100);
    if (d.state === 'queued') return 'Na fila';
    if (d.state === 'installing') return 'Instalando  ' + pct + '%';
    if (d.state === 'done') return 'Instalado';
    if (d.state === 'error') return 'Erro' + (d.error ? ': ' + d.error : '');
    var bits = ['Baixando  ' + pct + '%'];
    if (d.bytes_total) bits.push(bytes(d.bytes_done || 0) + ' de ' + bytes(d.bytes_total));
    if (d.speed_bps) bits.push(bytes(d.speed_bps) + '/s');
    if (d.eta_s) bits.push(duration(d.eta_s) + ' restantes');
    return bits.join('  \u00b7  ');
  }

  function storeName(id) { return id === 'epic' ? 'Epic Games' : id === 'steam' ? 'Steam' : id; }

  function openDownloads(startTab) {
    var p = newPage('tvg-dl');
    stage(p, 'waves');
    pageHead(p, 'download', 'Downloads');
    var tabsRow = add(p.el, el('div', 'tvg-tabs tvg-page-tabs'));
    var TABS = [
      { id: 'queue', name: 'Em andamento' },
      { id: 'steam', name: 'Steam' },
      { id: 'epic', name: 'Epic Games' },
      { id: 'hydra', name: 'Hydra' },
    ];
    var tabEls = TABS.map(function(t) {
      var e = add(tabsRow, el('div', 'tvg-tab', t.name));
      t.sup = add(e, el('sup'));
      return e;
    });
    var content = add(p.el, el('div', 'tvg-dl-content'));
    var hintBox = add(p.el, el('div'));
    var tab = startTab === undefined ? (activeDownloads().length ? 0 : 1) : 0;
    TABS.forEach(function(t, i) { if (t.id === startTab) tab = i; });
    var zone = 'content';
    var idx = 0;
    var items = []; // { el, act }
    var COLS = 6;
    var cache = {};
    var layout = 'list';

    function setHints(list) {
      hintBox.innerHTML = '';
      hintBox.appendChild(hints(list));
    }

    function fill() {
      tabEls.forEach(function(e, i) { e.classList.toggle('tvg-selected', i === tab); });
      var n = activeDownloads().length;
      TABS[0].sup.textContent = n ? String(n) : '';
      content.innerHTML = '';
      items = [];
      p.grid = null;
      p.list = null;
      var id = TABS[tab].id;
      state.dlFast = id === 'queue';
      if (id === 'queue') queueTab();
      else if (id === 'hydra') hydraTab();
      else storeTab(id);
      idx = Math.min(idx, Math.max(0, items.length - 1));
      if (!items.length) zone = 'tabs';
      focus();
    }

    function emptyState(title, sub, btnLabel, act) {
      var e = add(content, el('div', 'tvg-empty tvg-empty-center'));
      e.appendChild(el('div', 'tvg-empty-title', title));
      if (sub) e.appendChild(el('div', 'tvg-empty-sub', sub));
      if (btnLabel) {
        var b = add(e, el('div', 'tvg-pill', btnLabel));
        items.push({ el: b, act: act });
        b.addEventListener('click', act);
      }
    }

    function queueTab() {
      layout = 'list';
      var order = { downloading: 0, installing: 1, queued: 2, error: 3, done: 4 };
      var list = state.downloads.slice().sort(function(a, b) { return (order[a.state] || 0) - (order[b.state] || 0); });
      setHints([['OK', 'Op\u00e7\u00f5es'], ['Voltar', 'In\u00edcio']]);
      if (!list.length) {
        emptyState('Nenhum download em andamento', 'Escolha um jogo da sua conta Steam ou Epic Games para instalar no PC.', 'Ver jogos da Steam', function() { tab = 1; idx = 0; fill(); });
        return;
      }
      var l = add(add(content, el('div', 'tvg-list-box tvg-dl-list')), el('div', 'tvg-list'));
      list.forEach(function(d) {
        var r = add(l, el('div', 'tvg-trow tvg-dlrow tvg-dl-' + d.state));
        var cov = add(r, el('div', 'tvg-trow-cover'));
        if (d.cover) cov.appendChild(img(d.cover));
        var mid = add(r, el('div', 'tvg-trow-main'));
        mid.appendChild(el('div', 'tvg-trow-title', d.title));
        var line = add(mid, el('div', 'tvg-dl-line'));
        line.appendChild(el('span', 'tvg-chip', storeName(d.store)));
        line.appendChild(el('span', 'tvg-dl-state', dlStateText(d)));
        mid.appendChild(thinBar(Math.floor((d.progress || 0) * 100), 'tvg-dl-bar'));
        items.push({ el: r, act: function() { downloadOptions(d); } });
      });
      p.list = l;
    }

    function downloadOptions(d) {
      if (d.state === 'done') {
        var g = allGames().filter(function(x) { return fold(x.title) === fold(d.title); })[0];
        if (g) play(g);
        else refreshLibrary().then(function() { toast('Biblioteca atualizada', d.title, 'check'); });
        return;
      }
      if (d.state === 'error') {
        openDialog('Erro no download', d.title + (d.error ? ': ' + d.error : ''), [{ label: 'OK' }]);
        return;
      }
      openDialog('Cancelar o download?', d.title, [
        { label: 'Continuar baixando' },
        { label: 'Cancelar download', act: function() {
          request('POST', '/api/downloads/' + d.store + '/' + encodeURIComponent(d.id) + '/cancel', {}).then(function() {
            toast('Download cancelado', d.title, 'x');
            pollDownloads();
          }, function() { toast('N\u00e3o deu para cancelar', d.title, 'x'); });
        } },
      ]);
    }

    function hydraTab() {
      layout = 'list';
      var hero = add(content, el('div', 'tvg-dl-hydra'));
      hero.appendChild(el('div', 'tvg-dl-big', 'Baixe pelo Hydra no PC'));
      hero.appendChild(el('div', 'tvg-empty-sub', 'Abre o Hydra em tela cheia (Big Picture) no PC. Use o controle para escolher e baixar. Quando terminar, o jogo aparece no Play TV sozinho.'));
      var b = add(hero, el('div', 'tvg-pill tvg-primary', 'Abrir Hydra'));
      var act = function() {
        var app = hydraApp();
        if (app) play(app);
        else toast('Hydra n\u00e3o configurado', 'Atualize o tvgames no PC', 'x');
      };
      b.addEventListener('click', act);
      items.push({ el: b, act: act });
      setHints([['OK', 'Abrir'], ['Voltar', 'In\u00edcio']]);
    }

    function storeTab(id) {
      layout = 'grid';
      setHints([['OK', 'Instalar'], ['Voltar', 'In\u00edcio']]);
      if (state.stores === undefined) {
        content.appendChild(el('div', 'tvg-empty-sub tvg-dl-wait', 'Conectando...'));
        return;
      }
      if (state.stores === null) {
        emptyState('Downloads indispon\u00edveis', 'O tvgames do PC ainda n\u00e3o tem a parte de downloads. Atualize-o.', null);
        return;
      }
      var st = state.stores.filter(function(s) { return s.id === id; })[0];
      if (!st || !st.ready) {
        emptyState(storeName(id) + ' n\u00e3o est\u00e1 pronta no PC', (st && st.note) || '', 'Tentar de novo', function() {
          loadStores().then(function() { delete cache[id]; fill(); });
        });
        return;
      }
      if (!cache[id]) {
        // Skeleton tiles while the list loads.
        var sk = add(add(content, el('div', 'tvg-grid-box tvg-dl-grid')), el('div', 'tvg-grid tvg-grid-6 tvg-skeleton'));
        for (var i = 0; i < 12; i++) sk.appendChild(el('div', 'tvg-gtile'));
        cache[id] = 'loading';
        request('GET', '/api/store/' + id + '/games', undefined, null, 60000).then(function(list) {
          cache[id] = list || [];
          if (TABS[tab].id === id && state.dlPage === p) fill();
        }, function() {
          cache[id] = 'error';
          if (TABS[tab].id === id && state.dlPage === p) fill();
        });
        return;
      }
      if (cache[id] === 'loading') return;
      if (cache[id] === 'error') {
        emptyState('N\u00e3o deu para carregar seus jogos', 'Veja se a ' + storeName(id) + ' est\u00e1 logada no PC.', 'Tentar de novo', function() { delete cache[id]; fill(); });
        return;
      }
      var games = cache[id];
      add(content, el('div', 'tvg-lib-meta tvg-dl-meta')).appendChild(el('span', null, 'Na sua conta e n\u00e3o instalados: ' + games.length));
      if (!games.length) {
        emptyState('Todos os seus jogos j\u00e1 est\u00e3o instalados', '', null);
        return;
      }
      var grid = add(add(content, el('div', 'tvg-grid-box tvg-dl-grid')), el('div', 'tvg-grid tvg-grid-6'));
      games.forEach(function(g) {
        var t = add(grid, el('div', 'tvg-gtile'));
        t.appendChild(el('div', 'tvg-placeholder', g.title));
        if (g.cover) t.appendChild(img(g.cover, 'tvg-cover', true));
        var over = add(t, el('div', 'tvg-gtile-over'));
        if (g.size_bytes) over.appendChild(el('div', 'tvg-chip', bytes(g.size_bytes)));
        over.appendChild(el('div', 'tvg-gtile-name', g.title));
        var busy = state.downloads.filter(function(d) { return d.store === id && String(d.id) === String(g.id) && d.state !== 'error'; })[0];
        if (busy) t.appendChild(el('div', 'tvg-gtile-flag', busy.state === 'done' ? 'Instalado' : 'Baixando'));
        var act = function() { chooseFolder(id, g); };
        t.addEventListener('click', act);
        items.push({ el: t, act: act });
      });
      p.grid = grid;
    }

    function focus() {
      setFocus(p, zone === 'tabs' || !items[idx] ? tabEls[tab] : items[idx].el);
      if (layout === 'grid' && p.grid && zone === 'tabs') {
        for (var j = 0; j < Math.min(items.length, COLS * 3); j++) loadLazy(items[j].el);
      }
      if (zone === 'tabs') return;
      if (layout === 'grid' && p.grid) {
        var rowI = Math.floor(idx / COLS);
        p.grid.style.transform = 'translate3d(0,' + (-Math.max(0, rowI - 1) * 346) + 'px,0)';
        for (var i = Math.max(0, (rowI - 1) * COLS); i < Math.min(items.length, (rowI + 3) * COLS); i++) loadLazy(items[i].el);
      } else if (p.list) {
        p.list.style.transform = 'translate3d(0,' + (-Math.max(0, idx - 3) * 150) + 'px,0)';
      }
    }

    function move(dir) {
      if (zone === 'tabs') {
        if (dir === 'left' && tab > 0) { tab--; idx = 0; fill(); return; }
        if (dir === 'right' && tab < TABS.length - 1) { tab++; idx = 0; fill(); return; }
        if (dir === 'down' && items.length) zone = 'content';
        focus();
        return;
      }
      if (layout === 'grid' && p.grid) {
        var n = gridMove(idx, items.length, COLS, dir);
        if (n >= 0) idx = n;
        else if (dir === 'up') zone = 'tabs';
      } else if (dir === 'down' && idx < items.length - 1) idx++;
      else if (dir === 'up') { if (idx > 0) idx--; else zone = 'tabs'; }
      focus();
    }

    p.keys = {
      up: function() { move('up'); },
      down: function() { move('down'); },
      left: function() { move('left'); },
      right: function() { move('right'); },
      accept: function() {
        if (zone === 'tabs') { if (items.length) { zone = 'content'; focus(); } return; }
        if (items[idx]) items[idx].act();
      },
    };
    p.refresh = function() {
      if (TABS[tab].id === 'queue') {
        var keep = idx;
        var z = zone;
        fill();
        idx = Math.min(keep, Math.max(0, items.length - 1));
        if (items.length) zone = z;
        focus();
      } else {
        var n = activeDownloads().length;
        TABS[0].sup.textContent = n ? String(n) : '';
      }
    };
    p.goQueue = function() { tab = 0; idx = 0; zone = 'content'; fill(); };
    p.onClose = function() { if (state.dlPage === p) state.dlPage = null; state.dlFast = false; };
    state.dlPage = p;
    if (!state.stores) loadStores().then(function() { if (state.dlPage === p) fill(); });
    fill();
    push(p);
    pollDownloads();
    return p;
  }

  /** Before every download: where to install it. */
  function chooseFolder(store, g) {
    var p = newPage('tvg-folder');
    stage(p, 'spot');
    var head = add(p.el, el('div', 'tvg-folder-head'));
    var cov = add(head, el('div', 'tvg-folder-cover'));
    if (g.cover) cov.appendChild(img(g.cover));
    var t = add(head, el('div'));
    t.appendChild(el('div', 'tvg-kicker', 'INSTALAR NO PC  \u00b7  ' + storeName(store).toUpperCase()));
    t.appendChild(el('div', 'tvg-head-title', g.title));
    t.appendChild(el('div', 'tvg-empty-sub', 'Onde voc\u00ea quer instalar?' + (g.size_bytes ? '  Precisa de ' + bytes(g.size_bytes) + '.' : '')));
    var box = add(p.el, el('div', 'tvg-folder-list'));
    box.appendChild(el('div', 'tvg-empty-sub', 'Carregando pastas do PC...'));
    p.el.appendChild(hints([['OK', 'Instalar aqui'], ['Voltar', 'Cancelar']]));
    var rows = [];
    var dirs = [];
    var idx = 0;
    var busy = false;
    function focus() {
      setFocus(p, rows[idx]);
      box.style.transform = 'translate3d(0,' + (-Math.max(0, idx - 3) * 150) + 'px,0)';
    }
    p.keys = {
      up: function() { if (idx > 0) { idx--; focus(); } },
      down: function() { if (idx < rows.length - 1) { idx++; focus(); } },
      left: noop,
      right: noop,
      accept: function() {
        var d = dirs[idx];
        if (!d || busy) return;
        if (g.size_bytes && d.free_bytes && d.free_bytes < g.size_bytes) {
          toast('Sem espa\u00e7o suficiente', d.label || d.path, 'x');
          return;
        }
        busy = true;
        var row = rows[idx];
        row.classList.add('tvg-busy');
        request('POST', '/api/install', { store: store, id: g.id, dir: d.path }, null, 60000).then(function(r) {
          busy = false;
          row.classList.remove('tvg-busy');
          if (r && r.ok === false) {
            toast('N\u00e3o deu para instalar', r.error || '', 'x');
            return;
          }
          pop(p);
          toast('Download iniciado', g.title + '  \u2192  ' + (d.label || d.path), 'download');
          if (state.dlPage) state.dlPage.goQueue();
          pollDownloads();
        }, function(e) {
          busy = false;
          row.classList.remove('tvg-busy');
          toast('N\u00e3o deu para instalar', e.message, 'x');
        });
      },
    };
    push(p);
    request('GET', '/api/install-dirs?store=' + encodeURIComponent(store)).then(function(list) {
      dirs = list || [];
      box.innerHTML = '';
      rows = dirs.map(function(d, i) {
        var r = add(box, driveRow(d, g.size_bytes));
        r.classList.add('tvg-folder-row');
        if (g.size_bytes && d.free_bytes && d.free_bytes < g.size_bytes) r.classList.add('tvg-nospace');
        r.addEventListener('click', function() { idx = i; p.keys.accept(); });
        return r;
      });
      if (!rows.length) box.appendChild(el('div', 'tvg-empty-sub', 'O PC n\u00e3o informou nenhuma pasta.'));
      focus();
    }, function() {
      box.innerHTML = '';
      box.appendChild(el('div', 'tvg-empty-sub', 'N\u00e3o deu para ler as pastas do PC.'));
    });
    return p;
  }

  // ========================================================== QUICK MENU --
  // Over the home: recent games as cards, a bar of icons, popovers.

  function openQuick() {
    var tp = topPage();
    if (tp && tp.quick) { pop(tp); return tp; }
    var p = newPage('tvg-quick');
    p.cover = false;
    p.quick = true;
    p.el.appendChild(el('div', 'tvg-quick-dim'));
    var cardsBox = add(p.el, el('div', 'tvg-quick-cards'));
    var games = sortGames(allGames().filter(function(g) { return state.recent.indexOf(g.id) >= 0; }), 'recent').slice(0, 6);
    var cards = games.map(function(g) {
      var c = add(cardsBox, el('div', 'tvg-qcard'));
      if (g.hero || g.cover) c.appendChild(img(g.hero || g.cover));
      var t = add(c, el('div', 'tvg-qcard-text'));
      t.appendChild(el('div', 'tvg-lv-label', isRunning(g) ? 'Aberto agora' : 'Jogado recentemente'));
      t.appendChild(el('div', 'tvg-qcard-title', g.title));
      return { el: c, act: function() { pop(p); play(g); } };
    });
    var bar = add(p.el, el('div', 'tvg-quick-bar'));
    var running = allGames().filter(isRunning)[0];
    var BTN = [{ icon: 'home', label: 'In\u00edcio', act: function() { popToHome(); } }];
    if (running) {
      BTN.push({ icon: 'play', label: running.title, act: function() {
        popover(1, [
          { label: 'Voltar ao jogo', act: function() { pop(p); play(running); } },
          { label: 'Fechar jogo', act: function() { pop(p); closeGame(running); } },
        ]);
      } });
    }
    BTN.push({ icon: 'download', label: 'Downloads', badge: activeDownloads().length, act: function() { pop(p); openDownloads('queue'); } });
    BTN.push({ icon: 'medal', label: 'Conquistas', act: function() { pop(p); openTrophyList(); } });
    BTN.push({ icon: 'search', label: 'Buscar', act: function() { pop(p); openSearch(); } });
    BTN.push({ icon: 'user', label: 'Perfil', act: function() { pop(p); openProfile(); } });
    BTN.push({ icon: 'gear', label: 'Configura\u00e7\u00f5es', act: function() { pop(p); openSettings(); } });
    BTN.push({ icon: 'power', label: 'Energia', act: function() {
      popover(BTN.length - 1, powerItems(function() { pop(p); }));
    } });
    var btnEls = BTN.map(function(b) {
      var e = add(bar, el('div', 'tvg-qbtn'));
      e.appendChild(icon(b.icon));
      e.appendChild(el('span', 'tvg-qbtn-label', b.label));
      if (b.badge) e.appendChild(el('span', 'tvg-badge-count', String(b.badge)));
      return e;
    });
    var zone = 'bar';
    var bi = 0;
    var ci = 0;
    var pop2 = null;
    function popover(at, list) {
      var box = add(p.el, el('div', 'tvg-menu tvg-qpop'));
      box.style.left = Math.max(40, btnEls[at].offsetLeft + bar.offsetLeft - 140) + 'px';
      var els = list.map(function(it) { return add(box, el('div', 'tvg-menu-item', it.label)); });
      pop2 = { box: box, els: els, list: list, i: 0 };
      setFocus(p, els[0]);
    }
    function closePop() {
      if (pop2 && pop2.box.parentNode) pop2.box.parentNode.removeChild(pop2.box);
      pop2 = null;
      focus();
    }
    function focus() { setFocus(p, zone === 'bar' ? btnEls[bi] : cards[ci].el); }
    p.keys = {
      left: function() {
        if (pop2) return;
        if (zone === 'bar' && bi > 0) bi--;
        else if (zone === 'cards' && ci > 0) ci--;
        focus();
      },
      right: function() {
        if (pop2) return;
        if (zone === 'bar' && bi < btnEls.length - 1) bi++;
        else if (zone === 'cards' && ci < cards.length - 1) ci++;
        focus();
      },
      up: function() {
        if (pop2) { if (pop2.i > 0) setFocus(p, pop2.els[--pop2.i]); return; }
        if (zone === 'bar' && cards.length) { zone = 'cards'; focus(); }
      },
      down: function() {
        if (pop2) { if (pop2.i < pop2.els.length - 1) setFocus(p, pop2.els[++pop2.i]); return; }
        if (zone === 'cards') { zone = 'bar'; focus(); }
      },
      accept: function() {
        if (pop2) { var it = pop2.list[pop2.i]; closePop(); it.act(); return; }
        if (zone === 'bar') BTN[bi].act();
        else cards[ci].act();
      },
      back: function() { if (pop2) closePop(); else pop(p); },
      menu: function() { pop(p); },
    };
    focus();
    push(p);
    return p;
  }

  // ============================================================ PLAYING --

  function play(g) {
    if (!state.host || !g) return;
    rememberPlayed(g.id);
    var host = state.host;
    state.launching = g;
    // Resolve the id from Moonlight's own app list by name (same list the
    // stream uses); fall back to the id computed by tvgames.
    var go = function(id) {
      state.launchAppId = id;
      startGame(host, id);
    };
    if (host.getAppByName) {
      host.getAppByName(g.app_name).then(function(app) {
        go(app ? app.id : parseInt(g.app_id, 10));
      }, function() { go(parseInt(g.app_id, 10)); });
    } else {
      go(parseInt(g.app_id, 10));
    }
  }

  // -------------------------------------------------------------- sounds --

  function playSound(name) {
    if (!state.settings.sounds) return;
    try {
      var a = new Audio(SOUND_DIR + name);
      a.volume = 0.8;
      var pr = a.play();
      if (pr && pr.catch) pr.catch(noop);
    } catch (e) { /* no sound is fine */ }
  }

  // -------------------------------------------------------------- splash --

  var splashStart = Date.now();

  function hideSplash() {
    var d = document.getElementById('playtv-splash');
    if (!d || d.getAttribute('data-out')) return;
    d.setAttribute('data-out', '1');
    setTimeout(function() {
      d.className += ' pts-out';
      setTimeout(function() { if (d.parentNode) d.parentNode.removeChild(d); }, 600);
    }, Math.max(0, SPLASH_MIN_MS - (Date.now() - splashStart)));
  }

  // ------------------------------------------------------- launch screen --
  // The game's art stays full screen, its name comes in big in the middle and
  // a small Play TV mark spins at the bottom until the stream is up.

  function launchHold(g, resuming) {
    if (resuming) return HOLD_RESUME_MS;
    if (!g) return HOLD_PC_MS;
    if (g.launcher) return HOLD_EMULATOR_MS;
    return PC_CATEGORIES.indexOf(String(g.category || '').toLowerCase()) !== -1 ? HOLD_PC_MS : HOLD_EMULATOR_MS;
  }

  function showLaunch() {
    var g = state.launching;
    var host = state.host;
    var resuming = !!(host && state.launchAppId && String(host.currentGame) === String(state.launchAppId));
    hideLaunch(true);
    var o = el('div');
    o.id = 'playtv-launch';
    if (g && (g.hero || g.cover)) o.appendChild(img(g.hero || g.cover, 'ptl-bg' + (g.hero ? ' ptl-wide' : '')));
    o.appendChild(el('div', 'ptl-shade'));
    if (g) {
      var info = add(o, el('div', 'ptl-game'));
      var t = add(info, el('div', 'ptl-title', g.title));
      if (g.logo) {
        var lg = img(g.logo, 'ptl-logo-img');
        lg.onload = function() { info.classList.add('ptl-has-logo'); };
        lg.onerror = function() { if (lg.parentNode) lg.parentNode.removeChild(lg); };
        info.insertBefore(lg, t);
      }
      info.appendChild(el('div', 'ptl-label', resuming ? 'Voltando ao jogo' : 'Iniciando'));
    }
    var mark = add(o, el('div', 'ptl-mark'));
    mark.appendChild(el('div', 'ptl-ring'));
    var word = add(mark, el('div', 'ptl-word'));
    word.appendChild(el('span', null, 'PL'));
    word.appendChild(el('span', 'ptl-lambda', LAMBDA));
    word.appendChild(el('span', null, 'Y'));
    word.appendChild(el('span', 'ptl-tv', 'TV'));
    document.body.appendChild(o);
    document.body.classList.add('playtv-launching');
    state.launch = { el: o, hold: launchHold(g, resuming), timer: 0, connected: false };
    state.launch.timer = setTimeout(function() { hideLaunch(); }, LAUNCH_FAILSAFE_MS);
    playSound('playtv-launch.wav');
  }

  function hideLaunch(now) {
    var l = state.launch;
    if (!l) return;
    state.launch = null;
    clearTimeout(l.timer);
    document.body.classList.remove('playtv-launching');
    if (now) {
      if (l.el.parentNode) l.el.parentNode.removeChild(l.el);
      return;
    }
    l.el.className += ' ptl-out';
    setTimeout(function() { if (l.el.parentNode) l.el.parentNode.removeChild(l.el); }, 500);
  }

  /** Follows Moonlight's stream messages to know when the game is on screen. */
  function onStreamMessage(msg) {
    var l = state.launch;
    if (!l || typeof msg !== 'string') return;
    if (msg === 'Connection Established') {
      l.connected = true;
      clearTimeout(l.timer);
      l.timer = setTimeout(function() { hideLaunch(); }, l.hold);
    } else if (msg.indexOf('streamTerminated: ') === 0) {
      hideLaunch(true);
    }
  }

  // ---------------------------------------------------------- navigation --

  function hookNavigation() {
    var apps = Views.Apps;
    ['up', 'down', 'left', 'right', 'accept', 'back', 'switch', 'enter', 'leave'].forEach(function(name) {
      var original = apps[name];
      apps[name] = function() {
        if (state.active) {
          if (name === 'switch' || name === 'enter' || name === 'leave') return undefined;
          if (dispatch(name)) return undefined;
        }
        return original.apply(this, arguments);
      };
    });
    // Gamepad extras (Moonlight only maps A, B and the D-pad): Y = options of
    // the focused item, Start / Select = quick menu.
    window.addEventListener('gamepadinputchanged', function(e) {
      if (!state.active || window.isInGame || !e.detail || !e.detail.changes) return;
      e.detail.changes.forEach(function(c) {
        if (c.type !== 'button' || !c.pressed) return;
        if (c.index === 3) dispatch('option');
        else if (c.index === 9 || c.index === 8) { if (!dispatch('menu')) openQuick(); }
      });
    });
    // Letters typed on a keyboard go to the search page.
    document.addEventListener('keydown', function(e) {
      var p = topPage();
      if (state.active && p && p.onKey && !window.isInGame && p.onKey(e)) e.preventDefault();
    }, true);
  }

  function show(host, library) {
    hideSplash();
    hideLaunch(true);
    state.host = host;
    state.base = apiBase(host);
    state.library = library;
    state.active = true;
    applySettings();
    if (window.showAppsMode) showAppsMode();
    $('#game-grid').hide();
    $('#header-title').html('Play TV');
    var r = root();
    $(r).show();
    document.body.classList.add('tvgames-active');
    if (!state.home || !state.home.page.el.parentNode) {
      r.innerHTML = '';
      state.pages = [];
      var hp = buildHome();
      r.appendChild(hp.el);
      state.pages.push(hp);
    } else {
      popToHome();
      state.home.rebuild();
    }
    if (!state.whoShown && state.settings.whoScreen) openWho();
    state.whoShown = true;
    clearInterval(state.clockTimer);
    state.clockTimer = setInterval(updateClock, 20000);
    updateClock();
    loadStores();
    pollDownloads();
  }

  function hide() {
    state.active = false;
    clearInterval(state.clockTimer);
    clearTimeout(state.dlTimer);
    $('#tvgames-view').hide();
    document.body.classList.remove('tvgames-active');
  }

  // --------------------------------------------------------------- hooks --

  function install() {
    var originalShowApps = showApps;
    showApps = function(host) {
      if (!host || !host.paired) return originalShowApps(host);
      return fetchLibrary(apiBase(host)).then(function(library) {
        show(host, library);
      }, function(err) {
        console.warn('[tvgames] library not available (' + err.message + '), showing Moonlight apps');
        hide();
        hideSplash();
        return originalShowApps(host);
      });
    };

    ['showHostsMode', 'showSettingsMode'].forEach(function(name) {
      var original = window[name];
      window[name] = function() {
        hide();
        hideSplash();
        var r = original.apply(this, arguments);
        $('#header-logo').hide();
        return r;
      };
    });

    // Play TV launch screen: shown when Moonlight enters stream mode, removed
    // once the stream is up (plus a hold that hides the PC desktop).
    var originalStreamMode = window.showStreamMode;
    window.showStreamMode = function() {
      var r = originalStreamMode.apply(this, arguments);
      try { showLaunch(); } catch (e) { console.error('[tvgames] launch screen', e); }
      return r;
    };
    var originalHandleMessage = window.handleMessage;
    window.handleMessage = function(msg) {
      try { onStreamMessage(msg); } catch (e) { /* never break the stream */ }
      return originalHandleMessage.apply(this, arguments);
    };
    // Any key skips the hold once the stream is connected.
    document.addEventListener('keydown', function() {
      if (state.launch && state.launch.connected) hideLaunch();
    }, true);

    $('#header-logo').hide();
    applySettings();
    if (document.getElementById('playtv-splash')) playSound('playtv-start.wav');
    setTimeout(hideSplash, SPLASH_MAX_MS);

    // Open the last used PC straight into Play TV at startup.
    var originalRestore = restoreUiAfterWasmLoad;
    restoreUiAfterWasmLoad = function() {
      var r = originalRestore.apply(this, arguments);
      autoOpenLastHost();
      return r;
    };

    // Moonlight's update check would offer Moonlight releases, not Play TV.
    window.checkForAppUpdatesAtStartup = noop;

    hookNavigation();
  }

  function autoOpenLastHost() {
    var uid = null;
    try { uid = localStorage.getItem('lastOpenedHost'); } catch (e) { /* ignore */ }
    if (!uid) {
      hideSplash();
      return;
    }
    var started = Date.now();
    var timer = setInterval(function() {
      var host = hosts[uid];
      if (host && host.online && host.paired) {
        clearInterval(timer);
        hostChosen(host);
      } else if (Date.now() - started > AUTO_OPEN_TIMEOUT_MS) {
        clearInterval(timer);
        hideSplash();
      }
    }, 500);
  }

  return {
    install: install,
    // Exposed for tests.
    _state: state,
    _apiBase: apiBase,
    _show: show,
    _dispatch: dispatch,
    _showLaunch: showLaunch,
    _hideLaunch: hideLaunch,
    _onStreamMessage: onStreamMessage,
    _hideSplash: hideSplash,
    _open: {
      who: openWho, library: openLibrary, search: openSearch, trophies: openTrophyList,
      game: openGameTrophies, profile: openProfile, avatar: openAvatarPicker,
      settings: openSettings, downloads: openDownloads, folder: chooseFolder, quick: openQuick,
    },
  };
})();

TVGames.install();
