/**
 * What the native PDF print adds to a loaded slide, and the checks it runs
 * inside the page before printing. See `exportSlidePdf` in `export-slides.ts`.
 *
 * The checks run inside the page through Puppeteer, which serialises each
 * function's source: a function passed to `page.evaluate` must not reference
 * anything outside itself, so helpers are declared inside it.
 *
 * Slide HTML is untrusted. Elements with a `name` or `id` can shadow
 * properties of `document` and of forms (DOM clobbering), so the checks read
 * the document only through the built-in prototype accessors. Declarative
 * shadow DOM renders without scripts, so the checks walk open shadow roots;
 * closed ones cannot be read from the page and are found through the
 * DevTools protocol instead (see `hasClosedShadowRoot`).
 */

/**
 * Print-only rules that make the paper the slide: the slide's own `@page`
 * size, margins and page margin boxes exist only in print, so they are
 * overridden.
 */
export function printPageCss(width: number, height: number): string {
  const marginBoxes = [
    "top-left-corner", "top-left", "top-center", "top-right", "top-right-corner",
    "bottom-left-corner", "bottom-left", "bottom-center", "bottom-right", "bottom-right-corner",
    "left-top", "left-middle", "left-bottom", "right-top", "right-middle", "right-bottom",
  ];
  return (
    `@page { size: ${width}px ${height}px !important; margin: 0 !important; ` +
    marginBoxes.map((box) => `@${box} { content: none !important; }`).join(" ") +
    " }"
  );
}

/**
 * The screen clips the slide at the viewport, but print layout does not: an
 * absolutely positioned element reaching past the right edge makes Chromium
 * shrink the whole slide to fit the paper, and one reaching past the bottom
 * can start another page. `wrapSlideHtml` already gives the body
 * `overflow: hidden`, but that only clips what the body contains, and an
 * absolutely positioned element belongs to the page unless the body is
 * positioned. Positioning the body makes it their containing block, so the
 * print clips where the screen does. Nothing else changes: `position:
 * relative` without a z-index creates no stacking context and no formatting
 * context, and the body keeps the screen's own overflow (replacing it, with
 * `overflow: clip` say, would let a child's margin collapse through the body
 * and move the slide).
 *
 * It is only exact while the body is the slide's own box, as `wrapSlideHtml`
 * sizes it, so it is applied only then (see `bodyIsTheSlide`): positioning a
 * body the slide has resized or moved would move what is positioned in it. A slide whose
 * body does not clip still reaches past the slide, and `readPrintableText`
 * refuses it. Content placed entirely outside the slide can still start a
 * second page; the merge refuses that slide with a message naming it.
 */
export const PRINT_CLIP_CSS = "body { position: relative !important; }";

/** Whether the body is exactly the slide's box. Runs inside the page. */
export function bodyIsTheSlide(): boolean {
  const get = (proto: object, key: string, target: object) =>
    Object.getOwnPropertyDescriptor(proto, key)!.get!.call(target);
  const root = get(Document.prototype, "documentElement", document);
  const body = get(Document.prototype, "body", document);
  if (!(root instanceof HTMLHtmlElement) || !(body instanceof HTMLBodyElement)) return false;
  const r = Element.prototype.getBoundingClientRect.call(body);
  return (
    r.left === 0 &&
    r.top === 0 &&
    r.width === get(Element.prototype, "clientWidth", root) &&
    r.height === get(Element.prototype, "clientHeight", root)
  );
}

/**
 * Why a slide cannot be printed faithfully, as found by `readPrintableText`.
 *
 * - `filter`, `box-reflect`: Chromium turns an element with a CSS or SVG
 *   `filter`, or a `-webkit-box-reflect`, into an image of everything in it,
 *   so any text in it would become a picture.
 * - `backdrop-filter`: Chromium leaves the text inside it out of the PDF and
 *   can drop other content painted after it.
 * - `gradient-text`: text filled through `background-clip: text` prints as a
 *   soft mask that Apple Preview and poppler draw as a solid block.
 * - `mask`: CSS and SVG masks print as soft masks that Apple Preview and
 *   poppler draw wrongly (the masked image or text loses its fade).
 * - `overflow`: content reaches past the slide although the print clip could
 *   not be applied, so the page would come out shrunk.
 * - `unreadable`: part of the slide cannot be checked: a closed shadow root,
 *   a frame the check cannot run in, or a document without an ordinary root
 *   and body (which a slide's own elements cannot fake, see above).
 */
