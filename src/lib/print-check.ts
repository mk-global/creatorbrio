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
 * - `text-paint`: text inside an SVG `<pattern>` is printed as part of a
 *   picture, and text used as a `<clipPath>` prints as a soft mask that
 *   Apple Preview and poppler draw wrongly.
 * - `gradient-text`: text filled through `background-clip: text` prints as a
 *   soft mask that Apple Preview and poppler draw as a solid block.
 * - `mask`: CSS and SVG masks print as soft masks that Apple Preview and
 *   poppler draw wrongly (the masked image or text loses its fade).
 * - `blend`: `mix-blend-mode: plus-lighter` and `plus-darker` have no PDF
 *   equivalent and print as an ordinary overlay.
 * - `backface`: an element with `backface-visibility: hidden` faces away from
 *   the viewer, so the screen hides it, but Chromium prints it, mirrored.
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
  | "text-paint"
  | "gradient-text"
  | "mask"
  | "blend"
  | "backface"
  | "overflow"
  | "unreadable";

/** What `readPrintableText` reports for one document. */
export interface PrintableText {
  /** Whether the document visibly paints any text. */
  hasText: boolean;
  /**
   * The text the slide visibly paints, as its characters, in no particular
   * order: compared with the printed page's text by `comparableCharacters`.
   * Only read in the slide's own document, where it is exact; empty in frames.
   */
  visibleText: string;
  problem: PrintProblem | null;
}

/**
 * Checks a loaded slide, with the print-only rules applied, for what would
 * not print faithfully, and reads the text it visibly paints (the post-print
 * check compares that with the printed page). Runs inside the page.
 *
 * The effect checks are deliberately conservative: an element with one of the
 * effects above is refused when anything it renders could draw text, painted
 * or not, so hidden text under such an effect is refused too. The visible
 * text is deliberately narrow: only text nodes that are painted, inside the
 * slide and every clip, not transparent, so it can undercount, which only
 * weakens the post-print check, but never claims text the slide does not show.
 *
 * It runs in the slide's own document, and with `isSlide` false in each frame
 * inside it, where an effect would flatten text just the same.
 */
