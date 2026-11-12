/*
 * TVGames for Samsung (Tizen): the TVGames game library on top of Moonlight Tizen.
 *
 * Loaded after Moonlight's own scripts (see build.ps1 / build.sh). It does not
 * replace any streaming code: it only swaps Moonlight's app grid for the
 * TVGames library served by `tvgames serve` on the PC (port 47900), and starts
 * the chosen game with Moonlight's own startGame().
 *
 * Layout: a console-style home (shelves as tabs, one horizontal row of games,
 * the focused game's banner/art as the background, details, Jogar/Trof\u00e9us
 * buttons and info cards), plus profile and trophy screens, a startup splash
 * and a launch screen.
 *
 * Hooks into Moonlight Tizen v1.20.0 globals: showApps, showAppsMode,
 * showHostsMode, showSettingsMode, restoreUiAfterWasmLoad, hostChosen,
 * startGame, hosts, Views.Apps, Navigation. If the TVGames API is not
 * reachable, Moonlight's original app grid is shown instead.
 *
 * Licensed GPL-3.0 like Moonlight Tizen.
 */
/* global $, hosts, api, showApps:writable, showHostsMode:writable, showSettingsMode:writable,
   restoreUiAfterWasmLoad:writable, showAppsMode, showStreamMode, handleMessage, hostChosen, startGame, Views, Navigation, snackbarLogLong */

