"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { wrapSlideHtml } from "@/lib/slide-html";
import { DIMENSIONS, type AspectRatio } from "@/types/carousel";
import type { ProjectFormat } from "@/lib/formats";

/**
 * A project or template drawn at its true proportion, standing on its bottom
 * edge (#175). The geometry is CSS calc() on one variable, --fh (the frame's
 * height), so a container-unit class sizes it from its column without
 * JavaScript. A carousel fans sideways (it swipes), a document stacks
 * downwards (it pages), a Reel cover is one sheet.
 *
 * The top sheet is the real first slide in a sandboxed iframe (`sandbox=""`,
 * no scripts), mounted only once the frame is near the screen, so a library
 * of hundreds of projects keeps only the visible previews alive.
 */
export function ProjectFrame({
  html,
  slideCount,
  aspectRatio,
  format,
  heightClass = "[--fh:200px]",
  selected = false,
  emptyLabel = "No slides yet",
  paperColors,
}: {
  /** The first slide's body HTML, or null when there is none yet. */
  html: string | null;
  slideCount: number;
  aspectRatio: AspectRatio;
  format: ProjectFormat;
  heightClass?: string;
  selected?: boolean;
  emptyLabel?: string;
  /** The colours of the sheets behind the first, usually the brand's surface and background. */
  paperColors?: [string, string];
}) {
  const { width, height } = DIMENSIONS[aspectRatio];
  const stack = format === "reel-cover" ? 0 : Math.min(2, Math.max(0, slideCount - 1));
  const off = "calc(var(--fh) * 0.055)";
  const h = format === "linkedin-document" ? `calc(var(--fh) - ${stack} * ${off})` : "var(--fh)";
  const w = `calc(${h} * ${width} / ${height})`;
  const boxW = format === "instagram-carousel" ? `calc(${w} + ${stack} * ${off})` : w;
  const [under, behind] = paperColors ?? ["var(--color-hover)", "var(--color-sheet)"];

  return (
    <div className={`relative shrink-0 ${heightClass}`} style={{ width: boxW, height: "var(--fh)" }}>
      {Array.from({ length: stack }).map((_, i) => {
        const shift = `calc(${stack - i} * ${off})`;
        const place = format === "linkedin-document" ? { left: 0, bottom: shift } : { left: shift, bottom: 0 };
        return (
          <div
            key={i}
            className="paper absolute"
            style={{ ...place, width: w, height: h, background: i === 0 ? under : behind }}
            aria-hidden="true"
          />
        );
      })}
      <div className="crop absolute bottom-0 left-0" data-selected={selected} style={{ width: w, height: h }}>
        <div className="paper h-full w-full bg-sheet">
          {html !== null ? (
            <SlideFace html={html} aspectRatio={aspectRatio} />
          ) : (
            <div className="flex h-full w-full items-center justify-center p-2 text-center text-[12px] leading-tight text-graphite">
              {emptyLabel}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One slide, scaled to fill its box, rendered only while near the screen. */
export function SlideFace({ html, aspectRatio, title = "Slide preview" }: { html: string; aspectRatio: AspectRatio; title?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [near, setNear] = useState(false);
  const { width, height } = DIMENSIONS[aspectRatio];
  const srcDoc = useMemo(() => (near ? wrapSlideHtml(html, aspectRatio) : ""), [near, html, aspectRatio]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const resize = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / width));
    resize.observe(el);
    const seen = new IntersectionObserver(([entry]) => entry.isIntersecting && setNear(true), { rootMargin: "300px" });
    seen.observe(el);
    return () => {
      resize.disconnect();
      seen.disconnect();
    };
  }, [width]);

  return (
    <div ref={box} className="relative h-full w-full overflow-hidden" aria-hidden="true">
      {near && scale > 0 && (
        <iframe
          sandbox=""
          srcDoc={srcDoc}
          title={title}
          tabIndex={-1}
          loading="lazy"
          style={{
            width,
            height,
            border: "none",
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            position: "absolute",
            top: 0,
            left: 0,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}
