---
name: continuity-compose
description: >-
  Keeps characters, props, locations, style, and audio consistent across the
  clips of a multi-shot piece. Use when a project has more than one clip of the
  same character, prop, or place; when planning anchors and clip contracts
  before rendering a sequence; when a landed clip must be checked against its
  neighbours rather than against its own prompt; when a cut reads wrong at the
  seam; or when one clip in an approved sequence needs repairing without
  rebuilding the rest. Owns the production packet, the clip contract, the
  continuity verdict, and the smallest-unit repair rule.
---

# Continuity

Continuity is recorded state, not repeated prose. Write it down once, hand it to each clip, and
check the result against what was promised.

Generated media is probabilistic. References and contracts raise consistency; they never guarantee
it. Say so to the user, and never promise a perfect match.

## Contract

- `story-to-video-workflow` owns sequencing and wakes first on story work. This skill owns
  continuity only, and is loaded when continuity is the live question.
- Anchors and refs are made by `image-compose` and `voice-compose`; clips by `video-compose`. Do not
  call generation CLIs from here.
- This skill sits **downstream** of PROJECT_AGENT.md § "Prompt alignment check". That check asks
  *did I get what I asked for*. This one asks *does it match the other shots*. Run alignment first;
  a clip that failed its own prompt is not a continuity problem yet.

## The production packet

Durable plain text under `projects/<active>/production/`. It survives context loss, it is greppable,
and any agent can read it. Create or update it **before** generating a sequence.

| File | Holds |
|---|---|
| `brief.md` | premise, format, target duration, narrative spine, visual and audio approach, definition of done |
| `bibles.md` | one section per character, recurring prop, location, visual style, audio style — each with a stable ID |
| `shot-ledger.md` | the ordered clip list and the authoritative continuity state of each clip |
| `reference-plan.md` | which asset anchors what, its provenance and consent status, and the clips it serves |

Keep entries compact and observable. Record what a viewer could point at, not what you intended.

Give every recurring element a stable ID (`CHAR-MARA-01`, `PROP-COMPASS-01`, `LOC-LANTERN-01`) and
use it verbatim in every clip contract. Separate **locked traits** — true in every shot — from
**scene state**, which legitimately changes.

- **Character**: apparent age, face geometry, skin, hair, build, silhouette, posture, wardrobe
  layers, accessories, voice quality. Identity should rest on a combination, never on one accessory —
  a hat is not a character.
- **Prop**: design, scale, material, markings, condition, count, and whose hand it is in.
- **Location**: layout, entrances, landmarks, geography, time, weather, light sources.
- **Style**: medium, palette, contrast, texture, lens and camera grammar, motion, aspect, exclusions.
- **Audio**: voice anchors, ambience, recurring motif, instrumentation, tempo, transition rules.

If the story implies more than roughly three minutes, recommend narrowing before building anchors.

When the user wants the packet visible on the canvas, mirror a short summary into a note per
PROJECT_AGENT.md § "Take a note". The files stay the source of truth; the note is a view.

## Clip contracts

Every clip gets a row in `shot-ledger.md` with a stable ID:

```
clip | beat | duration | depends on | incoming | action/camera/audio | outgoing | refs | result | verdict
```

**Incoming** is what must be true in the first readable moment: who is present and in which variant,
positions, facing and eyelines, wardrobe, prop count and condition and hand, location geometry, time
and weather and light, camera relation, action phase, ambience and music state, and the preceding
edit type.

**Outgoing** is what the clip promises the next cut: final positions, facing, wardrobe and prop
state, light and time, action and camera direction, last-frame composition where it matters,
dialogue and music state, and the intended transition.

Mark dependencies explicitly. Render independent clips in parallel; serialise any clip whose opening
depends on an earlier clip's rendered output.

An extracted boundary frame is **composition evidence, not an identity anchor** — see
PROJECT_AGENT.md § "Asset, ref, and edge rules" for how refs attach. Do not chain extracted frames
across a location, time, wardrobe, or reality break; compose a fresh opening frame from the
character sheet instead.

Before each generation, read the contract against the bibles and the reference plan. After it lands,
record the prompt actually used, the refs, the node id, and the reported cost in the ledger row.
Never record a setting the CLI did not report.

## Inspecting a landed clip

Run after PROJECT_AGENT.md § "Prompt alignment check" returns `pass`, and before anything that
depends on this clip's outgoing state.

1. **Look.** Extract frames with `node "$PAI_REPO_ROOT/server/cli/extract_frames.js" --path <local_path>`
   and view the opening, the middle, and the ending in order.
2. **Describe, then judge.** Write two or three factual sentences about what the clip shows before
   re-reading the contract. Reading the contract first primes you to see what you promised.
