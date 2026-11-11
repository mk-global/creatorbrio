/*
 * The creation flow. Every format creates the same carousel record the app
 * already has; a format only changes defaults (size, slide guidance, export).
 */
(function () {
  "use strict";

  var CB = window.CB;
  var icon = CB.icon;
  var esc = CB.esc;
  var F = CB.FORMATS;
  var draft = null;

  var RATIOS = {
    carousel: [["4:5", "Portrait", "1080 × 1350, recommended"], ["1:1", "Square", "1080 × 1080"], ["9:16", "Story", "1080 × 1920"]],
    document: [["4:5", "Portrait", "1080 × 1350, reads best in the feed"], ["1:1", "Square", "1080 × 1080"]],
    cover: [["9:16", "Vertical", "1080 × 1920, fixed for Reels"]]
  };

  function shape(ratio) {
    var s = { "4:5": [16, 20], "1:1": [18, 18], "9:16": [12, 22] }[ratio];
    return "<span class=\"shape\" style=\"width:" + s[0] + "px;height:" + s[1] + "px\"></span>";
  }

  function stepOne() {
    return "<div class=\"dialog-head\"><div><p class=\"stepper\">Step 1 of 2</p><h2 id=\"dlg-title\" class=\"t-h2\">What are you making?</h2></div>" +
      "<button class=\"btn btn-ghost btn-icon\" data-c=\"close\" aria-label=\"Close\">" + icon("x") + "</button></div>" +
      "<div class=\"dialog-body\"><div class=\"choice-grid\" role=\"radiogroup\" aria-label=\"Format\">" + ["carousel", "document", "cover", "video"].map(function (k) {
        var f = F[k];
        return "<button class=\"choice\" role=\"radio\" aria-checked=\"" + (draft.format === k) + "\" data-c=\"format\" data-v=\"" + k + "\"><span class=\"c-icon\">" + icon(f.icon) + "</span>" +
          "<span><span class=\"c-title\">" + esc(f.label) + (k === "video" ? " <span class=\"tag-early\">Early</span>" : "") + "</span><span class=\"c-desc\" style=\"display:block\">" + esc(f.desc) + "</span>" +
          "<span class=\"c-desc\" style=\"display:block\">" + (k === "video" ? "Opens the Video Studio" : esc(f.out)) + "</span></span></button>";
      }).join("") + "</div></div>" +
      "<div class=\"dialog-foot\"><span class=\"t-small muted df-hint\">You can change the brand on the next step.</span><div class=\"df-right\"><button class=\"btn btn-secondary\" data-c=\"close\">Cancel</button>" +
      "<button class=\"btn btn-primary\" data-c=\"next\">Continue" + icon("arrow-right", "sm") + "</button></div></div>";
  }

  function templatesFor() {
    return CB.store().templates.filter(function (t) { return t.brand === draft.brandId && t.format === draft.format; });
  }

  function stepTwo() {
    var f = F[draft.format];
    var b = CB.brandById(draft.brandId);
    var ratios = RATIOS[draft.format];
    var tpls = templatesFor();
    if (draft.start === "template" && !tpls.some(function (t) { return t.id === draft.templateId; })) draft.templateId = tpls.length ? tpls[0].id : null;

    var brandOptions = CB.brands().map(function (x) {
      return "<option value=\"" + x.id + "\"" + (x.id === draft.brandId ? " selected" : "") + ">" + esc(CB.brandName(x)) + "</option>";
    }).join("");

    var ratioBlock = ratios.length > 1
      ? "<div class=\"field\"><span class=\"field-label\" id=\"c-size\">Size</span><div class=\"ratio-choices\" role=\"radiogroup\" aria-labelledby=\"c-size\">" + ratios.map(function (r) {
        return "<button class=\"ratio\" role=\"radio\" aria-checked=\"" + (draft.ratio === r[0]) + "\" data-c=\"ratio\" data-v=\"" + r[0] + "\">" + shape(r[0]) + "<span>" + r[1] + " " + r[0] + "<small>" + r[2] + "</small></span></button>";
      }).join("") + "</div></div>"
      : "<div class=\"field\"><span class=\"field-label\">Size</span><p class=\"t-small\" style=\"display:flex;gap:8px;align-items:center\">" + shape("9:16") + "Vertical 9:16, 1080 × 1920. A Reel cover is always one slide.</p></div>";

    var startBlock = "<div class=\"field\"><span class=\"field-label\" id=\"c-start\">Start with</span><div class=\"seg\" role=\"radiogroup\" aria-labelledby=\"c-start\">" +
      "<button role=\"radio\" aria-checked=\"" + (draft.start === "describe") + "\" data-c=\"start\" data-v=\"describe\">" + icon("message-square", "sm") + "A description</button>" +
      "<button role=\"radio\" aria-checked=\"" + (draft.start === "template") + "\" data-c=\"start\" data-v=\"template\">" + icon("layout-template", "sm") + "A template</button></div></div>";

    var startDetail;
    if (draft.start === "template") {
      startDetail = tpls.length
        ? "<div class=\"tpl-pick\" role=\"radiogroup\" aria-label=\"Template\">" + tpls.map(function (t) {
          var src = CB.projectById(t.from);
          var preview = src && src.slides.length ? CB.slideBox({ brand: t.brand, ratio: t.ratio, slides: src.slides }, 0, "width:100%;border-radius:4px") : "";
          return "<button role=\"radio\" aria-checked=\"" + (draft.templateId === t.id) + "\" data-c=\"tpl\" data-v=\"" + t.id + "\">" + preview + "<span>" + esc(t.name) + "</span></button>";
        }).join("") + "</div>"
        : "<p class=\"t-small muted\">" + esc(CB.brandName(b)) + " has no " + esc(f.label) + " templates yet. Start with a description instead, or save a project as a template later.</p>";
    } else {
      startDetail = "<div class=\"field\"><label for=\"c-about\">What is it about? <span class=\"muted\" style=\"font-weight:400\">Optional</span></label>" +
        "<textarea id=\"c-about\" class=\"textarea\" data-c-input=\"about\" placeholder=\"" + (draft.format === "cover" ? "For example: a cover for a 30-second studio tour" : "For example: three small habits for a calmer morning, ending with an invitation to save the post") + "\">" + esc(draft.about) + "</textarea>" +
        "<span class=\"hint\">It goes into the design chat, ready to send. Nothing is designed until you press Send.</span></div>";
    }

    var canCreate = draft.start === "describe" || !!draft.templateId;
    return "<div class=\"dialog-head\"><div><p class=\"stepper\">Step 2 of 2 · " + esc(f.label) + "</p><h2 id=\"dlg-title\" class=\"t-h2\">Set up your " + esc(f.short.toLowerCase()) + "</h2></div>" +
      "<button class=\"btn btn-ghost btn-icon\" data-c=\"close\" aria-label=\"Close\">" + icon("x") + "</button></div>" +
      "<div class=\"dialog-body\">" +
      "<div class=\"field\"><label for=\"c-brand\">Brand</label><select id=\"c-brand\" class=\"select\" data-c-input=\"brand\">" + brandOptions + "</select>" +
      "<span class=\"hint\">A project keeps its brand for good, so its designs always match.</span></div>" +
      ratioBlock + startBlock + startDetail +
      "<div class=\"field\"><label for=\"c-name\">Name <span class=\"muted\" style=\"font-weight:400\">Optional</span></label><input id=\"c-name\" class=\"input\" data-c-input=\"name\" value=\"" + esc(draft.name) + "\" placeholder=\"Named from your description if left empty\"></div>" +
      "</div><div class=\"dialog-foot\"><button class=\"btn btn-ghost\" data-c=\"back\">" + icon("arrow-left", "sm") + "Back</button><div class=\"df-right\">" +
      "<button class=\"btn btn-primary\" data-c=\"create\"" + (canCreate ? "" : " disabled") + ">Create and open" + icon("arrow-right", "sm") + "</button></div></div>";
  }

  function paint() {
    var dlg = document.querySelector(".scrim .dialog");
    if (!dlg) return;
    dlg.innerHTML = draft.step === 1 ? stepOne() : stepTwo();
    CB.fitSlides(dlg);
  }

  function deriveName() {
    if (draft.name.trim()) return draft.name.trim();
    if (draft.start === "template" && draft.templateId) {
      var t = CB.store().templates.filter(function (x) { return x.id === draft.templateId; })[0];
      return t.name;
    }
    var words = draft.about.trim().split(/\s+/).filter(Boolean).slice(0, 7).join(" ");
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Untitled " + F[draft.format].short.toLowerCase();
  }

  function create() {
    var slides = [];
    if (draft.start === "template" && draft.templateId) {
      var t = CB.store().templates.filter(function (x) { return x.id === draft.templateId; })[0];
      var src = CB.projectById(t.from);
      slides = src ? CB.clone(src.slides) : [];
    }
    // The format travels as visible, editable words in the prefilled message.
    // Nothing is sent until the person presses Send (decision D5).
    var about = draft.start === "describe" ? draft.about.trim() : "";
    var frame = { carousel: "", document: "A LinkedIn document. ", cover: "A one-slide Reel cover. " }[draft.format];
    var prefill = draft.format === "cover" || about ? frame + about : "";
    var p = { id: "p-new-" + Date.now(), brand: draft.brandId, format: draft.format, ratio: draft.ratio, name: deriveName(), edited: CB.D.now, slides: slides, fresh: true, about: prefill };
    CB.store().projects.unshift(p);
    CB.closeDialog();
    CB.state.editor = { slide: 0, tab: slides.length ? "preview" : "chat", safe: false };
    CB.go("editor/" + p.id);
    CB.toast("Created “" + p.name + "” in " + CB.brandName(CB.brandById(p.brand)) + ".");
  }

  CB.openCreate = function (opts) {
    var o = opts || {};
    var fmt = o.format && F[o.format] && o.format !== "video" ? o.format : "carousel";
    draft = {
      step: o.step || (o.format ? 2 : 1), format: fmt, brandId: CB.state.brandId, ratio: F[fmt].ratio,
      start: o.start || "describe", templateId: o.templateId || null, about: o.about || "", name: ""
    };
    var scrim = CB.showDialog("", {});
    paint();
    var first = scrim.querySelector(draft.step === 1 ? ".choice[aria-checked=true]" : "#c-brand");
    if (first) first.focus();

    scrim.addEventListener("click", function (e) {
      var el = e.target.closest("[data-c]");
      if (!el) return;
      var c = el.getAttribute("data-c");
      var v = el.getAttribute("data-v");
      if (c === "close") { CB.closeDialog(); return; }
      if (c === "format") { draft.format = v; if (v !== "video") draft.ratio = F[v].ratio; paint(); scrim.querySelector("[data-v=\"" + v + "\"]").focus(); return; }
      if (c === "next") {
        if (draft.format === "video") { CB.closeDialog(); CB.go("studio"); return; }
        draft.step = 2; paint(); scrim.querySelector("#c-brand").focus(); return;
      }
      if (c === "back") { draft.step = 1; paint(); return; }
      if (c === "ratio") { draft.ratio = v; paint(); return; }
      if (c === "start") { draft.start = v; paint(); return; }
      if (c === "tpl") { draft.templateId = v; paint(); return; }
      if (c === "create") create();
    });
    scrim.addEventListener("input", function (e) {
      var k = e.target.getAttribute("data-c-input");
      if (k === "about") draft.about = e.target.value;
      if (k === "name") draft.name = e.target.value;
    });
    scrim.addEventListener("change", function (e) {
      if (e.target.getAttribute("data-c-input") === "brand") { draft.brandId = e.target.value; paint(); }
    });
  };

  CB.actions.create = function (btn) {
    var f = btn.getAttribute("data-format");
    CB.openCreate(f ? { format: f, step: 2 } : {});
  };
})();
