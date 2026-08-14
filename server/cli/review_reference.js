#!/usr/bin/env node
// Review gate for reference images.
//
//   node review_reference.js --node-id image_8              # inspect, mark pending
//   node review_reference.js --node-id image_8 --approve
//   node review_reference.js --node-id image_8 --reject --reason "panel 4 has a moustache"
//   node review_reference.js --list
//
// WHY A GATE
//
// A reference sheet is the asset whose defects compound. Anchor six clips on a
// sheet whose close-up panel drifted and all six inherit the drift; the bill
// arrives before the problem is visible. It happened on this project: the
// first sheet for a clean-shaven character came back with a MOUSTACHE on the
// face-anchor panel — the other character's features bleeding across a
// two-subject prompt — and it reached the user, because nothing sat between
// generating an image and handing it over.
//
// So: an unreviewed reference is not a reference. This command is the step in
// between, and the verdict it records is what the generate CLIs check.
//
// WHO REVIEWS
//
// A model that can see. Not this program. deAPI has no vision-language model,
// so filmhut cannot judge whether two panels show the same person — and a
// green tick that means nothing is worse than no tick at all, because it
// launders an unchecked asset as a checked one.
//
// What this command does is make the review cheap enough to be routine and
// impossible to skip silently: it slices the panels, builds a face strip at
// matched scale (the crop that makes a stray moustache obvious), settles every
// question a machine can settle, and marks the node `pending`. Approval is a
// separate, explicit act by whoever looked.
//
// The `unchecked` list is a CHECKLIST, not a disclaimer. It is there because a
// reviewer with no prompt reviews whatever catches the eye: one sheet was
// approved with a note about the legibility of a prop, and the same image had
// THREE HANDS in it. Read every unchecked item and answer it deliberately.

import path from "node:path";
import fs from "node:fs/promises";

import { parseArgs, emitSuccess, emitFailure, classify, isoNow, PAI_REPO_ROOT } from "./_cli.js";
import { postMutation } from "./_mutate_helper.js";
import { readActiveProject } from "../local_mirror.js";
import { inspectSheet, PANEL_ROLES } from "../lib/refsheet.js";

const args = parseArgs({
  "node-id":    { type: "string" },
  "project-id": { type: "string" },
  kind:         { type: "string" },
  panels:       { type: "string" },
  approve:      { type: "boolean" },
  reject:       { type: "boolean" },
  reason:       { type: "string" },
  reviewer:     { type: "string" },
  list:         { type: "boolean" },
  "no-canvas-write": { type: "boolean" },
});

const projectId = args["project-id"] || (await readActiveProject());
const root = path.join(PAI_REPO_ROOT, "projects", projectId);

async function loadNodes() {
  const wf = JSON.parse(await fs.readFile(path.join(root, "workflow.json"), "utf8"));
  return wf.nodes ?? [];
}

/** One line per reference and where it stands. Cheap, and the thing to run
 *  before handing anything to a human. */
async function list() {
  const nodes = (await loadNodes()).filter((n) => n.type === "image_result");
  return nodes.map((n) => ({
    node_id: n.id,
    subtype: n.data?.subtype ?? null,
    verdict: n.data?.review?.verdict ?? "unreviewed",
    reviewer: n.data?.review?.reviewer ?? null,
    reason: n.data?.review?.reason ?? null,
    reviewed_at: n.data?.review?.at ?? null,
    safe_to_use: n.data?.review?.verdict === "approved",
  }));
}

if (args.list) {
  try {
    const rows = await list();
    emitSuccess({
      ok: true,
      project_id: projectId,
      references: rows,
      unreviewed: rows.filter((r) => r.verdict === "unreviewed").length,
      pending: rows.filter((r) => r.verdict === "pending").length,
      rejected: rows.filter((r) => r.verdict === "rejected").length,
    });
    process.exit(0);
  } catch (e) {
    emitFailure(classify(e), e.message);
    process.exit(1);
  }
}

if (!args["node-id"]) {
  emitFailure("bad_args", "--node-id is required (or --list)");
  process.exit(2);
}
if (args.approve && args.reject) {
  emitFailure("bad_args", "--approve and --reject are mutually exclusive");
  process.exit(2);
}
if (args.reject && !args.reason) {
  // A rejection without a reason tells the next run nothing, and the next run
  // is usually the same agent an hour later.
  emitFailure("bad_args", "--reject requires --reason: say what is wrong so the re-roll can fix it");
  process.exit(2);
}

const nodeId = args["node-id"];
const reviewer = args.reviewer || process.env.FILMHUT_REVIEWER || process.env.CLAUDE_AGENT_ID || "model";