3. **Compare side by side.** Open the anchor images and the neighbouring clips' boundary frames.
   Never judge identity from memory — that is the single most common way drift is missed.
4. **Check both seams.** The opening against the previous clip's outgoing state, the ending against
   the next clip's incoming state.

## Classifying a break

| Bucket | The break |
|---|---|
| `identity` | face, age, build, hair, wardrobe, signature movement, or voice no longer reads as the same character |
| `prop` | a recurring object's design, scale, markings, count, condition, or hand changes wrongly |
| `location_style` | geometry, landmark, light, weather, palette, texture, lens, or medium drifts |
| `seam` | pose, screen direction, eyeline, action phase, timing, or camera relation breaks the cut |
| `audio` | voice timbre, ambience, motif, instrumentation, tempo, or loudness breaks across the join |

Verdict is `pass`, `minor` (visible variance that does not break the story), or `repair`. Reserve
`repair` for a material failure of recognition, space, time, or sound. Harmless pixel variation is
not a repair.

Record it on the result node alongside the alignment verdict:

```bash
node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" --op updateNode --payload-json \
  '{"id":"<node_id>","patch":{"metadata":{"continuity":{"verdict":"repair","buckets":["identity"],"against":["<prev_node_id>","<next_node_id>"],"issues":["Mara reads ~20 years younger than CHAR-MARA-01"],"checked_at":"<ISO 8601>"}}}}'
```

Report one line — `continuity: pass` or `continuity: repair — <buckets>: <issue>` — then recommend
the next step per PROJECT_AGENT.md § "Recommendation and choice shape".

## Repairing

**Freeze what passed.** Regenerate only the failed clip. Never restart a sequence because one shot
drifted; approved clips have been paid for.

1. Name the first failed locked requirement, and whether it belongs to this clip's incoming state,
   its internal action, or its outgoing state.
2. Prefer the cheapest fix that could work, in this order: choose a different edit point or trim an
   approved take with local tools; recompose the opening frame from the character sheet and re-animate
   that; only then re-render the clip.
3. Reuse the approved inputs. Change only the prompt, ref, or boundary choice the classified bucket
   points at — changing several at once tells you nothing about which one worked.
4. Respect the payment gates. Staging and consent follow PROJECT_AGENT.md § "Draft gate", and
   § "Failure handling" governs paid video: never auto-retry a video clip.
5. Re-inspect the replacement against **both** adjacent contracts, not just its own. Keep the
   rejected take's node so the lineage survives.

After two failed repairs on one clip, stop. Say what the models will not hold, and offer a story or
edit compromise — a cut to a different angle, a tighter framing that excludes the drifting detail, or
a beat rewritten to make the change diegetic.

## Consent and rights

These gate the packet, not the render — settle them before an anchor is built.

- Use reference images only with documented permission or a compatible licence. Record source and
  allowed use in `reference-plan.md`. Do not pull in scraped, private, or needlessly sensitive images.
- Get informed permission before cloning or closely imitating a real person's face or voice. Never
  help produce deceptive impersonation; label synthetic media where context warrants it.
- Use original, commissioned, public-domain, or licensed music and sound, and record the licence.
  Do not ask for imitation of a living artist as a shortcut.
- Minimise personal data. Keep private assets in the project, not in prompts or logs.
- Escalate unclear consent, copyright, privacy, or publicity questions to the user before generating.

## Worked example

Premise: during a storm, 68-year-old lighthouse keeper Mara repairs the beacon and uses her late
partner's brass compass to guide a ferry home. Roughly 72 seconds, three locations.

- **Bibles.** `CHAR-MARA-01`: long angular face, deep smile lines, asymmetric silver bob, red knit
  cap, mustard oilskin, deliberate left-shoulder-leading walk. `PROP-COMPASS-01`: palm-sized tarnished
  brass, chipped blue-enamel star; closed at first, opened in the lantern room, ending clasped in her
  right hand. Locked: lighthouse layout, storm direction, lens and contrast rules, wind ambience, a
  three-note low-string motif.
- **Reference plan.** Neutral, profile, and full-body sheets for Mara; compass closed and open in
  detail; cottage, lantern-room, and cliff anchors; consented voice source.
- **Ledger, clip 5.** Incoming: Mara in the lantern room, wet oilskin, compass open in her right
  hand, beacon dark, motif unresolved. Outgoing: beacon lit, Mara facing seaward, compass still open,
  music holding under the cut to the exterior.
- **Inspection.** Clip 5 lands with Mara reading twenty years younger and the compass in her left
  hand. Classify `identity` + `prop`, verdict `repair`. Freeze clips 1–4. Recompose clip 5's opening
  frame from the Mara sheet with the compass explicitly in the right hand, re-animate that frame, then
  re-inspect its opening against clip 4 and its ending against clip 6 before continuing.
