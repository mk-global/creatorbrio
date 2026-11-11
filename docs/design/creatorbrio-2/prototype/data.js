/*
 * Synthetic content for the CreatorBrio 2.0 prototype. Every brand, project,
 * template and production here is invented. Nothing is read from a real
 * CreatorBrio data folder.
 */
(function () {
  "use strict";

  var brands = [
    {
      id: "northwind",
      name: "Northwind Studio",
      isDefault: true,
      colors: { primary: "#1f2a44", secondary: "#3a4a6b", accent: "#e07a5f", background: "#f4efe6", surface: "#ffffff" },
      fonts: { heading: "Fraunces", body: "Inter" },
      keywords: ["editorial", "calm", "confident"],
      logo: "N"
    },
    {
      id: "kettle",
      name: "Kettle & Pine",
      isDefault: false,
      colors: { primary: "#2f4a3a", secondary: "#55705f", accent: "#d9a441", background: "#f7f3ea", surface: "#ffffff" },
      fonts: { heading: "DM Serif Display", body: "DM Sans" },
      keywords: ["warm", "seasonal", "handmade"],
      logo: "K"
    },
    {
      id: "fieldnotes",
      name: "Fieldnotes Coaching",
      isDefault: false,
      colors: { primary: "#111111", secondary: "#333333", accent: "#ff5a36", background: "#ffffff", surface: "#f5f5f5" },
      fonts: { heading: "Space Grotesk", body: "Space Grotesk" },
      keywords: ["bold", "direct", "practical"],
      logo: "F"
    }
  ];

  var HOUR = 3600 * 1000;
  var now = Date.UTC(2026, 10, 11, 15, 0, 0);

  // format: "carousel" (Instagram Carousel), "document" (LinkedIn Document), "cover" (Reel Cover)
  var featured = [
    {
      id: "p-morning", brand: "northwind", format: "carousel", ratio: "4:5", name: "Three habits for a calmer morning", edited: now - 2 * HOUR,
      slides: [
        { kicker: "Morning reset", title: "Three habits for a calmer morning", dark: true, big: true },
        { kicker: "Habit 01", title: "Light before screens", body: "Open the curtains before you open your phone." },
        { kicker: "Habit 02", title: "One glass of water", body: "Keep it on the nightstand. The easiest win of the day." },
        { kicker: "Habit 03", title: "Write one line", body: "Not a journal. One sentence about what matters today." },
        { kicker: "Try it", title: "Start with one. Keep it for a week.", center: true },
        { kicker: "Save this", title: "Save for tomorrow morning", dark: true, center: true }
      ]
    },
    {
      id: "p-onboarding", brand: "northwind", format: "document", ratio: "4:5", name: "How we cut client onboarding in half", edited: now - 26 * HOUR,
      slides: [
        { kicker: "Case study", title: "How we cut client onboarding in half", dark: true, big: true },
        { kicker: "The problem", title: "Nine emails before kickoff", body: "Every new client meant a week of back-and-forth." },
        { kicker: "Step 1", title: "One intake form", body: "Everything we asked across nine emails, in one place." },
        { kicker: "Step 2", title: "A fixed kickoff agenda", body: "Same five questions, every project." },
        { kicker: "Step 3", title: "Shared timeline on day one", body: "Clients see every milestone before we start." },
        { kicker: "Result", title: "From 9 days to 4", big: true, center: true },
        { kicker: "Takeaway", title: "Fewer touchpoints, clearer starts", center: true },
        { kicker: "Let's talk", title: "Follow for more studio notes", dark: true, center: true }
      ]
    },
    {
      id: "p-studio-cover", brand: "northwind", format: "cover", ratio: "9:16", name: "Inside the studio", edited: now - 50 * HOUR,
      slides: [{ kicker: "Studio tour", title: "Inside the studio", body: "A day in 30 seconds", dark: true, big: true, center: true }]
    },
    {
      id: "p-voice", brand: "northwind", format: "carousel", ratio: "1:1", name: "Brand voice checklist", edited: now - 5 * 24 * HOUR,
      slides: [
        { kicker: "Checklist", title: "Is it on brand?", dark: true, big: true },
        { kicker: "01", title: "Would we say it out loud?" },
        { kicker: "02", title: "Is it shorter than it was?" },
        { kicker: "03", title: "Does it sound like a person?" },
        { kicker: "Done", title: "Ship it.", dark: true, center: true }
      ]
    },
    {
      id: "p-draft", brand: "northwind", format: "carousel", ratio: "4:5", name: "Untitled carousel", edited: now - 6 * 24 * HOUR, slides: []
    },
    {
      id: "p-autumn", brand: "kettle", format: "carousel", ratio: "4:5", name: "Autumn menu launch", edited: now - 3 * HOUR,
      slides: [
        { kicker: "New this week", title: "The autumn menu is here", dark: true, big: true },
        { kicker: "Drink", title: "Maple oat latte", body: "Slow-roasted espresso, oat milk, a spoon of maple." },
        { kicker: "Bake", title: "Pear and ginger loaf", body: "Baked every morning, gone by noon." },
        { kicker: "Bowl", title: "Roasted squash soup", body: "With brown butter sage and sourdough." },
        { kicker: "Visit", title: "Open daily, 7 to 4", dark: true, center: true }
      ]
    },
    {
      id: "p-latte", brand: "kettle", format: "cover", ratio: "9:16", name: "Latte art in 30 seconds", edited: now - 30 * HOUR,
      slides: [{ kicker: "Behind the bar", title: "Latte art in 30 seconds", dark: true, big: true, center: true }]
    },
    {
      id: "p-quit", brand: "fieldnotes", format: "carousel", ratio: "4:5", name: "Five questions before you quit", edited: now - 8 * HOUR,
      slides: [
        { kicker: "Career", title: "Five questions before you quit", dark: true, big: true },
        { kicker: "Q1", title: "What exactly is draining you?" },
        { kicker: "Q2", title: "Have you said it out loud?" },
        { kicker: "Q3", title: "What would make you stay?" },
        { kicker: "Q4", title: "Where are you going, not leaving?" },
        { kicker: "Q5", title: "Can you afford six months?" },
        { kicker: "Next", title: "Book a free call", dark: true, center: true }
      ]
    },
    {
      id: "p-pricing", brand: "fieldnotes", format: "document", ratio: "4:5", name: "Pricing your first coaching package", edited: now - 4 * 24 * HOUR,
      slides: [
        { kicker: "Guide", title: "Pricing your first coaching package", dark: true, big: true },
        { kicker: "Rule 1", title: "Price the outcome, not the hour" },
        { kicker: "Rule 2", title: "Three tiers, one obvious choice" },
        { kicker: "Rule 3", title: "Raise it after five clients", dark: true, center: true }
      ]
    }
  ];

  // A long tail of older work, so the library can be judged at scale.
  var topics = [
    "Weekly studio notes", "Client spotlight", "Before and after", "Myths about branding", "Five tools we use",
    "What we learned this quarter", "Behind the scenes", "Quick tip", "Process breakdown", "Reading list",
    "Seasonal special", "Team intro", "Frequently asked", "Small business checklist", "Launch recap"
  ];
  var kinds = [
    { format: "carousel", ratio: "4:5" }, { format: "carousel", ratio: "1:1" }, { format: "document", ratio: "4:5" },
    { format: "cover", ratio: "9:16" }, { format: "carousel", ratio: "4:5" }
  ];
  var tail = [];
  for (var i = 0; i < 138; i++) {
    var b = brands[i % 3].id;
    var k = kinds[i % kinds.length];
    var t = topics[i % topics.length];
    var count = k.format === "cover" ? 1 : 4 + (i % 5);
    var slides = [];
    for (var s = 0; s < count; s++) {
      slides.push(s === 0
        ? { kicker: "No. " + (140 - i), title: t, dark: i % 2 === 0, big: true, center: k.format === "cover" }
        : { kicker: "Part " + s, title: t + ", part " + s });
    }
    tail.push({
      id: "p-tail-" + i, brand: b, format: k.format, ratio: k.ratio,
      name: t + " " + (140 - i), edited: now - (7 + i * 1.7) * 24 * HOUR, slides: slides
    });
  }

  var templates = [
    { id: "t-checklist", brand: "northwind", name: "Checklist post", format: "carousel", ratio: "1:1", from: "p-voice" },
    { id: "t-case", brand: "northwind", name: "Case study document", format: "document", ratio: "4:5", from: "p-onboarding" },
    { id: "t-menu", brand: "kettle", name: "Menu announcement", format: "carousel", ratio: "4:5", from: "p-autumn" },
    { id: "t-cover", brand: "kettle", name: "Behind the bar cover", format: "cover", ratio: "9:16", from: "p-latte" },
    { id: "t-questions", brand: "fieldnotes", name: "Five questions", format: "carousel", ratio: "4:5", from: "p-quit" }
  ];

  // Productions have no brand or thumbnail in the current Production API, so none is invented here.
  var productions = [
    { id: "v-tour", name: "Studio tour reel", revision: 14, updated: now - 5 * HOUR, agentRun: false },
    { id: "v-latte", name: "Latte pour, slow motion cut", revision: 6, updated: now - 3 * 24 * HOUR, agentRun: false },
    { id: "v-tips", name: "Three tips, talking head", revision: 22, updated: now - 9 * 24 * HOUR, agentRun: false }
  ];

  var DIM = { "1:1": [1080, 1080], "4:5": [1080, 1350], "9:16": [1080, 1920] };

  function esc(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c];
    });
  }

  // The same slide design the audit seeded into the running app, as body HTML at native size.
  function slideHtml(brand, ratio, slide, index, total) {
    var d = DIM[ratio];
    var bg = slide.dark ? brand.colors.primary : brand.colors.background;
    var fg = slide.dark ? brand.colors.background : brand.colors.primary;
    var size = slide.big ? 128 : 92;
    return "<div class=\"cb-slide\" style=\"width:" + d[0] + "px;height:" + d[1] + "px;background:" + bg + ";color:" + fg +
      ";font-family:'" + brand.fonts.body + "',system-ui,sans-serif;justify-content:" + (slide.center ? "center" : "space-between") + "\">" +
      "<div class=\"cb-slide-orb\" style=\"background:" + brand.colors.accent + ";opacity:" + (slide.dark ? 0.9 : 0.18) + "\"></div>" +
      "<div class=\"cb-slide-kicker\" style=\"color:" + brand.colors.accent + "\">" + esc(slide.kicker) + "</div>" +
      "<div class=\"cb-slide-main\"><h1 style=\"font-family:'" + brand.fonts.heading + "',Georgia,serif;font-size:" + size + "px\">" + esc(slide.title) + "</h1>" +
      (slide.body ? "<p>" + esc(slide.body) + "</p>" : "") + "</div>" +
      "<div class=\"cb-slide-foot\"><span>" + esc(brand.name) + "</span><span>" + (index + 1) + " / " + total + "</span></div></div>";
  }

  window.CB_DATA = {
    now: now,
    brands: brands,
    projects: featured.concat(tail),
    templates: templates,
    productions: productions,
    DIM: DIM,
    slideHtml: slideHtml,
    esc: esc
  };
})();