async function writeReview(patchReview) {
  if (args["no-canvas-write"]) return { canvas_mutation_skipped: "--no-canvas-write" };
  return postMutation({
    op: "updateNode",
    payload: { id: nodeId, patch: { review: patchReview } },
    projectId,
    actor: "cli:review_reference",
  });
}

try {
  const nodes = await loadNodes();
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) {
    emitFailure("bad_args", `no such node: ${nodeId}`);
    process.exit(2);
  }
  if (node.type !== "image_result") {
    emitFailure("bad_args", `${nodeId} is ${node.type}; only image_result nodes are reviewed here`);
    process.exit(2);
  }

  // ---- verdict paths -------------------------------------------------
  if (args.approve || args.reject) {
    const prior = node.data?.review ?? null;

    // Approving something never inspected would defeat the point: the whole
    // value is that a human sees an asset only after a model has looked.
    if (args.approve && !prior?.inspected_at) {
      emitFailure(
        "bad_args",
        `${nodeId} has not been inspected. Run 'review_reference.js --node-id ${nodeId}' first, `
        + "look at the face strip it writes, then approve.",
      );
      process.exit(2);
    }
    // A mechanical fail is not a matter of opinion — the sheet did not come
    // back in the shape it was asked for.
    if (args.approve && prior?.machine_verdict === "fail") {
      const failed = (prior.checks ?? []).filter((c) => c.status === "fail").map((c) => c.id);
      emitFailure(
        "bad_args",
        `${nodeId} fails a mechanical check (${failed.join(", ")}) and cannot be approved. Re-roll the sheet.`,
      );
      process.exit(2);
    }

    const review = {
      ...(prior ?? {}),
      verdict: args.approve ? "approved" : "rejected",
      reviewer,
      at: isoNow(),
      ...(args.reason ? { reason: args.reason } : {}),
    };
    const mut = await writeReview(review);
    emitSuccess({
      ok: true,
      node_id: nodeId,
      verdict: review.verdict,
      reviewer,
      reason: review.reason ?? null,
      safe_to_use: review.verdict === "approved",
      ...(mut?.canvas_mutation_error ? { canvas_mutation_error: mut.canvas_mutation_error } : {}),
    });
    process.exit(0);
  }

  // ---- inspection path -----------------------------------------------
  const localPath = node.data?.local_path;
  if (!localPath) {
    emitFailure("bad_args", `${nodeId} has no local_path to inspect`);
    process.exit(2);
  }
  const imagePath = path.isAbsolute(localPath) ? localPath : path.join(root, localPath);
  await fs.access(imagePath);

  const kind = args.kind || (node.data?.subtype === "character" ? "character" : "item");
  if (!PANEL_ROLES[kind]) {
    emitFailure("bad_args", `--kind must be one of ${Object.keys(PANEL_ROLES).join(", ")}`);
    process.exit(2);
  }
  const panelCount = args.panels ? Number(args.panels) : 4;
  if (!Number.isInteger(panelCount) || panelCount < 1 || panelCount > 8) {
    emitFailure("bad_args", "--panels must be an integer 1-8");
    process.exit(2);
  }

  const outDir = path.join(root, "assets", "reviews", nodeId);
  const report = await inspectSheet({ imagePath, kind, panelCount, outDir });

  // A re-inspection refreshes the MACHINE checks. It must not quietly discard a
  // verdict someone recorded: an approval that silently decays to "pending" is
  // the same defect as a pending that reads as approved, just pointing the
  // other way. Re-running the checks is not new evidence about the image, which
  // has not changed.
  const priorVerdict = node.data?.review?.verdict;
  const keep = priorVerdict === "approved" || priorVerdict === "rejected";
  const review = {
    ...(keep ? node.data.review : {}),
    verdict: keep ? priorVerdict : "pending",
    inspected_at: isoNow(),
    machine_verdict: report.machine_verdict,
    checks: report.checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
    face_strip: path.relative(root, report.face_strip),
    panels: report.panels.map((p) => path.relative(root, p.path)),
    identity_checked: false,
  };
  const mut = await writeReview(review);

  emitSuccess({
    ok: true,
    node_id: nodeId,
    kind,
    verdict: review.verdict,
    ...report,
    // Said in the payload, not just in a doc, because the next reader is a
    // model deciding what to do with this JSON.
    next_step:
      `LOOK at ${path.relative(root, report.face_strip)} and the full sheet, then record a verdict: `
      + `review_reference.js --node-id ${nodeId} --approve`
      + `  (or --reject --reason "...")`,
    unchecked:
      "identity, per-view features and stray text are NOT machine-checkable here and remain open",
    safe_to_use: review.verdict === "approved",
    ...(mut?.canvas_mutation_error ? { canvas_mutation_error: mut.canvas_mutation_error } : {}),
  });
} catch (e) {
  emitFailure(classify(e), e.message);
  process.exit(1);
}
