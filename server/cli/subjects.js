#!/usr/bin/env node
// The cast and props list: everything that recurs, and whether it is anchored.
//
//   node subjects.js --declare --name "the brass telegraph key" --kind item \
//     --alias "telegraph key" --alias "brass key"
//   node subjects.js --list
//   node subjects.js --audit          # exit 1 if anything recurring is unanchored
//   node subjects.js --link --name "the brass telegraph key" --node-id image_22
//
// WHY THIS EXISTS
//
// A finished piece shipped with its hero prop — a telegraph key, in five of six
// shots — never once drawn. Each prompt described it in prose and each shot
// invented it again. The reference tool existed and went unused, because
// nothing in the process ever asked "what recurs here?".
//
// This is that question, made into a file. Declaring a subject costs nothing
// and no generation; it is a list. What it buys is that _subject_guard.js can
// then refuse to render a shot whose prompt names something unanchored, and
// that --audit can fail a run before any money is spent rather than after.
//
// Characters were never the gap — a face is obviously a character and gets a
// sheet. Objects are the gap, because a prop reads as scenery until the third
// shot, by which point it has been three different objects.

import path from "node:path";
import fs from "node:fs/promises";

import { parseArgs, emitSuccess, emitFailure, classify, isoNow, PAI_REPO_ROOT } from "./_cli.js";
import { readActiveProject } from "../local_mirror.js";

const args = parseArgs({
  declare:      { type: "boolean" },
  link:         { type: "boolean" },
  forget:       { type: "boolean" },
  list:         { type: "boolean" },
  audit:        { type: "boolean" },
  name:         { type: "string" },
  kind:         { type: "string" },
  alias:        { type: "string", multiple: true },
  "node-id":    { type: "string" },
  "project-id": { type: "string" },
});

const projectId = args["project-id"] || (await readActiveProject());
const root = path.join(PAI_REPO_ROOT, "projects", projectId);
const FILE = path.join(root, "subjects.json");

async function load() {
  try {
    const doc = JSON.parse(await fs.readFile(FILE, "utf8"));
    return Array.isArray(doc?.subjects) ? doc.subjects : [];
  } catch {
    return [];
  }
}

async function save(subjects) {
  await fs.writeFile(FILE, `${JSON.stringify({ version: 1, subjects }, null, 2)}\n`, "utf8");
}

async function loadNodes() {
  try {
    const wf = JSON.parse(await fs.readFile(path.join(root, "workflow.json"), "utf8"));
    return wf.nodes ?? [];
  } catch {
    return [];
  }
}

/** Subjects joined to their reference node's review verdict. */
async function resolved() {
  const [subjects, nodes] = await Promise.all([load(), loadNodes()]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return subjects.map((s) => {
    const node = s.node_id ? byId.get(s.node_id) : null;
    const verdict = node?.data?.review?.verdict ?? (s.node_id ? "unreviewed" : "none");
    return {
      ...s,
      verdict,
      anchored: verdict === "approved",
      // Said explicitly so a caller cannot read "has a node_id" as "is usable".
      reason: !s.node_id ? "no reference built yet"
        : verdict === "approved" ? null
        : `reference ${s.node_id} is ${verdict}`,
    };
  });
}

const key = (s) => String(s ?? "").trim().toLowerCase();

try {
  if (args.declare || args.link || args.forget) {
    if (!args.name) {
      emitFailure("bad_args", "--name is required");
      process.exit(2);
    }
    const subjects = await load();
    const i = subjects.findIndex((s) => key(s.name) === key(args.name));

    if (args.forget) {
      if (i === -1) {
        emitFailure("not_found", `no declared subject named "${args.name}"`);
        process.exit(2);
      }
      subjects.splice(i, 1);
      await save(subjects);
      emitSuccess({ ok: true, forgot: args.name, subjects: subjects.length });
      process.exit(0);
    }

    if (args.link && !args["node-id"]) {
      emitFailure("bad_args", "--link requires --node-id");
      process.exit(2);
    }

    const aliases = Array.isArray(args.alias) ? args.alias : args.alias ? [args.alias] : [];
    const entry = {
      name: args.name,
      kind: args.kind ?? (i >= 0 ? subjects[i].kind : "item"),
      aliases: aliases.length ? aliases : (i >= 0 ? subjects[i].aliases ?? [] : []),
      node_id: args["node-id"] ?? (i >= 0 ? subjects[i].node_id ?? null : null),
      declared_at: i >= 0 ? subjects[i].declared_at : isoNow(),
    };
    if (i >= 0) subjects[i] = entry; else subjects.push(entry);
    await save(subjects);
    emitSuccess({ ok: true, subject: entry, subjects: subjects.length });
    process.exit(0);
  }

  const rows = await resolved();

  if (args.audit) {
    const unanchored = rows.filter((r) => !r.anchored);
    emitSuccess({
      ok: unanchored.length === 0,
      project_id: projectId,
      declared: rows.length,
      anchored: rows.length - unanchored.length,
      unanchored: unanchored.map((r) => ({ name: r.name, kind: r.kind, reason: r.reason })),
      ...(rows.length === 0
        ? { note: "nothing declared. An empty list is not a clean audit — it means nobody has said what recurs." }
        : {}),
      ...(unanchored.length
        ? { next_step: `reference_sheet.js --kind ${unanchored[0].kind} --name "${unanchored[0].name}"${unanchored[0].kind === "item" ? " --single" : ""}` }
        : {}),
    });
    // Non-zero so this can gate a run before anything is spent. An empty list
    // is also a failure: it is the state the telegraph key was lost in.
    process.exit(unanchored.length === 0 && rows.length > 0 ? 0 : 1);
  }

  emitSuccess({ ok: true, project_id: projectId, subjects: rows });
} catch (e) {
  emitFailure(classify(e), e.message);
  process.exit(1);
}
