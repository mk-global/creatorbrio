/**
 * A long, fully specified request for a ten-page LinkedIn PDF carousel, shaped
 * like the one refused in #124: a stated length in pages (never in slides),
 * page labels such as "Page 01: Cover", page markers such as "03 / 10", the
 * word "cover", exact copy to keep, and instructions not to fetch anything or
 * generate images.
 *
 * The page titles follow the reproduction brief; every body block and design
 * note is synthetic placeholder text written for this test, not real copy.
 */

const PAGE_TITLES = [
  "Cover, When weight changes in midlife, what deserves a closer look?",
  "Start with real life.",
  "Why one explanation is not enough.",
  "Challenge the easy answers.",
  "Weight, composition and fat distribution.",
  "Stress, sleep and food patterns.",
  "Perimenopause, muscle and medical possibilities.",
  "The cost of the wrong response.",
  "An evidence-aware next step.",
  "A reusable four-step framework.",
];

const pad = (n: number) => String(n).padStart(2, "0");

function pageBlock(title: string, n: number): string {
  return [
    `Page ${pad(n)}: ${title}`,
    "",
    `Heading: ${title.replace(/^Cover, /, "")}`,
    "",
    "Body (approved, keep exactly): This is synthetic placeholder copy standing in for an approved paragraph. " +
      "It is long enough to behave like real editorial text, with commas, a question or two, and a second sentence " +
      "that qualifies the first. Nothing here should be shortened, merged with another page or rewritten in a new voice.",
    "",
    "Second paragraph (approved, keep exactly): A further placeholder paragraph that continues the argument of this page " +
      "without introducing statistics, claims or calls to action. It ends with a short line that the layout should give room.",
    "",
    `Design: page marker "${pad(n)} / 10" bottom right; a quiet "STUDIO NAME / SERIES" label top left; ` +
      "one clear focal element; generous margins; a restrained diagram built from type, rules and simple shapes in HTML and CSS, " +
      "never a stock photograph or a generated image.",
  ].join("\n");
}

export const TEN_PAGE_BRIEF = [
  "Create the final LinkedIn PDF carousel. Exactly 10 pages, 4:5 portrait format.",
  "Use the exact supplied content and do not rewrite any wording. Do not access websites or retrieve external content.",
  "Use Cormorant Garamond and Inter, warm ivory, sage, charcoal and terracotta.",
  "Use editorial diagrams and typography rather than generated images.",
  "",
  ...PAGE_TITLES.map((t, i) => `Page ${pad(i + 1)}: ${t}`),
  "",
  "Create all ten pages. Preserve their order and text. Export one PDF, not ten separate images.",
  "",
  "Approved content and per-page design rules follow.",
  "",
  ...PAGE_TITLES.flatMap((t, i) => [pageBlock(t, i + 1), ""]),
  "Separate caption (do not place it on any page): a synthetic caption of several short paragraphs, kept apart from the PDF.",
].join("\n");
