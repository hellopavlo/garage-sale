/*
 * Garage Sale engine — generic and reusable.
 * Reads sale-specific content from ../data/config.json and ../data/items.csv.
 * Nothing sale-specific should live in this file.
 *
 * Item statuses: "available" (default), "reserved", "sold".
 *   - The "Show reserved & sold" toggle SWITCHES the whole view to only
 *     reserved + sold items (available ones are hidden). Search, category
 *     filters, sort and pagination all apply within the current view.
 *   - Default sort is price high-to-low; blank prices sort last.
 *
 * Shareable state: the current search / categories / sort / page / view live in
 * the URL query string, so any filtered view can be copied and shared.
 *
 * Reserve list ("cart"): stateless — it lives ONLY as an array of item ids in
 * the URL (?cart=1,5,9). No localStorage, no backend. The link is the list;
 * shoppers copy it or open a pre-filled email to the seller to request a hold.
 * This mirrors the Shopify "cart permalink" model.
 */
(function () {
  "use strict";

  var DATA_DIR = "data/";
  var IMG_BASE = "assets/images/";
  var THUMB_DIR = IMG_BASE + "thumb/";
  var WEB_DIR = IMG_BASE + "web/";
  var DEFAULT_PAGE_SIZE = 12;
  var DEFAULT_SORT = "price-desc";
  var RENDERABLE_STATUSES = ["available", "reserved", "sold"];

  var state = {
    config: {},
    items: [],
    byId: {},
    activeCategories: new Set(),
    query: "",
    sort: DEFAULT_SORT,
    view: "available", // "available" | "hidden" (reserved + sold)
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  };

  var els = {};
  var lb = null;   // lightbox controller
  var cart = null; // reserve-list controller
  var booted = false;

  document.addEventListener("DOMContentLoaded", boot);

  function boot() {
    els.title = document.getElementById("sale-title");
    els.subtitle = document.getElementById("sale-subtitle");
    els.contact = document.getElementById("sale-contact");
    els.search = document.getElementById("search");
    els.sort = document.getElementById("sort");
    els.catToggle = document.getElementById("cat-toggle");
    els.catCount = document.getElementById("cat-count");
    els.catMenu = document.getElementById("cat-menu");
    els.catList = document.getElementById("cat-list");
    els.catClear = document.getElementById("cat-clear");
    els.catBackdrop = document.getElementById("cat-backdrop");
    els.showHidden = document.getElementById("show-hidden");
    els.activeFilters = document.getElementById("active-filters");
    els.grid = document.getElementById("grid");
    els.count = document.getElementById("result-count");
    els.pager = document.getElementById("pager");

    showLoading();
    fetchJSON(DATA_DIR + "config.json")
      .catch(function () { return {}; })
      .then(function (cfg) {
        state.config = cfg || {};
        state.pageSize = positiveInt(state.config.pageSize, DEFAULT_PAGE_SIZE);
        applyConfig(state.config);
        lb = createLightbox();
        cart = createCart();
        bindEvents();
        loadData();
      })
      .catch(function (err) { showError(err, false); });
  }

  // Fetch the item data and render. On failure, show an error with a Retry
  // button — there is intentionally no silent fallback to stale data.
  function loadData() {
    showLoading();
    loadItemsCSV(state.config)
      .then(function (csvText) {
        state.items = parseCSV(csvText).map(normalizeItem).filter(function (it) {
          return RENDERABLE_STATUSES.indexOf(it.status) !== -1;
        });
        state.byId = {};
        state.items.forEach(function (it) { state.byId[it.id] = it; });
        buildCategoryMenu();
        if (!booted) {
          var hadCartParam = readURL(); // apply shareable state on first load
          booted = true;
          render();
          if (hadCartParam && cart.size()) cart.open();
        } else {
          render();
        }
      })
      .catch(function (err) { showError(err, true); });
  }

  // Data source: a published Google Sheet (live) if configured, else the
  // bundled data/items.csv. When a Sheet IS configured it is the sole source —
  // no fallback — so the visitor sees a loader until the Sheet responds and a
  // clear error (with Retry) if it cannot be reached.
  function loadItemsCSV(cfg) {
    var sheetUrl = sheetCsvUrl(cfg);
    if (!sheetUrl) return fetchText(DATA_DIR + "items.csv");
    return fetchText(sheetUrl).then(function (txt) {
      if (!looksLikeCsv(txt)) {
        throw new Error("The Google Sheet didn't return data. Make sure it is shared “Anyone with the link can view” and the tab name is correct.");
      }
      return txt;
    });
  }

  // Builds the CORS-friendly gviz CSV endpoint for a Google Sheet.
  // Note: this endpoint works cross-origin; the "Publish to web" CSV URL does not.
  function sheetCsvUrl(cfg) {
    var s = cfg.sheet || {};
    var id = s.id || cfg.sheetId;
    if (!id) return null;
    var url = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(id) + "/gviz/tq?tqx=out:csv";
    if (s.gid || cfg.sheetGid) url += "&gid=" + encodeURIComponent(s.gid || cfg.sheetGid);
    else url += "&sheet=" + encodeURIComponent(s.tab || cfg.sheetTab || "Items");
    url += "&_cb=" + Date.now(); // avoid stale browser cache
    return url;
  }

  function looksLikeCsv(txt) {
    if (!txt) return false;
    var t = txt.replace(/^﻿/, "").trimStart();
    if (t.charAt(0) === "<") return false;                 // HTML (login/error page)
    if (t.indexOf("google.visualization") !== -1) return false; // gviz JSON/error wrapper
    return t.indexOf(",") !== -1 && t.indexOf("\n") !== -1;
  }

  /* ---------- data loading ---------- */

  function fetchText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("Could not load " + url + " (" + r.status + ")");
      return r.text();
    });
  }
  function fetchJSON(url) {
    return fetchText(url).then(function (t) { return JSON.parse(t); });
  }

  function parseCSV(text) {
    var rows = [], row = [], field = "", inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i], next = text[i + 1];
      if (inQuotes) {
        if (c === '"' && next === '"') { field += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else { field += c; }
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\r") { /* ignore */ }
        else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else { field += c; }
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    var headers = rows.shift().map(function (h) { return h.trim(); });
    return rows
      .filter(function (r) { return r.some(function (v) { return v.trim() !== ""; }); })
      .map(function (r) {
        var obj = {};
        headers.forEach(function (h, idx) { obj[h] = (r[idx] == null ? "" : r[idx]).trim(); });
        return obj;
      });
  }

  function normalizeItem(raw, i) {
    var priceRaw = (raw.price || "").replace(/^\$/, "").trim();
    var num = parseFloat(priceRaw.replace(/[^0-9.]/g, ""));
    var status = (raw.status || "available").toLowerCase();
    var fullRaw = (raw["full price"] || "").replace(/^\$/, "").trim();
    var fullNum = parseFloat(fullRaw.replace(/[^0-9.]/g, ""));
    var raw_imgs = raw.images != null && raw.images !== "" ? raw.images : (raw.image || "");
    var photos = raw_imgs.split("|").map(function (s) { return s.trim(); }).filter(Boolean);
    var qn = parseInt((raw.quantity || "").replace(/[^0-9]/g, ""), 10);
    return {
      // strip a stray leading "$" in case a sheet cell was currency-formatted
      id: (raw.id || String(i)).replace(/^\$/, "").trim(),
      name: raw.name || "Untitled item",
      category: raw.category || "Misc",
      description: raw.description || "",
      photos: photos,
      status: status,
      condition: (raw.condition || "").trim(),
      quantity: isNaN(qn) ? null : qn,
      priceRaw: priceRaw,
      priceNum: isNaN(num) ? null : num,
      fullPriceNum: isNaN(fullNum) ? null : fullNum,
    };
  }

  function isHidden(it) { return it.status === "reserved" || it.status === "sold"; }
  function inView(it) {
    return state.view === "hidden" ? isHidden(it) : !isHidden(it);
  }

  /* ---------- config ---------- */

  function applyConfig(cfg) {
    if (cfg.title) { els.title.textContent = cfg.title; document.title = cfg.title; }
    if (cfg.subtitle) { els.subtitle.textContent = cfg.subtitle; }
    if (cfg.contact) { els.contact.textContent = cfg.contact; }
  }

  /* ---------- filters ---------- */

  function buildCategoryMenu() {
    var names = uniqueSorted(state.items.map(function (it) { return it.category; }));
    els.catList.innerHTML = "";
    names.forEach(function (name) {
      var opt = document.createElement("label");
      opt.className = "cat-opt";
      opt.innerHTML =
        '<input type="checkbox" class="cat-check" />' +
        '<span class="cat-opt-name"></span>' +
        '<span class="cat-opt-count"></span>';
      opt.querySelector(".cat-opt-name").textContent = name;
      var cb = opt.querySelector(".cat-check");
      cb.value = name;
      cb.checked = state.activeCategories.has(name);
      cb.addEventListener("change", function () { toggleCategory(name, cb.checked); });
      els.catList.appendChild(opt);
    });
  }

  function toggleCategory(name, on) {
    if (on) state.activeCategories.add(name);
    else state.activeCategories.delete(name);
    state.page = 1;
    render();
  }

  function syncCategoryChecks() {
    Array.prototype.forEach.call(els.catList.querySelectorAll(".cat-check"), function (cb) {
      cb.checked = state.activeCategories.has(cb.value);
    });
  }

  function clearCategories() {
    state.activeCategories.clear();
    syncCategoryChecks();
    state.page = 1;
    render();
  }

  function clearAllFilters() {
    state.query = ""; els.search.value = "";
    state.activeCategories.clear(); syncCategoryChecks();
    state.page = 1; render();
  }

  /* category dropdown open / close */
  function openCatMenu() {
    els.catMenu.hidden = false;
    els.catBackdrop.hidden = false;
    els.catToggle.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", onCatKeydown);
    // defer so the opening click doesn't immediately close it
    setTimeout(function () { document.addEventListener("click", onDocClickForCat, true); }, 0);
  }
  function closeCatMenu() {
    els.catMenu.hidden = true;
    els.catBackdrop.hidden = true;
    els.catToggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onCatKeydown);
    document.removeEventListener("click", onDocClickForCat, true);
  }
  function toggleCatMenu() { if (els.catMenu.hidden) openCatMenu(); else closeCatMenu(); }
  function onDocClickForCat(e) {
    if (els.catMenu.contains(e.target) || els.catToggle.contains(e.target)) return;
    closeCatMenu();
  }
  function onCatKeydown(e) { if (e.key === "Escape") { closeCatMenu(); els.catToggle.focus(); } }

  function bindEvents() {
    els.search.addEventListener("input", function () {
      state.query = els.search.value.toLowerCase().trim(); state.page = 1; render();
    });
    els.sort.addEventListener("change", function () {
      state.sort = els.sort.value; state.page = 1; render();
    });
    els.showHidden.addEventListener("change", function () {
      state.view = els.showHidden.checked ? "hidden" : "available";
      state.page = 1; render();
    });
    els.catToggle.addEventListener("click", toggleCatMenu);
    els.catClear.addEventListener("click", clearCategories);
    els.catBackdrop.addEventListener("click", closeCatMenu);
  }

  /* ---------- URL state (shareable filtered views + cart) ---------- */

  function readURL() {
    var p;
    try { p = new URLSearchParams(location.search); } catch (e) { return false; }
    var q = p.get("q");
    if (q) { state.query = q.toLowerCase(); els.search.value = q; }
    var v = p.get("v");
    if (v === "hidden") { state.view = "hidden"; els.showHidden.checked = true; }
    var s = p.get("s");
    if (s) { state.sort = s; els.sort.value = s; }
    var c = p.get("c");
    if (c) {
      c.split(",").forEach(function (name) { if (name) state.activeCategories.add(name); });
      syncCategoryChecks();
    }
    var pg = parseInt(p.get("p"), 10);
    if (!isNaN(pg) && pg > 0) state.page = pg;
    var cartParam = p.get("cart");
    if (cartParam != null) { cart.setFromIds(cartParam.split(",").filter(Boolean)); }
    return cartParam != null;
  }

  function currentParams() {
    var p = new URLSearchParams();
    if (state.query) p.set("q", state.query);
    if (state.view === "hidden") p.set("v", "hidden");
    if (state.sort !== DEFAULT_SORT) p.set("s", state.sort);
    if (state.activeCategories.size) p.set("c", Array.from(state.activeCategories).join(","));
    if (state.page > 1) p.set("p", String(state.page));
    if (cart && cart.size()) p.set("cart", cart.ids().join(","));
    return p;
  }

  function writeURL() {
    if (!booted) return;
    try {
      var qs = currentParams().toString();
      var url = location.pathname + (qs ? "?" + qs : "") + location.hash;
      history.replaceState(null, "", url);
    } catch (e) { /* file:// or unsupported — ignore */ }
  }

  /* ---------- selection pipeline ---------- */

  function baseItems() {
    var tokens = state.query ? state.query.split(/\s+/) : [];
    return state.items.filter(function (it) {
      if (!inView(it)) return false;
      if (tokens.length) {
        var hay = (it.name + " " + it.category + " " + it.description).toLowerCase();
        return tokens.every(function (t) { return hay.indexOf(t) !== -1; });
      }
      return true;
    });
  }

  function applyCategory(list) {
    if (!state.activeCategories.size) return list;
    return list.filter(function (it) { return state.activeCategories.has(it.category); });
  }

  function sortItems(list) {
    var s = state.sort;
    if (s === "name-asc") return list.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    // price sort — default is high-to-low; items without a price go last
    var dir = s === "price-asc" ? 1 : -1;
    return list.slice().sort(function (a, b) {
      var av = a.priceNum, bv = b.priceNum;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
  }

  /* ---------- rendering ---------- */

  function render() {
    var base = baseItems();
    updateCategoryCounts(base);

    var matched = sortItems(applyCategory(base));
    var total = matched.length;

    var pageSize = state.pageSize;
    var totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;
    var start = (state.page - 1) * pageSize;
    var pageItems = matched.slice(start, start + pageSize);

    els.grid.innerHTML = "";
    if (!total) {
      els.grid.innerHTML = '<p class="empty">' +
        (state.view === "hidden" ? "No reserved or sold items match your filters." : "No items match your filters.") +
        "</p>";
    } else {
      var frag = document.createDocumentFragment();
      pageItems.forEach(function (it) { frag.appendChild(card(it)); });
      els.grid.appendChild(frag);
    }

    var noun = state.view === "hidden" ? "reserved / sold item" : "item";
    els.count.textContent = !total ? "No " + noun + "s"
      : "Showing " + (start + 1) + "–" + (start + pageItems.length) + " of " + total + " " + noun + (total === 1 ? "" : "s");

    updateCategoryUI();
    renderPager(totalPages);
    writeURL();
  }

  function updateCategoryCounts(base) {
    var counts = {};
    base.forEach(function (it) { counts[it.category] = (counts[it.category] || 0) + 1; });
    Array.prototype.forEach.call(els.catList.querySelectorAll(".cat-opt"), function (opt) {
      var cb = opt.querySelector(".cat-check");
      var n = counts[cb.value] || 0;
      opt.querySelector(".cat-opt-count").textContent = n;
      opt.classList.toggle("cat-opt-empty", n === 0);
    });
  }

  function updateCategoryUI() {
    var n = state.activeCategories.size;
    els.catCount.textContent = n;
    els.catCount.hidden = n === 0;
    els.catToggle.classList.toggle("has-selection", n > 0);
    renderActiveFilters();
  }

  function renderActiveFilters() {
    els.activeFilters.innerHTML = "";
    if (!state.activeCategories.size) { els.activeFilters.hidden = true; return; }
    els.activeFilters.hidden = false;
    uniqueSorted(Array.from(state.activeCategories)).forEach(function (name) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "afilter";
      chip.setAttribute("aria-label", "Remove filter: " + name);
      chip.innerHTML = escapeHTML(name) + ' <span class="afilter-x" aria-hidden="true">×</span>';
      chip.addEventListener("click", function () {
        state.activeCategories.delete(name); syncCategoryChecks(); state.page = 1; render();
      });
      els.activeFilters.appendChild(chip);
    });
    var clearAll = document.createElement("button");
    clearAll.type = "button";
    clearAll.className = "afilter-clear";
    clearAll.textContent = "Clear all";
    clearAll.addEventListener("click", clearAllFilters);
    els.activeFilters.appendChild(clearAll);
  }

  function renderPager(totalPages) {
    els.pager.innerHTML = "";
    if (totalPages <= 1) return;
    els.pager.appendChild(pagerButton("‹ Prev", state.page - 1, state.page === 1));
    pageTokens(state.page, totalPages).forEach(function (tok) {
      if (tok === "…") {
        var span = document.createElement("span"); span.className = "pager-gap"; span.textContent = "…";
        els.pager.appendChild(span);
      } else {
        els.pager.appendChild(pagerButton(String(tok), tok, false, tok === state.page));
      }
    });
    els.pager.appendChild(pagerButton("Next ›", state.page + 1, state.page === totalPages));
  }

  function pagerButton(label, targetPage, disabled, current) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "pager-btn" + (current ? " is-current" : "");
    b.textContent = label;
    if (current) b.setAttribute("aria-current", "page");
    if (disabled) b.disabled = true;
    else b.addEventListener("click", function () { goToPage(targetPage); });
    return b;
  }

  function goToPage(p) {
    state.page = p; render();
    // land just below the sticky controls bar (whatever its current height is)
    var bar = document.querySelector(".controls-bar");
    var barH = bar ? bar.getBoundingClientRect().height : 0;
    var top = els.count.getBoundingClientRect().top + window.pageYOffset - barH - 8;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  function pageTokens(cur, total) {
    if (total <= 7) { var all = []; for (var i = 1; i <= total; i++) all.push(i); return all; }
    var wanted = [1, 2, total - 1, total, cur - 1, cur, cur + 1], set = {};
    wanted.forEach(function (n) { if (n >= 1 && n <= total) set[n] = true; });
    var nums = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    var out = [], prev = 0;
    nums.forEach(function (n) { if (prev && n - prev > 1) out.push("…"); out.push(n); prev = n; });
    return out;
  }

  /* ---------- cards ---------- */

  function card(it) {
    var el = document.createElement("article");
    el.className = "card status-is-" + it.status;
    el.appendChild(buildMedia(it));

    var body = document.createElement("div");
    body.className = "card-body";

    var content = document.createElement("div");
    content.className = "card-content";
    // Distinct channels so attributes are never confused:
    //  - category = quiet uppercase eyebrow (self-describing)
    //  - condition = color-coded status chip beside the price (marketplace convention)
    //  - quantity = plain "N available" text
    // Title + description are line-clamped for uniform card heights.
    var condChip = it.condition
      ? '<span class="card-condition ' + conditionClass(it.condition) + '">' + escapeHTML(it.condition) + "</span>"
      : "";
    content.innerHTML =
      '<div class="card-head">' +
        '<span class="card-eyebrow">' + escapeHTML(it.category) + "</span>" +
        '<h2 class="card-name">' + escapeHTML(it.name) + "</h2>" +
        '<div class="card-priceline">' +
          '<span class="card-price">' + priceHTML(it) + "</span>" +
          condChip +
        "</div>" +
      "</div>" +
      (it.quantity && it.quantity > 1 ? '<div class="card-qty">' + it.quantity + " available</div>" : "") +
      (it.description ? '<p class="card-desc">' + escapeHTML(it.description) + "</p>" : "");
    body.appendChild(content);

    if (!isHidden(it)) body.appendChild(cartButton(it));
    el.appendChild(body);
    return el;
  }

  function cartButton(it) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "cart-add";
    b.dataset.id = it.id;
    b.addEventListener("click", function () { cart.toggle(it.id); });
    syncCartButton(b);
    return b;
  }

  function syncCartButton(b) {
    var inCart = cart.has(b.dataset.id);
    b.classList.toggle("in-cart", inCart);
    b.textContent = inCart ? "✓ In your list" : "+ Add to reserve list";
    b.setAttribute("aria-pressed", inCart ? "true" : "false");
  }

  // Keep every visible card button in sync with the cart (covers panel
  // actions like "Clear list" and "Remove", not just direct card clicks).
  function syncCartButtons() {
    if (!cart) return;
    Array.prototype.forEach.call(document.querySelectorAll(".cart-add"), syncCartButton);
  }

  function buildMedia(it) {
    var hasPhotos = it.photos.length > 0;
    var media = document.createElement(hasPhotos ? "button" : "div");
    media.className = "card-media";
    if (hasPhotos) {
      media.type = "button";
      media.setAttribute("aria-label", "View photos of " + it.name);
      var first = it.photos[0];
      media.appendChild(imgWithFallback([THUMB_DIR + first, WEB_DIR + first, IMG_BASE + first], it.name, media));
      if (it.photos.length > 1) {
        var pill = document.createElement("span");
        pill.className = "photo-count";
        pill.innerHTML = cameraIcon() + "<span>" + it.photos.length + "</span>";
        media.appendChild(pill);
      }
      media.addEventListener("click", function () { lb.open(it, 0); });
    } else {
      media.classList.add("is-empty");
      media.appendChild(placeholder());
    }
    if (it.status !== "available") {
      var badge = document.createElement("span");
      badge.className = "status status-" + it.status;
      badge.textContent = it.status === "sold" ? "SOLD" : cap(it.status);
      media.appendChild(badge);
    }
    return media;
  }

  function imgWithFallback(srcs, alt, host) {
    var img = document.createElement("img");
    img.loading = "lazy"; img.alt = alt;
    var idx = 0;
    img.addEventListener("error", function () {
      idx += 1;
      if (idx < srcs.length) img.src = srcs[idx];
      else if (host) { host.classList.add("is-empty"); img.remove(); host.insertBefore(placeholder(), host.firstChild); }
    });
    img.src = srcs[0];
    return img;
  }

  function placeholder() {
    var d = document.createElement("div");
    d.className = "placeholder"; d.setAttribute("aria-hidden", "true"); d.textContent = "No photo";
    return d;
  }

  function fmtNum(n) { return Number.isInteger(n) ? String(n) : n.toFixed(2); }

  function formatPrice(it) {
    if (it.priceNum == null) return it.priceRaw ? escapeHTML(it.priceRaw) : "N/A";
    if (it.priceNum === 0) return "Free";
    return (state.config.currency || "$") + fmtNum(it.priceNum);
  }

  // actual price, plus a struck-through "full price" when the sheet provides one
  function priceHTML(it) {
    var html = formatPrice(it);
    if (it.fullPriceNum != null && it.fullPriceNum > 0) {
      html += ' <s class="card-full">' + (state.config.currency || "$") + fmtNum(it.fullPriceNum) + "</s>";
    }
    return html;
  }

  // Maps a condition value to a color class (neutral-dominant: color only where
  // it changes the buyer's decision). Falls back to neutral for unknown values.
  function conditionClass(c) {
    var k = (c || "").toLowerCase().trim();
    if (k === "new") return "cond-new";
    if (k === "like new") return "cond-likenew";
    if (k === "good") return "cond-good";
    if (k === "fair") return "cond-fair";
    if (k === "for parts") return "cond-forparts";
    return "cond-default";
  }

  /* ---------- reserve list ("cart") ---------- */

  function createCart() {
    var ids = []; // stateless: populated only from the URL (?cart=)

    // Floating pill
    var pill = document.createElement("button");
    pill.type = "button";
    pill.className = "cart-pill";
    pill.hidden = true;
    pill.innerHTML = bagIcon() + '<span class="cart-pill-count"></span> <span class="cart-pill-label">reserve list</span>';
    document.body.appendChild(pill);

    // Panel
    var root = document.createElement("div");
    root.className = "cartp";
    root.hidden = true;
    root.innerHTML =
      '<div class="cartp-backdrop"></div>' +
      '<aside class="cartp-panel" role="dialog" aria-label="Reserve list">' +
        '<header class="cartp-head"><h2>Your reserve list</h2>' +
          '<button class="cartp-close" type="button" aria-label="Close">&#10005;</button></header>' +
        '<div class="cartp-items"></div>' +
        '<p class="cartp-empty">Your list is empty. Browse items and tap ' +
          '<strong>“Add to reserve list”</strong> to build a request.</p>' +
        '<footer class="cartp-foot">' +
          '<p class="cartp-note">Send this list to the seller to ask them to hold these items for you.</p>' +
          '<div class="cartp-actions">' +
            '<a class="cartp-email btn-primary" href="#">Email the seller</a>' +
            '<button class="cartp-copy btn" type="button">Copy share link</button>' +
            '<button class="cartp-clear btn-ghost" type="button">Clear list</button>' +
          '</div>' +
        '</footer>' +
      '</aside>';
    document.body.appendChild(root);

    var itemsBox = root.querySelector(".cartp-items");
    var emptyMsg = root.querySelector(".cartp-empty");
    var foot = root.querySelector(".cartp-foot");
    var emailLink = root.querySelector(".cartp-email");
    var copyBtn = root.querySelector(".cartp-copy");
    var clearBtn = root.querySelector(".cartp-clear");
    var countEl = pill.querySelector(".cart-pill-count");

    pill.addEventListener("click", open);
    root.querySelector(".cartp-close").addEventListener("click", close);
    root.querySelector(".cartp-backdrop").addEventListener("click", close);
    copyBtn.addEventListener("click", function () {
      copyText(cartLink(), copyBtn, "Copied!");
    });
    clearBtn.addEventListener("click", function () {
      ids = []; changed(); renderPanel();
    });
    document.addEventListener("keydown", function (e) {
      if (!root.hidden && e.key === "Escape") close();
    });

    function has(id) { return ids.indexOf(String(id)) !== -1; }
    function toggle(id) {
      id = String(id);
      var i = ids.indexOf(id);
      if (i === -1) ids.push(id); else ids.splice(i, 1);
      changed();
      if (!root.hidden) renderPanel();
    }
    function setFromIds(list) {
      // keep only ids that exist in the catalog, de-duplicated, preserve order
      var seen = {};
      ids = list.map(String).filter(function (id) {
        if (seen[id] || !state.byId[id]) return false; seen[id] = true; return true;
      });
      changed();
    }

    function changed() {
      countEl.textContent = ids.length;
      pill.hidden = ids.length === 0;
      syncCartButtons();
      writeURL();
    }

    function cartLink() {
      var base = location.origin + location.pathname;
      return ids.length ? base + "?cart=" + ids.join(",") : base;
    }

    function emailHref() {
      var to = state.config.reserveEmail || "";
      var lines = ids.map(function (id) {
        var it = state.byId[id];
        return it ? "- " + it.name + " (" + it.category + ")" : "- item " + id;
      });
      var subject = "Reserve request — " + (state.config.title || "Garage Sale");
      var body =
        "Hi! I'd like to reserve these items:\n\n" +
        lines.join("\n") +
        "\n\nMy list link: " + cartLink() + "\n";
      return "mailto:" + encodeURIComponent(to) +
        "?subject=" + encodeURIComponent(subject) +
        "&body=" + encodeURIComponent(body);
    }

    function renderPanel() {
      itemsBox.innerHTML = "";
      var hasItems = ids.length > 0;
      emptyMsg.hidden = hasItems;
      foot.hidden = !hasItems;
      emailLink.hidden = !state.config.reserveEmail;
      if (hasItems) emailLink.href = emailHref();

      ids.forEach(function (id) {
        var it = state.byId[id];
        if (!it) return;
        var row = document.createElement("div");
        row.className = "cartp-row";
        var thumb = it.photos.length
          ? '<img class="cartp-thumb" loading="lazy" alt="" src="' + THUMB_DIR + it.photos[0] + '">'
          : '<span class="cartp-thumb is-empty" aria-hidden="true"></span>';
        row.innerHTML =
          thumb +
          '<span class="cartp-info"><span class="cartp-name">' + escapeHTML(it.name) +
          '</span><span class="cartp-cat">' + escapeHTML(it.category) + "</span></span>" +
          '<button class="cartp-remove" type="button" aria-label="Remove ' + escapeHTML(it.name) + '">&#10005;</button>';
        row.querySelector(".cartp-remove").addEventListener("click", function () { toggle(id); });
        itemsBox.appendChild(row);
      });
    }

    function open() { renderPanel(); root.hidden = false; document.body.classList.add("cartp-open"); root.querySelector(".cartp-close").focus(); }
    function close() { root.hidden = true; document.body.classList.remove("cartp-open"); }

    // init pill state
    countEl.textContent = ids.length;
    pill.hidden = ids.length === 0;

    return {
      has: has, toggle: toggle, setFromIds: setFromIds,
      size: function () { return ids.length; }, ids: function () { return ids.slice(); },
      open: open,
    };
  }

  /* ---------- lightbox (fullscreen gallery) ---------- */

  function createLightbox() {
    var root = document.createElement("div");
    root.className = "lb"; root.hidden = true;
    root.innerHTML =
      '<div class="lb-backdrop"></div>' +
      '<button class="lb-close" type="button" aria-label="Close (Esc)">&#10005;</button>' +
      '<button class="lb-nav lb-prev" type="button" aria-label="Previous">&#8249;</button>' +
      '<div class="lb-stage"><img class="lb-img" alt="" draggable="false" /></div>' +
      '<button class="lb-nav lb-next" type="button" aria-label="Next">&#8250;</button>' +
      '<div class="lb-bar"><span class="lb-caption"></span><span class="lb-counter"></span></div>' +
      '<div class="lb-thumbs"></div>';
    document.body.appendChild(root);

    var stage = root.querySelector(".lb-stage");
    var img = root.querySelector(".lb-img");
    var caption = root.querySelector(".lb-caption");
    var counter = root.querySelector(".lb-counter");
    var thumbs = root.querySelector(".lb-thumbs");
    var prevBtn = root.querySelector(".lb-prev");
    var nextBtn = root.querySelector(".lb-next");
    var closeBtn = root.querySelector(".lb-close");
    var backdrop = root.querySelector(".lb-backdrop");

    var cur = { item: null, index: 0 };
    var zoom = false, tx = 0, ty = 0, lastFocus = null;

    function open(item, index) {
      if (!item.photos.length) return;
      cur.item = item; cur.index = index || 0; lastFocus = document.activeElement;
      buildThumbs(); show(); root.hidden = false;
      document.body.classList.add("lb-open"); closeBtn.focus();
    }
    function close() {
      root.hidden = true; document.body.classList.remove("lb-open");
      img.removeAttribute("src"); resetZoom();
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    function show() {
      var photos = cur.item.photos, name = photos[cur.index];
      resetZoom();
      img.src = WEB_DIR + name;
      img.onerror = function () { img.onerror = null; img.src = IMG_BASE + name; };
      img.alt = cur.item.name + " — photo " + (cur.index + 1) + " of " + photos.length;
      caption.textContent = cur.item.name;
      counter.textContent = (cur.index + 1) + " / " + photos.length;
      var multi = photos.length > 1;
      prevBtn.hidden = !multi; nextBtn.hidden = !multi; thumbs.hidden = !multi;
      Array.prototype.forEach.call(thumbs.children, function (t, i) { t.classList.toggle("is-active", i === cur.index); });
      preload(cur.index + 1); preload(cur.index - 1);
    }
    function preload(i) { var photos = cur.item.photos; if (i < 0 || i >= photos.length) return; var p = new Image(); p.src = WEB_DIR + photos[i]; }
    function go(delta) { var n = cur.item.photos.length; cur.index = (cur.index + delta + n) % n; show(); }
    function gotoIndex(i) { cur.index = i; show(); }
    function buildThumbs() {
      thumbs.innerHTML = "";
      cur.item.photos.forEach(function (name, i) {
        var b = document.createElement("button"); b.type = "button"; b.className = "lb-thumb";
        b.setAttribute("aria-label", "Photo " + (i + 1));
        var t = document.createElement("img"); t.loading = "lazy"; t.alt = ""; t.src = THUMB_DIR + name;
        t.onerror = function () { t.onerror = null; t.src = IMG_BASE + name; };
        b.appendChild(t); b.addEventListener("click", function () { gotoIndex(i); });
        thumbs.appendChild(b);
      });
    }
    function resetZoom() { zoom = false; tx = 0; ty = 0; img.classList.remove("is-zoomed"); img.style.transform = ""; }
    function applyTransform() { img.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + (zoom ? 2 : 1) + ")"; }
    function clampPan() { var r = stage.getBoundingClientRect(), mx = r.width / 2, my = r.height / 2; tx = Math.max(-mx, Math.min(mx, tx)); ty = Math.max(-my, Math.min(my, ty)); }
    function toggleZoom() { zoom = !zoom; tx = 0; ty = 0; img.classList.toggle("is-zoomed", zoom); applyTransform(); }

    var down = null;
    stage.addEventListener("pointerdown", function (e) { down = { x: e.clientX, y: e.clientY, tx: tx, ty: ty, t: Date.now(), moved: false }; stage.setPointerCapture(e.pointerId); });
    stage.addEventListener("pointermove", function (e) {
      if (!down) return;
      var dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) down.moved = true;
      if (zoom) { tx = down.tx + dx; ty = down.ty + dy; clampPan(); applyTransform(); }
    });
    stage.addEventListener("pointerup", function (e) {
      if (!down) return;
      var dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!zoom && down.moved) {
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
        else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) close();
      }
      down = null;
    });
    img.addEventListener("dblclick", function (e) { e.preventDefault(); toggleZoom(); });
    prevBtn.addEventListener("click", function () { go(-1); });
    nextBtn.addEventListener("click", function () { go(1); });
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (root.hidden) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "Tab") trapFocus(e);
    });
    function trapFocus(e) {
      var f = Array.prototype.filter.call(root.querySelectorAll("button:not([hidden])"), function (b) { return b.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return { open: open };
  }

  /* ---------- icons + clipboard ---------- */

  function cameraIcon() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
      '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" ' +
      'd="M4 9.5a2 2 0 0 1 2-2h1.2l1-1.6a1 1 0 0 1 .85-.47h4.9a1 1 0 0 1 .85.47l1 1.6H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>' +
      '<circle cx="12" cy="13" r="3.1" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  }
  function bagIcon() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" ' +
      'd="M6 8h12l-1 11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/>' +
      '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M9 8V6.5a3 3 0 0 1 6 0V8"/></svg>';
  }

  function copyText(text, btn, okLabel) {
    function flash() {
      if (!btn) return;
      var prev = btn.textContent;
      btn.textContent = okLabel || "Copied!";
      btn.classList.add("copied");
      setTimeout(function () { btn.textContent = prev; btn.classList.remove("copied"); }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash, function () { legacyCopy(text); flash(); });
    } else { legacyCopy(text); flash(); }
  }
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  /* ---------- helpers ---------- */

  function showLoading() {
    if (els.count) els.count.textContent = "";
    if (els.pager) els.pager.innerHTML = "";
    els.grid.innerHTML =
      '<div class="loading"><span class="spinner" aria-hidden="true"></span>' +
      '<span>Loading items…</span></div>';
  }

  function showError(err, retryable) {
    if (els.count) els.count.textContent = "";
    if (els.pager) els.pager.innerHTML = "";
    var msg = escapeHTML(err && err.message ? err.message : String(err));
    els.grid.innerHTML =
      '<div class="error"><strong>Could not load the sale items.</strong><br>' + msg +
      (retryable ? '<br><br><button type="button" class="retry-btn">Try again</button>' : "") +
      "</div>";
    if (retryable) {
      var b = els.grid.querySelector(".retry-btn");
      if (b) b.addEventListener("click", loadData);
    }
  }
  function uniqueSorted(arr) {
    var seen = {}, out = [];
    arr.forEach(function (v) { if (!seen[v]) { seen[v] = true; out.push(v); } });
    return out.sort(function (a, b) { return a.localeCompare(b); });
  }
  function positiveInt(v, fallback) { var n = parseInt(v, 10); return isNaN(n) || n < 1 ? fallback : n; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function escapeHTML(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
})();