var TVGames = (function() {
  'use strict';

  var API_PORT = 47900;
  var TROPHY = '\uD83C\uDFC6';
  var ALL = 'Todos';
  var APPS = 'Apps';
  var AUTO_OPEN_TIMEOUT_MS = 15000;
  // Console-style home: one horizontal row of tiles, the focused one is larger
  // and always sits at the left edge; the row moves with a single transform.
  // Geometry must match tvgames.css (.tvg-tile width + margin-right).
  var TILE_STEP = 150 + 20;
  // TV CPUs are slow: the background art and details are redrawn only after
  // the focus rests for a moment, and covers load only near the focus.
  var HERO_DELAY_MS = 140;
  var PRELOAD_BEFORE = 2;
  var PRELOAD_AFTER = 11;
  var MAX_RECENT = 40;
  // Startup splash (markup injected into index.html by the build) and the
  // launch screen shown while the PC opens the game.
  var SPLASH_MIN_MS = 2600;
  var SPLASH_MAX_MS = 25000;
  var LAUNCH_FAILSAFE_MS = 120000;
  // After the stream connects the PC may still show its desktop while the game
  // window opens, so the launch screen stays a bit longer (any key skips it).
  var HOLD_RESUME_MS = 800;
  var HOLD_EMULATOR_MS = 4000;
  var HOLD_PC_MS = 9000;
  var PC_CATEGORIES = ['steam', 'pc', 'epic', 'gog', 'heroic', 'hydra', 'windows', 'apps'];
  var SOUND_DIR = 'platform/sounds/';
  var LAMBDA = '\u039B';

  var state = {
    active: false,
    host: null,
    base: '',
    library: null,
    filters: [],
    filter: ALL,
    shown: [],
    zone: 'row', // 'tabs' | 'row' | 'actions'
    index: 0,
    topIndex: 0, // focused item of the top bar
    action: 0, // focused button under the details
    screen: null, // open full screen (profile, trophies)
    recent: loadRecent(),
    focused: null, // element with the tvg-focus class
    heroTimer: 0,
    clockTimer: 0,
  };

  function loadRecent() {
    try {
      var r = JSON.parse(localStorage.getItem('tvgamesRecent') || '[]');
      if (Array.isArray(r)) return r;
    } catch (e) { /* ignore */ }
    var last = localStorage.getItem('tvgamesLastPlayed');
    return last ? [last] : [];
  }

  function rememberPlayed(id) {
    state.recent = [id].concat(state.recent.filter(function(x) { return x !== id; })).slice(0, MAX_RECENT);
    try {
      localStorage.setItem('tvgamesRecent', JSON.stringify(state.recent));
      localStorage.setItem('tvgamesLastPlayed', id);
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------- helpers --

  function apiBase(host) {
    var addr = String(host.address || '');
    // "1.2.3.4:47989" -> "1.2.3.4"; IPv6 gets brackets.
    if (addr.indexOf('[') === 0) {
      addr = addr.slice(1, addr.indexOf(']'));
    } else if ((addr.match(/:/g) || []).length === 1) {
      addr = addr.split(':')[0];
    }
    if (addr.indexOf(':') !== -1) {
      addr = '[' + addr + ']';
    }
    return 'http://' + addr + ':' + API_PORT;
  }

  function fetchLibrary(base) {
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', base + '/api/library', true);
      xhr.timeout = 6000;
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error('HTTP ' + xhr.status));
        }
      };
      xhr.onerror = function() { reject(new Error('network error')); };
      xhr.ontimeout = function() { reject(new Error('timeout')); };
      xhr.send();
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function percent(a) {
    return a && a.total ? Math.floor(a.earned * 100 / a.total) : 0;
  }

  /** Filters (shelves) in the same order as the Android app. */
  function buildFilters(games) {
    var cats = [];
    games.forEach(function(g) {
      if (!g.launcher && cats.indexOf(g.category) === -1) cats.push(g.category);
    });
    cats.sort(function(a, b) { return a.localeCompare(b); });
    var out = [ALL].concat(cats);
    if (games.some(function(g) { return g.launcher; })) out.push(APPS);
    return out;
  }

  /** Games of a shelf, most recently played first (like a console home), then A-Z. */
  function gamesFor(filter) {
    var games = state.library ? state.library.games : [];
    var list;
    if (filter === APPS) list = games.filter(function(g) { return g.launcher; });
    else if (filter === ALL) list = games.filter(function(g) { return !g.launcher; });
    else list = games.filter(function(g) { return !g.launcher && g.category === filter; });
    var rank = {};
    state.recent.forEach(function(id, i) { rank[id] = i; });
    return list
      .map(function(g, i) { return { g: g, i: i, r: rank.hasOwnProperty(g.id) ? rank[g.id] : 1e6 }; })
      .sort(function(a, b) { return a.r - b.r || a.i - b.i; })
      .map(function(x) { return x.g; });
  }

  // ------------------------------------------------------------------ view --

  function root() {
    var r = document.getElementById('tvgames-view');
    if (!r) {
      r = el('div');
      r.id = 'tvgames-view';
      document.getElementById('main-content').appendChild(r);
    }
    return r;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function updateClock() {
    var c = root().querySelector('.tvg-clock');
    if (!c) return;
    var d = new Date();
    c.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function brand(cls) {
    var b = el('div', cls);
    b.appendChild(el('span', null, 'PL'));
    b.appendChild(el('span', 'tvg-lambda', LAMBDA));
    b.appendChild(el('span', null, 'Y'));
    b.appendChild(el('span', 'tvg-brand-tv', 'TV'));
    return b;
  }

  function profileName() {
    var p = state.library && state.library.profile;
    return p && p.user ? p.user : 'Jogador';
  }

  /** Round avatar: the RetroAchievements picture, or the player's initial. */
  function avatar(cls) {
    var p = state.library && state.library.profile;
    var a = el('div', 'tvg-avatar ' + (cls || ''));
    a.appendChild(el('span', 'tvg-avatar-initial', profileName().charAt(0).toUpperCase()));
    if (p && p.avatar) {
      var img = el('img');
      img.onerror = function() { if (img.parentNode) img.parentNode.removeChild(img); };
      img.src = p.avatar;
      a.appendChild(img);
    }
    return a;
  }

  /** Totals for the profile and the trophy icon in the top bar. */
  function trophyStats() {
    var games = state.library ? state.library.games : [];
    var s = { games: 0, withCheevos: 0, earned: 0, total: 0, complete: 0 };
    games.forEach(function(g) {
      if (!g.launcher) s.games++;
      var a = g.achievements;
      if (a && a.total) {
        s.withCheevos++;
        s.earned += a.earned;
        s.total += a.total;
        if (a.earned === a.total) s.complete++;
      }
    });
    return s;
  }

  function points() {
    var p = state.library && state.library.profile;
    return p ? (p.points || 0) + (p.softcore_points || 0) : 0;
  }

  /** Items of the top bar: the shelves, then the trophy and profile buttons. */
  function topItems() {
    return state.filters.concat(['@trophies', '@profile']);
  }

  function render() {
    var lib = state.library;
    var r = root();
    r.innerHTML = '';

    // Background: two layers that cross-fade (opacity only, no blur).
    // A wide banner ("hero") fills the screen; a cover sits on the right.
    for (var b = 0; b < 2; b++) {
      var bg = el('img', 'tvg-bg');
      bg.onerror = function() { this.classList.remove('tvg-on'); };
      r.appendChild(bg);
    }
    r.appendChild(el('div', 'tvg-shade-left'));
    r.appendChild(el('div', 'tvg-shade-bottom'));

    var top = el('div', 'tvg-topbar');
    top.appendChild(brand('tvg-brand'));
    var tabs = el('div', 'tvg-tabs');
    state.filters.forEach(function(f, i) {
      var t = el('div', 'tvg-tab' + (f === state.filter ? ' tvg-selected' : ''), f);
      t.setAttribute('data-top', i);
      t.addEventListener('click', function() {
        state.zone = 'tabs';
        state.topIndex = i;
        selectFilter(f);
      });
      tabs.appendChild(t);
    });
    top.appendChild(tabs);
    var right = el('div', 'tvg-status');
    var st = trophyStats();
    var tro = el('div', 'tvg-icon-btn tvg-trophy-btn');
    tro.setAttribute('data-top', state.filters.length);
    tro.appendChild(el('span', 'tvg-trophy-glyph', TROPHY));
    tro.appendChild(el('span', 'tvg-trophy-count', st.withCheevos ? String(st.earned) : ''));
    tro.addEventListener('click', function() { openProfile('trophies'); });
    right.appendChild(tro);
    var prof = el('div', 'tvg-icon-btn tvg-profile-btn');
    prof.setAttribute('data-top', state.filters.length + 1);
    prof.appendChild(avatar('tvg-avatar-sm'));
    prof.addEventListener('click', function() { openProfile('profile'); });
    right.appendChild(prof);
    var pc = el('div', 'tvg-pc');
    pc.appendChild(el('span', 'tvg-dot'));
    pc.appendChild(el('span', 'tvg-hostname', lib.host && lib.host.name ? lib.host.name : state.host.hostname || ''));
    right.appendChild(pc);
    right.appendChild(el('span', 'tvg-clock'));
    top.appendChild(right);
    r.appendChild(top);

    // The row of games.
    var rowBox = el('div', 'tvg-row-box');
    var row = el('div', 'tvg-row');
    if (state.shown.length === 0) {
      row.appendChild(el('div', 'tvg-empty', 'Nada aqui ainda. Rode `tvgames sync` no PC.'));
    }
    state.shown.forEach(function(g, i) {
      var tile = el('div', 'tvg-tile');
      tile.setAttribute('data-index', i);
      tile.appendChild(el('div', 'tvg-placeholder', g.title));
      if (g.cover) {
        var img = el('img', 'tvg-cover');
        img.setAttribute('data-src', state.base + g.cover);
        img.onerror = function() { if (img.parentNode) img.parentNode.removeChild(img); };
        tile.appendChild(img);
      }
      if (g.achievements && g.achievements.total && g.achievements.earned === g.achievements.total) {
        tile.appendChild(el('div', 'tvg-tile-done', TROPHY));
      }
      tile.addEventListener('click', function() {
        if (state.zone === 'row' && state.index === i) {
          play(g);
        } else {
          state.zone = 'row';
          state.index = i;
          updateFocus();
        }
      });
      row.appendChild(tile);
    });
    rowBox.appendChild(row);
    r.appendChild(rowBox);

    // Details of the focused game.
    var hero = el('div', 'tvg-hero');
    var heroText = el('div', 'tvg-hero-text');
    heroText.appendChild(el('div', 'tvg-category'));
    heroText.appendChild(el('div', 'tvg-title'));
    heroText.appendChild(el('div', 'tvg-tags'));
    hero.appendChild(heroText);
    var actions = el('div', 'tvg-actions');
    var playBtn = el('div', 'tvg-btn tvg-play', 'Jogar');
    playBtn.addEventListener('click', function() {
      var g = state.shown[state.index];
      if (g) play(g);
    });
    actions.appendChild(playBtn);
    var trophiesBtn = el('div', 'tvg-btn tvg-btn-ghost tvg-trophies-btn');
    trophiesBtn.appendChild(el('span', null, TROPHY + ' Trof\u00e9us'));
    trophiesBtn.addEventListener('click', function() {
      var g = state.shown[state.index];
      if (g) openTrophies(g, 'home');
    });
    actions.appendChild(trophiesBtn);
    actions.appendChild(el('div', 'tvg-actions-note'));
    hero.appendChild(actions);
    hero.appendChild(el('div', 'tvg-cards'));
    r.appendChild(hero);

    var hints = el('div', 'tvg-hints');
    hints.appendChild(el('span', null, 'OK  Selecionar'));
    hints.appendChild(el('span', null, '\u25b2\u25bc  Navegar'));
    hints.appendChild(el('span', null, 'Voltar  Trocar de PC'));
    r.appendChild(hints);

    state.focused = null;
    state.current = null;
    state.heroFor = undefined;
    state.bgSrc = '';
    updateClock();
    updateFocus();
  }

  /** Swaps the background with a cross-fade between the two layers. */
  function setBackground(g) {
    var r = root();
    var layers = r.querySelectorAll('.tvg-bg');
    if (layers.length < 2) return;
    var wide = !!(g && g.hero);
    var src = g ? (g.hero || g.cover || '') : '';
    if (src) src = state.base + src;
    if (state.bgSrc === src) return;
    state.bgSrc = src;
    var on = r.querySelector('.tvg-bg.tvg-on');
    var next = on === layers[0] ? layers[1] : layers[0];
    if (on) on.classList.remove('tvg-on');
    if (!src) return;
    next.className = 'tvg-bg' + (wide ? ' tvg-wide' : '');
    next.onload = function() {
      if (state.bgSrc === src) next.classList.add('tvg-on');
    };
    next.src = src;
  }

  function cheevoCard(g) {
    var a = g.achievements;
    var card = el('div', 'tvg-card tvg-card-cheevos');
    card.appendChild(el('div', 'tvg-card-label', 'Trof\u00e9us'));
    var line = el('div', 'tvg-cheevos-line');
    line.appendChild(el('span', 'tvg-cheevos-pct', percent(a) + '%'));
    var bar = el('div', 'tvg-bar');
    var fill = el('div', 'tvg-fill' + (a.earned === a.total ? ' tvg-complete' : ''));
    fill.style.width = percent(a) + '%';
    bar.appendChild(fill);
    line.appendChild(bar);
    card.appendChild(line);
    card.appendChild(el('div', 'tvg-card-sub', a.earned + ' de ' + a.total + ' conquistados'));
    var badges = el('div', 'tvg-badges');
    // Earned first, like a console's trophy card.
    (a.badges || []).slice().sort(function(x, y) { return (y.earned ? 1 : 0) - (x.earned ? 1 : 0); })
      .slice(0, 7).forEach(function(b) {
        var img = el('img', 'tvg-badge' + (b.earned ? '' : ' tvg-locked'));
        img.src = b.url;
        badges.appendChild(img);
      });
    card.appendChild(badges);
    return card;
  }

  function infoCard(g) {
    var card = el('div', 'tvg-card tvg-card-info');
    card.appendChild(el('div', 'tvg-card-label', 'Sobre'));
    card.appendChild(el('div', 'tvg-card-big', g.launcher ? 'Aplicativo' : (g.category || 'Jogo')));
    var pos = state.recent.indexOf(g.id);
    card.appendChild(el('div', 'tvg-card-sub', pos === 0 ? 'Jogado por \u00faltimo' : pos > 0 ? 'Jogado recentemente' : 'Ainda n\u00e3o jogado aqui'));
    return card;
  }

  function renderHero(g) {
    var r = root();
    var hero = r.querySelector('.tvg-hero');
    if (!hero) return;
    state.heroFor = g;
    setBackground(g);
    // Re-trigger the fade-in of the texts.
    var text = hero.querySelector('.tvg-hero-text');
    text.classList.remove('tvg-in');
    void text.offsetWidth;
    text.classList.add('tvg-in');
    hero.querySelector('.tvg-category').textContent = g ? (g.launcher ? 'APP' : (g.category || '').toUpperCase()) : '';
    hero.querySelector('.tvg-title').textContent = g ? g.title : '';
    var tags = hero.querySelector('.tvg-tags');
    tags.innerHTML = '';
    if (g) (g.tags || []).slice(0, 4).forEach(function(t) { tags.appendChild(el('span', 'tvg-tag', t)); });
    hero.querySelector('.tvg-actions-note').textContent = g && state.recent[0] === g.id ? 'Jogado por \u00faltimo' : '';
    hero.querySelector('.tvg-actions').style.visibility = g ? 'visible' : 'hidden';
    var hasCheevos = !!(g && g.achievements && g.achievements.total);
    hero.querySelector('.tvg-trophies-btn').style.display = hasCheevos ? '' : 'none';
    var cards = hero.querySelector('.tvg-cards');
    cards.innerHTML = '';
    if (g) {
      if (hasCheevos) cards.appendChild(cheevoCard(g));
      cards.appendChild(infoCard(g));
    }
    cards.classList.remove('tvg-in');
    void cards.offsetWidth;
    cards.classList.add('tvg-in');
  }

  /** Moves the row so the focused tile sits at the left edge, and loads nearby covers. */
  function scrollRow(row, tiles) {
    row.style.transform = 'translate3d(' + (-state.index * TILE_STEP) + 'px,0,0)';
    var from = Math.max(0, state.index - PRELOAD_BEFORE);
    var to = Math.min(tiles.length, state.index + PRELOAD_AFTER + 1);
    for (var i = from; i < to; i++) {
      var img = tiles[i].querySelector('img[data-src]');
      if (img) {
        img.src = img.getAttribute('data-src');
        img.removeAttribute('data-src');
      }
    }
  }

  function actionButtons() {
    return Array.prototype.filter.call(root().querySelectorAll('.tvg-actions .tvg-btn'), function(b) {
      return b.style.display !== 'none';
    });
  }

  function updateFocus() {
    var r = root();
    var row = r.querySelector('.tvg-row');
    var tiles = row ? row.querySelectorAll('.tvg-tile') : [];
    if (row && tiles.length) scrollRow(row, tiles);
    // The tile keeps a "current" mark while the focus is on the tabs or the buttons.
    var current = tiles[state.index] || null;
    if (state.current !== current) {
      if (state.current) state.current.classList.remove('tvg-current');
      if (current) current.classList.add('tvg-current');
      state.current = current;
    }
    var g = state.shown[state.index] || null;
    if (state.heroFor !== g) {
      clearTimeout(state.heroTimer);
      var first = state.heroFor === undefined;
      state.heroTimer = setTimeout(function() { renderHero(g); }, first ? 0 : HERO_DELAY_MS);
      if (first) renderHero(g);
    }
    var target;
    if (state.zone === 'row') {
      target = current;
    } else if (state.zone === 'actions') {
      var btns = actionButtons();
      if (state.action >= btns.length) state.action = btns.length - 1;
      target = btns[Math.max(0, state.action)];
    } else {
      target = r.querySelector('[data-top="' + state.topIndex + '"]');
    }
    r.className = 'tvg-zone-' + state.zone;
    // Touch only the elements that change instead of every tile.
    if (state.focused !== target) {
      if (state.focused) state.focused.classList.remove('tvg-focus');
      if (target) target.classList.add('tvg-focus');
      state.focused = target;
    }
  }

  function selectFilter(f) {
    if (state.filter === f) return;
    state.filter = f;
    state.shown = gamesFor(f);
    state.index = 0;
    render();
  }

  // ------------------------------------------------------- full screens --
  // Profile, trophy list and per-game trophies: full-screen layers over the
  // home with their own simple focus list; Back closes them.

  function screenLayer(cls) {
    closeScreen(true);
    var s = el('div', 'tvg-screen ' + cls);
    document.body.appendChild(s);
    void s.offsetWidth;
    s.classList.add('tvg-in');
    state.screen = { el: s, items: [], index: 0, back: null };
    return state.screen;
  }

  function closeScreen(now) {
    var s = state.screen;
    if (!s) return;
    state.screen = null;
    if (now) {
      if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
      return;
    }
    s.el.classList.remove('tvg-in');
    setTimeout(function() { if (s.el.parentNode) s.el.parentNode.removeChild(s.el); }, 260);
    if (s.back) s.back();
  }

  function screenFocus() {
    var s = state.screen;
    if (!s) return;
    s.items.forEach(function(it, i) { it.el.classList.toggle('tvg-focus', i === s.index); });
    var it = s.items[s.index];
    if (it && s.scroller) {
      // Keep the focused item in view by moving the list (transform only).
      var box = s.scroller.parentNode;
      var y = it.el.offsetTop;
      var off = Math.max(0, Math.min(y - 120, s.scroller.offsetHeight - box.clientHeight + 40));
      s.scroller.style.transform = 'translate3d(0,' + (-off) + 'px,0)';
    }
  }

  function ring(pct, label) {
    var r = el('div', 'tvg-ring');
    r.style.background = 'conic-gradient(#7fe3ff 0 ' + pct + '%, rgba(255,255,255,0.1) ' + pct + '% 100%)';
    var inner = el('div', 'tvg-ring-inner');
    inner.appendChild(el('div', 'tvg-ring-pct', pct + '%'));
    if (label) inner.appendChild(el('div', 'tvg-ring-label', label));
    r.appendChild(inner);
    return r;
  }

  function stat(value, label) {
    var s = el('div', 'tvg-stat');
    s.appendChild(el('div', 'tvg-stat-value', String(value)));
    s.appendChild(el('div', 'tvg-stat-label', label));
    return s;
  }

  /** Profile ('profile') or trophy overview ('trophies'). */
  function openProfile(mode) {
    var s = screenLayer('tvg-profile');
    var st = trophyStats();
    var head = el('div', 'tvg-screen-head');
    head.appendChild(avatar('tvg-avatar-lg'));
    var who = el('div', 'tvg-who');
    who.appendChild(el('div', 'tvg-who-name', profileName()));
    var p = state.library && state.library.profile;
    who.appendChild(el('div', 'tvg-who-sub', p ? TROPHY + ' ' + points() + ' pontos RetroAchievements' : 'Conecte o RetroAchievements no PC para ver seus trof\u00e9us'));
    head.appendChild(who);
    head.appendChild(ring(st.total ? Math.floor(st.earned * 100 / st.total) : 0, 'geral'));
    s.el.appendChild(head);

    var stats = el('div', 'tvg-stats');
    stats.appendChild(stat(st.games, 'jogos na biblioteca'));
    stats.appendChild(stat(st.earned, 'trof\u00e9us conquistados'));
    stats.appendChild(stat(st.complete, 'jogos 100%'));
    stats.appendChild(stat(state.recent.length, 'jogados aqui'));
    s.el.appendChild(stats);

    var box = el('div', 'tvg-list-box');
    var list = el('div', 'tvg-list');
    var games = (state.library ? state.library.games : []).filter(function(g) { return !g.launcher; });
    var rank = {};
    state.recent.forEach(function(id, i) { rank[id] = i; });
    if (mode === 'profile') {
      list.appendChild(el('div', 'tvg-list-title', 'Jogados recentemente'));
      var recent = state.recent.map(function(id) {
        return games.filter(function(g) { return g.id === id; })[0];
      }).filter(Boolean).slice(0, 12);
      if (!recent.length) list.appendChild(el('div', 'tvg-list-empty', 'Nenhum jogo aberto pelo Play TV ainda.'));
      recent.forEach(function(g) { addGameItem(s, list, g, 'profile'); });
    }
    list.appendChild(el('div', 'tvg-list-title', 'Trof\u00e9us por jogo'));
    var withCheevos = games.filter(function(g) { return g.achievements && g.achievements.total; })
      .sort(function(a, b) {
        var ra = rank.hasOwnProperty(a.id) ? rank[a.id] : 1e6;
        var rb = rank.hasOwnProperty(b.id) ? rank[b.id] : 1e6;
        return ra - rb || percent(b.achievements) - percent(a.achievements);
      });
    if (!withCheevos.length) list.appendChild(el('div', 'tvg-list-empty', 'Nenhum jogo com trof\u00e9us ainda.'));
    withCheevos.forEach(function(g) { addGameItem(s, list, g, mode); });
    box.appendChild(list);
    s.el.appendChild(box);
    s.scroller = list;
    s.el.appendChild(screenHints('OK  Ver trof\u00e9us', 'Voltar  In\u00edcio'));
    screenFocus();
  }

  function addGameItem(s, list, g, from) {
    var it = el('div', 'tvg-item');
    var cov = el('div', 'tvg-item-cover');
    if (g.cover) {
      var img = el('img');
      img.src = state.base + g.cover;
      cov.appendChild(img);
    }
    it.appendChild(cov);
    var mid = el('div', 'tvg-item-main');
    mid.appendChild(el('div', 'tvg-item-title', g.title));
    mid.appendChild(el('div', 'tvg-item-sub', g.category || ''));
    it.appendChild(mid);
    var a = g.achievements;
    if (a && a.total) {
      var right = el('div', 'tvg-item-right');
      right.appendChild(el('div', 'tvg-item-pct' + (a.earned === a.total ? ' tvg-complete' : ''), percent(a) + '%'));
      var bar = el('div', 'tvg-bar tvg-bar-sm');
      var fill = el('div', 'tvg-fill' + (a.earned === a.total ? ' tvg-complete' : ''));
      fill.style.width = percent(a) + '%';
      bar.appendChild(fill);
      right.appendChild(bar);
      right.appendChild(el('div', 'tvg-item-sub', TROPHY + ' ' + a.earned + '/' + a.total));
      it.appendChild(right);
    }
    list.appendChild(it);
    s.items.push({ el: it, accept: function() {
      if (a && a.total) openTrophies(g, from);
      else play(g);
    } });
  }

  function screenHints(a, b) {
    var h = el('div', 'tvg-hints tvg-screen-hints');
    h.appendChild(el('span', null, a));
    h.appendChild(el('span', null, b));
    return h;
  }

  /** Trophy list of one game. */
  function openTrophies(g, from) {
    var a = g.achievements;
    if (!a || !a.total) return;
    var s = screenLayer('tvg-trophies');
    if (from === 'profile' || from === 'trophies') {
      s.back = function() { openProfile(from); };
    }
    if (g.hero || g.cover) {
      var bg = el('img', 'tvg-screen-bg' + (g.hero ? ' tvg-wide' : ''));
      bg.src = state.base + (g.hero || g.cover);
      s.el.appendChild(bg);
    }
    s.el.appendChild(el('div', 'tvg-screen-shade'));
    var head = el('div', 'tvg-screen-head');
    var cov = el('div', 'tvg-head-cover');
    if (g.cover) {
      var img = el('img');
      img.src = state.base + g.cover;
      cov.appendChild(img);
    }
    head.appendChild(cov);
    var who = el('div', 'tvg-who');
    who.appendChild(el('div', 'tvg-who-kicker', 'TROF\u00c9US'));
    who.appendChild(el('div', 'tvg-who-name', g.title));
    var pts = 0;
    var ptsTotal = 0;
    (a.badges || []).forEach(function(b) { ptsTotal += b.points || 0; if (b.earned) pts += b.points || 0; });
    who.appendChild(el('div', 'tvg-who-sub', a.earned + ' de ' + a.total + ' conquistados \u00b7 ' + pts + ' / ' + ptsTotal + ' pontos'));
    head.appendChild(who);
    head.appendChild(ring(percent(a), a.earned === a.total ? 'completo' : 'progresso'));
    s.el.appendChild(head);

    var box = el('div', 'tvg-list-box tvg-list-box-tall');
    var list = el('div', 'tvg-list');
    (a.badges || []).slice().sort(function(x, y) { return (y.earned ? 1 : 0) - (x.earned ? 1 : 0); }).forEach(function(b) {
      var it = el('div', 'tvg-item tvg-trophy' + (b.earned ? '' : ' tvg-locked'));
      var ic = el('img', 'tvg-trophy-icon');
      ic.src = b.url;
      it.appendChild(ic);
      var mid = el('div', 'tvg-item-main');
      mid.appendChild(el('div', 'tvg-item-title', b.title));
      mid.appendChild(el('div', 'tvg-item-sub', b.description || ''));
      it.appendChild(mid);
      var right = el('div', 'tvg-item-right');
      right.appendChild(el('div', 'tvg-trophy-points', (b.points || 0) + ' pts'));
      right.appendChild(el('div', 'tvg-item-sub', b.earned ? 'Conquistado' : 'Bloqueado'));
      it.appendChild(right);
      list.appendChild(it);
      s.items.push({ el: it, accept: function() {} });
    });
    box.appendChild(list);
    s.el.appendChild(box);
    s.scroller = list;
    s.el.appendChild(screenHints('\u25b2\u25bc  Navegar', 'Voltar  Sair'));
    screenFocus();
  }

  var screenNav = {
    up: function() {
      var s = state.screen;
      if (s.index > 0) { s.index--; screenFocus(); }
    },
    down: function() {
      var s = state.screen;
      if (s.index < s.items.length - 1) { s.index++; screenFocus(); }
    },
    left: function() {},
    right: function() {},
    accept: function() {
      var s = state.screen;
      var it = s.items[s.index];
      if (it) it.accept();
    },
    back: function() { closeScreen(); },
  };

  // ------------------------------------------------------------ actions --

  function play(g) {
    if (!state.host) return;
    rememberPlayed(g.id);
    var host = state.host;
    state.launching = g;
    // Resolve the id from Moonlight's own app list by name (same list the
    // stream uses); fall back to the id computed by tvgames.
    host.getAppByName(g.app_name).then(function(app) {
      state.launchAppId = app ? app.id : parseInt(g.app_id, 10);
      startGame(host, state.launchAppId);
    }, function() {
      state.launchAppId = parseInt(g.app_id, 10);
      startGame(host, state.launchAppId);
    });
  }

  // -------------------------------------------------------------- sounds --

  function playSound(name) {
    try {
      var a = new Audio(SOUND_DIR + name);
      a.volume = 0.8;
      var p = a.play();
      if (p && p.catch) p.catch(function() {});
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

  function launchHold(g, resuming) {
    if (resuming) return HOLD_RESUME_MS;
    if (!g) return HOLD_PC_MS;
    if (g.launcher) return HOLD_EMULATOR_MS;
    return PC_CATEGORIES.indexOf(String(g.category || '').toLowerCase()) !== -1 ? HOLD_PC_MS : HOLD_EMULATOR_MS;
  }

  function showLaunch() {
    closeScreen(true);
    var g = state.launching;
    var host = state.host;
    var resuming = !!(host && state.launchAppId && String(host.currentGame) === String(state.launchAppId));
    hideLaunch(true);
    var o = el('div');
    o.id = 'playtv-launch';
    if (g && (g.hero || g.cover)) {
      var bg = el('img', 'ptl-bg');
      bg.src = state.base + (g.hero || g.cover);
      o.appendChild(bg);
    }
    o.appendChild(el('div', 'ptl-shade'));
    var logo = el('div', 'ptl-logo');
    logo.appendChild(el('div', 'ptl-ring'));
    var word = el('div', 'ptl-word');
    word.appendChild(el('span', null, 'PL'));
    word.appendChild(el('span', 'ptl-lambda', LAMBDA));
    word.appendChild(el('span', null, 'Y'));
    logo.appendChild(word);
    logo.appendChild(el('div', 'ptl-tv', 'TV'));
    o.appendChild(logo);
    if (g) {
      var info = el('div', 'ptl-game');
      info.appendChild(el('div', 'ptl-label', resuming ? 'Voltando para' : 'Iniciando'));
      info.appendChild(el('div', 'ptl-title', g.title));
      o.appendChild(info);
    }
    var bar = el('div', 'ptl-bar');
    bar.appendChild(el('i'));
    o.appendChild(bar);
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

  // Navigation handlers, called through Moonlight's Views.Apps while active.
  // Zones from top to bottom: top bar (shelves, trophies, profile) > row of
  // games > buttons (Jogar, Trof\u00e9us).
  var nav = {
    up: function() {
      if (state.zone === 'actions') state.zone = 'row';
      else if (state.zone === 'row') {
        state.zone = 'tabs';
        state.topIndex = state.filters.indexOf(state.filter);
      }
      updateFocus();
    },
    down: function() {
      if (!state.shown.length) return;
      if (state.zone === 'tabs') state.zone = 'row';
      else if (state.zone === 'row') {
        state.zone = 'actions';
        state.action = 0;
      }
      updateFocus();
    },
    left: function() {
      if (state.zone === 'tabs') {
        if (state.topIndex > 0) moveTop(state.topIndex - 1);
      } else if (state.zone === 'row' && state.index > 0) {
        state.index--;
        updateFocus();
      } else if (state.zone === 'actions' && state.action > 0) {
        state.action--;
        updateFocus();
      }
    },
    right: function() {
      if (state.zone === 'tabs') {
        if (state.topIndex < topItems().length - 1) moveTop(state.topIndex + 1);
      } else if (state.zone === 'row' && state.index < state.shown.length - 1) {
        state.index++;
        updateFocus();
      } else if (state.zone === 'actions' && state.action < actionButtons().length - 1) {
        state.action++;
        updateFocus();
      }
    },
    accept: function() {
      if (state.zone === 'tabs') {
        var item = topItems()[state.topIndex];
        if (item === '@trophies') openProfile('trophies');
        else if (item === '@profile') openProfile('profile');
        else if (state.shown.length) {
          state.zone = 'row';
          updateFocus();
        }
      } else if (state.zone === 'actions') {
        var btn = actionButtons()[state.action];
        if (btn) btn.click();
      } else if (state.shown[state.index]) {
        play(state.shown[state.index]);
      }
    },
    switch: function() { updateFocus(); },
    enter: function() { updateFocus(); },
    leave: function() {},
  };

  /** Focus another top-bar item; shelves switch right away. */
  function moveTop(i) {
    state.topIndex = i;
    var item = topItems()[i];
    if (item.charAt(0) !== '@') selectFilter(item);
    state.zone = 'tabs';
    updateFocus();
  }

  function hookNavigation() {
    var apps = Views.Apps;
    ['up', 'down', 'left', 'right', 'accept', 'back', 'switch', 'enter', 'leave'].forEach(function(name) {
      var original = apps[name];
      apps[name] = function() {
        if (state.active && state.screen && screenNav[name]) return screenNav[name].apply(screenNav, arguments);
        if (state.active && nav[name]) return nav[name].apply(nav, arguments);
        return original.apply(this, arguments);
      };
    });
    // Gamepad extras (Moonlight only maps A, B and the D-pad): Y opens the
    // trophies of the focused game, Start/Options opens the profile.
    window.addEventListener('gamepadinputchanged', function(e) {
      if (!state.active || window.isInGame || !e.detail || !e.detail.changes) return;
      e.detail.changes.forEach(function(c) {
        if (c.type !== 'button' || !c.pressed) return;
        if (c.index === 3) {
          var g = state.shown[state.index];
          if (g && g.achievements && g.achievements.total) openTrophies(g, 'home');
        } else if (c.index === 9) {
          if (state.screen) closeScreen(true);
          openProfile('profile');
        }
      });
    });
  }

  function show(host, library) {
    hideSplash();
    hideLaunch(true);
    closeScreen(true);
    state.host = host;
    state.base = apiBase(host);
    state.library = library;
    state.filters = buildFilters(library.games || []);
    if (state.filters.indexOf(state.filter) === -1) state.filter = ALL;
    state.shown = gamesFor(state.filter);
    // Come back to the card that was just played.
    var last = state.shown.map(function(g) { return g.id; }).indexOf(state.recent[0]);
    state.index = last >= 0 ? last : Math.min(state.index, Math.max(0, state.shown.length - 1));
    state.zone = 'row';
    state.active = true;

    showAppsMode();
    $('#game-grid').hide();
    $('#header-title').html('Play TV');
    $(root()).show();
    document.body.classList.add('tvgames-active');
    render();
    clearInterval(state.clockTimer);
    state.clockTimer = setInterval(updateClock, 20000);
  }

  function hide() {
    state.active = false;
    closeScreen(true);
    clearInterval(state.clockTimer);
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
        var r = original.apply(this, arguments);
        $('#header-logo').hide();
        return r;
      };
    });
    window.showSettingsMode = (function(original) {
      return function() {
        hideSplash();
        return original.apply(this, arguments);
      };
    })(window.showSettingsMode);

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
    if (document.getElementById('playtv-splash')) playSound('playtv-start.wav');
    setTimeout(hideSplash, SPLASH_MAX_MS);

    // Open the last used PC straight into the cards at startup.
    var originalRestore = restoreUiAfterWasmLoad;
    restoreUiAfterWasmLoad = function() {
      var r = originalRestore.apply(this, arguments);
      autoOpenLastHost();
      return r;
    };

    // Moonlight's update check would offer Moonlight releases, not TVGames.
    window.checkForAppUpdatesAtStartup = function() {};

    hookNavigation();
  }

  function autoOpenLastHost() {
    var uid = localStorage.getItem('lastOpenedHost');
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
    _buildFilters: buildFilters,
    _show: show,
    _nav: nav,
    _showLaunch: showLaunch,
    _openProfile: openProfile,
    _openTrophies: openTrophies,
    _screenNav: screenNav,
    _onStreamMessage: onStreamMessage,
    _hideSplash: hideSplash,
  };
})();

TVGames.install();