export function readPrintableText(isSlide = true): PrintableText {
  const getter = (proto: object, key: string) => Object.getOwnPropertyDescriptor(proto, key)!.get!;
  const rootOf = getter(Document.prototype, "documentElement");
  const bodyOf = getter(Document.prototype, "body");
  const parentOf = getter(Node.prototype, "parentElement");
  const parentNodeOf = getter(Node.prototype, "parentNode");
  const childNodesOf = getter(Node.prototype, "childNodes");
  const shadowOf = getter(Element.prototype, "shadowRoot");
  const nameOf = getter(Element.prototype, "localName");
  const widthOf = getter(Element.prototype, "clientWidth");
  const heightOf = getter(Element.prototype, "clientHeight");
  const offsetWidthOf = getter(HTMLElement.prototype, "offsetWidth");
  const offsetHeightOf = getter(HTMLElement.prototype, "offsetHeight");
  const scrollWidthOf = getter(Element.prototype, "scrollWidth");
  const scrollHeightOf = getter(Element.prototype, "scrollHeight");
  const completeOf = getter(HTMLImageElement.prototype, "complete");
  const naturalWidthOf = getter(HTMLImageElement.prototype, "naturalWidth");
  const assignedNodes = HTMLSlotElement.prototype.assignedNodes;
  const elementSlotOf = getter(Element.prototype, "assignedSlot");
  const textSlotOf = getter(Text.prototype, "assignedSlot");
  const hostOf = getter(ShadowRoot.prototype, "host");
  const rectOf = (el: Element) => Element.prototype.getBoundingClientRect.call(el);
  const attribute = (el: Element, name: string) => Element.prototype.getAttribute.call(el, name);
  const hasAttribute = (el: Element, name: string) => Element.prototype.hasAttribute.call(el, name);

  /**
   * What renders under `node`: its children, an element's open shadow root,
   * and a slot's assigned nodes. A shadow host's own children are included
   * whether slotted or not, which errs towards checking more.
   */
  function rendered(node: Node): Node[] {
    const list: Node[] = Array.from(childNodesOf.call(node) as NodeList);
    if (node instanceof Element) {
      const shadow = shadowOf.call(node);
      if (shadow) list.push(shadow);
      if (node instanceof HTMLSlotElement) list.push(...assignedNodes.call(node, { flatten: true }));
    }
    return list;
  }

  /** Every element and text node rendered under `from`, each once. */
  function subtree(from: Node): { elements: Element[]; texts: Text[] } {
    const elements: Element[] = [];
    const texts: Text[] = [];
    const seen = new Set<Node>([from]);
    const pending: Node[] = [from];
    for (let node = pending.pop(); node; node = pending.pop()) {
      for (const child of rendered(node)) {
        if (seen.has(child)) continue;
        seen.add(child);
        if (child instanceof Text) texts.push(child);
        else if (child instanceof Element) {
          elements.push(child);
          pending.push(child);
        } else if (child instanceof ShadowRoot) pending.push(child);
      }
    }
    return { elements, texts };
  }

  /**
   * Where `node` renders in the flat tree: the slot it is assigned to, else
   * its parent element, else the host of the shadow root it sits in.
   */
  function flatParent(node: Element | Text): Element | null {
    const slot = node instanceof Text ? textSlotOf.call(node) : elementSlotOf.call(node);
    if (slot) return slot;
    const parent = parentOf.call(node);
    if (parent) return parent;
    const shadow = parentNodeOf.call(node);
    return shadow instanceof ShadowRoot ? hostOf.call(shadow) : null;
  }

  const root = rootOf.call(document);
  const body = bodyOf.call(document);
  // A slide's own document always has both; a frame inside it may be an SVG
  // or other document, which is checked from its root.
  if (isSlide ? !(root instanceof HTMLHtmlElement) || !(body instanceof HTMLBodyElement) : !(root instanceof Element)) {
    return { hasText: false, visibleText: "", problem: "unreadable" };
  }
  const top: Element = body instanceof HTMLBodyElement ? body : root;
  const slideWidth: number = widthOf.call(root);
  const slideHeight: number = heightOf.call(root);
  // A frame scrolls and clips its own content, so only the slide can overflow.
  if (isSlide && (scrollWidthOf.call(root) > slideWidth || scrollHeightOf.call(root) > slideHeight)) {
    return { hasText: false, visibleText: "", problem: "overflow" };
  }

  const PSEUDOS = ["::before", "::after"];
  const set = (value: string | undefined) => Boolean(value && value !== "none" && value !== "normal");
  const hasBox = (el: Element) => {
    const r = rectOf(el);
    return r.width > 0 && r.height > 0;
  };

  // Elements whose text is never drawn: style sheets, scripts and SVG
  // metadata such as a tooltip title.
  const SILENT = ["style", "script", "title", "desc", "metadata"];
  const drawableText = (node: Text) => {
    if (!node.nodeValue?.trim()) return false;
    const parent = parentNodeOf.call(node);
    return !(parent instanceof Element && SILENT.includes(nameOf.call(parent)));
  };

  /**
   * A computed `content` value read as CSS: its quoted strings, and whether
   * anything else in it draws text (counters, attributes, quotation marks).
   * Functions such as `url()` and gradients are skipped whole, strings inside
   * them included, so a string spelling `url(` cannot hide text.
   */
  function contentParts(content: string): { strings: string[]; other: boolean } {
    const strings: string[] = [];
    let other = false;
    let i = 0;
    const readString = () => {
      const quote = content[i++];
      let out = "";
      while (i < content.length && content[i] !== quote) {
        if (content[i] === "\\") i++;
        out += content[i++] ?? "";
      }
      i++;
      return out;
    };
    while (i < content.length) {
      const ch = content[i];
      if (ch === '"' || ch === "'") {
        strings.push(readString());
        continue;
      }
      const word = /^[a-z-]+/i.exec(content.slice(i))?.[0];
      if (!word) {
        i++;
        continue;
      }
      i += word.length;
      if (content[i] === "(") {
        if (/^(?:counters?|attr)$/i.test(word)) other = true;
        for (let depth = 0; i < content.length; ) {
          const c = content[i];
          if (c === '"' || c === "'") readString();
          else {
            i++;
            if (c === "(") depth++;
            else if (c === ")" && --depth === 0) break;
          }
        }
      } else if (/^(?:no-)?(?:open|close)-quote$/i.test(word)) other = true;
    }
    return { strings, other };
  }

  /** Whether generated content draws anything other than images, spaces or nothing. */
  const generatesText = (style: CSSStyleDeclaration) => {
    if (style.display === "none" || !set(style.content)) return false;
    const { strings, other } = contentParts(style.content);
    return other || strings.some((text) => text.trim() !== "");
  };

  /** `<use>` elements being resolved, so a reference cycle ends. */
  const resolving = new Set<Element>();

  /** Whether `el` itself draws text that is not one of its text nodes. */
  function drawsOwnText(el: Element): boolean {
    const name = nameOf.call(el);
    // A details element without a summary draws its own "Details" label.
    if (["textarea", "select", "button", "iframe", "object", "embed", "frame", "details"].includes(name)) return true;
    if (name === "input") return attribute(el, "type")?.toLowerCase() !== "hidden";
    if ((name === "video" || name === "audio") && hasAttribute(el, "controls")) return true;
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
      // The target is drawn as it is, through any further references.
      if (resolving.has(el)) return false;
      resolving.add(el);
      try {
        return containsText(target);
      } finally {
        resolving.delete(el);
      }
    }
    const style = getComputedStyle(el);
    // A list marker draws its counter, or its own content even without one.
    if (style.display === "list-item" && (style.listStyleType !== "none" || generatesText(getComputedStyle(el, "::marker")))) {
      return true;
    }
    return PSEUDOS.some((pseudo) => generatesText(getComputedStyle(el, pseudo)));
  }

  /**
   * Whether anything rendered under `start`, `start` included, could draw
   * text. Answers are kept, so asking about nested elements stays linear in
   * the size of the slide; the walk is iterative, so depth cannot overflow it.
   */
  const textBelow = new Map<Node, boolean>();
  function containsText(start: Node): boolean {
    const stack: [Node, boolean][] = [[start, false]];
    while (stack.length > 0) {
      const [node, expanded] = stack.pop()!;
      if (textBelow.has(node)) continue;
      const children = rendered(node);
      if (!expanded) {
        stack.push([node, true]);
        for (const child of children) if (!textBelow.has(child)) stack.push([child, false]);
        continue;
      }
      const own = node instanceof Text ? drawableText(node) : node instanceof Element && drawsOwnText(node);
      textBelow.set(node, own || children.some((child) => textBelow.get(child) === true));
    }
    return textBelow.get(start) === true;
  }

  const reflects = (style: CSSStyleDeclaration) => set(style.getPropertyValue("-webkit-box-reflect"));
  const clipsToText = (style: CSSStyleDeclaration) =>
    style.backgroundClip === "text" || style.getPropertyValue("-webkit-background-clip") === "text";
  const masks = (style: CSSStyleDeclaration) =>
    set(style.maskImage) || set(style.getPropertyValue("-webkit-mask-image")) || set(style.getPropertyValue("-webkit-mask-box-image-source"));
  const blendsWithoutPdfEquivalent = (style: CSSStyleDeclaration) => /^plus-/.test(style.mixBlendMode);

  /** Degrees in a computed angle. */
  const degrees = (angle: string) => {
    const value = parseFloat(angle);
    if (angle.endsWith("rad") && !angle.endsWith("grad")) return (value * 180) / Math.PI;
    if (angle.endsWith("turn")) return value * 360;
    if (angle.endsWith("grad")) return value * 0.9;
    return value;
  };
  /** An element's own transform: its `rotate` and `scale` properties, then `transform`. */
  function transformOf(style: CSSStyleDeclaration): DOMMatrix {
    let m = new DOMMatrix();
    if (set(style.rotate)) {
      const parts = style.rotate.trim().split(/\s+/);
      const angle = degrees(parts[parts.length - 1]);
      const named: Record<string, number[]> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
      const axis = parts.length === 1 ? [0, 0, 1] : (named[parts[0]] ?? parts.slice(0, 3).map(Number));
      m = m.rotateAxisAngle(axis[0], axis[1], axis[2], angle);
    }
    if (set(style.scale)) {
      const [x, y = x, z = 1] = style.scale.trim().split(/\s+/).map(Number);
      m = m.scale(x, y, z);
    }
    if (set(style.transform)) m = m.multiply(new DOMMatrix(style.transform));
    return m;
  }
  /**
   * Whether `el` shows its back to the viewer: its transform, composed with
   * those of the ancestors sharing its 3D context, turns its front away.
   */
  function facesAway(el: Element): boolean {
    let m = transformOf(getComputedStyle(el));
    for (let at = flatParent(el); at; at = flatParent(at)) {
      const style = getComputedStyle(at);
      if (style.transformStyle !== "preserve-3d") break;
      m = transformOf(style).multiply(m);
    }
    return m.m33 < 0;
  }

  // Pseudo-elements that style an element's own content rather than add to
  // it, so an effect on one applies to text the element holds.
  const TEXT_PSEUDOS = ["::first-letter", "::first-line", "::marker", "::placeholder", "::file-selector-button", "::details-content"];

  // In order of severity: content lost first, then pictures of text, then
  // effects some readers draw wrongly.
  const found = new Set<PrintProblem>();
  const scanned = top === root ? subtree(root).elements : [top, ...subtree(top).elements];
  for (const el of [root, ...scanned.filter((e) => e !== root)]) {
    const own = getComputedStyle(el);
    const pseudos = PSEUDOS.map((p) => getComputedStyle(el, p)).filter((s) => s.display !== "none" && set(s.content));
    // A pseudo-element's own box cannot be measured, so one that is
    // generated at all is checked; an element is checked when it has a box,
    // and an SVG element always, as one in <defs> is drawn where it is used.
    for (const style of hasBox(el) || el instanceof SVGElement ? [own, ...pseudos] : pseudos) {
      if (set(style.backdropFilter)) found.add("backdrop-filter");
      if (masks(style)) found.add("mask");
    }
    if (blendsWithoutPdfEquivalent(own)) found.add("blend");
    const name = nameOf.call(el);
    if ((name === "pattern" || name === "clipPath") && containsText(el)) found.add("text-paint");
    if (set(own.filter) && containsText(el)) found.add("filter");
    if (reflects(own) && containsText(el)) found.add("box-reflect");
    if (clipsToText(own) && containsText(el)) found.add("gradient-text");
    if (own.backfaceVisibility === "hidden" && facesAway(el)) found.add("backface");
    for (const pseudo of TEXT_PSEUDOS) {
      const style = getComputedStyle(el, pseudo);
      if (!set(style.filter) && !reflects(style) && !clipsToText(style)) continue;
      if (!containsText(el)) continue;
      if (set(style.filter)) found.add("filter");
      if (reflects(style)) found.add("box-reflect");
      if (clipsToText(style)) found.add("gradient-text");
    }
    for (const style of pseudos) {
      if (!generatesText(style)) continue;
      if (set(style.filter)) found.add("filter");
      if (reflects(style)) found.add("box-reflect");
      if (clipsToText(style)) found.add("gradient-text");
      if (blendsWithoutPdfEquivalent(style)) found.add("blend");
    }
  }
  const order: PrintProblem[] = ["backdrop-filter", "filter", "box-reflect", "text-paint", "gradient-text", "mask", "blend", "backface"];
  const problem = order.find((p) => found.has(p)) ?? null;
  if (problem) return { hasText: true, visibleText: "", problem };

  // Visibly painted text: inside the slide, every clipping ancestor and any
  // clip path's region, not hidden, transparent or disguised, and SVG text
  // with a fill or a stroke.
  type Box = { left: number; top: number; right: number; bottom: number };
  const MIN_VISIBLE_PX = 2;
  const intersect = (a: Box, b: Box): Box => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
  const visibleBox = (b: Box) => b.right - b.left >= MIN_VISIBLE_PX && b.bottom - b.top >= MIN_VISIBLE_PX;
  const inside = (r: Box, area: Box) =>
    r.left >= area.left && r.top >= area.top && r.right <= area.right && r.bottom <= area.bottom;
  // Chromium paints in 8-bit alpha, so anything under half a step is nothing.
  const invisibleAlpha = (alpha: number) => alpha * 255 < 0.5;
  /** Whether a computed colour (rgb(), rgba() or color(... / alpha)) is not painted. */
  const transparent = (color: string) => {
    if (color === "transparent") return true;
    const alpha = /^rgba\((?:[^,]*,){3}\s*([\d.]+)\s*\)$/.exec(color) ?? /\/\s*([\d.]+)\s*\)$/.exec(color);
    return alpha ? invisibleAlpha(Number(alpha[1])) : false;
  };
  // SVG resources draw nothing where they are written, only where referenced.
  const RESOURCES = ["defs", "symbol", "pattern", "clipPath", "mask", "marker", "filter", "linearGradient", "radialGradient"];

  /**
   * The region a `clip-path` leaves, as a box in the page: "empty" when it
   * shows nothing, which Chromium then leaves out of the PDF altogether (the
   * visually hidden pattern), or "unknown" when it cannot be measured, in
   * which case the element's other clips stand. A clip path that shows any
   * part of the text keeps all of its glyphs in the PDF, so the box only
   * narrows which characters are compared.
   */
  function clipRegion(el: Element, clipPath: string): Box | "empty" | "unknown" {
    const r = rectOf(el);
    const width: number = el instanceof HTMLElement ? offsetWidthOf.call(el) : r.width;
    const height: number = el instanceof HTMLElement ? offsetHeightOf.call(el) : r.height;
    // Shapes are measured in the element's own box; under a transform they
    // are only checked for being empty.
    const flat = Math.abs(r.width - width) < 0.5 && Math.abs(r.height - height) < 0.5;
    const length = (value: string, basis: number): number | null => {
      if (/^-?[\d.]+px$/.test(value)) return parseFloat(value);
      if (/^-?[\d.]+%$/.test(value)) return (parseFloat(value) / 100) * basis;
      return value === "0" ? 0 : null;
    };
    const box = (left: number, top: number, right: number, bottom: number): Box | "empty" | null => {
      if (right - left <= 0 || bottom - top <= 0) return "empty";
      return flat ? { left: r.left + left, top: r.top + top, right: r.left + right, bottom: r.top + bottom } : null;
    };
    const shape = /^(inset|circle|ellipse|polygon)\((.*)\)/.exec(clipPath.trim());
    if (clipPath.startsWith("url(")) {
      const id = /#([^"')]+)/.exec(clipPath)?.[1];
      const scope = Node.prototype.getRootNode.call(el);
      const target = id ? (scope instanceof ShadowRoot ? DocumentFragment.prototype.getElementById : Document.prototype.getElementById).call(scope, id) : null;
      // A clip path with nothing in it clips everything away.
      return target && nameOf.call(target) === "clipPath" && subtree(target).elements.length === 0 ? "empty" : "unknown";
    }
    if (!shape) return "unknown";
    const [, kind, args] = shape;
    const at = /\bat\s+(\S+)\s+(\S+)/.exec(args);
    const centre = at ? [length(at[1], width), length(at[2], height)] : [width / 2, height / 2];
    let result: Box | "empty" | null = null;
    if (kind === "inset") {
      const values = args.split(/\s+round\s+/)[0].trim().split(/\s+/);
      const [t, rgt = t, b = t, l = rgt] = values;
      const [top, right, bottom, left] = [length(t, height), length(rgt, width), length(b, height), length(l, width)];
      if ([top, right, bottom, left].every((v) => v !== null)) result = box(left!, top!, width - right!, height - bottom!);
    } else if (kind === "circle" || kind === "ellipse") {
      const radii = args.split(/\s+at\s+/)[0].trim().split(/\s+/).filter(Boolean);
      const diagonal = Math.sqrt((width * width + height * height) / 2);
      const rx = radii[0] === undefined ? null : length(radii[0], kind === "circle" ? diagonal : width);
      const ry = kind === "circle" ? rx : radii[1] === undefined ? null : length(radii[1], height);
      if (rx === 0 || ry === 0) return "empty";
      if (rx !== null && ry !== null && centre.every((v) => v !== null)) {
        result = box(centre[0]! - rx, centre[1]! - ry, centre[0]! + rx, centre[1]! + ry);
      }
    } else {
      const points = args.replace(/^\s*(?:nonzero|evenodd)\s*,/, "").split(",").map((p) => p.trim().split(/\s+/));
      const xy = points.map(([x, y]) => [length(x ?? "", width), length(y ?? "", height)]);
      if (xy.length > 0 && xy.every(([x, y]) => x !== null && y !== null)) {
        const xs = xy.map(([x]) => x!);
        const ys = xy.map(([, y]) => y!);
        // A polygon of no area draws nothing, even when its points spread out.
        let area = 0;
        for (let i = 0; i < xy.length; i++) {
          const [x1, y1] = xy[i];
          const [x2, y2] = xy[(i + 1) % xy.length];
          area += x1! * y2! - x2! * y1!;
        }
        result = area === 0 ? "empty" : box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
      }
    }
    return result ?? "unknown";
  }

  /**
   * Where `el`'s text can show, or null when it is not painted at all.
   * `exact` is false when the text may be shortened where it shows, by a
   * `text-overflow` ellipsis or a line clamp: its characters still have boxes
   * inside the clip, so they are not compared, only counted as shown.
   */
  function shownArea(el: Element): { box: Box; exact: boolean } | null {
    let box: Box = { left: 0, top: 0, right: slideWidth, bottom: slideHeight };
    let opacity = 1;
    let exact = true;
    for (let at: Element | null = el, from: Element | null = null; at; from = at, at = flatParent(at)) {
      const style = getComputedStyle(at);
      opacity *= Number(style.opacity);
      if (RESOURCES.includes(nameOf.call(at))) return null;
      if (set(style.clipPath)) {
        const region = clipRegion(at, style.clipPath);
        if (region === "empty") return null;
        if (region !== "unknown") box = intersect(box, region);
      }
      // Skipped content is never painted, though Chromium still lays it out
      // when asked; a closed details element shows only its summary.
      if (style.contentVisibility === "hidden") return null;
      if (nameOf.call(at) === "details" && !hasAttribute(at, "open") && !(from && nameOf.call(from) === "summary")) {
        return null;
      }
      const clips =
        style.overflowX !== "visible" || style.overflowY !== "visible" || /\b(?:paint|strict|content)\b/.test(style.contain);
      if (clips) box = intersect(box, rectOf(at));
      if ((clips && style.textOverflow !== "clip") || set(style.getPropertyValue("-webkit-line-clamp"))) exact = false;
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
    if (style.visibility !== "visible" || invisibleAlpha(opacity)) return null;
    // Masked characters (-webkit-text-security) draw as discs, not as the text.
    if (set(style.getPropertyValue("-webkit-text-security"))) return null;
    if (el instanceof SVGElement) {
      if (style.fill === "none" && style.stroke === "none") return null;
    } else if (
      transparent(style.getPropertyValue("-webkit-text-fill-color")) &&
      parseFloat(style.getPropertyValue("-webkit-text-stroke-width")) === 0
    ) {
      return null;
    }
    return { box, exact };
  }

  let hasText = false;
  const visible: string[] = [];
  const { elements: shownElements, texts: shownTexts } = subtree(top);
  for (const node of shownTexts) {
    const el = flatParent(node);
    const value = node.nodeValue ?? "";
    if (!el || !value.trim() || !drawableText(node)) continue;
    const shown = shownArea(el);
    if (!shown) continue;
    const area = shown.box;
    const range = Document.prototype.createRange.call(document);
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects());
    if (!rects.some((r) => visibleBox(intersect(r, area)))) continue;
    hasText = true;
    if (!isSlide || !shown.exact) continue;
    if (rects.every((r) => inside(r, area))) {
      visible.push(value);
      continue;
    }
    // Partly clipped: only the characters drawn inside the clip count.
    for (let i = 0; i < value.length; ) {
      const length = (value.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
      range.setStart(node, i);
      range.setEnd(node, i + length);
      if (Array.from(range.getClientRects()).some((r) => visibleBox(intersect(r, area)))) {
        visible.push(value.slice(i, i + length));
      }
      i += length;
    }
  }

  // Generated text: the strings of ::before, ::after and a custom ::marker,
  // counted only where they must show, laid out in their element's flow and
  // that element wholly in view. A pseudo-element's own box cannot be
  // measured, so one placed elsewhere is not compared.
  if (isSlide) {
    for (const el of shownElements) {
      const pseudos = ["::before", "::after", ...(getComputedStyle(el).display === "list-item" ? ["::marker"] : [])];
      for (const pseudo of pseudos) {
        const style = getComputedStyle(el, pseudo);
        if (!generatesText(style)) continue;
        if (!/^(?:static|relative)$/.test(style.position) || style.visibility !== "visible") continue;
        if (invisibleAlpha(Number(style.opacity)) || transparent(style.getPropertyValue("-webkit-text-fill-color"))) continue;
        const shown = shownArea(el);
        const r = rectOf(el);
        if (!shown || !shown.exact || !visibleBox(r) || !inside(r, shown.box)) continue;
        hasText = true;
        visible.push(...contentParts(style.content).strings);
      }
    }
  }
  return { hasText, visibleText: visible.join(" "), problem: null };
}

/**
 * The letters and digits of `text`, counted, in a form that survives
 * printing, for comparing what a slide shows with what its PDF page carries:
 * case folded (so `text-transform` and small caps compare equal, ß with SS,
 * and final sigma with sigma), decomposed with compatibility mappings (so
 * ligatures, full-width forms and accents compare equal however they were
 * encoded), without marks, punctuation, spaces or symbols. Emoji are symbols,
 * and keycap emoji are removed with their digit, since they are drawn as
 * pictures. Counts matter: the same characters elsewhere on a slide must not
 * stand in for ones the page lost.
 */
export function comparableCharacters(text: string): Map<string, number> {
  const withoutKeycaps = text.replace(/[#*0-9]\uFE0F?\u20E3|[#*0-9]\uFE0F/gu, " ");
  const folded = withoutKeycaps.toUpperCase().toLowerCase().replace(/\u03C2/g, "\u03C3").normalize("NFKD");
  const counts = new Map<string, number>();
  for (const ch of folded) {
    if (/[\p{L}\p{N}]/u.test(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  return counts;
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
