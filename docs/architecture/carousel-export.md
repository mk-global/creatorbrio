# Carousel export

How a carousel becomes Instagram PNGs or a LinkedIn PDF: the formats a person can download, when export is available, how each slide is rendered and printed, and the effects the native PDF refuses or handles differently.
For the Video Studio's MP4 export, see [video-rendering.md](video-rendering.md).

## Formats and availability

The Export menu renders every slide in headless Chromium at the carousel's exact dimensions and offers these downloads:

- **Instagram · PNG ZIP**: one PNG per slide, in a ZIP.
  A carousel with a single slide, such as a reel cover, can also be downloaded as that one PNG with **Instagram · PNG**, no ZIP to extract.
- **LinkedIn · PDF**: one PDF for a LinkedIn document post, with one page per slide in carousel order.
  Chromium prints each slide natively, so its text is real PDF text that can be selected, copied and searched, set in embedded subsets of the slide's fonts and sharp at any zoom.
  CSS and SVG shapes stay vector graphics and photographs stay images, on a page with the carousel's own aspect ratio.
  4:5 portrait is the recommended LinkedIn format; 1:1 exports as square pages, and 9:16 exports as-is with a note that 4:5 generally displays better in LinkedIn's feed.
  A PDF larger than LinkedIn's 100 MB limit is refused with a message saying what to change.
  A slide whose text or effects cannot be printed faithfully is refused with a message naming the slide, rather than exported as a picture or drawn wrongly; see [Native PDF limits](#native-pdf-limits).

While the design agent is still creating or changing slides, the Export button reads **Waiting for slides…** and is unavailable, so a download never captures a half-finished carousel.
Every open editor tab notices within a couple of seconds, including one left open before the generation started.
When the agent finishes, Export opens as usual.
When it was stopped (the Stop button, a page reload, a closed tab), failed or timed out after changing slides, every slide it saved is kept, but the Export button reads **Incomplete**: export the slides only after confirming them with **Use these slides**, or ask the agent to continue and export once it finishes.
Only the slides themselves count as changes: their content and their order.
Attaching a reference image, renaming the carousel, or a change to a slide's notes, the caption or the hashtags (which the agent and the API can make; the editor shows them but does not edit them) never makes a generation incomplete.
If the server stops while the agent is working, the carousel reads **Incomplete** only when its slides changed.
A carousel runs one generation at a time: a message sent from another tab while one is running is refused with a message saying so.

If an export fails, the editor tells you what went wrong.

## From slide to PNG and PDF

Slides are stored as body-level HTML, without `<html>`, `<head>`, or `<!DOCTYPE>`.
`wrapSlideHtml()` in [`src/lib/slide-html.ts`](../../src/lib/slide-html.ts) wraps that body into a full document with font loading and fixed dimensions.
The same function feeds both the sandboxed preview iframe and the Puppeteer export, which renders each slide at its exact pixel size.

Before a slide is loaded for export, each uploaded image it references in a `src` attribute or a CSS `url()` is replaced with a `data:` URI of its bytes, because the export page has no server behind it.
Slide HTML is untrusted, so only a reference to one file directly under `/uploads/`, in the name form the app gives uploads and generated images, is read, through `readUpload()` in [`src/lib/upload-files.ts`](../../src/lib/upload-files.ts), the same confined reader that serves uploads to the preview ([#145](https://github.com/mk-global/creatorbrio/issues/145)).
It never follows a link or leaves the real uploads folder, and the bytes must be a PNG, JPEG or WebP image, labelled by what they are.
Any other reference is left as it is and never read; in the export it does not load.

The slide's Google Fonts are inlined the same way, by `getInlinedFontCSS()` in [`src/lib/fonts.ts`](../../src/lib/fonts.ts), and cached under `data/.font-cache/` once every file of a family has been inlined.
Each font request is abandoned when nothing arrives for 10 seconds, headers or body, rather than after a fixed total, so a large family that downloads steadily is never cut off ([#200](https://github.com/mk-global/creatorbrio/issues/200)).
A request that stalls or cannot connect marks the font source unreachable for 60 seconds, during which every export falls back at once instead of waiting again.
A family with any file that could not be fetched renders in the fallback font and is not cached, so the next export tries it again.

`POST /api/carousels/[id]/export` answers in one of three ways.
Without a `format`, or with `?format=png`, it answers with a ZIP of PNGs, as it always has.
With `?format=single-png`, a carousel with exactly one slide is answered with that slide's PNG itself, the same bytes the ZIP would contain.
With `?format=pdf`, each slide is loaded in the same document, with the same inlined images and the same waits as for its PNG, and printed natively by Chromium to a one-page PDF with screen media, backgrounds and no margins.

A slide's scripts never run in an export, for the PNG and the PDF alike, as they never run in the preview's sandboxed iframe ([#130](https://github.com/mk-global/creatorbrio/issues/130)).
Slide HTML is untrusted: the design agent writes it while able to fetch web pages, and any local client can write it through the API.
The export's own font and image waits are evaluated by Puppeteer and still run.

The print differs from the screenshot's page in three deliberate ways, each so that the PDF shows what the preview shows:

- The slide's own `@page` size, margins and page margin boxes are overridden, so the paper is the slide.
- The body is positioned, so that it, rather than the page, contains absolutely positioned elements and its own `overflow: hidden` clips them in print as the screen clips them; an element reaching past an edge then neither shrinks the page nor starts another.
  Nothing else about the body changes, so its layout, stacking and background are the screen's.
- Google Fonts are fetched as static instances, one file per weight, from the same family, so they embed as TrueType; Chromium embeds the variable files the preview uses as Type 3 glyphs, whose text Apple's Preview and Safari break into fragments.

The print-only rules and the checks run on the page before printing live in [`src/lib/print-check.ts`](../../src/lib/print-check.ts).
[`src/lib/export-pdf.ts`](../../src/lib/export-pdf.ts) then copies those pages into one document in slide order, unchanged apart from removing links and re-expressing blurred shadows.
Chromium prints a blurred `box-shadow` or `text-shadow` as a fill under a luminosity soft mask, which Apple's renderers (Preview, Quick Look, Safari) draw wrongly: a text shadow as a solid block, a box shadow cut off.
[`src/lib/pdf-shadows.ts`](../../src/lib/pdf-shadows.ts) draws each one instead as an image of the shadow's colour carrying the same blur as its own soft mask, which Apple's renderers and poppler both draw as the screen does; it matches only that exact construct and leaves anything else as printed.
While a chat run is still writing the carousel's slides, every format is refused with status 409.
Pages are sized at 0.75 pt per pixel (72 pt per inch over 96 CSS pixels per inch), so a 1080×1350 slide becomes an 810×1012.5 pt page, keeping its exact aspect ratio.
Chromium rounds the paper up to a hundredth of an inch (a 4:5 slide prints 1013.04 pt tall), so each page is trimmed to the slide's exact size from its top edge, where the slide is drawn.
The trim moves the page box, not the drawing, so the sliver falls below the box and the content is copied byte for byte; moving the drawing instead would leave gradients, which are positioned against the page itself, half a point off.

## The export browser

One headless Chromium in the server process renders every export, launched by the first export and shared by those after it, and each export renders in its own browser context, closed when the export ends ([#198](https://github.com/mk-global/creatorbrio/issues/198)).
At most one browser is alive at a time: a new one is launched only after the previous one has shut down.
It runs with Chromium's process sandbox on ([#197](https://github.com/mk-global/creatorbrio/issues/197)), so each renderer loading untrusted slide HTML is confined by the operating system rather than running with the server's access; on macOS that is the system sandbox, on Linux Chromium's namespace or setuid sandbox with a seccomp filter.
A browser whose command line turns any part of the sandbox off is killed and the export refused, and where the system cannot provide the sandbox (on Linux, when unprivileged user namespaces are blocked and Chrome's setuid helper is not installed) the export fails saying so.
There is no setting to export without it; on such a Linux system, use a Chrome whose setuid sandbox helper is installed (Google Chrome's packages install one) or allow unprivileged user namespaces.
Every shutdown is bounded: a clean close gets 2 seconds, after which the browser's whole process group is killed and its exit awaited.

Every slide has a deadline from opening its page to its capture: 60 seconds for a PNG and 120 seconds for a PDF page.
Each sits above the sum of the bounded waits inside it (load 20 s, fonts 10 s and images 10 s, and for the PDF the print check 15 s and the print 30 s), so it fires only when the browser stops answering, and every DevTools call times out 5 seconds after the longer one.
A slide that misses its deadline marks the browser for replacement and starts one health check, shared by every slide that missed it: a fresh context, a tiny page and its screenshot, within 10 seconds.

- A browser that fails the check is killed at once. The export, and any other export still running in it, fails with "The export browser stopped responding and was replaced. Try the export again.", and the next export launches a new browser.
- A browser that passes is replaced as soon as no export is using it, and the export fails with a message naming the slide that took too long.

The browser is also replaced after 50 slides once no export is using it; otherwise it stays open between exports.
Why Chromium stopped completing captures in the outage that led to this is not known; a browser that stays connected but completes no capture is recovered this way whatever the cause.
The route does not stop an export when its request is abandoned; the slide deadlines bound how long that work runs.

## Native PDF limits

Chromium's PDF printer keeps text as text through transforms, opacity, clipping, gradients, blend modes other than `plus-lighter` and `plus-darker`, outlined text, and text and box shadows.
Some effects behave differently on paper than on screen, or in some PDF readers, and are handled as follows.

Refused before printing, with status 422 and a message naming the slide and the effect:

- A CSS or SVG `filter` or a `-webkit-box-reflect` turns the element into an image of everything in it, so it is refused when anything it renders could draw text: a text node, `::before` or `::after` text (counters included), a form field, media controls, an embedded frame, a list marker, a `<details>` element's own label, a broken image's alt text, or an SVG `<use>` that reaches `<text>` through any chain of references.
  The check follows what renders, not only the document tree: open shadow roots, the content slotted into them, and every frame of the slide are held to the same rule.
  The check is deliberately conservative and does not ask whether that text is visible, so hidden text under a filter is refused too.
  The same applies to a filter or reflection on a pseudo-element that styles an element's own content (`::first-letter`, `::first-line`, `::marker`, `::placeholder`, `::file-selector-button`, `::details-content`) when that element holds text.
  Text that is never drawn, in `<style>`, `<script>` or SVG `<title>`, `<desc>` and `<metadata>`, does not count, and a filter on an image, a shape or an icon with no text is fine.
- A closed shadow root anywhere in the slide, frames included, because its content cannot be checked; a frame the check cannot run in, a document nested too deeply for the DevTools protocol to read (far beyond real designs: 140 levels is accepted, 200 is not), and a check that takes longer than 15 seconds are refused for the same reason.
- A `backdrop-filter` anywhere on the slide, including on a `::before` or `::after` whatever the size of its element, because Chromium leaves the text inside it, and can leave content painted after it, out of the PDF.
- Text inside an SVG `<pattern>`, which prints as part of a picture, or used as an SVG `<clipPath>`, which prints as a soft mask that Apple's Preview and poppler-based readers draw wrongly.
- Text filled through `background-clip: text` (gradient or image text), including through `::first-letter` or `::first-line`: it prints as text, but Apple's Preview and poppler-based readers draw it as a solid block.
- A CSS or SVG mask (`mask`, `mask-image`) on anything visible, on any generated `::before` or `::after`, or on SVG content defined in `<defs>` or a `<symbol>` and drawn through `<use>`: Apple's Preview and poppler-based readers draw the masked image or text without its fade.
- An element with `backface-visibility: hidden` turned away from the viewer, such as the back of a flip card: the screen hides it, but Chromium prints it, mirrored, over the face that shows.
  A flip card is refused whichever face is turned; showing one face and leaving the other out with `display: none` prints as the screen shows.
- `mix-blend-mode: plus-lighter` or `plus-darker`, which PDF has no equivalent for, so Chromium prints it as an ordinary overlay.
- Content reaching past the slide when the print clip cannot apply, because the slide resizes or moves its own `body` (the clip is then left off, since positioning that body would move what is positioned inside it) or turns the body's clipping off; the page would otherwise come out shrunk.

Refused after printing:

- A slide whose page leaves out letters or digits the slide visibly shows.
  Every letter and digit painted inside the slide (not hidden, clipped away or transparent) must be in the page's text as a PDF reader extracts it, through each font's Unicode map and the `ActualText` Chromium writes for ligatures and similar glyphs, compared without case, accents or ligatures; punctuation and emoji are not compared.
  Characters are counted, so a character the slide shows twice must be in the page twice: the same words printed in another font elsewhere on the slide cannot stand in for ones the page lost.
  Text under a `clip-path` that shows any of it is compared, since Chromium keeps every glyph of it in the page; text a clip path hides entirely is not.
  The literal text of a `::before`, `::after` or custom `::marker` is compared when it is laid out in its element's flow and that element is wholly in view; counter numbers, `attr()` text, default list numbers and generated text positioned elsewhere are not compared.
  This catches characters that fall back to a system font Chromium cannot embed, which it leaves out of the page entirely: on macOS, Chinese with no web font covering it falls back to PingFang and is refused, while Japanese and Korean fall back to Hiragino and Apple SD Gothic, which embed.
  It also catches an effect not listed above that flattens part of a slide's text.
  The message quotes up to five of the missing characters; text shortened by an ellipsis or a line clamp counts as shown but is not compared.
- A slide that shows visible text but whose page holds no text at all, such as one whose only text is punctuation or symbols, flattened by an effect not listed above.
- A slide that did not print as exactly one page of its own size, such as one with a shape placed entirely outside the slide, which shows nothing on screen but can start a second page in print.

Printed, with a difference worth knowing:

- A blurred shadow (`box-shadow`, `text-shadow`) is embedded as an image of its blur, re-expressed by the merge as described above; the text it belongs to stays text.
  An unblurred shadow stays a vector shape, and a `drop-shadow` filter on a shape prints as a picture of that shape.
- A radial gradient that fades to transparent, such as a glow, is drawn as on screen by Apple's readers, but darker and muddier by poppler-based readers (most Linux PDF viewers).
  poppler also draws a hard colour stop in a slide-high gradient as a ramp a few pixels long, where Apple's readers draw it sharp.
- Outlined text (`-webkit-text-stroke`) is printed by Chromium in two layers, the fill in the TrueType font and the outline in a Type 3 copy of it.
  Readers find and select the words whole, but copying or extracting the page's text returns them twice.
- Text that is not painted, such as a visually hidden label, text clipped out of view (by overflow, `contain: paint` or a clip path), text below the smallest opacity Chromium paints, SVG text left unused in `<defs>`, or SVG text with neither fill nor stroke, is not expected in the PDF.
- If Google cannot serve static instances of a font covering every weight and style of its variable font, the variable font is embedded instead, as Type 3 glyphs with Unicode maps: the typeface is still right and the text still selectable, but Apple's readers fragment it.
- A character a web font does not contain is drawn from a system font, as in the preview and the PNG export, and embedded when Chromium can embed that font; when it cannot, the slide is refused, as above.
  For Chinese, giving the text a Google font such as Noto Sans SC avoids the fallback altogether.
- The first PDF export using a font Google splits into many files is slow: Noto Sans SC is about 100 unicode-range files per weight, fetched one after another for the variable font and again for its static instances, which took over three minutes on a cold font cache (the PNG export's share is the first half of that).
  Fonts are cached under `data/.font-cache`, so later exports take seconds; Latin fonts are a handful of files and take seconds even the first time.
- An SVG file used as an image (a `data:` URI; uploads are PNG, JPEG or WebP) is printed as Chromium draws it and is not checked inside: a filter within it turns its text into a picture.
- A page with no background is white paper in the PDF, while the PNG export shows headless Chromium's dark default canvas there.
- Uploaded images are embedded at their own resolution: JPEGs as they are, PNG and WebP losslessly.
  A carousel of large PNG or WebP photographs can therefore exceed LinkedIn's 100 MB limit where its PNG export would not; the export then refuses it with status 422, before merging when the printed slides alone are already over the limit.
- The document has no tags or outline: pages are printed separately and merged, which cannot carry a document-level structure across.
  Links are removed, because the preview and the PNG have nothing to click.
