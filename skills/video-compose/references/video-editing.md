# Video — editing prompt construction

For transforming an existing canvas clip. **No video ref exists** — extract a representative frame (or opening + closing frame) from the source clip with `extract_frames.js`, land it as an `image_result` node, and pass it as `--ref-source-id`. That frame anchors composition/subject/look; the prompt names the change and describes any motion, since motion no longer carries over from a video ref.

## Sub-intent decision tree

- **Restyle** — change the visual treatment (regrade, anime, golden hour, monochrome). Preserve composition, motion, subject.
- **Partial edit** — change one element (rain, color, single object, single passerby). Preserve everything else.
- **Replace** — swap a subject or product for another, keep the scene composition.
- **Re-plot** — keep the characters and environment, rewrite the action.
- **Other / doesn't fit** — see Fallback branch.

## Slot-by-slot construction (per sub-intent)

**Restyle:**

```
Starting from the frame in @Image1, re-render in [transformation]. Preserve composition and subject; describe the original clip's motion so it carries over.
```

Examples:
- *"Starting from the frame in @Image1, re-render in golden-hour light with warm highlights and long shadows. Preserve composition and subject; keep the same slow dolly-in motion."*
- *"Starting from the frame in @Image1, re-render as 2D anime with cel shading and bold outlines. Preserve composition and subject; keep the same handheld follow motion."*

**Partial edit:**

```
Starting from the frame in @Image1, re-render with [single change]. Keep [list of preserves] unchanged, including the original motion.
```

Example: *"Starting from the frame in @Image1, re-render with heavy rain and overcast sky. Keep the character's position, wardrobe, and camera movement unchanged."*

**Replace:**

```
Starting from the frame in @Image1, re-render with [old subject/product] replaced by [new subject/product]. Preserve scene, lighting, composition, and motion.
```

Example: *"Starting from the frame in @Image1, re-render with the silver perfume bottle replaced by a matte-black ceramic vase. Preserve scene, lighting, composition, and motion."*

**Re-plot:**

```
Starting from the frame in @Image1, keep the characters and environment, but [new action].
```

Example: *"Starting from the frame in @Image1, keep the detective and the diner, but the detective stands and walks out instead of staying seated."*

## Adjacent roles

- **Character image ref:** attach for Restyle/Partial when identity may drift; counts against the 2-image-ref cap alongside the extracted source frame.
- **Camera-move source:** no video ref exists to borrow it from — name the camera move explicitly when the user swaps camera grammar.

## What to lock vs. what to change (per sub-intent)

| Mode | Lock | Change |
|---|---|---|
| Restyle | composition, motion, subject | look (palette, light, style) |
| Partial | everything else | the named element |
| Replace | scene, lighting, composition | swapped subject / product |
| Re-plot | characters, environment | the action |

## Combinations to avoid

- **Re-plot + Replace at once** → identity drift. Do them in two steps: first Replace, then Re-plot the result.
- **Restyle + Re-plot at once** → both preserve clauses get diluted. Do separately if both are needed.

## Troubleshooting

- **Output looks too different from source** — over-described; the prompt is doing redescribe instead of transform. Reduce the prompt to the change clause + preserves clause.
- **Output looks identical to source** — under-described; the change clause is too vague. Be specific about *what* changes.
- **Identity drift in Restyle / Partial** — attach a character image ref; the extracted frame alone may not be enough to lock identity through a style change.

## Worked example — Restyle

User: *"Re-render the detective interrogation clip in golden-hour light."*

Extract the source clip's key frame, land it as `frame_1`, then:

```
Starting from the frame in @Image1, re-render in warm golden-hour light, with low-angle sun streaming through the blinds and long shadows across the desk. Preserve composition and subject; keep the same slow push-in motion.
```

Call: `--ref-source-id <frame_1.id>`. Only one more image-ref slot remains — use it for a character ref (`--ref-source-id <detective.id>`) only if identity is at risk of drifting through the regrade.

## Fallback branch

When the user's ask doesn't fit Restyle / Partial / Replace / Re-plot — e.g., a creative experiment that mixes modes, or an edit type that's genuinely novel: default rule — describe the *result*, not the motion. Preserve composition unless the user explicitly says otherwise. Name what stays and what changes.
