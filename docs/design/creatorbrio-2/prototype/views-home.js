/*
 * Home, Projects and Templates views for the CreatorBrio 2.0 prototype.
 */
(function () {
  "use strict";

  var CB = window.CB;
  var state = CB.state;
  var icon = CB.icon;
  var esc = CB.esc;
  var F = CB.FORMATS;

  function brandProjects() {
    return CB.store().projects.filter(function (p) { return p.brand === state.brandId; })
      .sort(function (a, b) { return b.edited - a.edited; });
  }

  function projectCard(p, showBrand) {
    var b = CB.brandById(p.brand);
    var count = p.slides.length;
    var countText = p.format === "cover" ? "" : (count === 1 ? "1 slide" : count + (p.format === "document" ? " pages" : " slides"));
    return "<article class=\"pcard\">" +
      "<button class=\"pcard-open\" data-action=\"open-project\" data-id=\"" + p.id + "\" aria-label=\"Open " + esc(p.name) + "\">" + CB.thumb(p) + "</button>" +
      "<button class=\"btn btn-sm btn-icon menu-btn\" data-action=\"project-menu\" data-id=\"" + p.id + "\" aria-haspopup=\"menu\" aria-label=\"More actions for " + esc(p.name) + "\">" + icon("ellipsis", "sm") + "</button>" +
      "<div class=\"pmeta\"><span class=\"pname\" title=\"" + esc(p.name) + "\">" + esc(p.name) + "</span>" +
      "<span class=\"psub\">" + CB.formatChip(p.format) + "</span>" +
      "<span class=\"psub\">" + (count === 0 ? "Empty draft · " : countText ? countText + " · " : "") + CB.ago(p.edited) + "</span>" +
      (showBrand ? "<span class=\"psub\"><span class=\"brand-dot\" style=\"background:" + b.colors.accent + "\"></span>" + esc(CB.brandName(b)) + "</span>" : "") +
      "</div></article>";
  }

  function formatArt(format, b) {
    var c = b ? b.colors : null;
    if (format === "carousel") {
      return "<div class=\"mini\" style=\"width:62px;aspect-ratio:4/5;background:" + c.background + ";transform:translate(-46px,6px) rotate(-7deg)\"><span class=\"mo\" style=\"background:" + c.accent + ";opacity:.25\"></span></div>" +
        "<div class=\"mini\" style=\"width:62px;aspect-ratio:4/5;background:" + c.background + ";transform:translate(46px,6px) rotate(7deg)\"><span class=\"mo\" style=\"background:" + c.accent + ";opacity:.25\"></span></div>" +
        "<div class=\"mini\" style=\"width:76px;aspect-ratio:4/5;background:" + c.primary + "\"><span class=\"mo\" style=\"background:" + c.accent + "\"></span>" +
        "<span class=\"ml\" style=\"top:46%;background:" + c.background + "\"></span><span class=\"ml\" style=\"top:56%;right:38%;background:" + c.background + "\"></span></div>";
    }
    if (format === "document") {
      var lines = "";
      for (var i = 0; i < 4; i++) lines += "<span class=\"ml\" style=\"top:" + (44 + i * 10) + "%;height:4%;right:" + (18 + (i % 2) * 18) + "%;background:" + c.primary + ";opacity:.35\"></span>";
      return "<div class=\"mini\" style=\"width:72px;aspect-ratio:4/5;background:#fff;transform:translate(14px,10px)\"></div>" +
        "<div class=\"mini\" style=\"width:72px;aspect-ratio:4/5;background:#fff;transform:translate(7px,5px)\"></div>" +
        "<div class=\"mini\" style=\"width:72px;aspect-ratio:4/5;background:" + c.background + "\"><span class=\"ml\" style=\"top:18%;height:9%;background:" + c.primary + "\"></span>" + lines + "</div>";
    }
    if (format === "cover") {
      return "<div class=\"mini\" style=\"width:60px;aspect-ratio:9/16;background:" + c.primary + ";border-radius:8px;box-shadow:0 0 0 3px #1c1917,0 10px 18px -8px rgba(28,25,23,.5)\">" +
        "<span class=\"mo\" style=\"background:" + c.accent + "\"></span><span class=\"ml\" style=\"top:48%;background:" + c.background + "\"></span><span class=\"ml\" style=\"top:56%;right:36%;background:" + c.background + "\"></span></div>";
    }
    return "<div class=\"timeline-art\"><div class=\"track\"><span class=\"clip\" style=\"width:38%;background:#4b5d7a\"></span><span class=\"clip\" style=\"width:30%;background:#5d7290\"></span><span class=\"clip\" style=\"width:22%;background:#4b5d7a\"></span></div>" +
      "<div class=\"track\"><span class=\"clip\" style=\"width:24%;margin-left:14%;background:#c28a3a\"></span><span class=\"clip\" style=\"width:20%;margin-left:12%;background:#c28a3a\"></span></div>" +
      "<div class=\"track\"><span class=\"clip\" style=\"width:92%;background:#3d6b55\"></span></div><span class=\"playhead\"></span></div>";
  }

  function formatCards(b) {
    return "<div class=\"formats\" role=\"list\">" + ["carousel", "document", "cover", "video"].map(function (key) {
      var f = F[key];
      return "<button class=\"format-card\" role=\"listitem\" data-action=\"" + (key === "video" ? "go-studio" : "create") + "\" data-format=\"" + key + "\">" +
        "<span class=\"format-art\" aria-hidden=\"true\"><span class=\"fa-inner\">" + formatArt(key, b) + "</span></span>" +
        "<span class=\"format-body\"><span class=\"fname\">" + esc(f.label) + (key === "video" ? " <span class=\"tag-early\">Early</span>" : "") + "</span>" +
        "<span class=\"fdesc\">" + esc(f.desc) + "</span><span class=\"fout\">" + icon(key === "video" ? "film" : "download", "sm") + esc(f.out) + "</span></span></button>";
    }).join("") + "</div>";
  }

  function claudeBanner() {
    if (state.claude) return "";
    return "<div class=\"banner warn\" role=\"status\" style=\"margin-bottom:20px\">" + icon("plug") + "<div class=\"b-body\"><div class=\"b-title\">Claude Code is not connected</div>" +
      "<div class=\"t-small\">You can open, arrange and export existing work. Designing new slides needs Claude Code installed and signed in on this computer.</div></div>" +
      "<a class=\"btn btn-secondary btn-sm\" href=\"#/settings\">How to connect</a></div>";
  }

  function quickCreate() {
    return "<form class=\"card quick\" data-quick>" +
      "<div class=\"field\"><label for=\"quick-about\">Start from an idea</label>" +
      "<div class=\"q-row\"><input id=\"quick-about\" class=\"input\" style=\"flex:1 1 260px\" placeholder=\"For example: three small habits for a calmer morning\" autocomplete=\"off\">" +
      "<select class=\"select\" style=\"width:auto;flex:0 0 auto\" aria-label=\"Format\" id=\"quick-format\">" +
      "<option value=\"carousel\">Instagram Carousel</option><option value=\"document\">LinkedIn Document</option><option value=\"cover\">Reel Cover</option></select></div></div>" +
      "<button class=\"btn btn-primary\" type=\"submit\">Continue" + icon("arrow-right", "sm") + "</button>" +
      "<p class=\"q-hint\">" + icon("info", "sm") + "<span>Your idea goes into the design chat. Nothing is designed until you press Send there; a five-slide design takes a few minutes.</span></p></form>";
  }

  function studioPanel() {
    var prods = CB.store().productions.slice(0, 2);
    var body;
    if (!state.paired) {
      body = "<p class=\"t-small muted\">Pair this browser once to open the Studio. It takes a code from a terminal command, for your security.</p>" +
        "<a class=\"btn btn-secondary\" href=\"#/studio\">" + icon("key-round", "sm") + "Pair and open</a>";
    } else if (!prods.length) {
      body = "<p class=\"t-small muted\">No productions yet. A production is one video: footage, music, titles and captions on a timeline.</p>" +
        "<a class=\"btn btn-secondary\" href=\"#/studio\">Open Video Studio</a>";
    } else {
      body = "<ul class=\"prod-list\" style=\"margin:0 -20px\">" + prods.map(function (v) {
        return "<li><a class=\"prod-row\" style=\"text-decoration:none\" href=\"#/studio/" + v.id + "\"><span class=\"pr-icon\">" + icon("film", "sm") + "</span>" +
          "<span class=\"pr-text\"><span class=\"pname\" style=\"display:block\">" + esc(v.name) + "</span><span class=\"t-caption muted num\">Revision " + v.revision + " · " + CB.ago(v.updated) + "</span></span>" + icon("chevron-right", "sm") + "</a></li>";
      }).join("") + "</ul><a class=\"link\" href=\"#/studio\">All productions" + icon("arrow-right", "sm") + "</a>";
    }
    return "<section class=\"card studio-panel\" aria-labelledby=\"home-studio\"><div class=\"sp-art\">" + formatArt("video") + "</div>" +
      "<div class=\"sp-body\"><div style=\"display:flex;align-items:center;gap:8px\"><h2 id=\"home-studio\" class=\"t-h3\">Video Studio</h2><span class=\"tag-early\">Early</span></div>" +
      "<p class=\"t-small muted\">Edit a Reel by hand. AI video editing is not built yet.</p>" + body + "</div></section>";
  }

  function brandPanel(b) {
    var c = b.colors;
    return "<section class=\"card panel brand-card-mini\" aria-labelledby=\"home-brand\">" +
      "<div style=\"display:flex;align-items:center;gap:10px\">" + CB.monogram(b, 36) + "<div style=\"min-width:0;flex:1\"><h2 id=\"home-brand\" class=\"t-h3\">" + esc(CB.brandName(b)) + "</h2>" +
      "<p class=\"t-caption muted\">Every new project uses this brand</p></div></div>" +
      "<div class=\"color-row\" aria-label=\"Brand colours\">" + ["primary", "secondary", "accent", "background", "surface"].map(function (k) {
        return "<span title=\"" + k + " " + c[k] + "\" style=\"background:" + c[k] + "\"></span>";
      }).join("") + "</div>" +
      "<div class=\"font-sample\"><b style=\"font-family:'" + esc(b.fonts.heading) + "',Georgia,serif\">Aa</b><span>" + esc(b.fonts.heading) + " / " + esc(b.fonts.body) + "</span></div>" +
      (b.keywords.length ? "<div class=\"kw\">" + b.keywords.map(function (k) { return "<span class=\"chip\">" + esc(k) + "</span>"; }).join("") + "</div>" : "") +
      "<a class=\"btn btn-secondary btn-sm\" href=\"#/brands/" + b.id + "\">" + icon("pencil", "sm") + "Edit brand</a></section>";
  }

  function templateStrip(b) {
    var list = CB.store().templates.filter(function (t) { return t.brand === b.id; }).slice(0, 3);
    if (!list.length) return "";
    return "<section class=\"section\" aria-labelledby=\"home-templates\"><div class=\"section-head\"><h2 id=\"home-templates\" class=\"t-h2\">Start from a template</h2>" +
      "<a class=\"link\" href=\"#/templates\">All templates" + icon("arrow-right", "sm") + "</a></div><div class=\"grid grid-4\">" + list.map(templateCard).join("") + "</div></section>";
  }

  function skeletonGrid(n) {
    var s = "";
    for (var i = 0; i < n; i++) s += "<div><div class=\"skeleton\" style=\"aspect-ratio:4/5\"></div><div class=\"skeleton\" style=\"height:14px;margin-top:12px;width:70%;border-radius:6px\"></div></div>";
    return "<div class=\"grid\" aria-busy=\"true\" aria-label=\"Loading projects\">" + s + "</div>";
  }

  function loadError() {
    return "<div class=\"banner danger\" role=\"alert\">" + icon("circle-alert") + "<div class=\"b-body\"><div class=\"b-title\">Couldn't load your projects</div>" +
      "<div class=\"t-small\">The projects file could not be read: <code class=\"path\">data/carousels.json</code> is not valid JSON. Nothing was deleted; your files were left as they are.</div></div>" +
      "<button class=\"btn btn-secondary btn-sm\" data-action=\"retry\">Try again</button></div>";
  }

  CB.views.home = function () {
    var b = CB.activeBrand();
    var firstRun = state.data === "empty";
    var head = "<div class=\"hero\"><div><h1 class=\"t-display\">What would you like to create?</h1>" +
      "<p class=\"brand-line\">" + (firstRun && !b.name.trim()
        ? "Set up your brand first and every design will use its colours and fonts."
        : "Creating for " + CB.swatches(b) + "<strong style=\"color:var(--ink);margin-right:8px\">" + esc(CB.brandName(b)) + "</strong><button class=\"link\" style=\"border:0;background:none;padding:0\" data-action=\"brand-menu\" aria-haspopup=\"menu\">Switch brand</button>") +
      "</p></div></div>";

    var out = claudeBanner() + head;

    if (firstRun && !b.name.trim()) {
      out += "<div class=\"card panel\" style=\"display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:20px\">" +
        "<span class=\"e-icon\" style=\"width:44px;height:44px;border-radius:12px;background:var(--accent-tint);color:var(--accent);display:grid;place-items:center\">" + icon("palette") + "</span>" +
        "<div style=\"flex:1 1 240px\"><h2 class=\"t-h3\">Set up your brand</h2><p class=\"t-small muted\">A name, five colours, two fonts and a few words about your style. About a minute; you can change it any time.</p></div>" +
        "<a class=\"btn btn-primary\" href=\"#/brands/" + b.id + "\">Set up brand</a></div>";
    }

    out += formatCards(b) + quickCreate();

    var recent;
    if (state.data === "loading") recent = skeletonGrid(4);
    else if (state.data === "error") recent = loadError();
    else {
      var list = brandProjects();
      if (!list.length) {
        recent = null;
      } else {
        recent = "<div class=\"grid grid-4\">" + list.slice(0, 4).map(function (p) { return projectCard(p, false); }).join("") + "</div>";
      }
    }

    var left;
    if (recent === null) {
      left = "<section class=\"section\" aria-labelledby=\"home-how\"><div class=\"section-head\"><h2 id=\"home-how\" class=\"t-h2\">How it works</h2></div><div class=\"steps\">" +
        "<div class=\"card step\"><span class=\"n\">1</span><h3 class=\"t-h3\">Pick a format</h3><p class=\"t-small muted\">An Instagram carousel, a LinkedIn document or a Reel cover. Your brand is already applied.</p></div>" +
        "<div class=\"card step\"><span class=\"n\">2</span><h3 class=\"t-h3\">Describe your post</h3><p class=\"t-small muted\">Tell the design chat what it is about. Claude plans the message and designs each slide in your colours and fonts.</p></div>" +
        "<div class=\"card step\"><span class=\"n\">3</span><h3 class=\"t-h3\">Review and export</h3><p class=\"t-small muted\">Ask for changes, reorder or undo slides, then export PNGs for Instagram or a searchable PDF for LinkedIn.</p></div>" +
        "</div></section>";
    } else {
      var total = brandProjects().length;
      left = "<section class=\"section\" aria-labelledby=\"home-recent\"><div class=\"section-head\"><h2 id=\"home-recent\" class=\"t-h2\">Continue creating</h2>" +
        (state.data === "populated" ? "<a class=\"link\" href=\"#/projects\">All " + total + " projects" + icon("arrow-right", "sm") + "</a>" : "") + "</div>" + recent + "</section>" +
        (state.data === "populated" ? templateStrip(b) : "");
    }

    out += "<div class=\"two-col\"><div>" + left + "</div><div class=\"section\" style=\"display:flex;flex-direction:column;gap:16px\">" + studioPanel() + (b.name.trim() ? brandPanel(b) : "") + "</div></div>";
    return out;
  };

  // ----- Projects -----
  function filteredProjects() {
    var v = state.projectsView;
    var q = v.q.trim().toLowerCase();
    var list = CB.store().projects.filter(function (p) {
      if (v.scope === "brand" && p.brand !== state.brandId) return false;
      if (v.format !== "all" && p.format !== v.format) return false;
      if (q && p.name.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    list.sort(function (a, b) {
      if (v.sort === "name") return a.name.localeCompare(b.name);
      return b.edited - a.edited;
    });
    return list;
  }

  function videosPanel() {
    if (!state.paired) {
      return "<div class=\"card empty\"><span class=\"e-icon\">" + CB.icon("key-round") + "</span><h2 class=\"t-h3\">Pair this browser to list your videos</h2>" +
        "<p>Videos live in the Video Studio, which opens only in a browser you have paired with this computer.</p><a class=\"btn btn-secondary\" href=\"#/studio\">Pair in Video Studio</a></div>";
    }
    var prods = CB.store().productions;
    if (!prods.length) {
      return "<div class=\"card empty\"><span class=\"e-icon\">" + CB.icon("clapperboard") + "</span><h2 class=\"t-h3\">No videos yet</h2><p>Start a production in the Video Studio.</p><a class=\"btn btn-secondary\" href=\"#/studio\">Open Video Studio</a></div>";
    }
    return "<p class=\"result-line\">" + prods.length + " productions · Videos are not tied to a brand yet</p><div class=\"card\"><ul class=\"prod-list\">" + prods.map(function (v) {
      return "<li><a class=\"prod-row\" style=\"text-decoration:none\" href=\"#/studio/" + v.id + "\"><span class=\"pr-icon\">" + icon("film", "sm") + "</span><span class=\"pr-text\"><span class=\"pname\" style=\"display:block\">" + esc(v.name) + "</span>" +
        "<span class=\"t-caption muted num\">Revision " + v.revision + " · Updated " + CB.agoLower(v.updated) + "</span></span>" + icon("chevron-right", "sm") + "</a></li>";
    }).join("") + "</ul></div>";
  }

  function listTable(items) {
    return "<table class=\"list-view\"><thead><tr><th>Name</th><th class=\"hide-sm\">Format</th><th class=\"hide-sm\">Brand</th><th>Edited</th><th><span class=\"sr-only\">Actions</span></th></tr></thead><tbody>" +
      items.map(function (p) {
        var b = CB.brandById(p.brand);
        var mini = p.slides.length ? "<div class=\"lv-thumb\">" + CB.slideBox(p, 0, "width:100%") + "</div>" : "<div class=\"lv-thumb\">" + icon("circle-dashed", "sm") + "</div>";
        return "<tr><td><div class=\"lv-name\">" + mini + "<button class=\"rowlink\" data-action=\"open-project\" data-id=\"" + p.id + "\">" + esc(p.name) + "</button></div></td>" +
          "<td class=\"hide-sm\">" + CB.formatChip(p.format) + "</td><td class=\"hide-sm\"><span class=\"psub\"><span class=\"brand-dot\" style=\"background:" + b.colors.accent + "\"></span>" + esc(CB.brandName(b)) + "</span></td>" +
          "<td class=\"num t-small muted\">" + CB.ago(p.edited) + "</td><td style=\"text-align:right\"><button class=\"btn btn-ghost btn-sm btn-icon\" data-action=\"project-menu\" data-id=\"" + p.id + "\" aria-haspopup=\"menu\" aria-label=\"More actions for " + esc(p.name) + "\">" + icon("ellipsis", "sm") + "</button></td></tr>";
      }).join("") + "</tbody></table>";
  }

  CB.views.projects = function () {
    var v = state.projectsView;
    var b = CB.activeBrand();
    var all = CB.store().projects;
    var scoped = all.filter(function (p) { return v.scope === "all" || p.brand === state.brandId; });
    function count(fmt) { return scoped.filter(function (p) { return fmt === "all" || p.format === fmt; }).length; }
    var chips = [["all", "All designs"], ["carousel", F.carousel.plural], ["document", F.document.plural], ["cover", F.cover.plural], ["video", "Videos"]].map(function (c) {
      var n = c[0] === "video" ? (state.paired ? CB.store().productions.length : "") : count(c[0]);
      return "<button class=\"fchip\" aria-pressed=\"" + (v.format === c[0]) + "\" data-action=\"pfilter\" data-format=\"" + c[0] + "\">" + c[1] + (n !== "" ? " <span class=\"count\">" + n + "</span>" : "") + "</button>";
    }).join("");

    var head = "<div class=\"page-head\"><div><h1 class=\"t-h1\">Projects</h1><p class=\"muted t-small\">" +
      (v.scope === "brand" ? "Everything made for " + esc(CB.brandName(b)) + "." : "Everything you have made, across all brands.") + "</p></div>" +
      "<button class=\"btn btn-primary\" data-action=\"create\">" + icon("plus", "sm") + "New project</button></div>";

    var toolbar = "<div class=\"toolbar\"><div class=\"search\">" + icon("search", "sm") + "<input class=\"input\" type=\"search\" placeholder=\"Search projects\" aria-label=\"Search projects\" data-psearch value=\"" + esc(v.q) + "\"></div>" +
      "<div class=\"tb-right\"><div class=\"seg\" role=\"group\" aria-label=\"Brand scope\"><button aria-pressed=\"" + (v.scope === "brand") + "\" data-action=\"pscope\" data-scope=\"brand\">This brand</button><button aria-pressed=\"" + (v.scope === "all") + "\" data-action=\"pscope\" data-scope=\"all\">All brands</button></div>" +
      "<select class=\"select\" style=\"width:auto\" aria-label=\"Sort\" data-psort><option value=\"edited\"" + (v.sort === "edited" ? " selected" : "") + ">Last edited</option><option value=\"name\"" + (v.sort === "name" ? " selected" : "") + ">Name</option></select>" +
      "<div class=\"seg view-toggle\" role=\"group\" aria-label=\"View\"><button aria-pressed=\"" + (v.view === "grid") + "\" data-action=\"pview\" data-view=\"grid\" aria-label=\"Grid view\">" + icon("layout-grid", "sm") + "</button><button aria-pressed=\"" + (v.view === "list") + "\" data-action=\"pview\" data-view=\"list\" aria-label=\"List view\">" + icon("list", "sm") + "</button></div></div></div>" +
      "<div class=\"filters\" role=\"group\" aria-label=\"Format\">" + chips + "</div>";

    var content;
    if (state.data === "loading") content = "<div style=\"margin-top:20px\">" + skeletonGrid(8) + "</div>";
    else if (state.data === "error") content = "<div style=\"margin-top:20px\">" + loadError() + "</div>";
    else if (v.format === "video") content = videosPanel();
    else {
      var items = filteredProjects();
      if (!all.length) {
        content = "<div class=\"card empty\" style=\"margin-top:20px\"><span class=\"e-icon\">" + icon("folder") + "</span><h2 class=\"t-h3\">No projects yet</h2><p>Projects are the carousels, documents and Reel covers you make. Your first one is a minute away.</p>" +
          "<button class=\"btn btn-primary\" data-action=\"create\">" + icon("plus", "sm") + "Create a project</button></div>";
      } else if (!items.length) {
        content = "<div class=\"card empty\" style=\"margin-top:20px\"><span class=\"e-icon\">" + icon("search") + "</span><h2 class=\"t-h3\">No projects match</h2><p>" +
          (v.q ? "Nothing named “" + esc(v.q) + "” " : "Nothing ") + "in this view. Try all brands or another format.</p><button class=\"btn btn-secondary\" data-action=\"pclear\">Clear filters</button></div>";
      } else {
        var shown = items.slice(0, v.limit);
        content = "<p class=\"result-line num\" aria-live=\"polite\">Showing " + shown.length + " of " + items.length + "</p>" +
          (v.view === "grid" ? "<div class=\"grid\">" + shown.map(function (p) { return projectCard(p, v.scope === "all"); }).join("") + "</div>" : listTable(shown)) +
          (items.length > shown.length ? "<div class=\"load-more\"><button class=\"btn btn-secondary\" data-action=\"pmore\">Show 24 more</button></div>" : "");
      }
    }
    return head + toolbar + content;
  };

  // ----- Templates -----
  function templateCard(t) {
    var src = CB.projectById(t.from) || { brand: t.brand, ratio: t.ratio, slides: [], format: t.format };
    var shown = { brand: t.brand, ratio: t.ratio, slides: src.slides, format: t.format, name: t.name };
    var n = src.slides.length;
    return "<article class=\"pcard\"><button class=\"pcard-open\" data-action=\"use-template\" data-id=\"" + t.id + "\" aria-label=\"Use template " + esc(t.name) + "\">" + CB.thumb(shown) + "</button>" +
      "<button class=\"btn btn-sm btn-icon menu-btn\" data-action=\"template-menu\" data-id=\"" + t.id + "\" aria-haspopup=\"menu\" aria-label=\"More actions for " + esc(t.name) + "\">" + icon("ellipsis", "sm") + "</button>" +
      "<div class=\"pmeta\"><span class=\"pname\">" + esc(t.name) + "</span><span class=\"psub\">" + CB.formatChip(t.format) + (n > 1 ? "<span>" + n + (t.format === "document" ? " pages" : " slides") + "</span>" : "") + "</span>" +
      "<button class=\"btn btn-secondary btn-sm\" style=\"margin-top:6px;align-self:flex-start\" data-action=\"use-template\" data-id=\"" + t.id + "\">Use template</button></div></article>";
  }
  CB.templateCard = templateCard;

  CB.views.templates = function () {
    var b = CB.activeBrand();
    var list = CB.store().templates.filter(function (t) { return t.brand === state.brandId && (state.templatesFormat === "all" || t.format === state.templatesFormat); });
    var chips = [["all", "All"], ["carousel", F.carousel.plural], ["document", F.document.plural], ["cover", F.cover.plural]].map(function (c) {
      return "<button class=\"fchip\" aria-pressed=\"" + (state.templatesFormat === c[0]) + "\" data-action=\"tfilter\" data-format=\"" + c[0] + "\">" + c[1] + "</button>";
    }).join("");
    var body;
    var brandHasAny = CB.store().templates.some(function (t) { return t.brand === state.brandId; });
    if (state.data === "loading") body = skeletonGrid(4);
    else if (state.data === "error") {
      body = "<div class=\"banner danger\" role=\"alert\">" + icon("circle-alert") + "<div class=\"b-body\"><div class=\"b-title\">Couldn't load templates</div>" +
        "<div class=\"t-small\">The templates file could not be read. Nothing was deleted, and your projects are not affected.</div></div>" +
        "<button class=\"btn btn-secondary btn-sm\" data-action=\"retry\">Try again</button></div>";
    } else if (!list.length && brandHasAny) {
      body = "<div class=\"card empty\"><span class=\"e-icon\">" + icon("search") + "</span><h2 class=\"t-h3\">No templates for " + esc(F[state.templatesFormat].label) + "</h2>" +
        "<p>" + esc(CB.brandName(b)) + " has templates in other formats.</p><button class=\"btn btn-secondary\" data-action=\"tfilter\" data-format=\"all\">Show all formats</button></div>";
    } else if (!list.length) {
      body = "<div class=\"card empty\"><span class=\"e-icon\">" + icon("bookmark") + "</span><h2 class=\"t-h3\">No templates for " + esc(CB.brandName(b)) + " yet</h2>" +
        "<p>A template is a project saved for reuse. Open any project and choose <strong>Save as template</strong> from its menu. Using a template starts a new project with its slides.</p>" +
        (CB.store().projects.length ? "<a class=\"btn btn-secondary\" href=\"#/projects\">Go to projects</a>" : "<button class=\"btn btn-primary\" data-action=\"create\">Create a project</button>") + "</div>";
    } else {
      body = "<div class=\"grid\">" + list.map(templateCard).join("") + "</div>";
    }
    return "<div class=\"page-head\"><div><h1 class=\"t-h1\">Templates</h1><p class=\"muted t-small\">Starting points saved from " + esc(CB.brandName(b)) + "'s projects. A new project from a template keeps this brand.</p></div></div>" +
      "<div class=\"filters\" role=\"group\" aria-label=\"Format\" style=\"margin-bottom:20px\">" + chips + "</div>" + body;
  };

  // ----- Actions -----
  var A = CB.actions;
  A["go-studio"] = function () { CB.go("studio"); };
  A["retry"] = function () { state.data = "populated"; CB.render(); CB.toast("Loaded. (Prototype: the error state was simulated.)"); };
  A["open-project"] = function (btn) { CB.go("editor/" + btn.getAttribute("data-id")); };
  A["project-menu"] = function (btn) {
    var id = btn.getAttribute("data-id");
    var inEditor = CB.parseRoute().name === "editor";
    CB.showMenu(btn, (inEditor ? "" : CB.menuItem("open-project", "Open", "arrow-right", " data-id=\"" + id + "\"")) + CB.menuItem("dup-project", "Duplicate", "copy", " data-id=\"" + id + "\"") +
      CB.menuItem("save-template", "Save as template", "bookmark", " data-id=\"" + id + "\"") + "<hr>" +
      "<button role=\"menuitem\" class=\"danger\" data-action=\"del-project\" data-id=\"" + id + "\">" + icon("trash-2") + "<span>Delete</span></button>", "right");
  };
  A["dup-project"] = function (btn) {
    var p = CB.projectById(btn.getAttribute("data-id"));
    CB.closeMenu();
    var copy = CB.clone(p);
    copy.id = p.id + "-copy-" + Date.now();
    copy.name = p.name + " (copy)";
    copy.edited = CB.D.now;
    CB.store().projects.unshift(copy);
    CB.render();
    CB.toast("Duplicated as “" + copy.name + "”. It keeps the brand " + CB.brandName(CB.brandById(copy.brand)) + ".");
  };
  A["save-template"] = function (btn) {
    var p = CB.projectById(btn.getAttribute("data-id"));
    CB.closeMenu();
    if (!p.slides.length) { CB.toast("A project needs at least one slide to become a template."); return; }
    CB.store().templates.unshift({ id: "t-" + Date.now(), brand: p.brand, name: p.name, format: p.format, ratio: p.ratio, from: p.id });
    CB.toast("Saved “" + p.name + "” as a template.");
  };
  A["del-project"] = function (btn) {
    var p = CB.projectById(btn.getAttribute("data-id"));
    CB.closeMenu();
    CB.confirmDialog("Delete “" + p.name + "”?", "Its slides and their undo history are deleted for good. Exports you already downloaded are not affected.", "Delete project", function () {
      var list = CB.store().projects;
      list.splice(list.indexOf(p), 1);
      if (CB.parseRoute().name === "editor") CB.go("projects"); else CB.render();
      CB.toast("Deleted “" + p.name + "”.");
    });
  };
  A["pfilter"] = function (btn) { state.projectsView.format = btn.getAttribute("data-format"); state.projectsView.limit = 24; CB.render(); };
  A["pscope"] = function (btn) { state.projectsView.scope = btn.getAttribute("data-scope"); state.projectsView.limit = 24; CB.render(); };
  A["pview"] = function (btn) { state.projectsView.view = btn.getAttribute("data-view"); CB.render(); };
  A["pmore"] = function () { state.projectsView.limit += 24; CB.render(); };
  A["pclear"] = function () { state.projectsView.q = ""; state.projectsView.format = "all"; state.projectsView.scope = "all"; CB.render(); };
  A["tfilter"] = function (btn) { state.templatesFormat = btn.getAttribute("data-format"); CB.render(); };
  A["template-menu"] = function (btn) {
    var id = btn.getAttribute("data-id");
    CB.showMenu(btn, CB.menuItem("use-template", "Use template", "arrow-right", " data-id=\"" + id + "\"") + "<hr>" +
      "<button role=\"menuitem\" class=\"danger\" data-action=\"del-template\" data-id=\"" + id + "\">" + icon("trash-2") + "<span>Delete template</span></button>", "right");
  };
  A["del-template"] = function (btn) {
    var list = CB.store().templates;
    var id = btn.getAttribute("data-id");
    var t = list.filter(function (x) { return x.id === id; })[0];
    CB.closeMenu();
    CB.confirmDialog("Delete the template “" + t.name + "”?", "Projects already made from it are not affected.", "Delete template", function () {
      list.splice(list.indexOf(t), 1);
      CB.render();
      CB.toast("Deleted the template “" + t.name + "”.");
    });
  };
  A["use-template"] = function (btn) {
    var id = btn.getAttribute("data-id");
    CB.closeMenu();
    var t = CB.store().templates.filter(function (x) { return x.id === id; })[0];
    CB.openCreate({ format: t.format, step: 2, start: "template", templateId: t.id });
  };

  // Projects search and sort are live; they keep focus in the field while typing.
  document.addEventListener("input", function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute("data-psearch")) {
      state.projectsView.q = e.target.value;
      state.projectsView.limit = 24;
      var pos = e.target.selectionStart;
      CB.render();
      var field = document.querySelector("[data-psearch]");
      field.focus();
      field.setSelectionRange(pos, pos);
    }
  });
  document.addEventListener("change", function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute("data-psort")) { state.projectsView.sort = e.target.value; CB.render(); }
  });
  document.addEventListener("submit", function (e) {
    if (e.target.hasAttribute("data-quick")) {
      e.preventDefault();
      CB.openCreate({ format: document.getElementById("quick-format").value, step: 2, about: document.getElementById("quick-about").value.trim() });
    }
  });
})();
