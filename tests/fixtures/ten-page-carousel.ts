/**
 * A synthetic ten-slide 4:5 LinkedIn document in the shape of an editorial
 * carousel: a photographic cover, explanatory text, diagrams drawn in SVG and
 * CSS, comparisons and frameworks, set in Cormorant Garamond and Inter. Every
 * word is placeholder copy written for this test.
 *
 * Each slide lists the phrases a reader must be able to select and search on
 * that slide's page. The cover expects `/uploads/7c3d4e5f-6a7b-4c8d-8e9f-0a1b2c3d4e5f.png`, an upload's name holding JPEG bytes, to exist.
 */

const SERIF = "'Cormorant Garamond', serif";
const SANS = "'Inter', sans-serif";
const C = { ivory: "#f7f3e9", sage: "#8a9a5b", charcoal: "#2b2b2b", terracotta: "#c4622d", mist: "#e4e0d4" };

export interface TenPageSlide {
  html: string;
  /** Phrases that must come back, whole, from this page's text. */
  phrases: string[];
}

function frame(n: number, body: string, background: string = C.ivory, ink: string = C.charcoal): string {
  const marker = `${String(n).padStart(2, "0")} / 10`;
  return `<div style="position:relative;width:100%;height:100%;background:${background};color:${ink};font-family:${SANS};padding:110px 96px 120px">
  <div style="position:absolute;top:56px;left:96px;font-size:20px;letter-spacing:0.12em;opacity:.75">STUDIO NAME / SERIES</div>
  ${body}
  <div style="position:absolute;bottom:56px;right:96px;font-size:22px">${marker}</div>
</div>`;
}

const h = (text: string, size = 76) =>
  `<h2 style="font-family:${SERIF};font-weight:600;font-size:${size}px;line-height:1.05;margin-bottom:36px">${text}</h2>`;
const p = (text: string, size = 31) => `<p style="font-size:${size}px;line-height:1.5;margin-bottom:22px">${text}</p>`;

function slide(n: number, phrases: string[], body: string, background?: string, ink?: string): TenPageSlide {
  return { html: frame(n, body, background, ink), phrases: [...phrases, "STUDIO NAME / SERIES", `${String(n).padStart(2, "0")} / 10`] };
}