export type PrintProblem =
  | "filter"
  | "box-reflect"
  | "backdrop-filter"
  | "gradient-text"
  | "mask"
  | "overflow"
  | "unreadable";

/**
 * Checks a loaded slide, with the print-only rules applied, for what would
 * not print faithfully, and reports whether it shows text at all (the
 * post-print check compares that with the printed page). Runs inside the page.
 *
 * The effect checks are deliberately conservative: an element with one of the
 * effects above is refused when anything inside it could draw text, painted
 * or not, so hidden text under such an effect is refused too. `hasText` only
 * counts text that is visibly painted, so it can undercount, which only skips
 * the post-print check.
 *
 * It runs in the slide's own document, and with `isSlide` false in each frame
 * inside it, where an effect would flatten text just the same.
 */
export function readPrintableText(isSlide = true): { hasText: boolean; problem: PrintProblem | null } {
  const getter = (proto: object, key: string) => Object.getOwnPropertyDescriptor(proto, key)!.get!;
  const rootOf = getter(Document.prototype, "documentElement");
  const bodyOf = getter(Document.prototype, "body");
  const parentOf = getter(Node.prototype, "parentElement");
  const childNodesOf = getter(Node.prototype, "childNodes");
  const shadowOf = getter(Element.prototype, "shadowRoot");
  const nameOf = getter(Element.prototype, "localName");
  const widthOf = getter(Element.prototype, "clientWidth");
  const heightOf = getter(Element.prototype, "clientHeight");
  const scrollWidthOf = getter(Element.prototype, "scrollWidth");
  const scrollHeightOf = getter(Element.prototype, "scrollHeight");
  const completeOf = getter(HTMLImageElement.prototype, "complete");
  const naturalWidthOf = getter(HTMLImageElement.prototype, "naturalWidth");
  const rectOf = (el: Element) => Element.prototype.getBoundingClientRect.call(el);
  const attribute = (el: Element, name: string) => Element.prototype.getAttribute.call(el, name);

  /**
   * Every element and text node under `from`, including those in open shadow
   * roots, and a shadow host's own children whether slotted or not.
   */
  function subtree(from: Node): { elements: Element[]; texts: Text[] } {
    const elements: Element[] = [];
    const texts: Text[] = [];
    const pending: Node[] = [from];
    for (let node = pending.pop(); node; node = pending.pop()) {
      for (const child of Array.from(childNodesOf.call(node) as NodeList)) {
        if (child instanceof Text) texts.push(child);
        if (!(child instanceof Element)) continue;
        elements.push(child);
        pending.push(child);
        const shadow = shadowOf.call(child);
        if (shadow) pending.push(shadow);
      }
    }
    return { elements, texts };
  }
  const descendants = (el: Element) => {
    const shadow = shadowOf.call(el);
    return shadow ? [...subtree(el).elements, ...subtree(shadow).elements] : subtree(el).elements;
  };
  const textNodes = (el: Element) => {
    const shadow = shadowOf.call(el);
    return shadow ? [...subtree(el).texts, ...subtree(shadow).texts] : subtree(el).texts;
  };

  const root = rootOf.call(document);
  const body = bodyOf.call(document);
  // A slide's own document always has both; a frame inside it may be an SVG
  // or other document, which is checked from its root.
  if (isSlide ? !(root instanceof HTMLHtmlElement) || !(body instanceof HTMLBodyElement) : !(root instanceof Element)) {
    return { hasText: false, problem: "unreadable" };
  }
  const top: Element = body instanceof HTMLBodyElement ? body : root;
  const slideWidth: number = widthOf.call(root);
  const slideHeight: number = heightOf.call(root);
  // A frame scrolls and clips its own content, so only the slide can overflow.
  if (isSlide && (scrollWidthOf.call(root) > slideWidth || scrollHeightOf.call(root) > slideHeight)) {
    return { hasText: false, problem: "overflow" };
  }

  const PSEUDOS = ["::before", "::after"];
  const set = (value: string | undefined) => Boolean(value && value !== "none" && value !== "normal");
  const hasBox = (el: Element) => {
    const r = rectOf(el);
    return r.width > 0 && r.height > 0;
  };

  /** Whether generated content draws anything other than an image or nothing. */
  const generatesText = (style: CSSStyleDeclaration) => {
    if (style.display === "none" || !set(style.content)) return false;
    const withoutImages = style.content.replace(/url\([^)]*\)|(?:-webkit-)?(?:linear|radial|conic)-gradient\([^)]*\)/g, "");
    return withoutImages.replace(/""|''/g, "").trim() !== "";
  };

  /** Whether `el` itself draws text that is not one of its text nodes. */
  function drawsOwnText(el: Element): boolean {
    const name = nameOf.call(el);
    if (["textarea", "select", "button", "iframe", "object", "embed", "frame"].includes(name)) return true;
    if (name === "input") return attribute(el, "type")?.toLowerCase() !== "hidden";
    // A broken image draws its alt text instead.
    if (el instanceof HTMLImageElement) {
      return Boolean(attribute(el, "alt")?.trim()) && (!completeOf.call(el) || naturalWidthOf.call(el) === 0);
    }
    if (name === "use") {
      const href = attribute(el, "href") ?? attribute(el, "xlink:href") ?? "";
      const scope = Node.prototype.getRootNode.call(el);
      const byId = scope instanceof ShadowRoot ? DocumentFragment.prototype.getElementById : Document.prototype.getElementById;
      const target = href.startsWith("#") ? byId.call(scope, href.slice(1)) : null;
      // An external or missing reference cannot be checked, so it counts.
      if (!target) return href !== "";
      return nameOf.call(target) === "text" || descendants(target).some((d) => nameOf.call(d) === "text");
    }
    const style = getComputedStyle(el);
    if (style.display === "list-item" && style.listStyleType !== "none") return true;
    return PSEUDOS.some((pseudo) => generatesText(getComputedStyle(el, pseudo)));
  }

  /** Whether anything in `el`'s subtree, `el` included, could draw text. */
  function containsText(el: Element): boolean {
    if (textNodes(el).some((node) => node.nodeValue?.trim())) return true;
    return [el, ...descendants(el)].some(drawsOwnText);
  }

  const reflects = (style: CSSStyleDeclaration) => set(style.getPropertyValue("-webkit-box-reflect"));
  const clipsToText = (style: CSSStyleDeclaration) =>
    style.backgroundClip === "text" || style.getPropertyValue("-webkit-background-clip") === "text";
  const masks = (style: CSSStyleDeclaration) =>
    set(style.maskImage) || set(style.getPropertyValue("-webkit-mask-image")) || set(style.getPropertyValue("-webkit-mask-box-image-source"));

  // In order of severity: content lost first, then pictures of text, then
  // effects some readers draw wrongly.
  const found = new Set<PrintProblem>();
  for (const el of top === root ? [root, ...descendants(root)] : [root, top, ...descendants(top)]) {
    const styles = [getComputedStyle(el), ...PSEUDOS.map((p) => getComputedStyle(el, p)).filter((s) => set(s.content))];
    const visible = hasBox(el);
    for (const style of styles) {
      if (visible && set(style.backdropFilter)) found.add("backdrop-filter");
      if (visible && masks(style)) found.add("mask");
    }
    const own = styles[0];
    if (set(own.filter) && containsText(el)) found.add("filter");
    if (reflects(own) && containsText(el)) found.add("box-reflect");
    if (clipsToText(own) && containsText(el)) found.add("gradient-text");
    for (const style of styles.slice(1)) {
      if (!generatesText(style)) continue;
      if (set(style.filter)) found.add("filter");
      if (reflects(style)) found.add("box-reflect");
      if (clipsToText(style)) found.add("gradient-text");
    }
  }
  const order: PrintProblem[] = ["backdrop-filter", "filter", "box-reflect", "gradient-text", "mask"];
  const problem = order.find((p) => found.has(p)) ?? null;
  if (problem) return { hasText: true, problem };

  // Visibly painted text, for the post-print check: inside the slide and every
  // clipping ancestor, not hidden or fully transparent, and SVG text with a
  // fill or a stroke. Text under a clip-path is not counted.
  type Box = { left: number; top: number; right: number; bottom: number };
  const MIN_VISIBLE_PX = 2;
  const intersect = (a: Box, b: Box): Box => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
  const visibleBox = (b: Box) => b.right - b.left >= MIN_VISIBLE_PX && b.bottom - b.top >= MIN_VISIBLE_PX;
  function shownArea(el: Element): Box | null {
    let box: Box = { left: 0, top: 0, right: slideWidth, bottom: slideHeight };
    let opacity = 1;
    for (let at: Element | null = el; at; at = parentOf.call(at)) {
      const style = getComputedStyle(at);
      opacity *= Number(style.opacity);
      if (set(style.clipPath)) return null;
      if (style.overflowX !== "visible" || style.overflowY !== "visible") box = intersect(box, rectOf(at));
      // `clip` applies to absolutely positioned elements; anything but `auto`
      // is a crop or the visually-hidden pattern, read as its own rect.
      if (style.clip && style.clip !== "auto" && /^(absolute|fixed)$/.test(style.position)) {
        const [top, right, bottom, left] = (style.clip.match(/-?[\d.]+/g) ?? []).map(Number);
        const r = rectOf(at);
        if ([top, right, bottom, left].every(Number.isFinite)) {
          box = intersect(box, { left: r.left + left, top: r.top + top, right: r.left + right, bottom: r.top + bottom });
        }
      }
    }
    const style = getComputedStyle(el);
    if (style.visibility !== "visible" || opacity === 0) return null;
    if (el instanceof SVGElement && style.fill === "none" && style.stroke === "none") return null;
    return box;
  }
  for (const node of textNodes(top)) {
    const el = parentOf.call(node);
    if (!el || !node.nodeValue?.trim()) continue;
    const area = shownArea(el);
    if (!area) continue;
    const range = Document.prototype.createRange.call(document);
    range.selectNodeContents(node);
    if (Array.from(range.getClientRects()).some((r) => visibleBox(intersect(r, area)))) {
      return { hasText: true, problem: null };
    }
  }
  return { hasText: false, problem: null };
}

/** The part of a DevTools protocol DOM node `hasClosedShadowRoot` reads. */
export interface ProtocolNode {
  children?: ProtocolNode[];
  shadowRoots?: (ProtocolNode & { shadowRootType?: string })[];
  contentDocument?: ProtocolNode;
}

/**
 * Whether the document, read with `DOM.getDocument({ depth: -1, pierce: true })`,
 * holds a closed shadow root anywhere, frames included. Its content is hidden
 * from `readPrintableText`, so it cannot be checked. Browser-internal shadow
 * roots (of form fields and media) do not count.
 */
export function hasClosedShadowRoot(node: ProtocolNode): boolean {
  const pending: ProtocolNode[] = [node];
  for (let at = pending.pop(); at; at = pending.pop()) {
    for (const shadow of at.shadowRoots ?? []) {
      if (shadow.shadowRootType === "closed") return true;
      pending.push(shadow);
    }
    pending.push(...(at.children ?? []));
    if (at.contentDocument) pending.push(at.contentDocument);
  }
  return false;
}
