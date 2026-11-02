/** The Creative Brief's stored shape; its rules live in `src/lib/creative-brief.ts`. */

export type Provenance = "explicit" | "inferred";

export interface BriefValue {
  value: string;
  source: Provenance;
  /** When this value was recorded. */
  at: string;
}

export interface BriefItem {
  text: string;
  source: Provenance;
  at: string;
}

export interface AssetRelationship {
  /** A reference image or committed asset ID of this carousel. */
  id: string;
  role: string;
  source: Provenance;
  at: string;
}

export const BRIEF_FIELDS = ["objective", "audience", "centralMessage", "desiredResponse", "brandContext"] as const;
export type BriefField = (typeof BRIEF_FIELDS)[number];

export interface CreativeBrief {
  objective?: BriefValue;
  audience?: BriefValue;
  centralMessage?: BriefValue;
  desiredResponse?: BriefValue;
  /** Brand and style context that matters for this carousel. */
  brandContext?: BriefValue;
  /** Explicit or inferred constraints, for example "serious tone" or "no stock-photo look". */
  constraints: BriefItem[];
  /** Important visual decisions to keep across revisions. */
  visualDecisions: BriefItem[];
  /** What each relevant reference image or asset is for, for example "the user's own photograph". */
  assetRelationships: AssetRelationship[];
  updatedAt: string;
}
