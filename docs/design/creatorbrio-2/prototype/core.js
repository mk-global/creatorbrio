/*
 * CreatorBrio 2.0 prototype core: state, hash router, shell, menus, dialogs,
 * toasts and slide scaling. Classic script so the page opens from file://.
 * All state is in memory and resets on reload.
 */
(function () {
  "use strict";

  var D = window.CB_DATA;
  var ICONS = window.CB_ICONS;
  var esc = D.esc;

  var FORMATS = {
    carousel: { label: "Instagram Carousel", plural: "Instagram Carousels", short: "Carousel", icon: "layers", desc: "Slides people swipe through on Instagram.", out: "PNG images, exact Instagram sizes", ratio: "4:5" },
    document: { label: "LinkedIn Document", plural: "LinkedIn Documents", short: "Document", icon: "file-text", desc: "A multi-page post whose text stays searchable.", out: "One PDF for LinkedIn", ratio: "4:5" },
    cover: { label: "Reel Cover", plural: "Reel Covers", short: "Reel cover", icon: "rectangle-vertical", desc: "One 9:16 image for the cover of a Reel.", out: "One PNG, 1080 × 1920", ratio: "9:16" },
    video: { label: "Video Studio", plural: "Videos", short: "Video", icon: "clapperboard", desc: "Edit a Reel by hand from your own footage.", out: "MP4 checked for Instagram Reels" }
  };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  var emptyBrand = {
    id: "default", name: "", isDefault: true,
    colors: { primary: "#1a1a2e", secondary: "#16213e", accent: "#e94560", background: "#ffffff", surface: "#f5f5f5" },
    fonts: { heading: "Inter", body: "Inter" }, keywords: [], logo: ""
  };

  var state = {
    data: "populated",
    paired: true,
    claude: true,
    brandId: "northwind",
    populated: { brands: clone(D.brands), projects: clone(D.projects), templates: clone(D.templates), productions: clone(D.productions) },
    empty: { brands: [clone(emptyBrand)], projects: [], templates: [], productions: [] },
    projectsView: { scope: "brand", format: "all", q: "", sort: "edited", view: "grid", limit: 24 },
    templatesFormat: "all",
    editor: { slide: 0, tab: "preview", safe: false },
    brandDraft: null
  };

  function store() { return state.data === "empty" ? state.empty : state.populated; }
  function brands() { return store().brands; }
  function brandById(id) {
    var list = brands();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }
  function activeBrand() { return brandById(state.brandId); }
  // A brand not yet set up is the default brand; it is never called "unnamed".
  function brandName(b) { return b.name.trim() || "Default brand"; }
  function projectById(id) {
    var list = store().projects;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function icon(name, cls) {
    return "<svg class=\"i " + (cls || "") + "\" viewBox=\"0 0 24 24\" aria-hidden=\"true\">" + (ICONS[name] || "") + "</svg>";
  }

  function ago(ms) {
    var diff = D.now - ms;
    var h = Math.round(diff / 3600000);
    if (h < 1) return "Just now";
    if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    var d = Math.round(h / 24);
    if (d === 1) return "Yesterday";
    if (d < 7) return d + " days ago";
    return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  function agoLower(ms) {
    var text = ago(ms);
    return /ago$|^Yesterday$|^Just now$/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : "on " + text;
  }

  function monogram(b, size) {
    var s = size || 30;
    return "<span class=\"monogram\" style=\"width:" + s + "px;height:" + s + "px;background:" + b.colors.primary + ";color:" + b.colors.background + "\">" +
      esc((b.name.trim() || "?").charAt(0).toUpperCase()) + "</span>";
  }
  function swatches(b) {
    var c = b.colors;
    return "<span class=\"swatches\" aria-hidden=\"true\"><span style=\"background:" + c.primary + "\"></span><span style=\"background:" + c.accent + "\"></span><span style=\"background:" + c.background + "\"></span></span>";
  }

  // ----- Slide rendering: native-size HTML scaled into its box -----
  function slideBox(project, index, widthCss, extraStyle) {
    var b = brandById(project.brand);
    var d = D.DIM[project.ratio];
    var slide = project.slides[index];
    return "<div class=\"slide-box\" data-native-w=\"" + d[0] + "\" style=\"" + widthCss + ";aspect-ratio:" + d[0] + "/" + d[1] + ";" + (extraStyle || "") + "\">" +
      D.slideHtml(b, project.ratio, slide, index, project.slides.length) + "</div>";
  }
  function brandSampleSlide(b, ratio, slide, widthCss) {
    var d = D.DIM[ratio];
    return "<div class=\"slide-box\" data-native-w=\"" + d[0] + "\" style=\"" + widthCss + ";aspect-ratio:" + d[0] + "/" + d[1] + "\">" +
      D.slideHtml(b, ratio, slide, 0, 1) + "</div>";
  }
  function fitSlides(root) {
    var boxes = (root || document).querySelectorAll(".slide-box");
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      var native = Number(box.getAttribute("data-native-w"));
      var inner = box.firstElementChild;
      if (inner && native) inner.style.transform = "scale(" + box.clientWidth / native + ")";
    }
  }
  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () { fitSlides(); }, 60);
  });

  // A project thumbnail: the first slide at its true proportions, with a hint of the pages behind it.
  function thumb(project) {
    if (!project.slides.length) {
      return "<div class=\"thumb\"><div class=\"empty-thumb\">" + icon("circle-dashed", "lg") + "<span>No slides yet</span></div></div>";
    }
    var w = project.ratio === "9:16" ? "width:47%" : project.ratio === "1:1" ? "width:74%" : "width:70%";
    var many = project.slides.length > 1;
    var stack = "";
    if (many) {
      var offs = project.format === "document" ? "translate(6px,6px)" : "translate(9px,0)";
      stack = "<div class=\"stack\" style=\"" + w + ";aspect-ratio:" + D.DIM[project.ratio][0] + "/" + D.DIM[project.ratio][1] + ";transform:" + offs + "\"></div>";
    }
    return "<div class=\"thumb\">" + stack + "<div class=\"frame\" style=\"" + w + "\">" + slideBox(project, 0, "width:100%") + "</div></div>";
  }

  function formatChip(format) {
    var f = FORMATS[format];
    return "<span class=\"chip\">" + icon(f.icon) + esc(f.short) + "</span>";
  }

  // ----- Router -----
  function parseRoute() {
    var hash = window.location.hash.replace(/^#\/?/, "");
    var q = {};
    var parts = hash.split("?");
    if (parts[1]) {
      parts[1].split("&").forEach(function (kv) {
        var p = kv.split("=");
        q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || "");
      });
    }
    var segs = parts[0].split("/").filter(Boolean);
    return { name: segs[0] || "home", segs: segs, q: q };
  }
  function go(path) { window.location.hash = "#/" + path; }

  function applyQueryState(q) {
    if (q.data && ["populated", "empty", "loading", "error"].indexOf(q.data) >= 0) state.data = q.data;
    if (q.paired) state.paired = q.paired === "1";
    if (q.claude) state.claude = q.claude === "1";
    if (q.brand && brandById(q.brand).id === q.brand) state.brandId = q.brand;
    if (!brands().some(function (b) { return b.id === state.brandId; })) state.brandId = brands()[0].id;
  }

  // ----- Shell -----
  var NAV = [
    { id: "home", label: "Home", icon: "house" },
    { id: "projects", label: "Projects", icon: "folder-open" },
    { id: "templates", label: "Templates", icon: "layout-template" },
    { id: "brands", label: "Brands", icon: "palette" },
    { id: "studio", label: "Video Studio", icon: "clapperboard", tag: "Early" }
  ];

  function brandSwitchButton() {
    var b = activeBrand();
    return "<button class=\"brand-switch\" data-action=\"brand-menu\" aria-haspopup=\"menu\" aria-label=\"Brand: " + esc(brandName(b)) + ". Switch brand\">" +
      monogram(b) + "<span class=\"bs-text\"><span class=\"bs-label\">Brand</span><span class=\"bs-name\">" + esc(brandName(b)) + "</span></span>" + icon("chevron-down", "sm") + "</button>";
  }

  function sidebar(current) {
    var links = NAV.map(function (n) {
      return "<a href=\"#/" + n.id + "\"" + (current === n.id ? " aria-current=\"page\"" : "") + ">" + icon(n.icon) + "<span>" + n.label + "</span>" +
        (n.tag ? "<span class=\"nav-tag tag-early\">" + n.tag + "</span>" : "") + "</a>";
    }).join("");
    return "<aside class=\"sidebar\" aria-label=\"Main\">" +
      "<a class=\"wordmark\" href=\"#/home\" aria-label=\"CreatorBrio home\"><span class=\"mark\">" + icon("layers") + "</span><span class=\"wm-text\">CreatorBrio</span></a>" +
      brandSwitchButton() +
      "<button class=\"btn btn-primary btn-create\" data-action=\"create\" aria-label=\"Create\">" + icon("plus") + "<span class=\"bc-text\">Create</span></button>" +
      "<nav class=\"nav\">" + links + "</nav>" +
      "<div class=\"nav nav-bottom\"><a href=\"#/settings\"" + (current === "settings" ? " aria-current=\"page\"" : "") + ">" + icon("settings") + "<span>Settings</span></a>" +
      "<p class=\"local-note\">" + icon("hard-drive", "sm") + "<span>Your work is saved as files on this computer.</span></p></div>" +
      "</aside>";
  }

  function topbar() {
    return "<header class=\"topbar\"><a class=\"wordmark\" href=\"#/home\" aria-label=\"CreatorBrio home\"><span class=\"mark\">" + icon("layers") + "</span></a>" +
      brandSwitchButton() +
      "<a class=\"btn btn-ghost btn-icon\" href=\"#/settings\" aria-label=\"Settings\">" + icon("settings") + "</a></header>";
  }

  function tabbar(current) {
    function tab(id, label, ic) {
      return "<a href=\"#/" + id + "\"" + (current === id ? " aria-current=\"page\"" : "") + ">" + icon(ic) + "<span>" + label + "</span></a>";
    }
    return "<nav class=\"tabbar\" aria-label=\"Main\">" + tab("home", "Home", "house") + tab("projects", "Projects", "folder-open") +
      "<button class=\"tb-create\" data-action=\"create\" aria-label=\"Create\"><span class=\"plus\">" + icon("plus") + "</span><span>Create</span></button>" +
      tab("templates", "Templates", "layout-template") +
      "<button data-action=\"more-menu\" aria-haspopup=\"menu\"" + (["brands", "studio", "settings"].indexOf(current) >= 0 ? " aria-current=\"page\"" : "") + ">" + icon("menu") + "<span>More</span></button></nav>";
  }

  function protoBar() {
    function sel(name, value, options) {
      return "<select data-proto=\"" + name + "\">" + options.map(function (o) {
        return "<option value=\"" + o[0] + "\"" + (o[0] === value ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("") + "</select>";
    }
    return "<div class=\"proto-bar\" role=\"region\" aria-label=\"Prototype controls\"><strong>Prototype</strong><span>Synthetic data. Nothing is saved.</span>" +
      "<button class=\"proto-toggle\" data-action=\"proto-toggle\" aria-expanded=\"false\">States</button>" +
      "<span class=\"proto-controls\"><span class=\"proto-spacer\"></span>" +
      "<label>Data " + sel("data", state.data, [["populated", "Populated"], ["empty", "First run (empty)"], ["loading", "Loading"], ["error", "Load error"]]) + "</label>" +
      "<label>Studio " + sel("paired", state.paired ? "1" : "0", [["1", "Paired"], ["0", "Not paired"]]) + "</label>" +
      "<label>Claude Code " + sel("claude", state.claude ? "1" : "0", [["1", "Connected"], ["0", "Not connected"]]) + "</label>" +
      "<label><input type=\"checkbox\" data-proto=\"illus\"" + (document.body.classList.contains("show-illustrative") ? " checked" : "") + "> Mark illustrative controls</label>" +
      "<a href=\"../index.html\">Review package</a></span></div>";
  }

  // ----- Toasts -----
  function toast(message, opts) {
    var o = opts || {};
    var wrap = document.querySelector(".toast-wrap");
    var el = document.createElement("div");
    el.className = "toast" + (o.illus ? " illus" : "");
    el.setAttribute("role", "status");
    el.innerHTML = (o.illus ? "<span class=\"t-tag\">Illustrative</span>" : "") + "<span class=\"t-msg\">" + esc(message) + "</span>" +
      (o.undo ? "<button type=\"button\">Undo</button>" : "");
    if (o.undo) {
      el.querySelector("button").addEventListener("click", function () { o.undo(); el.remove(); });
    }
    wrap.innerHTML = "";
    wrap.appendChild(el);
    window.setTimeout(function () { if (el.parentNode) el.remove(); }, o.illus ? 6000 : 4500);
  }

  // ----- Menus -----
  var openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    var trigger = openMenu.trigger;
    openMenu.el.remove();
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    openMenu = null;
    if (trigger && document.contains(trigger)) trigger.focus();
  }
  function showMenu(trigger, html, align) {
    closeMenu();
    var el = document.createElement("div");
    el.className = "menu";
    el.setAttribute("role", "menu");
    el.innerHTML = html;
    document.body.appendChild(el);
    var r = trigger.getBoundingClientRect();
    var w = el.offsetWidth;
    var left = align === "right" ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    var top = r.bottom + 6 + window.scrollY;
    if (r.bottom + el.offsetHeight + 12 > window.innerHeight && r.top > el.offsetHeight + 12) top = r.top - el.offsetHeight - 6 + window.scrollY;
    el.style.left = left + "px";
    el.style.top = top + "px";
    trigger.setAttribute("aria-expanded", "true");
    openMenu = { el: el, trigger: trigger };
    var first = el.querySelector("button,a");
    if (first) first.focus();
  }
  function menuItem(action, label, ic, extra) {
    return "<button role=\"menuitem\" data-action=\"" + action + "\"" + (extra || "") + ">" + (ic ? icon(ic) : "") + "<span>" + label + "</span></button>";
  }

  // ----- Dialogs -----
  var openDialog = null;
  function showDialog(html, opts) {
    closeDialog();
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = "<div class=\"dialog" + (opts && opts.small ? " small" : "") + "\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"dlg-title\">" + html + "</div>";
    document.body.appendChild(scrim);
    openDialog = { el: scrim, returnTo: document.activeElement };
    scrim.addEventListener("mousedown", function (e) { if (e.target === scrim) closeDialog(); });
    var focusable = scrim.querySelector("[autofocus]") || scrim.querySelector("button,input,select,textarea");
    if (focusable) focusable.focus();
    return scrim;
  }
  function closeDialog() {
    if (!openDialog) return;
    var back = openDialog.returnTo;
    openDialog.el.remove();
    openDialog = null;
    if (back && document.contains(back)) back.focus();
  }
  function confirmDialog(title, body, confirmLabel, onConfirm) {
    var el = showDialog("<div class=\"dialog-head\"><h2 id=\"dlg-title\" class=\"t-h2\">" + esc(title) + "</h2></div>" +
      "<div class=\"dialog-body\"><p class=\"muted\">" + esc(body) + "</p></div>" +
      "<div class=\"dialog-foot\"><div class=\"df-right\"><button class=\"btn btn-secondary\" data-dlg=\"cancel\" autofocus>Cancel</button>" +
      "<button class=\"btn btn-danger\" data-dlg=\"ok\">" + esc(confirmLabel) + "</button></div></div>", { small: true });
    el.querySelector("[data-dlg=cancel]").addEventListener("click", closeDialog);
    el.querySelector("[data-dlg=ok]").addEventListener("click", function () { closeDialog(); onConfirm(); });
  }

  // ----- Render -----
  var views = {};
  var lastRouteKey = "";
  function render() {
    var route = parseRoute();
    applyQueryState(route.q);
    closeMenu();
    var app = document.getElementById("app");
    var full = route.name === "editor" || (route.name === "studio" && route.segs[1]);
    var view = views[route.name] || views.home;
    var body;
    try {
      body = view(route);
    } catch (err) {
      full = false;
      body = "<div class=\"banner danger\" role=\"alert\">" + icon("circle-alert") + "<div class=\"b-body\"><div class=\"b-title\">This prototype screen failed to draw</div><div class=\"t-small\">" + esc(String(err && err.message)) + "</div></div></div>";
    }
    var shellName = route.name === "editor" ? "projects" : route.name;
    app.innerHTML = protoBar() + (full ? body : "<div class=\"app\">" + sidebar(shellName) + "<div class=\"main\">" + topbar() +
      "<main id=\"main\" class=\"page\" tabindex=\"-1\">" + body + "</main></div></div>" + tabbar(shellName));
    fitSlides();
    if (window.CB.after) window.CB.after(route);
    var key = route.segs.join("/");
    if (key !== lastRouteKey) {
      lastRouteKey = key;
      window.scrollTo(0, 0);
      var heading = document.querySelector("main h1, .editor h1");
      if (heading) document.title = heading.textContent + " - CreatorBrio prototype";
    }
  }

  // ----- Global events -----
  var actions = {};
  document.addEventListener("click", function (e) {
    var target = e.target.closest("[data-action]");
    if (openMenu && !e.target.closest(".menu") && (!target || target !== openMenu.trigger)) closeMenu();
    if (!target) return;
    var name = target.getAttribute("data-action");
    if (name === "illus") {
      e.preventDefault();
      toast(target.getAttribute("data-illustrative") || "This control is illustrative in the prototype.", { illus: true });
      return;
    }
    if (actions[name]) {
      e.preventDefault();
      actions[name](target, e);
    }
  });
  document.addEventListener("change", function (e) {
    var proto = e.target.getAttribute && e.target.getAttribute("data-proto");
    if (!proto) return;
    if (proto === "illus") {
      document.body.classList.toggle("show-illustrative", e.target.checked);
      return;
    }
    if (proto === "data") state.data = e.target.value;
    if (proto === "paired") state.paired = e.target.value === "1";
    if (proto === "claude") state.claude = e.target.value === "1";
    if (!brands().some(function (b) { return b.id === state.brandId; })) state.brandId = brands()[0].id;
    var route = parseRoute();
    window.location.hash = "#/" + route.segs.join("/");
    render();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (openMenu) { closeMenu(); return; }
      if (openDialog) { closeDialog(); return; }
    }
    if (openDialog && e.key === "Tab") {
      var nodes = Array.prototype.slice.call(openDialog.el.querySelectorAll("button:not([disabled]),input,select,textarea,a[href]"));
      if (nodes.length) {
        var firstNode = nodes[0];
        var lastNode = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === firstNode) { e.preventDefault(); lastNode.focus(); }
        else if (!e.shiftKey && document.activeElement === lastNode) { e.preventDefault(); firstNode.focus(); }
        else if (!openDialog.el.contains(document.activeElement)) { e.preventDefault(); firstNode.focus(); }
      }
    }
    if (openMenu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      var items = Array.prototype.slice.call(openMenu.el.querySelectorAll("button,a"));
      var i = items.indexOf(document.activeElement);
      var next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
    }
  });
  window.addEventListener("hashchange", render);

  actions["proto-toggle"] = function (btn) {
    var bar = btn.closest(".proto-bar");
    bar.classList.toggle("open");
    btn.setAttribute("aria-expanded", bar.classList.contains("open") ? "true" : "false");
  };

  actions["brand-menu"] = function (btn) {
    var html = "<div class=\"m-label\">Show work for</div>" + brands().map(function (b) {
      return "<button role=\"menuitemradio\" aria-checked=\"" + (b.id === state.brandId) + "\" data-action=\"switch-brand\" data-brand=\"" + b.id + "\">" +
        monogram(b, 24) + "<span>" + esc(brandName(b)) + "</span>" + (b.id === state.brandId ? "<span class=\"check\">" + icon("check", "sm") + "</span>" : "") + "</button>";
    }).join("") + "<hr>" + "<a role=\"menuitem\" href=\"#/brands\">" + icon("palette") + "<span>Manage brands</span></a>";
    showMenu(btn, html);
  };
  actions["switch-brand"] = function (btn) {
    var id = btn.getAttribute("data-brand");
    closeMenu();
    if (id === state.brandId) return;
    state.brandId = id;
    render();
    toast("Now showing " + brandName(activeBrand()) + ". Each project keeps the brand it was made with.");
  };
  actions["more-menu"] = function (btn) {
    showMenu(btn, "<a role=\"menuitem\" href=\"#/brands\">" + icon("palette") + "<span>Brands</span></a>" +
      "<a role=\"menuitem\" href=\"#/studio\">" + icon("clapperboard") + "<span>Video Studio</span><span class=\"tag-early\" style=\"margin-left:auto\">Early</span></a>" +
      "<a role=\"menuitem\" href=\"#/settings\">" + icon("settings") + "<span>Settings</span></a>", "right");
  };

  window.CB = {
    D: D, state: state, FORMATS: FORMATS, views: views, actions: actions,
    store: store, brands: brands, brandById: brandById, activeBrand: activeBrand, brandName: brandName, projectById: projectById,
    icon: icon, esc: esc, ago: ago, agoLower: agoLower, monogram: monogram, swatches: swatches, thumb: thumb, formatChip: formatChip,
    slideBox: slideBox, brandSampleSlide: brandSampleSlide, fitSlides: fitSlides,
    go: go, render: render, parseRoute: parseRoute, toast: toast, showMenu: showMenu, closeMenu: closeMenu, menuItem: menuItem,
    showDialog: showDialog, closeDialog: closeDialog, confirmDialog: confirmDialog, clone: clone
  };

  document.addEventListener("DOMContentLoaded", function () {
    document.body.classList.add("show-illustrative");
    render();
  });
})();
