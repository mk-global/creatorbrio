import { readDataSafe, mutateData } from "./data";
import { generateId, now } from "./utils";
import { brandIdOf, getDefaultBrandId } from "./brand";
import type { Template, TemplatesData } from "@/types/template";
import type { Carousel } from "@/types/carousel";

const FILE = "templates.json";

const emptyData = (): TemplatesData => ({ templates: [] });

async function load(): Promise<TemplatesData> {
  return readDataSafe<TemplatesData>(FILE, emptyData());
}

/** Every change to templates.json goes through here, under the file's lock. */
function mutate<R>(fn: (data: TemplatesData) => R): Promise<R> {
  return mutateData<TemplatesData, R>(FILE, emptyData, fn);
}

/**
 * Lists templates, optionally only those of one brand. Templates saved before
 * brands existed belong to the default brand.
 */
export async function listTemplates(brandId?: string): Promise<Template[]> {
  const data = await load();
  if (brandId === undefined) return data.templates;
  const defaultBrandId = await getDefaultBrandId();
  return data.templates.filter((t) => brandIdOf(t, defaultBrandId) === brandId);
}

export async function getTemplate(id: string): Promise<Template | null> {
  const data = await load();
  return data.templates.find((t) => t.id === id) ?? null;
}

/**
 * A template keeps the brand of the carousel it was saved from: its slide HTML
 * carries that brand's colours, fonts and logo.
 */
export async function saveAsTemplate(
  carousel: Carousel,
  name?: string,
  description?: string
): Promise<Template> {
  const brandId = brandIdOf(carousel, await getDefaultBrandId());
  return mutate((data) => {
    const template: Template = {
      id: generateId(),
      name: name || carousel.name,
      description: description || `Template from ${carousel.name}`,
      aspectRatio: carousel.aspectRatio,
      slides: carousel.slides.map(({ id, html, order, notes }) => ({
        id,
        html,
        order,
        notes,
      })),
      tags: carousel.tags,
      brandId,
      // A template made from a document or a cover makes documents or covers (#175).
      ...(carousel.format ? { format: carousel.format } : {}),
      createdAt: now(),
    };
    data.templates.push(template);
    return template;
  });
}

export async function deleteTemplate(id: string): Promise<boolean> {
  return mutate((data) => {
    const idx = data.templates.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    data.templates.splice(idx, 1);
    return true;
  });
}
