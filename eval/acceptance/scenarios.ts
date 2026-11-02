import sharp from "sharp";
import type { AspectRatio } from "@/types/carousel";

/**
 * The acceptance scenarios for the creative run (#40). Every request and
 * image is synthetic. `kind` selects how the harness drives a scenario;
 * `expect` is what the deterministic acceptance checks look for.
 */

export type ScenarioId = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9";

export interface Scenario {
  id: ScenarioId;
  title: string;
  kind: "integration" | "revision" | "image-service-unavailable" | "cancel" | "restart-retry";
  aspectRatio: AspectRatio;
  message: string;
  /** For the judges: what the user is trying to achieve, and for whom. */
  objective: string;
  audience: string;
  constraints: string[];
  notes: string;
  expect: {
    slides?: number;
    /** Generated images attached: an exact count, "none", or "some" (at least one). */
    generated?: number | "none" | "some";
    /** Every generated image is placed on a slide. */
    generatedPlaced?: boolean;
    /** The uploaded reference image is placed on a slide. */
    referencePlaced?: boolean;
    /** No <img> or uploads background on any slide. */
    typographyOnly?: boolean;
    readsSources?: boolean;
  };
  /** Upload the synthetic founder portrait as a reference first. */
  reference?: boolean;
  /** A revision of another scenario's carousel, in the same session. */
  revisionOf?: ScenarioId;
  /** Also run as Design-Agent-only and compare blind. */
  compare?: boolean;
  /**
   * Needs the image service to make images. The harness waits, within a
   * bound, for the service to admit work first, and records the scenario as
   * not run, with no planning cost, when it does not.
   */
  needsImages?: boolean;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "S1",
    title: "Typography-only educational carousel",
    kind: "integration",
    aspectRatio: "4:5",
    message: "Make 5 slides explaining compound interest for first-time investors. Keep it purely typographic, no photos.",
    objective: "Teach first-time investors what compound interest is and why starting early matters.",
    audience: "First-time investors with no finance background.",
    constraints: ["exactly 5 slides", "purely typographic, no photos"],
    notes: "A good set builds the idea step by step with a simple worked example, keeps numbers correct, and uses type, colour and layout rather than imagery.",
    expect: { slides: 5, generated: "none", typographyOnly: true },
    compare: true,
  },
  {
    id: "S2",
    title: "Generated reel cover",
    kind: "integration",
    aspectRatio: "9:16",
    message: "Design a reel cover for my talk 'The quiet cost of comfort' for early-stage founders. Cinematic and serious, with a photo-like image.",
    objective: "Make founders stop scrolling and watch a talk about how comfort quietly costs early-stage companies.",
    audience: "Early-stage startup founders.",
    constraints: ["a single reel cover", "the talk title 'The quiet cost of comfort'", "cinematic and serious", "a photo-like image"],
    notes: "One 9:16 cover; the title is dominant and legible over or beside a photographic image whose subject relates to comfort or complacency.",
    expect: { slides: 1, generated: "some", generatedPlaced: true },
    compare: true,
    needsImages: true,
  },
  {
    id: "S3",
    title: "Five-image carousel with explicit placement",
    kind: "integration",
    aspectRatio: "4:5",
    message: "Make 5 slides about a founder's day from dawn to midnight, each slide with its own photo of that moment.",
    objective: "Show a founder's day as a visual story from dawn to midnight.",
    audience: "Followers interested in startup life.",
    constraints: ["exactly 5 slides", "each slide has its own photo of its moment of the day", "dawn to midnight"],
    notes: "Five slides in time order, each with a distinct photo matching its time of day, with short text that carries the story.",
    expect: { slides: 5, generated: 5, generatedPlaced: true },
    needsImages: true,
  },
  {
    id: "S4",
    title: "Uploaded photo placed on a reel cover",
    kind: "integration",
    aspectRatio: "9:16",
    message: "Use my photo for a reel cover announcing my podcast episode 'Building in public'",
    objective: "Announce a podcast episode with the creator's own photo on the cover.",
    audience: "The creator's followers.",
    constraints: ["a single reel cover", "uses the uploaded photo of the creator", "the episode title 'Building in public'"],
    notes: "The uploaded portrait (an illustrated person on a plain background) appears on the cover, not only as a style influence, and the episode title is prominent.",
    expect: { slides: 1, generated: "none", referencePlaced: true },
    reference: true,
    compare: true,
  },
  {
    id: "S5",
    title: "Revision keeps the brief",
    kind: "revision",
    aspectRatio: "9:16",
    message: "Make it more dramatic",
    objective: "Make the existing reel cover for 'The quiet cost of comfort' more dramatic while keeping its subject and audience.",
    audience: "Early-stage startup founders.",
    constraints: ["still the same single reel cover", "the talk title 'The quiet cost of comfort'", "more dramatic than before"],
    notes: "The cover keeps the title and subject; drama comes from contrast, light, scale or crop.",
    expect: { slides: 1 },
    revisionOf: "S2",
    needsImages: true,
  },
  {
    id: "S6",
    title: "Source-based carousel",
    kind: "integration",
    aspectRatio: "4:5",
    message: "Turn this article into a 6-slide carousel for high-school students: https://en.wikipedia.org/wiki/Lighthouse",
    objective: "Explain what lighthouses are, how they work and their history, accurately, from the linked article.",
    audience: "High-school students.",
    constraints: ["exactly 6 slides", "based on the linked article", "pitched for high-school students"],
    notes: "Facts should match the Wikipedia article on lighthouses; anything invented is a fabrication.",
    expect: { slides: 6, readsSources: true },
    compare: true,
  },
  {
    id: "S7",
    title: "Image service unavailable",
    kind: "image-service-unavailable",
    aspectRatio: "9:16",
    message: "Design a reel cover for my talk 'Night shift' with a generated photo of an empty city street at 3am.",
    objective: "A reel cover built around a generated night-street photo.",
    audience: "The creator's followers.",
    constraints: ["a single reel cover", "a generated photo of an empty city street at 3am"],
    notes: "With the image service down, the run must stop with a clear reason or plan no images; it must never silently design without the requested photo.",
    expect: {},
  },
  {
    id: "S8",
    title: "Cancellation while images are prepared",
    kind: "cancel",
    aspectRatio: "4:5",
    message: "Make 5 slides about a baker's day from 4am to closing, each slide with its own photo of that moment.",
    objective: "A five-photo day-in-the-life carousel.",
    audience: "Followers of a local bakery.",
    constraints: ["exactly 5 slides", "each slide has its own photo"],
    notes: "Cancelled during the image stage: nothing may be attached or changed.",
    expect: {},
    needsImages: true,
  },
  {
    id: "S9",
    title: "Restart and retry after partial generation",
    kind: "restart-retry",
    aspectRatio: "4:5",
    message: "Make 5 slides about a fisherman's day from before dawn to night, each slide with its own photo of that moment.",
    objective: "A five-photo day-in-the-life carousel.",
    audience: "Followers interested in coastal life.",
    constraints: ["exactly 5 slides", "each slide has its own photo"],
    notes: "The server stops mid-way through the images; Retry must remake only the missing images and then design.",
    expect: { slides: 5, generated: 5, generatedPlaced: true },
    needsImages: true,
  },
];

