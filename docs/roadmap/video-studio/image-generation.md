# Image generation and illustration provider contract

**Owner:** SS-GFX / SS-PLATFORM. **Implementation:** [WS12 #89](https://github.com/mk-global/creatorbrio/issues/89), [focused adapter #106](https://github.com/mk-global/creatorbrio/issues/106), [commercial license gate G9 #105](https://github.com/mk-global/creatorbrio/issues/105). **Workflow:** [script to animation](../../research/video-studio/spec/03-workflow-b-script-animation.md), [storyboard](../../research/video-studio/spec/04-storyboard-and-review.md).

## Implemented now (do not rebuild)

`src/lib/image-service.ts` is the existing private local image-service client. It accepts `POST /generate` with `prompt` and `aspectRatio`, and `POST /edit` for subject-preserving background replacement. It uses a loopback-only HTTP service with a bearer token stored in an owner-only local file. It validates and sanitizes PNG output and uses typed errors. The separate local service and its installed model are **not shipped in this repository**.

Current image service supports stills and photo background replacement used by the Design Agent. These are **not equivalent** to a complete character/illustration generation pipeline or a commercially distributable reference model. The current model variant/license must be verified, not inferred.

The existing carousel/image design flow must continue to work unchanged while Video Studio is added.

## Required extensions for video creation

- A **provider-neutral image capability interface**, selected at runtime; never place model-specific switches or access credentials in the production data document. The current loopback service is the first adapter. A future commercially licensed public reference adapter can use other local engines or optional authenticated services.
- **Capabilities discoverable before invocation:** text-to-image, image-to-image, reference-image conditioning, style matching, character reference/identity consistency, inpainting/outpainting and mask editing, supported aspect ratios, limits, version and availability. An unsupported capability must return a typed error, not silently substitute a different operation.
- **Storyboard integration:** each scene has an AssetSlot describing the needed subject, style and use. The image provider returns candidate art with provenance, source prompt hash, backend/model ID/revision, seeds if supported, generated-at timestamp and rights/consent status. Creator approves/rejects candidates before materialization.
- **Style and character continuity:** persist a reusable character design/reference sheet and visual style profile per production/brand, using explicit conditioning controls where supported. Scene revisions regenerate only the affected images and downstream layers, keeping unrelated narration, source media, approvals and edit history intact.
- **Motion is a separate concern:** generation creates still illustrations/plates; native animated Scene Specs/character rigs move them over time. No mandatory text-to-video generation service. External specialized renderers may return baked clips via isolated adapters.
- **Open-source and commercial availability:** at least one documented downloadable or user-installable commercially permitted local image backend, with weight license checked at the exact revision. Do not bundle a noncommercial model as the only working default. Optional restricted models may be marked as unavailable for commercially intended exports.
- **Security:** maintain loopback guard, owner-only credentials, bounded input/output sizes, source reference confinement, generated provenance and no personal image mutation without consent. Do not pass bearer tokens into generated HTML or agent prompts.

## Interface sketch (not implementation)

```ts
type ImageCapability =
  | "text_to_image"
  | "image_to_image"
  | "reference_style"
  | "character_reference"
  | "inpaint"
  | "replace_background";

interface ImageProviderInfo {
  providerId: string;
  modelId: string;
  modelRevision: string;
  commerciallyPermitted: boolean | "unverified";
  capabilities: ImageCapability[];
  aspectRatios: string[];
  maxReferences: number;
}

interface IllustrationRequest {
  productionId: string;
  sceneId: string;
  slotId: string;
  prompt: string;
  aspectRatio: string;
  styleProfileId?: string;
  referenceAssetIds?: string[];
  characterId?: string;
  seed?: number;
  mode: ImageCapability;
}

interface IllustrationAsset {
  mediaId: string; // content addressed
  provenance: {
    providerId: string;
    modelId: string;
    modelRevision: string;
    requestHash: string;
    references: string[];
    seed?: number;
  };
  rightsRecordId: string;
}
```

The actual schema and API must fit the canonical [Production v2 and rights record](../../research/video-studio/spec/07-data-models-and-interfaces.md). This sketch must not create a second source of truth.

## Release integration

**Edit Studio:** optional illustrated diagrams, backgrounds and B-roll assets; usable with local preexisting image service or manual/source-library assets. No requirement for generated character sheets.

**Create Studio:** fully usable local text-to-image illustrations, reusable visual styles and characters across scenes, deterministic regeneration metadata and editable animation on top of illustrations. Quality must pass the real creator-approved animation acceptance suite.

## Acceptance / tests

1. Existing `/generate` and `/edit` paths continue to satisfy current carousel tests and preserve original subject pixels for background replacement.
2. New Video Studio asset slots can request a local illustrated still without leaking tokens or absolute paths into the client.
3. A provider that does not support reference conditioning reports its limitation clearly, allowing alternate provider or user image; **no unadvertised fallback**.
4. A character sheet used in three scenes yields candidate illustrations with measurable consistency reviewed by the creator; changing one scene updates only linked assets and clips.
5. Asset ledger records model version, source references, consent and license; an unverified/noncommercial model blocks commercial exports.
6. A public install guide uses an actually commercially licensable reference backend, validated at G9. A user's already-running local model remains a private optional adapter.

**Avoid premature infrastructure:** no new inference gateway service, model registry database or image model training operation is authorized by this contract. Reuse existing local-service and capability-discovery patterns.
