"use client";

/**
 * What the preview shows when the current revision cannot be compiled (#150):
 * an empty timeline as a starting point, anything else as the reasons the
 * revision can be neither previewed nor exported, each with a way to select
 * the clip it names.
 */
import { useId } from "react";
import { Clapperboard, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CompileIssue } from "@/lib/video/render/plan";
import { describeIssues } from "@/lib/video/studio/preview-status";

export function PreviewIssues({ issues, onSelectClip }: { issues: CompileIssue[]; onSelectClip: (clipId: string) => void }) {
  const { empty, lines } = describeIssues(issues);
  const uid = useId();
  if (empty) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Clapperboard className="h-6 w-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-foreground">Nothing to preview yet</p>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">Add footage, a still or music from the media bin, or a title, and it plays here.</p>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div role="status" className="w-full max-w-md rounded-lg border border-border bg-surface p-4 shadow-sm">
        <div className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">This revision cannot be previewed or exported</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{lines.length === 1 ? "Fix this and the preview comes back:" : `Fix these ${lines.length} problems and the preview comes back:`}</p>
          </div>
        </div>
        <ul className="mt-3 space-y-2">
          {lines.map((line, i) => (
            <li key={i} className="flex items-start gap-3 rounded-md bg-muted px-3 py-2">
              <div className="min-w-0 flex-1">
                <p id={`${uid}-issue-${i}`} className="text-xs font-medium text-foreground">
                  {line.lead}
                </p>
                {line.detail && <p className="mt-0.5 break-words text-xs text-muted-foreground">{line.detail}</p>}
              </div>
              {line.clipId && (
                <Button variant="outline" size="sm" className="h-7 shrink-0 px-2" aria-describedby={`${uid}-issue-${i}`} onClick={() => onSelectClip(line.clipId!)}>
                  Select clip
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
