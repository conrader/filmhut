#!/usr/bin/env node
// What has this project cost?
//
// Reads the canvas first, because a node now records what it paid. Falls back
// to the `.results/` sidecars for nodes generated before that was true, and
// says so — a total that silently omits older work is worse than one that
// explains its own gaps.
//
//   node project_spend.js            summary
//   node project_spend.js --by-node  every paid node, newest first

import fs from "node:fs";
import path from "node:path";
import { parseArgs, emitSuccess, emitFailure } from "./_cli.js";

const args = parseArgs({
  "by-node": { type: "boolean" },
  "project-id": { type: "string" },
});

const cwd = process.cwd();

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const workflow = readJson(path.join(cwd, "workflow.json"));
if (!workflow) {
  emitFailure("bad_args", `no workflow.json in ${cwd} — run this from a project directory`);
  process.exit(2);
}

const KIND = {
  image_result: "image",
  video_result: "video",
  audio_result: "audio",
  note: "note",
};

const rows = [];
let fromNodes = 0;

for (const n of workflow.nodes ?? []) {
  const meta = n.data?.metadata ?? {};
  const cost = typeof meta.cost_usd === "number" ? meta.cost_usd : null;
  if (cost === null) continue;
  fromNodes += 1;
  rows.push({
    node_id: n.id,
    kind: KIND[n.type] ?? n.type,
    model: meta.model ?? null,
    cost_usd: cost,
    at: meta.generated_at ?? meta.transcribed_at ?? null,
    // A retired take still cost money; report it rather than hide it.
    in_reel: typeof n.data?.shot_id === "number" ? n.data.shot_id : null,
  });
}

// Older nodes carry no cost, so recover what we can from the durable results.
const resultsDir = path.join(cwd, ".results");
const seen = new Set(rows.map((r) => r.node_id));
let fromSidecars = 0;
let orphanedCost = 0;

if (fs.existsSync(resultsDir)) {
  for (const f of fs.readdirSync(resultsDir)) {
    if (!f.endsWith(".json")) continue;
    const d = readJson(path.join(resultsDir, f));
    const cost = typeof d?.cost_usd === "number" ? d.cost_usd : null;
    if (cost === null) continue;
    const nodeId = d.canvas_mutation?.node_id ?? d.node_id ?? null;
    if (nodeId && seen.has(nodeId)) continue; // already counted from the node
    fromSidecars += 1;
    orphanedCost += cost;
    rows.push({
      node_id: nodeId,
      kind: d.kind ?? "unknown",
      model: d.model ?? null,
      cost_usd: cost,
      at: d.completed_at ?? null,
      in_reel: null,
      source: "sidecar",
    });
  }
}

rows.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));

const byKind = {};
for (const r of rows) {
  byKind[r.kind] = byKind[r.kind] ?? { calls: 0, usd: 0 };
  byKind[r.kind].calls += 1;
  byKind[r.kind].usd += r.cost_usd;
}
for (const k of Object.keys(byKind)) byKind[k].usd = round(byKind[k].usd);

const total = round(rows.reduce((n, r) => n + r.cost_usd, 0));
const inReel = round(rows.filter((r) => r.in_reel !== null).reduce((n, r) => n + r.cost_usd, 0));

emitSuccess({
  ok: true,
  project: workflow.workflow_id ?? path.basename(cwd),
  total_usd: total,
  // What the delivered cut cost, as opposed to everything tried along the way.
  in_reel_usd: inReel,
  discarded_usd: round(total - inReel),
  paid_calls: rows.length,
  by_kind: byKind,
  sources: { nodes: fromNodes, sidecars: fromSidecars },
  ...(fromSidecars > 0
    ? { note: `${fromSidecars} call(s) predate on-node cost recording and were recovered from .results (${round(orphanedCost)} USD)` }
    : {}),
  ...(args["by-node"] ? { rows } : {}),
});

function round(n) {
  return Math.round(n * 10000) / 10000;
}
