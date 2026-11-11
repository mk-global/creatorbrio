/*
 * Brands, Video Studio, Settings and the representative editor for the
 * CreatorBrio 2.0 prototype.
 */
(function () {
  "use strict";

  var CB = window.CB;
  var state = CB.state;
  var icon = CB.icon;
  var esc = CB.esc;
  var F = CB.FORMATS;
  var A = CB.actions;

  var FONT_CHOICES = ["Inter", "Fraunces", "DM Serif Display", "DM Sans", "Space Grotesk", "Playfair Display", "Manrope", "Lora"];
  var KEYWORDS = ["editorial", "calm", "confident", "warm", "seasonal", "handmade", "bold", "direct", "practical", "playful", "minimal", "luxurious"];
  var COLOR_LABELS = [["primary", "Primary", "Headlines and dark slides"], ["secondary", "Secondary", "Supporting shapes"], ["accent", "Accent", "Highlights and marks"], ["background", "Background", "Light slides"], ["surface", "Surface", "Cards on slides"]];

  // ----- Brands -----
  function brandTile(b) {
    var c = b.colors;
    var count = CB.store().projects.filter(function (p) { return p.brand === b.id; }).length;
    var active = b.id === state.brandId;
    return "<article class=\"card brand-tile\"><div class=\"bt-sample\" style=\"background:" + c.primary + ";color:" + c.background + "\">" +
      "<span style=\"position:absolute;right:-30px;top:-30px;width:120px;height:120px;border-radius:50%;background:" + c.accent + "\"></span>" +
      "<span style=\"position:relative;font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:" + c.accent + "\">" + esc(b.keywords.slice(0, 2).join(" · ") || "Brand") + "</span>" +
      "<span style=\"position:relative;font-family:'" + esc(b.fonts.heading) + "',Georgia,serif;font-size:26px;line-height:1.1;font-weight:700\">" + esc(CB.brandName(b)) + "</span></div>" +
      "<div class=\"bt-body\"><div style=\"display:flex;gap:8px;align-items:center;flex-wrap:wrap\"><h2 class=\"t-h3\" style=\"margin-right:auto\">" + esc(CB.brandName(b)) + "</h2>" +
      (b.isDefault ? "<span class=\"chip\">Default</span>" : "") + (active ? "<span class=\"chip\" style=\"background:var(--accent-tint);color:var(--accent)\">" + icon("check", "sm") + "Active</span>" : "") + "</div>" +
      "<div class=\"color-row\">" + COLOR_LABELS.map(function (l) { return "<span title=\"" + l[1] + " " + c[l[0]] + "\" style=\"background:" + c[l[0]] + "\"></span>"; }).join("") + "</div>" +
      "<p class=\"t-small muted\">" + esc(b.fonts.heading) + " headings, " + esc(b.fonts.body) + " text · " + count + (count === 1 ? " project" : " projects") + "</p>" +
      "<div class=\"bt-actions\">" + (active ? "" : "<button class=\"btn btn-secondary btn-sm\" data-action=\"switch-brand\" data-brand=\"" + b.id + "\">Use this brand</button>") +
      "<a class=\"btn btn-ghost btn-sm\" href=\"#/brands/" + b.id + "\">" + icon("pencil", "sm") + "Edit</a></div></div></article>";
  }

  CB.views.brands = function (route) {
    if (route.segs[1]) return brandEditor(route.segs[1]);
    return "<div class=\"page-head\"><div><h1 class=\"t-h1\">Brands</h1><p class=\"muted t-small\">Each brand's colours, fonts, logo and style words go into every design made for it. A project keeps the brand it was made with.</p></div>" +
      "<a class=\"btn btn-primary\" href=\"#/brands/new\">" + icon("plus", "sm") + "Add brand</a></div>" +
      "<div class=\"brand-grid\">" + CB.brands().map(brandTile).join("") + "</div>" +
      "<p class=\"t-small muted\" style=\"margin-top:20px;display:flex;gap:8px;align-items:center\">" + icon("info", "sm") + "Brands cannot be deleted yet. The active brand is a choice of this browser and never changes existing projects.</p>";
  };

  function previewSlide(b) {
    return CB.brandSampleSlide(b, "4:5", { kicker: (b.keywords[0] || "Your brand"), title: "This is how your slides will look", body: "Headlines in " + b.fonts.heading + ", text in " + b.fonts.body + ".", dark: false }, "width:100%;border-radius:10px;box-shadow:var(--overlay-shadow)") +
      "<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px\">" +
      CB.brandSampleSlide(b, "4:5", { kicker: "Cover", title: b.name.trim() || "Brand name", dark: true, big: true }, "width:100%;border-radius:8px") +
      CB.brandSampleSlide(b, "4:5", { kicker: "Tip", title: "Short and clear", center: true }, "width:100%;border-radius:8px") + "</div>";
  }

  function brandEditor(id) {
    var isNew = id === "new";
    var src = isNew ? null : CB.brandById(id);
    if (!state.brandDraft || state.brandDraft.forId !== id) {
      state.brandDraft = isNew
        ? { forId: id, b: { id: "", name: "", isDefault: false, colors: { primary: "#1f2a44", secondary: "#3a4a6b", accent: "#e94560", background: "#f7f5f2", surface: "#ffffff" }, fonts: { heading: "Inter", body: "Inter" }, keywords: [], logo: "" } }
        : { forId: id, b: CB.clone(src) };
    }
    var b = state.brandDraft.b;
    var title = isNew ? "Add a brand" : (src.name.trim() ? "Edit " + esc(src.name) : "Set up your brand");
    var fontSelect = function (key, label) {
      return "<div class=\"field\"><label for=\"bf-" + key + "\">" + label + "</label><select id=\"bf-" + key + "\" class=\"select\" data-bfield=\"font-" + key + "\">" +
        FONT_CHOICES.map(function (f) { return "<option" + (b.fonts[key] === f ? " selected" : "") + ">" + f + "</option>"; }).join("") + "</select></div>";
    };
    return "<div class=\"page-head\"><div><a class=\"link\" href=\"#/brands\" style=\"margin-bottom:8px\">" + icon("arrow-left", "sm") + "Brands</a><h1 class=\"t-h1\">" + title + "</h1></div>" +
      "<div style=\"display:flex;gap:8px\"><a class=\"btn btn-secondary\" href=\"#/brands\" data-action=\"brand-cancel\">Cancel</a><button class=\"btn btn-primary\" data-action=\"brand-save\">" + (isNew ? "Create brand" : "Save brand") + "</button></div></div>" +
      "<div class=\"editor-layout\"><div>" +
      "<section class=\"card form-section\" aria-labelledby=\"bs-id\"><h2 id=\"bs-id\" class=\"t-h3\">Identity</h2>" +
      "<div class=\"field\"><label for=\"bf-name\">Brand name</label><input id=\"bf-name\" class=\"input\" data-bfield=\"name\" value=\"" + esc(b.name) + "\" placeholder=\"For example: Northwind Studio\"><span class=\"hint\">The design agent receives your brand details only when a name is set.</span></div>" +
      "<div class=\"field\"><span class=\"field-label\">Logo</span><div style=\"display:flex;gap:12px;align-items:center\">" + CB.monogram(b, 44) +
      "<button class=\"btn btn-secondary btn-sm\" data-action=\"illus\" data-illustrative=\"In the app this uploads a PNG, JPG or WebP logo (up to 10 MB), checked by its contents.\">" + icon("image", "sm") + "Upload logo</button></div></div></section>" +
      "<section class=\"card form-section\" aria-labelledby=\"bs-col\"><h2 id=\"bs-col\" class=\"t-h3\">Colours</h2><div class=\"color-fields\">" + COLOR_LABELS.map(function (l) {
        return "<label class=\"color-field\"><input type=\"color\" value=\"" + b.colors[l[0]] + "\" data-bfield=\"color-" + l[0] + "\" aria-label=\"" + l[1] + " colour\"><span class=\"cf-text\"><span>" + l[1] + "</span><span>" + b.colors[l[0]] + "</span></span></label>";
      }).join("") + "</div><p class=\"hint t-caption muted\">" + COLOR_LABELS.map(function (l) { return l[1] + ": " + l[2].toLowerCase(); }).join(" · ") + ".</p></section>" +
      "<section class=\"card form-section\" aria-labelledby=\"bs-type\"><h2 id=\"bs-type\" class=\"t-h3\">Typography</h2><div style=\"display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px\">" + fontSelect("heading", "Headings") + fontSelect("body", "Text") + "</div>" +
      "<p class=\"t-caption muted\">Fonts come from Google Fonts. Uploading your own font is not available yet.</p></section>" +
      "<section class=\"card form-section\" aria-labelledby=\"bs-voice\"><h2 id=\"bs-voice\" class=\"t-h3\">Style</h2><p class=\"t-small muted\">Words that describe how your posts should feel. The design agent reads them on every request.</p>" +
      "<div class=\"filters\" role=\"group\" aria-label=\"Style words\">" + KEYWORDS.map(function (k) {
        return "<button class=\"fchip\" aria-pressed=\"" + (b.keywords.indexOf(k) >= 0) + "\" data-action=\"brand-kw\" data-kw=\"" + k + "\">" + k + "</button>";
      }).join("") + "</div></section></div>" +
      "<aside class=\"sticky-preview\" aria-label=\"Live preview\"><div class=\"card panel\"><h2 class=\"t-h3\" style=\"margin-bottom:12px\">Preview</h2><div data-brand-preview>" + previewSlide(b) + "</div>" +
      "<p class=\"t-caption muted\" style=\"margin-top:12px\">A sample, not a real design. Real slides are designed by Claude from your request.</p></div></aside></div>";
  }

  function refreshBrandPreview() {
    var box = document.querySelector("[data-brand-preview]");
    if (!box) return;
    box.innerHTML = previewSlide(state.brandDraft.b);
    CB.fitSlides(box);
  }

  document.addEventListener("input", function (e) {
    var f = e.target.getAttribute && e.target.getAttribute("data-bfield");
    if (!f || !state.brandDraft) return;
    var b = state.brandDraft.b;
    if (f === "name") b.name = e.target.value;
    if (f.indexOf("color-") === 0) {
      b.colors[f.slice(6)] = e.target.value;
      var txt = e.target.parentNode.querySelector(".cf-text span:last-child");
      if (txt) txt.textContent = e.target.value;
    }
    if (f.indexOf("font-") === 0) b.fonts[f.slice(5)] = e.target.value;
    refreshBrandPreview();
  });
  document.addEventListener("change", function (e) {
    var f = e.target.getAttribute && e.target.getAttribute("data-bfield");
    if (f && f.indexOf("font-") === 0) { state.brandDraft.b.fonts[f.slice(5)] = e.target.value; refreshBrandPreview(); }
  });

  A["brand-kw"] = function (btn) {
    var kw = btn.getAttribute("data-kw");
    var list = state.brandDraft.b.keywords;
    var i = list.indexOf(kw);
    if (i >= 0) list.splice(i, 1); else list.push(kw);
    btn.setAttribute("aria-pressed", String(i < 0));
    refreshBrandPreview();
  };
  A["brand-cancel"] = function () { state.brandDraft = null; CB.go("brands"); };
  A["brand-save"] = function () {
    var d = state.brandDraft;
    if (!d.b.name.trim()) {
      CB.toast("Give the brand a name first. Slides use your brand only once it has one.");
      var n = document.getElementById("bf-name");
      if (n) { n.focus(); n.setAttribute("aria-invalid", "true"); }
      return;
    }
    var list = CB.brands();
    if (d.forId === "new") {
      d.b.id = "b-" + Date.now();
      list.push(d.b);
      state.brandId = d.b.id;
    } else {
      for (var i = 0; i < list.length; i++) if (list[i].id === d.forId) list[i] = d.b;
    }
    var name = d.b.name;
    state.brandDraft = null;
    CB.go(d.forId === "new" ? "home" : "brands");
    CB.toast(d.forId === "new" ? "Created " + name + ". It is now the active brand." : "Saved " + name + ".");
  };

  // ----- Video Studio -----
  var CAN = ["Import footage, music and images by file path", "Trim, split, move and delete clips on a timeline", "Titles, lower thirds and typed captions", "Undo and redo every edit", "Export an MP4 checked against Instagram's Reel requirements"];
  var NOT_YET = ["AI-assisted editing, transcripts and rough cuts", "Uploading files from the browser", "Transitions, speed changes and effects"];

  function pairingCard() {
    return "<section class=\"card panel\" aria-labelledby=\"pair-title\"><div style=\"display:flex;gap:10px;align-items:center\"><span class=\"e-icon\" style=\"width:36px;height:36px;border-radius:10px;background:var(--sunken);display:grid;place-items:center\">" + icon("key-round", "sm") + "</span>" +
      "<h2 id=\"pair-title\" class=\"t-h3\">Pair this browser</h2></div>" +
      "<p class=\"t-small muted\" style=\"margin-top:10px\">The Studio opens only in a browser paired with this computer, so other websites and other people on your network cannot reach your footage. You do this once; it lasts 12 hours, also across restarts.</p>" +
      "<ol class=\"t-small\" style=\"padding-left:18px;margin:12px 0;display:flex;flex-direction:column;gap:6px\"><li>In a terminal, in the CreatorBrio folder, run <span class=\"kbd\">npm run studio:pair</span></li><li>Type the code it prints. Each code works once, for five minutes.</li></ol>" +
      "<form data-pair class=\"field\"><label for=\"pair-code\">Pairing code</label><div style=\"display:flex;gap:8px;flex-wrap:wrap\"><input id=\"pair-code\" class=\"input code-input\" style=\"flex:1 1 220px\" placeholder=\"XXXXX-XXXXX-XXXXX-XXXXX\" autocomplete=\"one-time-code\" spellcheck=\"false\">" +
      "<button class=\"btn btn-primary\" type=\"submit\">Pair</button></div><span class=\"hint\" data-pair-hint>Prototype: any 20 letters or digits pair this browser.</span></form></section>";
  }

  CB.views.studio = function (route) {
    if (route.segs[1]) return studioWorkspace(route.segs[1]);
    var prods = CB.store().productions;
    var hero = "<section class=\"card studio-hero\"><div class=\"sh-copy\"><div style=\"display:flex;gap:8px;align-items:center\"><h1 class=\"t-h1\">Video Studio</h1><span class=\"tag-early\">Early</span></div>" +
      "<p class=\"muted\">Edit a short Instagram Reel by hand: bring in your own footage and music, arrange it on a timeline, add titles and captions, and export a verified MP4. Video editing with AI is the main work in progress and is not available yet.</p>" +
      "<div class=\"cap-columns\"><div><h2 class=\"t-small\" style=\"font-weight:600;margin-bottom:6px\">Works today</h2><ul class=\"checklist\">" + CAN.map(function (c) { return "<li class=\"yes\">" + icon("circle-check") + "<span>" + c + "</span></li>"; }).join("") + "</ul></div>" +
      "<div><h2 class=\"t-small\" style=\"font-weight:600;margin-bottom:6px\">Not built yet</h2><ul class=\"checklist\">" + NOT_YET.map(function (c) { return "<li class=\"no\">" + icon("circle-dashed") + "<span>" + c + "</span></li>"; }).join("") + "</ul></div></div>" +
      "<p class=\"t-caption muted\">Needs FFmpeg 6 or later on this computer. Tested so far with synthetic media only.</p></div>" +
      "<div class=\"sh-art\" aria-hidden=\"true\"><div class=\"timeline-art\" style=\"padding:24px;gap:8px;justify-content:flex-end\">" +
      "<div style=\"align-self:center;width:96px;aspect-ratio:9/16;border-radius:8px;background:linear-gradient(160deg,#3b4a63,#22283a);position:relative;margin-bottom:10px;box-shadow:0 0 0 1px #2c2b33\"><span style=\"position:absolute;left:10px;right:10px;bottom:22px;height:6px;border-radius:2px;background:#f2efea\"></span><span style=\"position:absolute;left:18px;right:18px;bottom:12px;height:4px;border-radius:2px;background:#a9a39b\"></span></div>" +
      "<div style=\"display:flex;flex-direction:column;gap:8px;position:relative\"><div class=\"track\" style=\"height:22px\"><span class=\"clip\" style=\"width:36%;background:#4b5d7a\"></span><span class=\"clip\" style=\"width:28%;background:#5d7290\"></span><span class=\"clip\" style=\"width:24%;background:#4b5d7a\"></span></div>" +
      "<div class=\"track\" style=\"height:22px\"><span class=\"clip\" style=\"width:22%;margin-left:12%;background:#c28a3a\"></span><span class=\"clip\" style=\"width:18%;margin-left:10%;background:#c28a3a\"></span></div>" +
      "<div class=\"track\" style=\"height:22px\"><span class=\"clip\" style=\"width:30%;margin-left:40%;background:#8a5a9e\"></span></div><div class=\"track\" style=\"height:22px\"><span class=\"clip\" style=\"width:94%;background:#3d6b55\"></span></div><span class=\"playhead\" style=\"top:-4px;bottom:-4px\"></span></div></div></div></section>";

    var mobileNote = "<div class=\"banner info\" style=\"margin-top:16px\">" + icon("monitor") + "<div class=\"b-body t-small\">The timeline needs a larger screen. On a phone you can see your productions; editing works from about 1024 pixels wide.</div></div>";

    var body;
    if (!state.paired) {
      body = "<div class=\"section\" style=\"margin-top:20px;max-width:640px\">" + pairingCard() + "</div>";
    } else {
      var list = prods.length
        ? "<ul class=\"prod-list\">" + prods.map(function (v) {
          return "<li><a class=\"prod-row\" style=\"text-decoration:none\" href=\"#/studio/" + v.id + "\"><span class=\"pr-icon\">" + icon("film", "sm") + "</span><span class=\"pr-text\"><span class=\"pname\" style=\"display:block\">" + esc(v.name) + "</span>" +
            "<span class=\"t-caption muted num\">Revision " + v.revision + " · Updated " + CB.agoLower(v.updated) + "</span></span><span class=\"t-small muted hide-mobile\">Open</span>" + icon("chevron-right", "sm") + "</a></li>";
        }).join("") + "</ul>"
        : "<div class=\"empty\"><span class=\"e-icon\">" + icon("clapperboard") + "</span><h3 class=\"t-h3\">No productions yet</h3><p>A production is one video you edit: its footage, music, captions and titles on a timeline, exported as an MP4.</p></div>";
      body = "<section class=\"section\" style=\"margin-top:24px\" aria-labelledby=\"prod-title\"><div class=\"section-head\"><h2 id=\"prod-title\" class=\"t-h2\">Productions</h2>" +
        "<div style=\"display:flex;gap:8px\"><button class=\"btn btn-ghost btn-sm\" data-action=\"studio-signout\">" + icon("log-out", "sm") + "Sign out</button>" +
        "<button class=\"btn btn-primary btn-sm\" data-action=\"new-production\">" + icon("plus", "sm") + "New production</button></div></div>" +
        "<div class=\"card\">" + list + "</div></section>";
    }
    return hero + "<div class=\"mobile-only\">" + mobileNote + "</div>" + body;
  };

  function studioWorkspace(id) {
    var v = CB.store().productions.filter(function (p) { return p.id === id; })[0] || CB.store().productions[0];
    if (!state.paired || !v) { return "<div class=\"page\">" + pairingCard() + "</div>"; }
    return "<div class=\"editor\" style=\"grid-template-rows:auto 1fr\"><div class=\"ed-top\"><a class=\"btn btn-ghost btn-sm\" href=\"#/studio\">" + icon("arrow-left", "sm") + "<span class=\"hide-mobile\">Video Studio</span></a>" +
      "<div class=\"crumb\"><h1 class=\"t-h3 ed-name\">" + esc(v.name) + "</h1><span class=\"t-caption muted num hide-mobile\">Revision " + v.revision + "</span></div><span class=\"tag-early\">Early</span></div>" +
      "<div style=\"overflow:auto;padding:24px\"><div style=\"max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:14px\">" +
      "<div class=\"banner info\">" + icon("info") + "<div class=\"b-body t-small\"><div class=\"b-title\">This is the existing Video Studio workspace</div>A screenshot of the merged Studio (from the repository's README), shown unchanged. Milestone 4 gives its top bar and navigation this design; the timeline, preview and Inspector keep their current look, including the black stage behind the video preview.</div></div>" +
      "<div class=\"studio-frame\"><img src=\"../screenshots/current/studio-workspace-readme.png\" alt=\"The existing Video Studio: a media library, a vertical preview with a title and a caption, the caption Inspector and a five-track timeline\"></div></div></div></div>";
  }

  A["studio-signout"] = function () { state.paired = false; CB.render(); CB.toast("Signed out of the Video Studio in this browser."); };
  A["new-production"] = function () {
    var el = CB.showDialog("<div class=\"dialog-head\"><h2 id=\"dlg-title\" class=\"t-h2\">New production</h2></div><form data-newprod><div class=\"dialog-body\"><div class=\"field\"><label for=\"np-name\">Name</label><input id=\"np-name\" class=\"input\" autofocus required placeholder=\"For example: Studio tour reel\"></div>" +
      "<p class=\"t-small muted\">Every production is a vertical 1080 × 1920 Reel at 30 frames per second, up to 90 seconds.</p></div>" +
      "<div class=\"dialog-foot\"><div class=\"df-right\"><button type=\"button\" class=\"btn btn-secondary\" data-np=\"cancel\">Cancel</button><button class=\"btn btn-primary\" type=\"submit\">Create and open</button></div></div></form>", { small: true });
    el.querySelector("[data-np=cancel]").addEventListener("click", CB.closeDialog);
    el.querySelector("form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = el.querySelector("#np-name").value.trim();
      if (!name) return;
      var p = { id: "v-" + Date.now(), name: name, revision: 1, updated: CB.D.now, agentRun: false };
      CB.store().productions.unshift(p);
      CB.closeDialog();
      CB.go("studio/" + p.id);
    });
  };
  document.addEventListener("submit", function (e) {
    if (!e.target.hasAttribute("data-pair")) return;
    e.preventDefault();
    var raw = document.getElementById("pair-code").value.replace(/[^a-z0-9]/gi, "");
    if (raw.length !== 20) {
      var hint = e.target.querySelector("[data-pair-hint]");
      hint.textContent = raw.length + " of 20 characters. Dashes, spaces and case do not matter.";
      hint.style.color = "var(--danger)";
      document.getElementById("pair-code").setAttribute("aria-invalid", "true");
      return;
    }
    state.paired = true;
    CB.render();
    CB.toast("This browser is paired for 12 hours.");
  });

  // ----- Settings -----
  CB.views.settings = function () {
    function row(title, desc, right) { return "<div class=\"setting-row\"><div class=\"sr-text\"><h3 class=\"t-h3\" style=\"font-size:15px\">" + title + "</h3><p>" + desc + "</p></div>" + (right || "") + "</div>"; }
    var claude = state.claude ? "<span class=\"status ok\"><span class=\"dot\"></span>Connected</span>" : "<span class=\"status warn\"><span class=\"dot\"></span>Not found</span>";
    return "<div class=\"page-head\"><div><h1 class=\"t-h1\">Settings</h1><p class=\"muted t-small\">How CreatorBrio is connected on this computer and where your work is kept. Brand settings are in Brands.</p></div></div>" +
      "<div class=\"settings-list\">" +
      "<section class=\"card panel\" aria-labelledby=\"set-conn\"><h2 id=\"set-conn\" class=\"t-h2\" style=\"margin-bottom:8px\">Connections</h2>" +
      row("Claude Code", "Designs your slides through your own Claude Code account and its usage limits." + (state.claude ? "" : " Install Claude Code, run <span class=\"kbd\">claude</span> once to sign in, then restart CreatorBrio. If it lives somewhere unusual, set <span class=\"kbd\">CLAUDE_CLI_PATH</span> in <code class=\"path\">.env.local</code>."), claude) +
      row("Local image service", "Optional. Generates new images or edits your photos for slides. Everything else works without it.", "<span class=\"status off\"><span class=\"dot\"></span>Not checked</span>") +
      "<p class=\"t-caption muted\">Prototype note: the app can report Claude Code today; the image-service status needs a small read-only check added in Milestone 2.</p></section>" +
      "<section class=\"card panel\" aria-labelledby=\"set-studio\"><h2 id=\"set-studio\" class=\"t-h2\" style=\"margin-bottom:8px\">Video Studio</h2>" +
      row("This browser", state.paired ? "Paired. The pairing lasts 12 hours, also across restarts." : "Not paired. Pair it from the Video Studio page.",
        state.paired ? "<button class=\"btn btn-secondary btn-sm\" data-action=\"studio-signout\">Sign out</button>" : "<a class=\"btn btn-secondary btn-sm\" href=\"#/studio\">Pair</a>") +
      row("Sign out every browser", "From a terminal in the CreatorBrio folder: <span class=\"kbd\">npm run studio:pair -- --revoke-all</span>", "") +
      row("FFmpeg", "Version 6.0 or later, with ffprobe, is needed for video import and export.", "") + "</section>" +
      "<section class=\"card panel\" aria-labelledby=\"set-data\"><h2 id=\"set-data\" class=\"t-h2\" style=\"margin-bottom:8px\">Your data</h2>" +
      row("Where your work lives", "Projects, brands and templates in <code class=\"path\">data/</code>; uploads and generated images in <code class=\"path\">public/uploads/</code>; videos in <code class=\"path\">data/video*</code>. Git never tracks them.", "") +
      row("Back up", "Copy <code class=\"path\">data/</code>, <code class=\"path\">public/uploads/</code> and <code class=\"path\">.env.local</code> somewhere safe.", "") +
      row("What leaves this computer", "Design requests, brand details and reference images go to Anthropic through Claude Code; links you paste are fetched; fonts load from Google Fonts. The Video Studio sends nothing out.", "<a class=\"btn btn-ghost btn-sm\" href=\"../../../../README.md#what-leaves-your-machine\">In the README" + icon("external-link", "sm") + "</a>") + "</section>" +
      "<section class=\"card panel\" aria-labelledby=\"set-about\"><h2 id=\"set-about\" class=\"t-h2\" style=\"margin-bottom:8px\">About</h2>" +
      row("CreatorBrio 0.1.3", "MIT licence. Derived from the open-source Open Carrusel project and independently maintained.", "") + "</section></div>";
  };

  // ----- Editor (representative) -----
  var EXPORTS = {
    carousel: [["Instagram · PNG images", "One PNG per slide, in a ZIP"], ["LinkedIn · PDF", "One multi-page PDF"]],
    document: [["LinkedIn · PDF", "One PDF with selectable, searchable text"], ["Instagram · PNG images", "One PNG per slide, in a ZIP"]],
    cover: [["Instagram · PNG", "This slide as one 1080 × 1920 PNG"], ["Instagram · PNG images", "As a ZIP"], ["LinkedIn · PDF", "One-page PDF"]]
  };
  var EXPORT_LABEL = { carousel: "Export PNGs", document: "Export PDF", cover: "Export PNG" };

  CB.views.editor = function (route) {
    var p = CB.projectById(route.segs[1]);
    if (!p) {
      return "<div class=\"page\"><div class=\"card empty\"><span class=\"e-icon\">" + icon("circle-alert") + "</span><h1 class=\"t-h2\">Project not found</h1><p>It may have been deleted.</p><a class=\"btn btn-secondary\" href=\"#/projects\">Back to projects</a></div></div>";
    }
    var b = CB.brandById(p.brand);
    var ed = state.editor;
    if (ed.slide >= p.slides.length) ed.slide = Math.max(0, p.slides.length - 1);
    var d = CB.D.DIM[p.ratio];

    var chat = "<section class=\"ed-chat\" aria-label=\"Design chat\"><div style=\"padding:14px 16px;border-bottom:1px solid var(--line)\"><h2 class=\"t-h3\">Design chat</h2><p class=\"t-caption muted\">Designs in " + esc(CB.brandName(b)) + "'s colours and fonts</p></div>" +
      "<div class=\"chat-log\" aria-live=\"polite\">" +
      (p.slides.length && !p.fresh
        ? "<div class=\"bubble me\">Make a " + p.slides.length + "-slide " + esc(F[p.format].short.toLowerCase()) + " about " + esc(p.name.toLowerCase()) + ".</div><div class=\"bubble agent\">" + (p.slides.length === 1 ? "Done. I designed the slide and saved it. Ask for any change, for example “make the title larger”." : "Done. I planned " + p.slides.length + " slides and saved each one. Ask for any change, for example “make slide 2 more minimal”.") + "</div>"
        : "<div class=\"bubble agent\">Tell me what this " + esc(F[p.format].short.toLowerCase()) + " is about. I will plan it, then design " + (p.format === "cover" ? "one slide" : "each slide") + " in your brand. It takes a few minutes; slides appear as they are saved.</div>") +
      "</div><div class=\"composer\"><button class=\"btn btn-ghost btn-sm\" style=\"align-self:flex-start\" data-action=\"illus\" data-illustrative=\"In the app you attach PNG, JPG or WebP images here, to show on a slide or to follow as a style.\">" + icon("image", "sm") + "Add reference image</button>" +
      "<label class=\"sr-only\" for=\"chat-in\">Message</label><textarea id=\"chat-in\" class=\"textarea\" style=\"min-height:72px\" placeholder=\"Describe your post or ask for a change\">" + esc(p.about || "") + "</textarea>" +
      "<div style=\"display:flex;justify-content:space-between;align-items:center;gap:8px\"><span class=\"t-caption muted\">" + (state.claude ? "Sends to Claude Code" : "Claude Code is not connected") + "</span>" +
      "<button class=\"btn btn-primary btn-sm\" data-action=\"illus\" data-illustrative=\"In the app, Send starts a design run: a plan first, then each slide appears as it is saved. Usually a few minutes; you can stop it.\"" + (state.claude ? "" : " disabled") + ">" + icon("send", "sm") + "Send</button></div></div></section>";

    var preview;
    if (!p.slides.length) {
      preview = "<div class=\"ed-preview\"><div class=\"empty\"><span class=\"e-icon\">" + icon("message-square") + "</span><h2 class=\"t-h3\">No slides yet</h2><p>Describe your post in the design chat. Slides appear here as they are designed.</p>" +
        "<button class=\"btn btn-secondary ed-chat-jump\" data-action=\"ed-tab\" data-tab=\"chat\">Open the chat</button></div></div>";
    } else {
      var heightFit = "min(100%, calc((100vh - 290px) * " + d[0] / d[1] + "))";
      preview = "<div class=\"ed-preview\"><button class=\"btn btn-secondary btn-icon nav-arrow prev\" data-action=\"ed-step\" data-d=\"-1\" aria-label=\"Previous slide\"" + (ed.slide === 0 ? " disabled" : "") + ">" + icon("chevron-left") + "</button>" +
        "<div style=\"width:" + heightFit + ";max-width:520px;position:relative\">" + CB.slideBox(p, ed.slide, "width:100%;border-radius:6px;box-shadow:var(--overlay-shadow)") +
        (ed.safe ? "<div aria-hidden=\"true\" style=\"position:absolute;inset:0;pointer-events:none;border:2px dashed rgba(233,69,96,.9);margin:" + (p.ratio === "9:16" ? "14% 6% 22% 6%" : "4%") + ";border-radius:4px\"></div>" : "") + "</div>" +
        "<button class=\"btn btn-secondary btn-icon nav-arrow next\" data-action=\"ed-step\" data-d=\"1\" aria-label=\"Next slide\"" + (ed.slide >= p.slides.length - 1 ? " disabled" : "") + ">" + icon("chevron-right") + "</button></div>" +
        "<div class=\"filmstrip\" role=\"list\" aria-label=\"Slides\">" + p.slides.map(function (s, i) {
          return "<button role=\"listitem\" data-action=\"ed-go\" data-i=\"" + i + "\" aria-label=\"Slide " + (i + 1) + "\"" + (i === ed.slide ? " aria-current=\"true\"" : "") + ">" + CB.slideBox(p, i, "height:76px;width:auto;border-radius:6px") + "<span class=\"fs-n\">" + (i + 1) + "</span></button>";
        }).join("") +
        (p.format === "cover" ? "" : "<button data-action=\"ed-add\" aria-label=\"Add a slide through the chat\" style=\"height:80px;aspect-ratio:" + d[0] + "/" + d[1] + ";border:1.5px dashed var(--line-strong);border-radius:6px;display:grid;place-items:center;color:var(--ink-muted)\">" + icon("plus") + "</button>") + "</div>";
    }

    var sizeLabel = icon(p.ratio === "9:16" ? "smartphone" : "square", "sm") + p.ratio + "<span class=\"hide-mobile\"> · " + d[0] + " × " + d[1] + "</span>";
    var tools = "<div class=\"ed-tools\" role=\"toolbar\" aria-label=\"Preview tools\">" +
      (p.format === "cover"
        ? "<span class=\"chip\" title=\"A Reel cover is always 9:16\">" + sizeLabel + "</span>"
        : "<button class=\"btn btn-ghost btn-sm\" data-action=\"ed-size\" aria-haspopup=\"menu\" aria-label=\"Size: " + p.ratio + ". Change size\">" + sizeLabel + icon("chevron-down", "sm") + "</button>") +
      "<span style=\"flex:1\"></span>" +
      "<button class=\"btn btn-ghost btn-sm\" data-action=\"illus\" data-illustrative=\"In the app this shows the caption and hashtags the design agent wrote for this post, each with a Copy button.\"" + (p.slides.length ? "" : " disabled") + ">" + icon("message-square", "sm") + "<span class=\"hide-mobile\">Caption</span></button>" +
      "<button class=\"btn btn-ghost btn-sm\" data-action=\"ed-safe\" aria-pressed=\"" + ed.safe + "\">" + icon("grid-3x3", "sm") + "<span class=\"hide-mobile\">Safe zones</span></button>" +
      "<button class=\"btn btn-ghost btn-sm\" data-action=\"illus\" data-illustrative=\"In the app this opens the full-window preview, with arrow-key navigation.\">" + icon("maximize-2", "sm") + "<span class=\"hide-mobile\">Full screen</span></button></div>";

    var exportBtn = "<button class=\"btn btn-primary btn-sm\" data-action=\"ed-export\" aria-haspopup=\"menu\"" + (p.slides.length ? "" : " disabled") + ">" + icon("download", "sm") + "<span class=\"hide-mobile\">" + EXPORT_LABEL[p.format] + "</span>" + icon("chevron-down", "sm") + "</button>";

    return "<div class=\"editor\"><header class=\"ed-top\"><a class=\"btn btn-ghost btn-sm\" href=\"#/projects\" aria-label=\"Back to projects\">" + icon("arrow-left", "sm") + "<span class=\"hide-mobile\">Projects</span></a>" +
      "<div class=\"crumb\"><h1 class=\"t-h3 ed-name\">" + esc(p.name) + "</h1><span class=\"hide-mobile\">" + CB.formatChip(p.format) + "</span>" +
      "<span class=\"chip hide-mobile\" title=\"A project keeps the brand it was made with\"><span class=\"brand-dot\" style=\"background:" + b.colors.accent + "\"></span>" + esc(CB.brandName(b)) + "</span></div>" +
      "<button class=\"btn btn-ghost btn-sm btn-icon\" data-action=\"project-menu\" data-id=\"" + p.id + "\" aria-haspopup=\"menu\" aria-label=\"More actions\">" + icon("ellipsis", "sm") + "</button>" + exportBtn + "</header>" +
      "<div class=\"ed-tabs\"><div class=\"seg\" role=\"tablist\" aria-label=\"Editor view\"><button role=\"tab\" aria-selected=\"" + (ed.tab === "preview") + "\" aria-pressed=\"" + (ed.tab === "preview") + "\" data-action=\"ed-tab\" data-tab=\"preview\">" + icon("eye", "sm") + "Preview</button>" +
      "<button role=\"tab\" aria-selected=\"" + (ed.tab === "chat") + "\" aria-pressed=\"" + (ed.tab === "chat") + "\" data-action=\"ed-tab\" data-tab=\"chat\">" + icon("message-square", "sm") + "Chat</button></div></div>" +
      "<div class=\"ed-body\" data-tab=\"" + ed.tab + "\">" + chat + "<section class=\"ed-stage\" aria-label=\"Preview\">" + tools + preview + "</section></div></div>";
  };

  A["ed-step"] = function (btn) { state.editor.slide += Number(btn.getAttribute("data-d")); CB.render(); };
  A["ed-go"] = function (btn) { state.editor.slide = Number(btn.getAttribute("data-i")); CB.render(); };
  A["ed-size"] = function (btn) {
    var p = CB.projectById(CB.parseRoute().segs[1]);
    CB.showMenu(btn, [["4:5", "Portrait 4:5", "1080 × 1350"], ["1:1", "Square 1:1", "1080 × 1080"], ["9:16", "Story 9:16", "1080 × 1920"]].map(function (r) {
      return "<button role=\"menuitemradio\" aria-checked=\"" + (p.ratio === r[0]) + "\" data-action=\"ed-set-size\" data-v=\"" + r[0] + "\" style=\"flex-direction:column;align-items:flex-start;gap:2px\"><span style=\"font-weight:600\">" + r[1] + (p.ratio === r[0] ? " · current" : "") + "</span><span class=\"t-caption muted\">" + r[2] + "</span></button>";
    }).join(""), "left");
  };
  A["ed-set-size"] = function (btn) {
    var p = CB.projectById(CB.parseRoute().segs[1]);
    var v = btn.getAttribute("data-v");
    CB.closeMenu();
    if (v === p.ratio) return;
    p.ratio = v;
    CB.render();
    CB.toast("Size changed to " + v + ". Slides keep their layout; ask in the chat to adapt them to the new size.");
  };
  A["ed-safe"] = function () { state.editor.safe = !state.editor.safe; CB.render(); };
  A["ed-tab"] = function (btn) { state.editor.tab = btn.getAttribute("data-tab"); CB.render(); var c = document.getElementById("chat-in"); if (state.editor.tab === "chat" && c && window.innerWidth >= 768) c.focus(); };
  A["ed-add"] = function () {
    state.editor.tab = "chat";
    CB.render();
    var c = document.getElementById("chat-in");
    c.value = "Add a slide that ";
    c.focus();
    c.setSelectionRange(c.value.length, c.value.length);
  };
  A["ed-export"] = function (btn) {
    var p = CB.projectById(CB.parseRoute().segs[1]);
    CB.showMenu(btn, EXPORTS[p.format].map(function (o, i) {
      return "<button role=\"menuitem\" data-action=\"illus\" data-illustrative=\"In the app this renders every slide with headless Chromium and downloads the file.\" style=\"flex-direction:column;align-items:flex-start;gap:2px\">" +
        "<span style=\"font-weight:600\">" + o[0] + (i === 0 ? " <span class=\"chip\" style=\"height:18px;font-size:11px\">Default for " + esc(F[p.format].short.toLowerCase()) + "</span>" : "") + "</span><span class=\"t-caption muted\">" + o[1] + "</span></button>";
    }).join(""), "right");
  };

  CB.after = function (route) {
    if (route.name === "editor") {
      var c = document.getElementById("chat-in");
      var p = CB.projectById(route.segs[1]);
      if (c && p && p.fresh && p.about && state.editor.tab === "chat") c.focus();
    }
  };
})();
