import { readDataSafe, mutateData } from "./data";
import { generateId, now } from "./utils";
import { brandIdOf, getDefaultBrandId } from "./brand";
import type { Carousel, CarouselAsset, CarouselsData, Slide, AspectRatio, ReferenceImage } from "@/types/carousel";
import type { CreativeBrief } from "@/types/creative-brief";
import { MAX_VERSIONS } from "@/types/carousel";
import { slideLimitOf, type ProjectFormat } from "./formats";

const FILE = "carousels.json";

const emptyData = (): CarouselsData => ({ carousels: [] });

async function load(): Promise<CarouselsData> {
  return readDataSafe<CarouselsData>(FILE, emptyData());
}

/** Every change to carousels.json goes through here, under the file's lock. */
function mutate<R>(fn: (data: CarouselsData) => R): Promise<R> {
  return mutateData<CarouselsData, R>(FILE, emptyData, fn);
}

/**
 * Exactly the fields of a reference image, as it is stored and returned. A
 * record stored before #62 may still carry the absolute path of its file on
 * the server; that is never copied into a new record or sent to the browser.
 */
export function referenceImageFields({ id, url, name, addedAt }: ReferenceImage): ReferenceImage {
  return { id, url, name, addedAt };
}

/**
 * A carousel as the API returns it. Every route that answers with a carousel
 * passes it through here, so a stored reference image reaches the browser
 * with its own fields only, never a server path (#62). Stored data is not
 * changed: this is a new object, and mutators hand back the stored one.
 */
export function carouselResponse(carousel: Carousel): Carousel {
  return { ...carousel, referenceImages: (carousel.referenceImages ?? []).map(referenceImageFields) };
}

/**
 * Lists carousels, optionally only those of one brand. Carousels made before
 * brands existed belong to the default brand.
 */
export async function listCarousels(brandId?: string): Promise<Carousel[]> {
  const data = await load();
  const carousels = data.carousels.filter((c) => !c.isTemplate);
  if (brandId === undefined) return carousels;
  const defaultBrandId = await getDefaultBrandId();
  return carousels.filter((c) => brandIdOf(c, defaultBrandId) === brandId);
}

export async function getCarousel(id: string): Promise<Carousel | null> {
  const data = await load();
  return data.carousels.find((c) => c.id === id) ?? null;
}

/**
 * `brandId` is stamped here, the default brand when none is given, and no
 * update can move a carousel to another brand afterwards.
 */
export async function createCarousel(
  name: string,
  aspectRatio: AspectRatio,
  brandId?: string,
  format?: ProjectFormat
): Promise<Carousel> {
  const owner = brandId ?? (await getDefaultBrandId());
  return mutate((data) => {
    const carousel: Carousel = {
      id: generateId(),
      name,
      aspectRatio,
      slides: [],
      referenceImages: [],
      chatSessionId: null,
      brandId: owner,
      // Stored only when given, so a carousel created the old way is
      // byte-for-byte what it was (#175).
      ...(format ? { format } : {}),
      isTemplate: false,
      tags: [],
      createdAt: now(),
      updatedAt: now(),
    };
    data.carousels.push(carousel);
    return carousel;
  });
}

export async function updateCarousel(
  id: string,
  updates: Partial<Pick<Carousel, "name" | "aspectRatio" | "tags" | "chatSessionId" | "caption" | "hashtags">>
): Promise<Carousel | null> {
  return mutate((data) => {
    const idx = data.carousels.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    Object.assign(data.carousels[idx], updates, { updatedAt: now() });
    return data.carousels[idx];
  });
}

export async function duplicateCarousel(id: string): Promise<Carousel | null> {
  return mutate((data) => {
    const source = data.carousels.find((c) => c.id === id);
    if (!source) return null;

    const duplicate: Carousel = {
      ...source,
      id: generateId(),
      name: `${source.name} (copy)`,
      slides: source.slides.map((s) => ({
        ...s,
        id: generateId(),
        previousVersions: [],
      })),
      // The same uploads, without a server path an old record may carry (#62).
      referenceImages: (source.referenceImages || []).map(referenceImageFields),
      // The copy shares the same files, as it does for reference images.
      assets: [...carouselAssets(source)],
      // The copy keeps what the carousel is for; its references and assets came with it.
      ...(source.creativeBrief ? { creativeBrief: structuredClone(source.creativeBrief) } : {}),
      chatSessionId: null,
      isTemplate: false,
      createdAt: now(),
      updatedAt: now(),
    };

    data.carousels.push(duplicate);
    return duplicate;
  });
}

export async function deleteCarousel(id: string): Promise<boolean> {
  return mutate((data) => {
    const idx = data.carousels.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    data.carousels.splice(idx, 1);
    return true;
  });
}

// --- Slide operations ---

export async function addSlide(
  carouselId: string,
  html: string,
  notes = ""
): Promise<Slide | null> {
  return mutate((data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return null;
    // The format's limit: 20 for carousels and documents, one for a Reel cover (#175).
    if (carousel.slides.length >= slideLimitOf(carousel)) return null;

    const slide: Slide = {
      id: generateId(),
      html,
      previousVersions: [],
      order: carousel.slides.length,
      notes,
    };
    carousel.slides.push(slide);
    carousel.updatedAt = now();
    return slide;
  });
}

