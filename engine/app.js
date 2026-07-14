/* Garage Sale engine — generic and reusable. */
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
  var editingSearch = false; // true while consecutive search keystrokes coalesce into one history entry

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

  function loadItemsCSV(cfg) {
    var sheetUrl = sheetCsvUrl(cfg);
    if (!sheetUrl) return Promise.reject(new Error("No item data source is configured."));
    return fetchText(sheetUrl).then(function (txt) {
      if (!looksLikeCsv(txt)) {
        throw new Error("Couldn't load the sale data. Please try again in a moment.");
      }
      return txt;
    });
  }

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
    render("push");
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
    render("push");
  }

  function clearAllFilters() {
    state.query = ""; els.search.value = "";
    state.activeCategories.clear(); syncCategoryChecks();
    state.page = 1; render("push");
  }

  /* category dropdown open / close */
  function openCatMenu() {
    els.catMenu.hidden = false;
    els.catBackdrop.hidden = false;
    els.catToggle.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", onCatKeydown);
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
      var prevQuery = state.query;
      state.query = els.search.value.toLowerCase().trim();
      if (state.query === prevQuery) return;
      state.page = 1;
      render(editingSearch ? "replace" : "push");
      editingSearch = true;
    });
    els.sort.addEventListener("change", function () {
      state.sort = els.sort.value; state.page = 1; render("push");
    });
    els.showHidden.addEventListener("change", function () {
      state.view = els.showHidden.checked ? "hidden" : "available";
      state.page = 1; render("push");
    });
    els.catToggle.addEventListener("click", toggleCatMenu);
    els.catClear.addEventListener("click", clearCategories);
    els.catBackdrop.addEventListener("click", closeCatMenu);
    window.addEventListener("popstate", onPopState);
    var clampT;
    window.addEventListener("resize", function () {
      clearTimeout(clampT); clampT = setTimeout(markClamped, 150);
    });
  }

  /* ---------- URL state (shareable filtered views + cart) ---------- */

  function paramsFromURL() {
    try { return new URLSearchParams(location.search); } catch (e) { return null; }
  }

  // Reset to defaults first so a back/forward to a sparser URL clears the params
  // that are absent from it, rather than leaving stale filters in place.
  function syncFiltersFromURL(p) {
    state.query = "";
    state.view = "available";
    state.sort = DEFAULT_SORT;
    state.activeCategories.clear();
    state.page = 1;

    var q = p.get("q");
    els.search.value = q || "";
    if (q) state.query = q.toLowerCase();

    if (p.get("v") === "hidden") state.view = "hidden";
    els.showHidden.checked = state.view === "hidden";

    var s = p.get("s");
    if (s) state.sort = s;
    els.sort.value = state.sort;

    var c = p.get("c");
    if (c) c.split(",").forEach(function (name) { if (name) state.activeCategories.add(name); });
    syncCategoryChecks();

    var pg = parseInt(p.get("p"), 10);
    if (!isNaN(pg) && pg > 0) state.page = pg;
  }

  function readURL() {
    var p = paramsFromURL();
    if (!p) return false;
    syncFiltersFromURL(p);
    var cartParam = p.get("cart");
    if (cartParam != null) cart.setFromIds(cartParam.split(",").filter(Boolean));
    return cartParam != null;
  }

  function onPopState() {
    var p = paramsFromURL();
    if (!p) return;
    syncFiltersFromURL(p);
    render("none");
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

  function writeURL(nav) {
    if (!booted || nav === "none") return;
    try {
      var qs = currentParams().toString();
      var url = location.pathname + (qs ? "?" + qs : "") + location.hash;
      if (nav === "push") history.pushState(null, "", url);
      else history.replaceState(null, "", url);
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

  function render(nav) {
    editingSearch = false;
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
    markClamped();
    writeURL(nav);
  }

  // "Read more" only shows when the 2-line description is actually truncated.
  function markClamped() {
    Array.prototype.forEach.call(els.grid.querySelectorAll(".card"), function (cardEl) {
      var d = cardEl.querySelector(".card-desc");
      if (d) cardEl.classList.toggle("is-clamped", d.scrollHeight > d.clientHeight + 1);
    });
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
        state.activeCategories.delete(name); syncCategoryChecks(); state.page = 1; render("push");
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
    state.page = p; render("push");
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
    var condChip = it.condition
      ? '<span class="card-condition ' + conditionClass(it.condition) + '">' + escapeHTML(it.condition) + "</span>"
      : "";
    content.innerHTML =
      '<div class="card-head">' +
        '<h2 class="card-name">' + escapeHTML(it.name) + "</h2>" +
        '<div class="card-priceline">' +
          '<span class="card-price">' + priceHTML(it) + "</span>" +
          condChip +
        "</div>" +
      "</div>" +
      (it.quantity && it.quantity > 1 ? '<div class="card-qty">' + it.quantity + " available</div>" : "") +
      (it.description
        ? '<div class="card-descwrap"><p class="card-desc">' + escapeHTML(it.description) +
          '</p><button type="button" class="card-more">Read more</button></div>'
        : "");
    body.appendChild(content);

    if (it.description) {
      var more = content.querySelector(".card-more");
      more.setAttribute("aria-label", "Read more about " + it.name);
      more.addEventListener("click", function () { lb.open(it, 0); });
    }
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

  function syncCartButtons() {
    if (!cart) return;
    Array.prototype.forEach.call(document.querySelectorAll(".cart-add"), syncCartButton);
  }

  function buildMedia(it) {
    var hasPhotos = it.photos.length > 0;
    var media = document.createElement("button");
    media.type = "button";
    media.className = "card-media" + (hasPhotos ? "" : " is-empty");
    media.setAttribute("aria-label", (hasPhotos ? "View photos of " : "View details of ") + it.name);
    media.addEventListener("click", function () { lb.open(it, 0); });
    if (hasPhotos) {
      var first = it.photos[0];
      media.appendChild(imgWithFallback([THUMB_DIR + first, WEB_DIR + first, IMG_BASE + first], it.name, media));
      if (it.photos.length > 1) {
        var pill = document.createElement("span");
        pill.className = "photo-count";
        pill.innerHTML = cameraIcon() + "<span>" + it.photos.length + "</span>";
        media.appendChild(pill);
      }
    } else {
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

  function priceHTML(it) {
    var html = formatPrice(it);
    if (it.fullPriceNum != null && it.fullPriceNum > 0) {
      html += ' <s class="card-full">' + (state.config.currency || "$") + fmtNum(it.fullPriceNum) + "</s>";
    }
    return html;
  }

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

  /* ---------- detail overlay (card modal + photo carousel) ---------- */

  function createLightbox() {
    var root = document.createElement("div");
    root.className = "lb"; root.hidden = true;
    root.innerHTML =
      '<div class="lb-backdrop"></div>' +
      '<div class="lb-card" role="dialog" aria-modal="true" aria-label="Item details">' +
        '<button class="lb-close" type="button" aria-label="Close (Esc)"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button>' +
        '<div class="lb-scroll">' +
        '<div class="lb-media">' +
          '<img class="lb-img" alt="" draggable="false" />' +
          '<button class="lb-nav lb-prev" type="button" aria-label="Previous photo"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/></svg></button>' +
          '<button class="lb-nav lb-next" type="button" aria-label="Next photo"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg></button>' +
          '<span class="lb-counter"></span>' +
          '<span class="lb-zoomhint" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>' +
        '</div>' +
        '<div class="lb-info">' +
          '<h2 class="lb-caption"></h2>' +
          '<div class="lb-meta"></div>' +
          '<p class="lb-desc"></p>' +
        '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    var media = root.querySelector(".lb-media");
    var img = root.querySelector(".lb-img");
    var caption = root.querySelector(".lb-caption");
    var counter = root.querySelector(".lb-counter");
    var meta = root.querySelector(".lb-meta");
    var desc = root.querySelector(".lb-desc");
    var prevBtn = root.querySelector(".lb-prev");
    var nextBtn = root.querySelector(".lb-next");
    var closeBtn = root.querySelector(".lb-close");
    var backdrop = root.querySelector(".lb-backdrop");
    var card = root.querySelector(".lb-card");
    var info = root.querySelector(".lb-info");

    var cur = { item: null, index: 0 }, lastFocus = null;
    var scale = 1, tx = 0, ty = 0, gStart = null, lastTap = 0;

    function open(item, index) {
      cur.item = item; cur.index = index || 0; lastFocus = document.activeElement;
      show(); root.hidden = false;
      document.body.classList.add("lb-open"); closeBtn.focus();
    }
    function close() {
      root.hidden = true; document.body.classList.remove("lb-open");
      img.removeAttribute("src");
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    function detailMeta(item) {
      var html = '<span class="card-price">' + priceHTML(item) + "</span>";
      if (item.condition) html += '<span class="card-condition ' + conditionClass(item.condition) + '">' + escapeHTML(item.condition) + "</span>";
      return html;
    }
    // Size the card to the photo's aspect ratio so it fills the modal without
    // cropping or large empty margins.
    function fitCard() {
      card.style.width = ""; media.style.aspectRatio = "";
      if (!cur.item || !cur.item.photos.length || !img.naturalWidth) return;
      var maxW = Math.min(window.innerWidth - 32, 1100);   // account for .lb padding
      var maxH = 0.72 * window.innerHeight;                 // leave room for the info below
      var aspect = img.naturalWidth / img.naturalHeight;
      // width drives the media box; aspect-ratio (exact) sets its height, so the
      // photo fills it with no sub-pixel letterbox and no crop.
      card.style.width = Math.round(Math.min(maxW, maxH * aspect)) + "px";
      media.style.aspectRatio = img.naturalWidth + " / " + img.naturalHeight;
    }
    function show() {
      var item = cur.item, photos = item.photos, multi = photos.length > 1;
      root.classList.toggle("lb--media", photos.length > 0);
      media.hidden = photos.length === 0;
      resetZoom();
      // Keep the media box sized during photo-to-photo navigation (fitCard
      // recomputes on load); only collapse it for photoless items.
      if (!photos.length) { card.style.width = ""; media.style.aspectRatio = ""; }
      caption.textContent = item.name;
      meta.innerHTML = detailMeta(item);
      desc.textContent = item.description || "";
      desc.hidden = !item.description;
      prevBtn.hidden = !multi; nextBtn.hidden = !multi; counter.hidden = !multi;
      if (photos.length) {
        var name = photos[cur.index];
        img.onload = fitCard;
        img.onerror = function () { img.onerror = null; img.src = IMG_BASE + name; };
        img.src = WEB_DIR + name;
        img.alt = item.name + " — photo " + (cur.index + 1) + " of " + photos.length;
        counter.textContent = (cur.index + 1) + " / " + photos.length;
        if (img.complete && img.naturalWidth) fitCard();
        preload(cur.index + 1); preload(cur.index - 1);
      }
    }
    function preload(i) { var photos = cur.item.photos; if (i < 0 || i >= photos.length) return; var p = new Image(); p.src = WEB_DIR + photos[i]; }
    function go(delta) { var n = cur.item.photos.length; if (!n) return; cur.index = (cur.index + delta + n) % n; show(); }

    prevBtn.addEventListener("click", function () { go(-1); });
    nextBtn.addEventListener("click", function () { go(1); });
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    window.addEventListener("resize", function () { if (!root.hidden) fitCard(); });

    // Pinch or double-tap to zoom, drag to pan; swipe left/right to change
    // photo, swipe down to close.
    function applyTransform() { img.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")"; }
    function resetZoom() { scale = 1; tx = 0; ty = 0; img.style.transform = ""; img.classList.remove("is-zoomed"); }
    function clampPan() {
      var r = media.getBoundingClientRect();
      var maxX = (scale - 1) * r.width / 2, maxY = (scale - 1) * r.height / 2;
      tx = Math.max(-maxX, Math.min(maxX, tx));
      ty = Math.max(-maxY, Math.min(maxY, ty));
    }
    function toggleZoom() {
      if (scale > 1) resetZoom();
      else { scale = 2; tx = 0; ty = 0; img.classList.add("is-zoomed"); applyTransform(); }
    }
    var pointers = {}, pinch = null;
    function activeIds() { return Object.keys(pointers); }
    function twoFingerDist() { var ids = activeIds(); return Math.hypot(pointers[ids[0]].x - pointers[ids[1]].x, pointers[ids[0]].y - pointers[ids[1]].y); }
    media.addEventListener("pointerdown", function (e) {
      if (e.target.closest("button")) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      try { media.setPointerCapture(e.pointerId); } catch (err) {}
      if (activeIds().length === 2) { pinch = { dist: twoFingerDist(), scale: scale }; gStart = null; }
      else if (activeIds().length === 1) { gStart = { x: e.clientX, y: e.clientY, tx: tx, ty: ty, id: e.pointerId, moved: false }; }
    });
    media.addEventListener("pointermove", function (e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (pinch && activeIds().length >= 2) {
        scale = Math.max(1, Math.min(4, pinch.scale * (twoFingerDist() / pinch.dist)));
        img.classList.toggle("is-zoomed", scale > 1);
        clampPan(); applyTransform();
        return;
      }
      if (gStart && e.pointerId === gStart.id) {
        if (Math.abs(e.clientX - gStart.x) > 6 || Math.abs(e.clientY - gStart.y) > 6) gStart.moved = true;
        if (scale > 1) { media.classList.add("is-panning"); tx = gStart.tx + (e.clientX - gStart.x); ty = gStart.ty + (e.clientY - gStart.y); clampPan(); applyTransform(); }
      }
    });
    media.addEventListener("pointerup", function (e) {
      var endingPinch = pinch && activeIds().length >= 2;
      delete pointers[e.pointerId];
      media.classList.remove("is-panning");
      if (endingPinch) {
        pinch = null; gStart = null;
        if (scale <= 1.02) resetZoom();
        return;
      }
      if (!gStart || e.pointerId !== gStart.id) return;
      var dx = e.clientX - gStart.x, dy = e.clientY - gStart.y, moved = gStart.moved;
      gStart = null;
      if (!moved) {
        // Mouse: single click toggles zoom (matches the zoom-in/out cursor).
        // Touch/pen: double-tap toggles zoom (a single tap must not).
        if (e.pointerType === "mouse") { toggleZoom(); return; }
        var now = Date.now();
        if (now - lastTap < 300) { lastTap = 0; toggleZoom(); } else lastTap = now;
        return;
      }
      if (scale > 1) return;
      if (e.pointerType !== "touch") return;
      if (cur.item.photos.length > 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) close();
    });
    media.addEventListener("pointercancel", function (e) { delete pointers[e.pointerId]; pinch = null; gStart = null; media.classList.remove("is-panning"); });
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
