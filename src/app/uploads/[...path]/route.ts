import { NextResponse } from "next/server";
import { readUpload } from "@/lib/upload-files";

// Uploaded and generated files appear while the app runs, so this is never prerendered.
export const dynamic = "force-dynamic";

/**
 * Serves uploads written after the app was built (see `src/lib/upload-files.ts`).
 * Files present at build time never reach this route: Next.js serves them from
 * `public/` first.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const file = await readUpload((await params).path);
  if (!file) return new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=0",
    },
  });
}
