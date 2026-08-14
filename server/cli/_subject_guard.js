// Guard: a declared subject that appears in a prompt must be anchored to an
// approved reference.
//
// Third sibling of _ref_guard.js and _review_guard.js, called from the same
// place — before staging, before any paid call.
//
// WHY DECLARATION RATHER THAN DETECTION
//
// The failure this exists for: a telegraph key sat on the desk in five of six
// shots of a finished piece with no reference behind it. Each prompt described
// it in prose and each shot invented it again. Nobody had enumerated the props,
// so nothing noticed.
//
// The tempting fix is to read the prompt and work out what is in the shot. That
// cannot be done reliably — a prompt is prose, and a guard that guesses wrong
// either blocks good work or misses the thing it was built for. So the subject
// list is DECLARED, by whoever is making the piece, and matching is literal.
// Declaring is the step being enforced; the guard only checks that what was
// declared is honoured.
//
// A subject with no declared name cannot be guarded, and that is honest: the
// tool cannot know a prop exists until someone says so. What it can guarantee
// is that nothing declared gets quietly skipped.

/** Leading articles carry no identity and stop a name matching prose. */
function coreName(name) {
  return String(name ?? "").trim().replace(/^(the|a|an)\s+/i, "").trim();
}

/**
 * Does `prompt` mention this subject?
 *
 * Whole-phrase, case-insensitive, on a word boundary. Deliberately strict:
 * a loose match ("key" inside "monkey", or inside "keyboard") would fire on
 * prose that has nothing to do with the prop, and a guard that cries wolf is a
 * guard that gets switched off.
 */
export function mentions(prompt, subject) {
  const text = String(prompt ?? "");
  const candidates = [coreName(subject?.name), ...(subject?.aliases ?? [])]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean);

  return candidates.some((phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(`(^|[^\\w])${escaped}([^\\w]|$)`, "i").test(text);
  });
}

/**
 * Every node this one descends from, following `derived` edges backwards.
 *
 * This is what makes the guard usable on VIDEO. A video's --ref-source-id is
 * its first or last FRAME, not a subject reference — the model takes those
 * images as literal frames. Demanding that a prop's reference be passed there
 * too would not anchor the prop, it would make it the closing frame of the
 * shot. The prop reaches a clip by being in the ANCHOR, and the anchor records
 * what it was built from. So: a subject counts as covered when its reference is
 * an ancestor of something wired, not only when it is wired itself.
 */
export function ancestorIds(edges = [], startIds = []) {
  const parents = new Map();
  for (const e of edges) {
    if (!e?.to || !e?.from) continue;
    if (!parents.has(e.to)) parents.set(e.to, []);
    parents.get(e.to).push(e.from);
  }
  const seen = new Set();
  const stack = [...startIds];
  while (stack.length) {
    const id = stack.pop();
    for (const p of parents.get(id) ?? []) {
      if (seen.has(p)) continue;   // also guards against a cycle
      seen.add(p);
      stack.push(p);
    }
  }
  return seen;
}

/**
 * @param prompt      the shot prompt
 * @param subjects    declared subjects: { name, kind, aliases?, node_id? }
 * @param refNodes    the image_result nodes wired as --ref-source-id
 * @param edges       canvas edges, so lineage counts as coverage (see above)
 * @returns { blocked: string|null, warning: string|null, missing: string[] }
 */
export function checkSubjectCoverage({ prompt, subjects = [], refNodes = [], edges = [] }) {
  const direct = refNodes.filter(Boolean).map((n) => n.id);
  const inherited = ancestorIds(edges, direct);
  const wiredIds = new Set([...direct, ...inherited]);
  // An inherited reference cannot be re-checked here (its node is not in
  // refNodes), so lineage coverage is taken as reviewed — it was reviewed when
  // the anchor that carries it was built.
  const approvedIds = new Set([
    ...refNodes.filter((n) => n?.data?.review?.verdict === "approved").map((n) => n.id),
    ...inherited,
  ]);

  const undeclared = [];   // named in the prompt, no reference made yet at all
  const unwired = [];      // reference exists but was not passed to this shot
  const unapproved = [];   // wired, but nobody has signed it off

  for (const s of subjects) {
    if (!mentions(prompt, s)) continue;
    if (!s.node_id) { undeclared.push(s); continue; }
    if (!wiredIds.has(s.node_id)) { unwired.push(s); continue; }
    if (!approvedIds.has(s.node_id)) unapproved.push(s);
  }

  const parts = [];
  if (undeclared.length) {
    parts.push(
      `no reference exists for ${undeclared.map((s) => `"${s.name}"`).join(", ")}. `
      + `Build one first: reference_sheet.js --kind ${undeclared[0].kind ?? "item"} `
      + `--name "${undeclared[0].name}"${(undeclared[0].kind ?? "item") === "item" ? " --single" : ""}`,
    );
  }
  if (unwired.length) {
    parts.push(
      `${unwired.map((s) => `"${s.name}" (${s.node_id})`).join(", ")} `
      + `${unwired.length === 1 ? "has a reference that is" : "have references that are"} neither wired to this shot nor in its lineage. `
      + `Either pass ${unwired.map((s) => `--ref-source-id ${s.node_id}`).join(" ")}, `
      + "or rebuild the anchor image with that reference so the shot inherits it",
    );
  }

  const blocked = parts.length
    ? `subject appears in the prompt without an anchored reference — ${parts.join("; ")}. `
      + "A prop drifts exactly like a face does. Pass --allow-unreferenced to override."
    : null;

  const warning = unapproved.length
    ? `${unapproved.map((s) => `"${s.name}" (${s.node_id})`).join(", ")} `
      + `${unapproved.length === 1 ? "is" : "are"} wired but not reviewed. `
      + "Run review_reference.js before this reaches anyone."
    : null;

  return {
    blocked,
    warning,
    missing: [...undeclared, ...unwired].map((s) => s.name),
  };
}
