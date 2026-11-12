import type { AspectRatio, Slide } from "./carousel";
import type { ProjectFormat } from "@/lib/formats";

export interface Template {
  id: string;
  name: string;
  description: string;
  aspectRatio: AspectRatio;
  slides: Omit<Slide, "previousVersions">[];
  tags: string[];
  /** The brand of the carousel it was saved from; none means the default brand. */
  brandId?: string;
  /** The format of the project it was saved from; absent means an Instagram carousel (#175). */
  format?: ProjectFormat;
  createdAt: string;
}

export interface TemplatesData {
  templates: Template[];
}
