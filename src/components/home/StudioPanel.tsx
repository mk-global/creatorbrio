"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useStudioStatus } from "@/components/app/useStudioStatus";
import { editedPhrase } from "@/lib/relative-time";

/** Home's Video Studio panel: honest about what exists, and the recent videos once this browser is paired. */
export function StudioPanel() {
  const status = useStudioStatus(true);
  const productions = status.state === "paired" ? (status.productions ?? []).flatMap((p) => (p.status === "ok" ? [p] : [])) : [];
  return (
    <section aria-labelledby="home-studio" className="panel flex flex-col p-5 sm:p-7">
      <h2 id="home-studio" className="type-section flex flex-wrap items-center gap-2">
        Video Studio <span className="tag tag-early">Early</span>
      </h2>
      <p className="mt-1 text-[14px] text-graphite">Edit a Reel by hand. AI video editing is not built yet.</p>
      {status.state === "paired" ? (
        <>
          <h3 className="mt-5 text-[13px] text-graphite">Recent productions</h3>
          {status.productions === null ? (
            <p className="mt-2 text-[14px] text-graphite">Reading your productions…</p>
          ) : productions.length === 0 ? (
            <p className="mt-2 text-[14px]">No productions yet. Start one in the Studio.</p>
          ) : (
            <ul className="mt-1 divide-y divide-rule">
              {productions.slice(0, 3).map((v) => (
                <li key={v.productionId}>
                  <Link
                    href={`/studio?production=${encodeURIComponent(v.productionId)}`}
                    className="-mx-2 flex min-h-12 items-center gap-3 rounded-md px-2 py-2 hover:bg-ground"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-semibold">{v.name}</span>
                      <span className="num block text-[13px] text-graphite">
                        Revision {v.revision}, edited {editedPhrase(v.updatedAt)}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-graphite" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-auto pt-4">
            <Link href="/studio" className="btn btn-quiet btn-sm">
              All productions
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="mt-5 text-[14px]">Import clips and music, cut them on a timeline, add titles and captions, and export an MP4 checked for Reels.</p>
          <div className="mt-auto pt-5">
            {status.state !== "checking" && (
              <p className="text-[14px] text-graphite">
                {status.state === "unreachable"
                  ? "The Studio didn't answer. It may still be starting."
                  : "This browser isn't paired yet. Pairing takes a one-time code from your terminal and lasts 12 hours."}
              </p>
            )}
            <Link href="/studio" className="btn btn-quiet btn-sm mt-3">
              {status.state === "unpaired" ? "Pair this browser" : "Open the Studio"}
            </Link>
          </div>
        </>
      )}
    </section>
  );
}