/** A synthetic portrait (an illustration, not a real person) for the reference scenario. */
export async function founderPhoto(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9e4dc"/><stop offset="1" stop-color="#c9c1b4"/></linearGradient>
    <linearGradient id="jacket" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f4858"/><stop offset="1" stop-color="#1d2d38"/></linearGradient>
  </defs>
  <rect width="900" height="1200" fill="url(#bg)"/>
  <path d="M150 1200 C170 930 300 840 450 840 C600 840 730 930 750 1200 Z" fill="url(#jacket)"/>
  <path d="M390 840 L450 960 L510 840 Z" fill="#f4efe8"/>
  <rect x="405" y="720" width="90" height="140" rx="30" fill="#c98f6b"/>
  <ellipse cx="450" cy="560" rx="170" ry="210" fill="#d9a07c"/>
  <path d="M280 520 C280 340 380 300 460 300 C560 300 630 360 625 500 C600 430 540 400 450 410 C370 418 320 450 280 520 Z" fill="#3a2a22"/>
  <ellipse cx="390" cy="560" rx="16" ry="11" fill="#2b2b2b"/>
  <ellipse cx="510" cy="560" rx="16" ry="11" fill="#2b2b2b"/>
  <path d="M400 665 Q450 700 500 665" stroke="#8a4f3a" stroke-width="10" fill="none" stroke-linecap="round"/>
  <path d="M450 580 Q440 630 455 635" stroke="#b37a5a" stroke-width="7" fill="none" stroke-linecap="round"/>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
