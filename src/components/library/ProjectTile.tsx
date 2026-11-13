"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BookmarkPlus, CopyPlus, Ellipsis, ExternalLink, Trash2 } from "lucide-react";
import { useApp } from "@/components/app/AppContext";
import { Menu } from "@/components/app/Menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { brandDisplayName } from "@/lib/brand-display";
import { countLabel, FORMATS } from "@/lib/formats";
import type { ProjectSummary } from "@/lib/project-summary";
import { editedPhrase } from "@/lib/relative-time";
import { deleteProject, duplicateProject, saveProjectAsTemplate } from "./useLibrary";
import { ProjectFrame } from "./ProjectFrame";

/**
 * Frame heights come from the tile's own width (container units): the widest
 * shape, a fanned square carousel, is 1.11 × its height, so 88% of the column
 * always fits. Recent work and templates share one grid and differ only in size.
 */
export const SHEET_FH = "[--fh:min(220px,88cqw)]";
export const LARGE_FH = "[--fh:min(248px,88cqw)]";
export const SMALL_FH = "[--fh:min(150px,62cqw)]";
export const SHEET_GRID =
  "grid grid-cols-2 gap-x-5 gap-y-10 md:grid-cols-[repeat(auto-fill,minmax(190px,1fr))] lg:gap-x-7 lg:gap-y-12 xl:grid-cols-[repeat(auto-fill,minmax(216px,1fr))]";
/** Home's rows: four columns from 1024 px, two below. */
export const HOME_GRID = "grid grid-cols-2 gap-x-5 gap-y-10 lg:grid-cols-4 lg:gap-x-7";

export interface TileEvents {
  /** A copy was made; the library shows it at once. */
  onDuplicated: (copyId: string) => void;
  onDeleted: (id: string) => void;
}

export function ProjectTile({
  project,
  showBrand = false,
  size = SHEET_FH,
  onDuplicated,
  onDeleted,
}: { project: ProjectSummary; showBrand?: boolean; size?: string } & TileEvents) {
  const { brands, toast } = useApp();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const brand = brands.find((b) => b.id === project.brandId);
  const brandName = brandDisplayName(brand);
  const def = FORMATS[project.format];
  const href = `/carousel/${encodeURIComponent(project.id)}`;
  const failed = (what: string) => (err: unknown) => toast(`${what}: ${err instanceof Error ? err.message : "the app did not answer."}`, { tone: "alert" });

  return (
    <div className={`@container relative min-w-0 ${size}`}>
      <Link href={href} className="crop-hover block rounded-md outline-offset-6">
        <ProjectFrame
          html={project.firstSlideHtml}
          slideCount={project.slideCount}
          aspectRatio={project.aspectRatio}
          format={project.format}
          heightClass={size}
          paperColors={brand ? [brand.colors.surface, brand.colors.background] : undefined}
        />
        <span className="mt-3 block pr-10 text-[15px] leading-snug font-semibold break-words">{project.name}</span>
      </Link>
      <p className="mt-0.5 text-[13px] leading-snug text-graphite">
        {def.name}
        {project.format !== "reel-cover" && <>, {countLabel(project.format, project.slideCount)}</>}
        <br />
        {showBrand && <>{brandName}, </>}
        <span className="num">
          {showBrand ? "edited" : "Edited"} {editedPhrase(project.updatedAt)}
        </span>
      </p>
      <div className="absolute right-[-6px]" style={{ top: "calc(var(--fh) + 4px)" }}>
        <Menu
          label={`Actions for ${project.name}`}
          trigger={<Ellipsis className="size-[18px]" aria-hidden="true" />}
          items={[
            { label: "Open", icon: <ExternalLink />, onSelect: () => router.push(href) },
            {
              label: "Duplicate",
              icon: <CopyPlus />,
              onSelect: () =>
                void duplicateProject(project.id).then((copy) => {
                  onDuplicated(copy.id);
                  toast(`Made a copy: "${copy.name}".`);
                }, failed("Couldn't duplicate")),
            },
            {
              label: "Save as template",
              hint: project.slideCount ? `For ${brandName}` : "Design the slides first",
              icon: <BookmarkPlus />,
              disabled: project.slideCount === 0,
              onSelect: () =>
                void saveProjectAsTemplate(project.id).then(
                  (t) => toast(`Saved "${t.name}" as a template for ${brandName}.`),
                  failed("Couldn't save the template")
                ),
            },
            { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setConfirm(true) },
          ]}
        />
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete "${project.name}"?`}
        description="The project and its slides are removed from this computer. Exports you already downloaded are not affected."
        confirmLabel="Delete project"
        cancelLabel="Keep it"
        variant="destructive"
        onConfirm={() =>
          void deleteProject(project.id).then(() => {
            onDeleted(project.id);
            toast(`Deleted "${project.name}".`);
          }, failed("Couldn't delete"))
        }
      />
    </div>
  );
}
