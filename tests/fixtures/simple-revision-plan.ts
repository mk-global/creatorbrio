/**
 * A plan the real Visual Director returned (#168) for "change the color of
 * 'failing' to the same color as 'Don't'" on a synthetic one-slide 9:16 reel
 * cover that shows an earlier background-replaced (edited) portrait. Before
 * #168 every such plan was refused with "execution.slides[0].treatment:
 * edited needs an edit task in assetRefs", because the slide keeps the earlier
 * edited image through `reuse` instead of a new edit task.
 *
 * `assetId` is the edited asset the slide shows.
 */
export const SIMPLE_REVISION_MESSAGE = "change the color of 'failing' to the same color as 'Don't'";

export function simpleRevisionPlan(assetId: string) {
  return {
    "status": "ready",
    "strategy": {
      "objective": "Hook engineers into an episode about production AI agents with a bold reel cover.",
      "audience": "Engineering leaders shipping AI agents.",
      "intendedResponse": "Stop scrolling and watch the episode.",
      "centralMessage": "Do not switch models before fixing the production gap; failing should not define you.",
      "contentType": "Reel cover (revision)",
      "priorities": [
        "Set 'failing' in the same signal orange as 'Don't'",
        "Keep everything else on the cover unchanged",
        "Keep the edited portrait low right fading into graphite"
      ],
      "creativeDirection": "A small, precise revision. The headline 'Don't let failing define you.' now carries two signal-orange accents, 'Don't' and 'failing', in the exact same orange (#ff6a1a). The other headline words stay off-white on graphite. Keep the existing layout, type scale, subline 'Never stop building.' and the edited portrait low right fading into graphite exactly as they are. The two orange words should read as a deliberate pair without making the headline look busy.",
      "treatmentStrategy": "This revision only changes colour, so the Design Agent handles it in typography. The existing edited portrait is reused unchanged, so no new image is made.",
      "reasoning": [
        {
          "decision": "Reuse the existing edited portrait asset",
          "why": "The user only asked for a text colour change; the image still fits and remaking it would add nothing."
        },
        {
          "decision": "Use the exact same orange for 'failing' as for 'Don't'",
          "why": "The user explicitly asked for the same colour; the brand accent is #ff6a1a."
        },
        {
          "decision": "Keep the slide count at 1 and leave the rest of the layout unchanged",
          "why": "It is a revision that asks for no other changes."
        }
      ],
      "successCriteria": [
        "'Don't' and 'failing' are both in the identical signal orange",
        "The other headline words keep their previous colour",
        "The subline 'Never stop building.' is unchanged",
        "The same edited portrait sits low right, fading into graphite",
        "The cover remains a single 9:16 slide"
      ],
      "assumptions": [
        "'Don't' currently uses the brand accent #ff6a1a, so 'failing' takes that same value",
        "No other copy or layout changes are wanted"
      ]
    },
    "execution": {
      "requestType": "revision",
      "slideCount": 1,
      "slideCountBasis": "existing",
      "slides": [
        {
          "index": 1,
          "visualIntent": "Same reel cover; 'Don't' and 'failing' both in signal orange, with the edited portrait low right fading into graphite.",
          "treatment": "edited",
          "assetRefs": [
            "a1"
          ],
          "styleReferenceIds": []
        }
      ],
      "assets": [
        {
          "key": "a1",
          "operation": "reuse",
          "assetId": assetId,
          "required": true,
          "targetSlides": [
            1
          ]
        }
      ]
    },
    "briefUpdate": {
      "fields": {},
      "addConstraints": [],
      "retireConstraints": [],
      "addVisualDecisions": [
        {
          "text": "'failing' set in the same signal orange as 'Don't'.",
          "source": "explicit"
        }
      ],
      "retireVisualDecisions": [],
      "assetRelationships": [
        {
          "id": assetId,
          "role": "Background-replaced cover portrait, reused on slide 1.",
          "source": "inferred"
        }
      ]
    }
  };
}
