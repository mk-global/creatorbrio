import { NextResponse } from "next/server";
import archiver from "archiver";
import { getCarousel } from "@/lib/carousels";
import {
  exportAllSlides,
  exportAllSlidePdfs,
  describeExportFailure,
} from "@/lib/export-slides";
import { mergeSlidePdfs, PdfExportError } from "@/lib/export-pdf";
import { parseExportFormat } from "@/lib/export-formats";
import {
  GENERATION_IN_PROGRESS_ERROR,
  getInterruption,
  interruptedExportError,
  isGenerating,
} from "@/lib/generation-status";
import { dataErrorResponse } from "@/lib/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // No `format` means the original PNG ZIP, so existing callers are unaffected.
  const format = parseExportFormat(new URL(request.url).searchParams.get("format"));
  if (!format) {
    return NextResponse.json(
      {
        error:
          'Unknown export format. Use "png" for a ZIP of PNGs, "pdf" for a PDF, or "single-png" for the PNG of a one-slide carousel.',
      },
      { status: 400 }
    );
  }

  const carousel = await getCarousel(id);

  if (!carousel) {
    return NextResponse.json({ error: "Carousel not found" }, { status: 404 });
  }

  // The design agent may still be adding or rewriting slides. Exporting now
  // would package whatever happens to be saved mid-run.
  if (isGenerating(carousel.id)) {
    return NextResponse.json(
      { error: GENERATION_IN_PROGRESS_ERROR },
      { status: 409 }
    );
  }

  // A run that was stopped, failed or timed out after changing slides may have
  // left the carousel half-made. Its slides are kept, but they are not
  // exported as though they were finished until the user confirms them.
  let interruption;
  try {
    interruption = await getInterruption(carousel.id);
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    throw err;
  }
  if (interruption) {
    return NextResponse.json(
      {
        error: interruptedExportError(interruption.reason),
        interrupted: interruption,
      },
      { status: 409 }
    );
  }

  if (carousel.slides.length === 0) {
    return NextResponse.json({ error: "No slides to export" }, { status: 400 });
  }

  if (format === "single-png" && carousel.slides.length !== 1) {
    return NextResponse.json(
      {
        error:
          "A single PNG download is only available for a carousel with one slide. Use the PNG ZIP to download every slide.",
      },
      { status: 400 }
    );
  }

  const fileBase = `carousel-${carousel.name.replace(/[^a-zA-Z0-9-_]/g, "_")}`;

  try {
    if (format === "pdf") {
      // Printed natively from the same slide documents as the PNGs, so text
      // stays selectable text instead of a picture of it.
      const pdfBytes = await mergeSlidePdfs(
        await exportAllSlidePdfs(carousel.slides, carousel.aspectRatio),
        carousel.aspectRatio,
        { title: carousel.name }
      );
      return new Response(new Uint8Array(pdfBytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${fileBase}.pdf"`,
        },
      });
    }

    // Export all slides to PNG buffers
    const pngBuffers = await exportAllSlides(
      carousel.slides,
      carousel.aspectRatio
    );

    if (format === "single-png") {
      // The exact bytes the ZIP would hold as slide-1.png, not re-encoded.
      // `png` is the Node Buffer itself, so the copy covers its own bytes only,
      // wherever they sit in a pooled allocation.
      const [{ buffer: png }] = pngBuffers;
      return new Response(new Uint8Array(png), {
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition": `attachment; filename="${fileBase}.png"`,
        },
      });
    }

    // Build ZIP archive and collect all data
    const zipBuffer = await new Promise<Buffer>((resolve, reject) => {
      const archive = archiver("zip", { zlib: { level: 5 } });
      const chunks: Buffer[] = [];

      archive.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      archive.on("end", () => {
        resolve(Buffer.concat(chunks));
      });

      archive.on("error", (err) => {
        reject(err);
      });

      try {
        for (const { name, buffer } of pngBuffers) {
          archive.append(buffer, { name });
        }
        archive.finalize();
      } catch (err) {
        archive.destroy();
        reject(err);
      }
    });

    return new Response(new Uint8Array(zipBuffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileBase}.zip"`,
      },
    });
  } catch (error) {
    if (error instanceof PdfExportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Full detail stays server-side; the client gets a safe, actionable summary.
    console.error("[export] failed", error);
    return NextResponse.json(
      { error: describeExportFailure(error) },
      { status: 500 }
    );
  }
}
