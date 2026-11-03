import { imageGenerationConfigured } from "./image-service";

/**
 * The creative capabilities the Visual Director chooses among, described in
 * the terms it reasons with: what each does, when it helps, what it needs,
 * what it produces, and how it fails. Availability is computed by the server
 * from local facts only, never by a network call, so the same carousel always
 * gives the Director the same description.
 *
 * This is a small fixed table, not a plugin system. Adding a capability (for
 * example motion) means adding a row here, a plan operation the validator
 * accepts and an executor in the creative run; the Director's reasoning
 * responsibilities do not change.
 */

export type CapabilityId =
  | "design-composition"
  | "reference-placement"
  | "reference-style"
  | "image-generation"
  | "asset-reuse"
  | "image-editing"
  | "object-removal"
  | "relighting"
  | "image-combination";

export interface Capability {
  id: CapabilityId;
  does: string;
  usefulWhen: string;
  needs: string;
  produces: string;
  constraints: string;
  failureModes: string;
}

export interface CapabilityStatus extends Capability {
  available: boolean;
  /** Why it is unavailable, in words a planner (and a user) can act on. */
  unavailableReason?: string;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "design-composition",
    does:
      "The Design Agent composes every slide in HTML and CSS: copy, typography, layout, hierarchy, colour within the brand, shapes, gradients, SVG illustration and data visuals.",
    usefulWhen:
      "Always. It is the only capability that produces slides; typography-only and CSS-visual treatments need nothing else.",
    needs: "The request, the brand and the visual plan.",
    produces: "Finished slide HTML.",
    constraints:
      "It decides copy, layout and typography itself; it follows the plan's slide count, asset placements and reference roles.",
    failureModes: "Can deviate from the plan; deviations are reported, never auto-corrected.",
  },
  {
    id: "reference-placement",
    does: "Places an image the user uploaded to this carousel directly on a slide as content.",
    usefulWhen:
      "The user's own photograph, product shot, logo variant or screenshot should appear as itself, for example a founder photo on a cover.",
    needs: "An uploaded reference image of this carousel, by its ID.",
    produces: "The original image placed on the slides the plan names.",
    constraints: "The image is used as it is; it cannot be altered.",
    failureModes: "None at planning time; the Design Agent may crop it.",
  },
  {
    id: "reference-style",
    does: "Uses an uploaded reference image as a style source the Design Agent imitates, without placing it.",
    usefulWhen: "The user shares a design, palette or mood to follow rather than an image to show.",
    needs: "An uploaded reference image of this carousel, by its ID.",
    produces: "Slides that follow the reference's visual style.",
    constraints: "A reference is either placed or followed as style on a given slide, never both.",
    failureModes: "None at planning time.",
  },
  {
    id: "image-generation",
    does: "Generates a new photographic or illustrative image from a written brief, on the local image service.",
    usefulWhen:
      "The message needs a concrete scene, subject or atmosphere that HTML and CSS cannot convey and the user has no suitable image.",
    needs: "A brief (subject, composition, framing, lighting, text-safe area) and an aspect ratio (1:1, 4:5, 9:16 or 16:9).",
    produces: "One validated PNG per task, attached as a carousel asset for the slides the plan names.",
    constraints:
      "At most 5 images per request and never more than the slide count; images are generated one at a time within a 12-minute stage; it cannot reproduce a real person's likeness or edit an existing image.",
    failureModes:
      "Busy, declined for lack of machine resources, not running or not set up: a required image stops the request before design with the reason; an optional one is skipped and the plan's alternative is used.",
  },
  {
    id: "asset-reuse",
    does: "Reuses an image this carousel already has from an earlier generation.",
    usefulWhen: "A revision keeps an existing image, or the same image fits another slide.",
    needs: "A committed asset of this carousel, by its ID, whose file is intact.",
    produces: "The existing image placed on the slides the plan names.",
    constraints:
      "Only intact assets this carousel generated earlier are offered; uploaded reference images are never reused this way, they are placed with reference-placement.",
    failureModes: "None at planning time.",
  },
  {
    id: "image-editing",
    does:
      "Replaces the background behind the one person in a photograph, keeping every pixel of that person exactly as photographed. The source is an uploaded photo of this carousel or an earlier image of it.",
    usefulWhen:
      "The user wants their own photo, unchanged, in a different setting: a clean studio wall, a calmer room, a branded colour, an outdoor scene.",
    needs:
      "Exactly one source (an uploaded reference image or an intact asset of this carousel, by ID), a description of the new background only, and an aspect ratio (1:1, 4:5, 9:16 or 16:9).",
    produces:
      "One edited copy, attached as a carousel asset that records its source; the original is never changed.",
    constraints:
      "Background replacement only. The person is never changed: not their face, expression, hair, skin, clothing, pose or lighting, and they cannot be made to look better. The photo needs one clearly visible main person. The person keeps the light they were photographed in, so describe a background whose light plausibly matches it. The source is cropped to the aspect ratio around the person, and edits count towards the 5 images per request.",
    failureModes:
      "No clear person, or several people of similar size: the request stops before design and the user is asked for another photo. Busy, declined, not running or not set up: it stops the request before design, like a required generated image. An edit is never replaced by a generated image.",
  },
  {
    id: "object-removal",
    does: "Removes an object or a person from a photograph.",
    usefulWhen: "The user asks to take something out of their photo.",
    needs: "Nothing can make it available; it is not offered.",
    produces: "Nothing: a plan that needs it is refused before any image is made.",
    constraints: "Not offered: it changed the rest of the photo unpredictably, including what the person was holding.",
    failureModes: "A plan that needs it is refused, and the user is told what is possible instead.",
  },
  {
    id: "relighting",
    does: "Changes the lighting on the person in a photograph.",
    usefulWhen: "The user asks for different light, colour or mood on themselves.",
    needs: "Nothing can make it available; it is not offered.",
    produces: "Nothing: a plan that needs it is refused before any image is made.",
    constraints: "Not offered: relighting regenerated the person and changed their face.",
    failureModes: "A plan that needs it is refused, and the user is told what is possible instead.",
  },
  {
    id: "image-combination",
    does: "Combines two images, for example placing the person from one photo into another photo.",
    usefulWhen: "The user asks to put themselves into a specific other picture.",
    needs: "Nothing can make it available; it is not offered.",
    produces: "Nothing: a plan that needs it is refused before any image is made.",
    constraints: "Not offered: combining images regenerated the person and changed their face and gaze.",
    failureModes: "A plan that needs it is refused, and the user is told what is possible instead.",
  },
];

