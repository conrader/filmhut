#!/usr/bin/env node
// Build a multi-angle reference sheet for a character or an item.
//
//   node reference_sheet.js --name "Marit Kall" --kind character \
//     --description "late 30s, brown skin, black hair centre-parted, olive coat" \
//     --ref-source-id image_2
//
//   node reference_sheet.js --name "the brass compass" --kind item \
//     --description "palm-sized tarnished brass, chipped blue-enamel star on the lid"
//
//   node reference_sheet.js --name "the telegraph key" --kind item --single \
//     --description "flat lever on a round brass base, black ebonite knob"
//
// EVERY REUSED OBJECT NEEDS ONE OF THESE, NOT JUST EVERY FACE.
//
// A prop that appears in more than one shot drifts exactly like a face does,
// and for the same reason: nothing anchors it, so each shot invents it again.
// In one piece the hero prop — a telegraph key on a desk, present in five of
// six shots — was described in prose in each prompt and never given a
// reference. It came back as a different object in the first shot from the
// other four, and as a ring-topped ornament rather than a telegraph key in all
// of them. Nobody had drawn it; five prompts had each guessed.
//
// So the rule is: if it appears twice, it gets a reference. Props, vehicles,
// signage, an animal, a distinctive garment worn by someone off-sheet.
//
// --single IS A FIRST-CLASS OPTION, NOT A FAILURE MODE.
//
// The four-panel sheet is the better anchor when it works. It does not always
// work: for a small rigid instrument the model has no confident idea of, four
// panels means four chances to disagree, and three attempts at that telegraph
// key produced three sheets whose own panels contradicted each other. One
// carefully composed view of an object the model renders CONSISTENTLY beats
// four views of an object it renders four ways. Reach for --single when the
// subject is small, rigid, and unlikely to be well known by name.
//
// WHY THIS EXISTS AS A COMMAND
//
// A single portrait gives a video model one viewpoint. Asked for a shot from
// behind, or standing rather than seated, it has to invent the unseen angles —
// and inventing is where identity drifts. A four-panel sheet triangulates:
// front, profile, back, and a close-up that serves as the face anchor.
//
// The prompt template lived only in a skill body, which meant it applied when
// an agent happened to load that skill and not otherwise. Every piece made
// before this shipped with single-portrait anchors and drifted for exactly the
// documented reason. Putting it behind a command makes the good path the short
// one.

import { parseArgs, emitSuccess, emitFailure, classify } from "./_cli.js";

const args = parseArgs({
  name:              { type: "string" },
  kind:              { type: "string" },   // character | item
  description:       { type: "string", short: "d" },
  "ref-source-id":   { type: "string", multiple: true },
  "source-node-id":  { type: "string" },
  size:              { type: "string" },
  "project-id":      { type: "string" },
  "request-id":      { type: "string" },
  "no-canvas-write": { type: "boolean" },
  print:             { type: "boolean" },  // emit the prompt without spending
  single:            { type: "boolean" },  // one composed view instead of four panels
});

const KINDS = new Set(["character", "item"]);
const kind = args.kind ?? "character";

if (!args.name) {
  emitFailure("bad_args", "--name is required: who or what this sheet is of");
  process.exit(2);
}
if (!KINDS.has(kind)) {
  emitFailure("bad_args", `--kind must be one of ${[...KINDS].join(", ")}`);
  process.exit(2);
}

const refs = Array.isArray(args["ref-source-id"]) ? args["ref-source-id"] : args["ref-source-id"] ? [args["ref-source-id"]] : [];
const description = String(args.description ?? "").trim();

// Shared across both kinds. Sheets that come back with captions are useless as
// refs — the caption gets rendered into every downstream shot.
//
// The film-stock name is deliberately ABSENT here.
//
// A sheet for a paper prop came back with "KO5aK POROT 400N" typed across the
// close-up panel: the model had read "Kodak Portra 400" out of the aesthetic
// block and printed it onto the subject. Naming a stock is a weak stylistic
// nudge; on a subject that can carry writing it is a free-text field. Describe
// the look instead, in words that are not brands.
const AESTHETIC = `[PHOTOGRAPHIC AESTHETIC]
Documentary photography on 35mm colour film, soft natural grain, gentle warm highlights and cool shadows, visible surface texture and fine detail, available-light soft studio lighting. ABSOLUTELY NOT a 3D render, video-game CG, Pixar, smoothed-skin filter, anime, or digital painting. Each panel is a separate on-set photograph.

[LAYOUT — HARD RULE]
ONE HORIZONTAL ROW. All panels sit side by side in a single row, each running the FULL HEIGHT of the image. This is NOT a 2x2 grid, NOT stacked, NOT a contact sheet. No panel sits above or below another.

[OUTPUT]
High-resolution 16:9 production sheet, clean editorial layout, neutral mid-grey seamless backdrop, no decorative borders between panels.`;