export const TEN_PAGE_CAROUSEL: TenPageSlide[] = [
  slide(
    1,
    ["When weight changes in midlife,", "what deserves a closer look?", "A ten-page field guide"],
    `<img src="/uploads/7c3d4e5f-6a7b-4c8d-8e9f-0a1b2c3d4e5f.png" style="position:absolute;left:0;top:0;width:100%;height:56%;object-fit:cover">
     <div style="position:absolute;left:96px;right:96px;top:61%">
       <h1 style="font-family:${SERIF};font-weight:600;font-size:84px;line-height:1.02">When weight changes in midlife,<br>what deserves a closer look?</h1>
       <p style="font-size:30px;margin-top:28px;color:${C.terracotta}">A ten-page field guide</p>
     </div>`
  ),
  slide(
    2,
    [
      "Start with real life.",
      "Most changes have ordinary causes, and the first job is to notice them without judgement.",
      "Write down what changed, when it started and what else moved at the same time.",
      "A clear record makes every later conversation shorter and more useful.",
    ],
    `${h("Start with real life.")}
     ${p("Most changes have ordinary causes, and the first job is to notice them without judgement.")}
     ${p("Write down what changed, when it started and what else moved at the same time.")}
     ${p("A clear record makes every later conversation shorter and more useful.")}`
  ),
  slide(
    3,
    ["Observation is not influence.", "What you see", "What shapes it", "Look before you explain."],
    `${h("Observation is not influence.")}
     <svg width="888" height="560" viewBox="0 0 888 560" style="font-family:${SANS}">
       <circle cx="230" cy="260" r="190" fill="none" stroke="${C.charcoal}" stroke-width="6"/>
       <circle cx="658" cy="260" r="190" fill="${C.sage}" fill-opacity="0.35" stroke="${C.sage}" stroke-width="6"/>
       <path d="M420 260 L470 260" stroke="${C.terracotta}" stroke-width="8"/>
       <path d="M462 240 L490 260 L462 280 Z" fill="${C.terracotta}"/>
       <text x="230" y="270" font-size="36" text-anchor="middle" fill="${C.charcoal}">What you see</text>
       <text x="658" y="270" font-size="36" text-anchor="middle" fill="${C.charcoal}">What shapes it</text>
       <text x="444" y="530" font-size="30" text-anchor="middle" fill="${C.terracotta}">Look before you explain.</text>
     </svg>`
  ),
  slide(
    4,
    ["Challenge the easy answers.", "The easy answer", "Eat less, move more.", "The fuller answer", "Ask what changed first."],
    `${h("Challenge the easy answers.")}
     <div style="display:flex;gap:32px;margin-top:20px">
       <div style="flex:1;border:3px solid ${C.mist};border-radius:20px;padding:40px;min-height:520px">
         <div style="font-size:24px;letter-spacing:.08em;color:${C.terracotta}">The easy answer</div>
         <p style="font-family:${SERIF};font-size:48px;margin-top:24px">Eat less, move more.</p>
       </div>
       <div style="flex:1;background:${C.charcoal};color:${C.ivory};border-radius:20px;padding:40px;min-height:520px">
         <div style="font-size:24px;letter-spacing:.08em;color:${C.sage}">The fuller answer</div>
         <p style="font-family:${SERIF};font-size:48px;margin-top:24px">Ask what changed first.</p>
       </div>
     </div>`
  ),
  slide(
    5,
    ["Weight, composition and fat distribution.", "Scale weight", "Body composition", "Where it sits", "Three measures, three different stories."],
    `${h("Weight, composition and fat distribution.", 68)}
     <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:30px;text-align:center">
       ${["Scale weight", "Body composition", "Where it sits"]
         .map(
           (label, i) => `<div><div style="width:150px;height:150px;margin:0 auto 26px;border-radius:50%;border:6px solid ${[C.terracotta, C.sage, C.charcoal][i]};display:flex;align-items:center;justify-content:center;font-family:${SERIF};font-size:64px">${i + 1}</div><div style="font-size:30px">${label}</div></div>`
         )
         .join("")}
     </div>
     <p style="font-size:32px;line-height:1.5;margin-top:90px">Three measures, three different stories.</p>`
  ),
  slide(
    6,
    ["Stress, sleep and food patterns.", "Stress", "Sleep", "Appetite", "Energy", "Each factor moves the others."],
    `${h("Stress, sleep and food patterns.")}
     <svg width="888" height="600" viewBox="0 0 888 600" style="font-family:${SANS}">
       <g stroke="${C.mist}" stroke-width="5">
         <line x1="200" y1="140" x2="688" y2="140"/><line x1="200" y1="140" x2="200" y2="440"/>
         <line x1="688" y1="140" x2="688" y2="440"/><line x1="200" y1="440" x2="688" y2="440"/>
         <line x1="200" y1="140" x2="688" y2="440"/>
       </g>
       ${[
         [200, 140, "Stress", C.terracotta],
         [688, 140, "Sleep", C.sage],
         [200, 440, "Appetite", C.charcoal],
         [688, 440, "Energy", C.sage],
       ]
         .map(
           ([x, y, label, colour]) =>
             `<circle cx="${x}" cy="${y}" r="92" fill="${C.ivory}" stroke="${colour}" stroke-width="6"/><text x="${x}" y="${Number(y) + 11}" font-size="32" text-anchor="middle" fill="${C.charcoal}">${label}</text>`
         )
         .join("")}
       <text x="444" y="580" font-size="30" text-anchor="middle" fill="${C.charcoal}">Each factor moves the others.</text>
     </svg>`
  ),
  slide(
    7,
    ["Perimenopause, muscle and medical possibilities.", "Hormones", "Hormonal shifts can change where weight settles.", "Muscle", "Less muscle means a lower daily energy need.", "Medicine", "Some medicines and conditions change weight too."],
    `${h("Perimenopause, muscle and medical possibilities.", 64)}
     ${[
       ["Hormones", "Hormonal shifts can change where weight settles."],
       ["Muscle", "Less muscle means a lower daily energy need."],
       ["Medicine", "Some medicines and conditions change weight too."],
     ]
       .map(
         ([title, text]) =>
           `<section style="border-top:3px solid ${C.terracotta};padding:26px 0 30px"><div style="font-family:${SERIF};font-size:44px;font-weight:600">${title}</div><p style="font-size:30px;line-height:1.45;margin-top:10px">${text}</p></section>`
       )
       .join("")}`
  ),
  slide(
    8,
    ["The cost of the wrong response.", "Wrong response", "Right response", "Blame", "Curiosity", "Restriction", "Measurement", "Waiting", "Asking early"],
    `${h("The cost of the wrong response.")}
     <div style="display:grid;grid-template-columns:1fr 1fr;border:3px solid ${C.charcoal};border-radius:16px;overflow:hidden;font-size:32px">
       <div style="background:${C.charcoal};color:${C.ivory};padding:26px 32px">Wrong response</div>
       <div style="background:${C.sage};color:${C.charcoal};padding:26px 32px">Right response</div>
       ${[
         ["Blame", "Curiosity"],
         ["Restriction", "Measurement"],
         ["Waiting", "Asking early"],
       ]
         .map(
           ([a, b]) =>
             `<div style="padding:28px 32px;border-top:2px solid ${C.mist}">${a}</div><div style="padding:28px 32px;border-top:2px solid ${C.mist};border-left:2px solid ${C.mist}">${b}</div>`
         )
         .join("")}
     </div>`
  ),
  slide(
    9,
    ["An evidence-aware next step.", "Did it change quickly?", "Book a check-up", "Is it slow and steady?", "Track for six weeks"],
    `${h("An evidence-aware next step.")}
     <div style="display:flex;flex-direction:column;gap:22px;font-size:30px">
       ${[
         ["Did it change quickly?", "Book a check-up"],
         ["Is it slow and steady?", "Track for six weeks"],
       ]
         .map(
           ([q, a]) =>
             `<div style="display:flex;align-items:center;gap:26px"><div style="flex:1;border:3px solid ${C.charcoal};border-radius:14px;padding:28px">${q}</div><div style="width:0;height:0;border-top:22px solid transparent;border-bottom:22px solid transparent;border-left:34px solid ${C.terracotta}"></div><div style="flex:1;background:${C.terracotta};color:${C.ivory};border-radius:14px;padding:28px">${a}</div></div>`
         )
         .join("")}
     </div>`
  ),
  slide(
    10,
    ["A reusable four-step framework.", "Notice", "Record", "Question", "Decide", "Save this guide for your next appointment."],
    `${h("A reusable four-step framework.")}
     <ol style="list-style:none;font-size:34px">
       ${["Notice", "Record", "Question", "Decide"]
         .map(
           (step, i) =>
             `<li style="display:flex;align-items:center;gap:28px;margin-bottom:26px"><span style="display:inline-flex;width:72px;height:72px;border-radius:50%;background:${[C.terracotta, C.sage, C.charcoal, C.terracotta][i]};color:${C.ivory};align-items:center;justify-content:center;font-family:${SERIF};font-size:40px">${i + 1}</span>${step}</li>`
         )
         .join("")}
     </ol>
     <p style="font-family:${SERIF};font-size:40px;margin-top:40px;color:${C.terracotta}">Save this guide for your next appointment.</p>`,
    C.ivory
  ),
];
