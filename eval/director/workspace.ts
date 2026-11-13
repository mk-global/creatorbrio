import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { BrandConfig } from "@/types/brand";
import type { AspectRatio, Carousel } from "@/types/carousel";
import { addReferenceImage, addSlide, createCarousel, getCarousel, setCreativeBrief } from "@/lib/carousels";
import { resolveBrandForCarousel } from "@/lib/brand";
import { resolveReferenceImages } from "@/lib/reference-images";
import { capabilityStatus } from "@/lib/creative-capabilities";
import type { CreativeBrief } from "@/types/creative-brief";
import type { DirectorRequest, DirectorSource } from "@/lib/visual-director";

/**
 * A throwaway CreatorBrio data directory for evaluations: real storage, real
 * confined uploads, synthetic brands and images. Never the founder's data.
 */
export async function enterWorkspace(brand: Partial<BrandConfig> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "creatorbrio-eval-"));
  await mkdir(path.join(dir, "data"), { recursive: true });
  await mkdir(path.join(dir, "public", "uploads"), { recursive: true });
  await writeFile(
    path.join(dir, "data", "brand.json"),
    JSON.stringify({
      name: "Northlight Studio",
      colors: { primary: "#0b3d91", secondary: "#1c1c1c", accent: "#ff8c00", background: "#fbfaf7", surface: "#eef1f6" },
      fonts: { heading: "Playfair Display", body: "Inter" },
      customFonts: [],
      logoPath: null,
      styleKeywords: ["editorial", "calm", "confident"],
      createdAt: "",
      updatedAt: "",
      ...brand,
    })
  );
  process.chdir(dir);
  return dir;
}

/** Renders an SVG description into a confined upload and returns its URL. */
export async function upload(name: string, svg: string): Promise<string> {
  const id = crypto.randomUUID();
  await sharp(Buffer.from(svg)).png().toFile(path.join(process.cwd(), "public", "uploads", `${id}.png`));
  return `/uploads/${id}.png`;
}

export interface ScenarioSetup {
  aspectRatio: AspectRatio;
  /** Existing slides for a revision: body HTML and notes. */
  slides?: { html: string; notes?: string }[];
  references?: { name: string; svg: string }[];
  brief?: CreativeBrief;
  /**
   * Relationships the stored brief records for uploaded references, by index
   * in `references`; resolved to the reference IDs minted at upload, as the
   * product would have stored them when the reference was first used.
   */
  briefReferenceRoles?: { index: number; role: string; source: "explicit" | "inferred" }[];
  sources?: DirectorSource[];
  imageGeneration?: boolean;
}

/** Creates the carousel a scenario describes and the Director request for a message. */
export async function scenarioRequest(setup: ScenarioSetup, message: string): Promise<DirectorRequest> {
  let carousel: Carousel = await createCarousel("Evaluation", setup.aspectRatio);
  for (const slide of setup.slides ?? []) {
    await addSlide(carousel.id, slide.html, slide.notes ?? "");
  }
  const referenceIds: string[] = [];
  for (const ref of setup.references ?? []) {
    const url = await upload(ref.name, ref.svg);
    const id = crypto.randomUUID();
    referenceIds.push(id);
    await addReferenceImage(carousel.id, {
      id,
      url,
      name: ref.name,
      addedAt: new Date().toISOString(),
    });
  }
  if (setup.brief) {
    const relationships = (setup.briefReferenceRoles ?? []).map((r) => ({
      id: referenceIds[r.index],
      role: r.role,
      source: r.source,
      at: setup.brief!.updatedAt,
    }));
    await setCreativeBrief(carousel.id, {
      ...setup.brief,
      assetRelationships: [...setup.brief.assetRelationships, ...relationships],
    });
  }
  carousel = (await getCarousel(carousel.id))!;
  const references = await resolveReferenceImages(carousel);
  return {
    carousel,
    brand: await resolveBrandForCarousel(carousel),
    stylePreset: null,
    message,
    sources: setup.sources ?? [],
    references,
    assets: [],
    capabilities: await capabilityStatus(
      { referenceCount: references.length, intactAssetCount: 0 },
      async () => setup.imageGeneration ?? true
    ),
  };
}