/**
 * The no-text rule, worded for the subject.
 *
 * A person cannot plausibly carry writing, so the generic rule holds. A sheet
 * of paper is nothing but a surface for writing, and asking for "no text" on a
 * telegram fights the subject — the model resolves the conflict by producing
 * gibberish, which is worse than either outcome. So the paper case asks for
 * illegibility rather than absence.
 */
function noTextRule(kind, description) {
  const papery = kind === "item"
    && /\b(paper|letter|telegram|note|document|book|page|card|map|newspaper|ticket|label)\b/i.test(description);
  return papery
    ? `[TEXT — HARD RULE]
Any writing on the object is BLURRED, faded and ILLEGIBLE — the impression of typed lines at a distance, never readable words. No legible letters, no invented alphabets, no gibberish that reads as an attempt at words. Nothing anywhere in frame but the object itself: no captions, labels, headers, annotations, watermarks or logos, and no camera, film or brand names rendered anywhere.`
    : `[NO TEXT — HARD RULE]
No captions, labels, words, numbers, headers, annotations, gibberish text or logos anywhere. The image is purely visual. Do not render camera, film stock or brand names into the picture.
Nothing is written ON the object either: NO engraved, stamped, etched, embossed or painted lettering of any kind — no maker's marks, no model or serial numbers, no monograms. Real antique brass and metal props usually carry a maker's stamp, and a model asked for a realistic one will invent illegible words to put there. Leave every surface blank.`;
}

function characterPrompt() {
  return `Professional character reference sheet. Subject: ${args.name}${description ? ` — ${description}` : ""}${refs.length ? ` — the SAME person shown in the reference photograph${refs.length > 1 ? "s" : ""}` : ""}. 16:9 horizontal layout with EXACTLY FOUR EQUAL-WIDTH PANELS side by side, left to right:

[PANEL 1] FULL BODY FRONT VIEW — head to feet, facing camera, arms slightly away from the body in a neutral A-pose.
[PANEL 2] FULL BODY PROFILE VIEW — perfect 90-degree side view, same pose and scale.
[PANEL 3] FULL BODY BACK VIEW — facing completely away, showing the back of the costume and hair. SAME GARMENTS as panels 1 and 2, seen from behind — not a jacket, coat or outer layer that panels 1 and 2 do not show.
[PANEL 4] CLOSE-UP HEAD AND SHOULDERS — bust only, the face filling 50-60% of the panel, looking at camera, neutral expression. This panel is the face-identity anchor for downstream video. It occupies the FULL HEIGHT of its own column and stays inside it: it must not overlap panel 3, sit in a corner, or float in empty backdrop.

[IDENTITY — HARD RULE]
All four panels show ONE person and one only. No second figure, no other face anywhere in the image, including in panel 4. Do not introduce facial hair, spectacles, headwear or accessories that the description and references do not specify — and do not omit any that they do. The face in panel 4 is the SAME AGE and build as in panel 1: same spectacle shape, same moustache or beard shape, same jawline. Panel 4 is a closer photograph of the person in panel 1, not a second person who resembles them.

${refs.length ? `[REFERENCE-PHOTO PRIORITY]
Where this prompt conflicts with the reference photograph${refs.length > 1 ? "s" : ""}, the PHOTOGRAPH WINS for face, hair and costume. No textbook substitution.

` : ""}[HARD CONSISTENCY]
EXACT same face, costume, hair and lighting in all four panels. Panels 1-3 at the same scale, head and feet aligned.

${noTextRule(kind, description)}

${AESTHETIC}`;
}

function itemPrompt() {
  // Layout leads, and says "tall vertical panel" explicitly. A character sheet
  // tiles into columns on its own because a standing figure is tall; a small
  // object does not, and the model reaches for a 2x2 grid or one hero panel
  // with three insets unless told otherwise in the first sentence.
  return `Professional prop reference sheet, ONE SINGLE HORIZONTAL ROW of EXACTLY FOUR EQUAL-WIDTH PANELS side by side, left to right, like four frames of film laid end to end. Each panel is a TALL VERTICAL PANEL running the full height of the image, with the object centred inside it. This is NOT a 2x2 grid, NOT a large panel with small insets, NOT a collage. Four panels, one row, equal width, full height.

Subject: ${args.name}${description ? ` — ${description}` : ""}${refs.length ? " — the SAME object shown in the reference photograph" : ""}.

[PANEL 1] FRONT VIEW — the object centred, filling the panel, photographed straight on.
[PANEL 2] THREE-QUARTER VIEW — same object rotated about 45 degrees, showing depth and side surfaces.
[PANEL 3] REVERSE OR OPEN VIEW — the back of the object, or the object opened if it opens, showing what a front view cannot.
[PANEL 4] MACRO DETAIL — a close-up of the single most identifying physical feature: the wear, damage, patina or shape that distinguishes this object from every similar one. NOT an inscription, marking or engraved label.

[IDENTITY — HARD RULE]
All four panels show ONE object and one only, at consistent scale relative to the panel. Same material, same colour, same wear and markings throughout. No hands, no people, no second object.

${refs.length ? `[REFERENCE-PHOTO PRIORITY]
Where this prompt conflicts with the reference photograph, the PHOTOGRAPH WINS for shape, material and markings.

` : ""}[HARD CONSISTENCY]
Identical lighting across all four panels. The object reads as the same physical thing photographed four times, not four similar objects.

${noTextRule(kind, description)}

${AESTHETIC}`;
}