export async function updateSlide(
  carouselId: string,
  slideId: string,
  updates: Partial<Pick<Slide, "html" | "notes">>
): Promise<Slide | null> {
  return mutate((data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return null;
    const slide = carousel.slides.find((s) => s.id === slideId);
    if (!slide) return null;

    // Save current HTML to version history before overwriting
    if (updates.html && updates.html !== slide.html) {
      slide.previousVersions.push(slide.html);
      if (slide.previousVersions.length > MAX_VERSIONS) {
        slide.previousVersions.shift();
      }
    }

    Object.assign(slide, updates);
    carousel.updatedAt = now();
    return slide;
  });
}

export async function deleteSlide(
  carouselId: string,
  slideId: string
): Promise<boolean> {
  return mutate((data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return false;
    const idx = carousel.slides.findIndex((s) => s.id === slideId);
    if (idx === -1) return false;

    carousel.slides.splice(idx, 1);
    // Re-order remaining slides
    carousel.slides.forEach((s, i) => {
      s.order = i;
    });
    carousel.updatedAt = now();
    return true;
  });
}

export async function reorderSlides(
  carouselId: string,
  slideIds: string[]
): Promise<boolean> {
  return mutate((data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return false;

    // Validate the request in full before mutating anything. A reorder must be
    // a permutation of the existing slides: accepting a subset would drop the
    // slides left out, and accepting duplicates would clone them. Validating
    // first also means a rejected reorder cannot leave half-applied order
    // fields behind now that the write happens under the same lock.
    if (slideIds.length !== carousel.slides.length) return false;

    const slideMap = new Map(carousel.slides.map((s) => [s.id, s]));
    const seen = new Set<string>();
    const reordered: Slide[] = [];
    for (const id of slideIds) {
      const slide = slideMap.get(id);
      if (!slide || seen.has(id)) return false;
      seen.add(id);
      reordered.push(slide);
    }

    reordered.forEach((s, i) => {
      s.order = i;
    });
    carousel.slides = reordered;
    carousel.updatedAt = now();
    return true;
  });
}

export async function undoSlide(
  carouselId: string,
  slideId: string
): Promise<Slide | null> {
  return mutate((data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return null;
    const slide = carousel.slides.find((s) => s.id === slideId);
    if (!slide || slide.previousVersions.length === 0) return null;

    const previousHtml = slide.previousVersions.pop()!;
    slide.html = previousHtml;
    carousel.updatedAt = now();
    return slide;
  });
}

// --- Reference images ---

export async function addReferenceImage(
  carouselId: string,
  image: ReferenceImage
): Promise<ReferenceImage | null> {
  return mutate((data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return null;

    if (!carousel.referenceImages) carousel.referenceImages = [];
    carousel.referenceImages.push(image);
    carousel.updatedAt = now();
    return image;
  });
}

export async function removeReferenceImage(
  carouselId: string,
  imageId: string
): Promise<boolean> {
  return mutate((data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel || !carousel.referenceImages) return false;

    const idx = carousel.referenceImages.findIndex((img) => img.id === imageId);
    if (idx === -1) return false;

    carousel.referenceImages.splice(idx, 1);
    carousel.updatedAt = now();
    return true;
  });
}

/** A carousel's committed assets; carousels from before assets existed have none. */
export function carouselAssets(carousel: Pick<Carousel, "assets">): CarouselAsset[] {
  return carousel.assets ?? [];
}

/**
 * Appends asset records to a carousel, skipping any whose ID it already has,
 * so repeating the call after a crash adds nothing twice. Returns false when
 * the carousel does not exist. Only the asset module's attach protocol calls
 * this.
 */
export async function appendCarouselAssets(carouselId: string, records: CarouselAsset[]): Promise<boolean> {
  return mutate((data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return false;
    const assets = carouselAssets(carousel);
    const known = new Set(assets.map((a) => a.id));
    const added = records.filter((r) => !known.has(r.id));
    if (added.length > 0) {
      carousel.assets = [...assets, ...added];
      carousel.updatedAt = now();
    }
    return true;
  });
}

/**
 * Removes asset records with these IDs from every carousel, including copies
 * made by duplication, so no record is left pointing at a file an attach roll-
 * back removes. Only the asset module calls this, for asset IDs it generated.
 */
export async function removeCarouselAssets(assetIds: string[]): Promise<void> {
  if (assetIds.length === 0) return;
  const ids = new Set(assetIds);
  // Nothing to remove means nothing to write, so a roll-back after a failed
  // carousel write does not depend on writing that file again.
  const stored = await readDataSafe<CarouselsData>(FILE, emptyData());
  if (!stored.carousels.some((c) => carouselAssets(c).some((a) => ids.has(a.id)))) return;
  await mutate((data) => {
    for (const carousel of data.carousels) {
      const assets = carouselAssets(carousel);
      if (assets.some((a) => ids.has(a.id))) {
        carousel.assets = assets.filter((a) => !ids.has(a.id));
        carousel.updatedAt = now();
      }
    }
  });
}

/**
 * Replaces a carousel's Creative Brief. In the app only the creative run calls
 * this, as design begins, with a brief merged from a validated Visual Director
 * update; the Director evaluation harness also uses it to seed scenarios.
 * Returns false when the carousel does not exist.
 */
export async function setCreativeBrief(carouselId: string, brief: CreativeBrief): Promise<boolean> {
  return mutate((data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return false;
    carousel.creativeBrief = brief;
    carousel.updatedAt = now();
    return true;
  });
}