export interface CapabilityContext {
  referenceCount: number;
  intactAssetCount: number;
}

/**
 * The capabilities with their availability for one carousel. Image generation
 * is available when it is set up for this account; whether the service is
 * running is only discovered when an image is requested.
 */
export async function capabilityStatus(
  context: CapabilityContext,
  imageGenerationReady: () => Promise<boolean> = imageGenerationConfigured
): Promise<CapabilityStatus[]> {
  const generation = await imageGenerationReady();
  return CAPABILITIES.map((capability) => {
    switch (capability.id) {
      case "reference-placement":
      case "reference-style":
        return context.referenceCount > 0
          ? { ...capability, available: true }
          : { ...capability, available: false, unavailableReason: "This carousel has no uploaded reference images." };
      case "asset-reuse":
        return context.intactAssetCount > 0
          ? { ...capability, available: true }
          : { ...capability, available: false, unavailableReason: "This carousel has no earlier generated images." };
      case "image-generation":
        return generation
          ? { ...capability, available: true }
          : { ...capability, available: false, unavailableReason: "Image generation is not set up on this machine." };
      case "image-editing":
        // The same local condition as generation: the service is set up for this
        // account. A service without editing is discovered when an edit is made.
        return generation
          ? { ...capability, available: true }
          : { ...capability, available: false, unavailableReason: "Image editing is not set up on this machine." };
      case "object-removal":
      case "relighting":
      case "image-combination":
        return { ...capability, available: false, unavailableReason: "Not offered: it would change the photograph or the person." };
      default:
        return { ...capability, available: true };
    }
  });
}

/** Whether a capability is available in a computed status list. */
export function isAvailable(status: readonly CapabilityStatus[], id: CapabilityId): boolean {
  return status.some((c) => c.id === id && c.available);
}