function singleItemPrompt() {
  return `Museum product photograph of ${args.name}${description ? ` — ${description}` : ""}${refs.length ? " — the SAME object shown in the reference photograph" : ""}. ONE object alone on a plain neutral mid-grey seamless backdrop, photographed slightly above and from a three-quarter angle so that both its length and its height read clearly in a single frame.

[FRAMING]
The object fills most of the frame, sharp throughout, with even soft studio light and no dramatic shadow hiding any part of it. This single view is the anchor every downstream shot will be matched against, so nothing important may be turned away from camera or lost in shade.

[IDENTITY — HARD RULE]
ONE object and one only. No hands, no people, no second object, no desk clutter, no props beside it.

${refs.length ? `[REFERENCE-PHOTO PRIORITY]
Where this prompt conflicts with the reference photograph, the PHOTOGRAPH WINS for shape, material and markings.

` : ""}${noTextRule(kind, description)}

[PHOTOGRAPHIC AESTHETIC]
Documentary product photography on 35mm colour film, soft natural grain, visible surface texture and fine detail. ABSOLUTELY NOT a 3D render, video-game CG, Pixar, or digital painting.`;
}

const prompt = kind === "character"
  ? characterPrompt()
  : (args.single ? singleItemPrompt() : itemPrompt());

if (args.print) {
  emitSuccess({ ok: true, kind, name: args.name, prompt });
  process.exit(0);
}

// The pro tier is what the sheet flow needs: it takes an exact --size and its
// edit model accepts multiple references.
const { spawn } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");
const path = await import("node:path");
const here = path.dirname(fileURLToPath(import.meta.url));

const argv = [
  path.join(here, "generate_image_pro.js"),
  "--prompt", prompt,
  "--size", args.size ?? "2560x1440",
  // Items land as `reference`; the schema has no `prop` subtype and inventing
  // one would fail validation.
  "--subtype", kind === "character" ? "character" : "reference",
];
for (const r of refs) argv.push("--ref-source-id", r);
if (args["source-node-id"]) argv.push("--source-node-id", args["source-node-id"]);
if (args["project-id"]) argv.push("--project-id", args["project-id"]);
if (args["no-canvas-write"]) argv.push("--no-canvas-write");


/** Upsert this subject into the project's subjects.json, pointing at its node. */
async function linkSubject(name, subjectKind, nodeId) {
  const fs = await import("node:fs/promises");
  const path2 = await import("node:path");
  const { readActiveProject } = await import("../local_mirror.js");
  const { PAI_REPO_ROOT: ROOT } = await import("./_cli.js");
  const pid = args["project-id"] || (await readActiveProject());
  const file = path2.join(ROOT, "projects", pid, "subjects.json");

  let subjects = [];
  try {
    const doc = JSON.parse(await fs.readFile(file, "utf8"));
    if (Array.isArray(doc?.subjects)) subjects = doc.subjects;
  } catch { /* first subject in this project */ }

  const k = (v) => String(v ?? "").trim().toLowerCase();
  const i = subjects.findIndex((s) => k(s.name) === k(name));
  const entry = {
    name,
    kind: subjectKind,
    aliases: i >= 0 ? subjects[i].aliases ?? [] : [],
    node_id: nodeId,
    declared_at: i >= 0 ? subjects[i].declared_at : new Date().toISOString(),
  };
  if (i >= 0) subjects[i] = entry; else subjects.push(entry);
  await fs.writeFile(file, `${JSON.stringify({ version: 1, subjects }, null, 2)}\n`, "utf8");
}

const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
let out = "";
let err = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { err += d; });

child.on("close", async (code) => {
  const line = out.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(line);
    // Register the subject against the node just made, so the declared list and
    // the built references cannot drift apart. Building a reference IS
    // declaring the subject; requiring both by hand would guarantee that one
    // day only one of them happens.
    const nodeId = parsed?.canvas_mutation?.node_id;
    if (parsed.ok !== false && nodeId) {
      await linkSubject(args.name, kind, nodeId).catch(() => {});
    }
    // Pass the child's own JSON straight through, tagged with what it is, so
    // the caller sees one line in the usual shape.
    emitSuccess({ ...parsed, sheet_kind: kind, sheet_name: args.name });
    process.exit(parsed.ok === false ? 1 : 0);
  } catch {
    emitFailure(classify({ message: err }), err.trim() || `generate_image_pro exited ${code}`);
    process.exit(1);
  }
});
