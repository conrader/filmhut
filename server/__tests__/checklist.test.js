// The reference checklist: does the project have the CATEGORIES a film needs,
// not merely "is what somebody happened to declare anchored?".

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { buildChecklist } from "../lib/checklist.js";

const sub = (name, kind, anchored = true) => ({
  name, kind, anchored, reason: anchored ? null : "no reference built yet",
});
const byId = (items, id) => items.find((i) => i.id === id);

describe("the checklist asks what a film needs, not what was declared", () => {
  test("A PROJECT WITH NO LOCATION FAILS, even with everything else anchored", () => {
    // This is the exact state a finished film shipped in: four subjects
    // declared, audit clean, and the set it was shot in never referenced once.
    // --audit passed it. This must not.
    const items = buildChecklist([
      sub("Elias Varde", "character"),
      sub("Marit Kall", "character"),
      sub("the brass telegraph key", "item"),
      sub("the telegram", "item"),
    ]);
    assert.equal(byId(items, "cast").status, "ok");
    assert.equal(byId(items, "props").status, "ok");
    assert.equal(byId(items, "locations").status, "fail");
    assert.match(byId(items, "locations").detail, /NO LOCATION DECLARED/);
    assert.match(byId(items, "locations").detail, /--kind location/, "it must name the fix");
  });

  test("a fully covered project passes every category", () => {
    const items = buildChecklist([
      sub("Sir Reginald", "creature"),
      sub("the house", "location"),
      sub("the vacuum cleaner", "item"),
    ]);
    assert.deepEqual(items.map((i) => i.status), ["ok", "ok", "ok"]);
  });

  test("a creature counts as cast — a dog is a character", () => {
    const items = buildChecklist([sub("Sir Reginald", "creature"), sub("the house", "location")]);
    assert.equal(byId(items, "cast").status, "ok");
    assert.equal(byId(items, "cast").declared, 1);
  });

  test("declared but UNANCHORED fails the category", () => {
    const items = buildChecklist([
      sub("Dermot", "character"),
      sub("the office", "location", false),
    ]);
    assert.equal(byId(items, "locations").status, "fail");
    assert.match(byId(items, "locations").detail, /no reference built yet/);
  });

  test("an empty project fails cast and locations", () => {
    const items = buildChecklist([]);
    assert.equal(byId(items, "cast").status, "fail");
    assert.equal(byId(items, "locations").status, "fail");
  });

  test("no props is UNCHECKED, not a pass and not a failure", () => {
    // A piece can legitimately have no recurring object, so this cannot fail —
    // but it must never read as a clean tick either, because "no props" is
    // also exactly what an un-enumerated project looks like.
    const items = buildChecklist([sub("Dermot", "character"), sub("the office", "location")]);
    const props = byId(items, "props");
    assert.equal(props.status, "unchecked");
    assert.notEqual(props.status, "ok");
    assert.match(props.detail, /Confirm nothing recurs/);
  });

  test("every item carries the question it is answering", () => {
    // The checklist is read by a model deciding what to do next; a bare
    // status is not actionable.
    for (const i of buildChecklist([])) {
      assert.ok(i.question && i.question.length > 20, `${i.id} needs a stated question`);
      assert.ok(i.detail, `${i.id} needs detail`);
    }
  });
});
