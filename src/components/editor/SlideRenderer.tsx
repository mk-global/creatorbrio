"use client";

import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { wrapSlideHtml } from "@/lib/slide-html";
import type { AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

interface SlideRendererProps {
  html: string;
  aspectRatio: AspectRatio;
  className?: string;
  style?: React.CSSProperties;
  /**
   * Rendered inside the scaled slide box, on top of the iframe.
   *
   * The slide is letterboxed inside its container, so anything that has to line
   * up with the slide's edges (the safe-zone guides) must be positioned against
   * this box rather than against the container around it.
   */
  overlay?: React.ReactNode;
}

export function SlideRenderer({
  html,
  aspectRatio,
  className,
  style,
  overlay,
}: SlideRendererProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const { width: slideW, height: slideH } = DIMENSIONS[aspectRatio];

  const measure = useCallback(() => {
    const el = outerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setDims({ w: rect.width, h: rect.height });
    }
  }, []);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => measure());
    obs.observe(el);
    measure();
    return () => obs.disconnect();
  }, [measure]);

  // Calculate scale to fit the slide into the container
  const scale = dims
    ? Math.min(dims.w / slideW, dims.h / slideH)
    : 0;

  // The preview document names the app's origin in its policy (#249), which
  // only the browser knows. `dims` is set from an effect, so the document is
  // built, and the frame drawn, only once the component has mounted there; a
  // server render emits neither.
  const mounted = scale > 0;
  const srcDoc = useMemo(
    () => (mounted ? wrapSlideHtml(html, aspectRatio, { previewOrigin: window.location.origin }) : ""),
    [mounted, html, aspectRatio]
  );

  const scaledW = Math.floor(slideW * scale);
  const scaledH = Math.floor(slideH * scale);

  return (
    <div
      ref={outerRef}
      className={className}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      {mounted && (
        <div
          style={{
            width: scaledW,
            height: scaledH,
            overflow: "hidden",
            borderRadius: 8,
            position: "relative",
            boxShadow: "0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08)",
            border: "1px solid rgba(0,0,0,0.06)",
          }}
        >
          <iframe
            sandbox=""
            srcDoc={srcDoc}
            title="Slide preview"
            style={{
              width: slideW,
              height: slideH,
              border: "none",
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              position: "absolute",
              top: 0,
              left: 0,
              pointerEvents: "none",
            }}
          />
          {overlay}
        </div>
      )}
    </div>
  );
}
