// Enforcing that recurring subjects are anchored, not just documented.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { checkSubjectCoverage, mentions } from "../cli/_subject_guard.js";

const KEY = { name: "the brass telegraph key", kind: "item", aliases: ["telegraph key", "brass key"], node_id: "image_22" };
const approved = (id) => ({ id, type: "image_result", data: { review: { verdict: "approved" } } });
const pending = (id) => ({ id, type: "image_result", data: { review: { verdict: "pending" } } });

describe("matching a subject to prose", () => {
  test("the leading article is ignored — prompts do not repeat it", () => {
    assert.ok(mentions("his hand rests on the brass telegraph key", KEY));
  });

  test("aliases match, because a prompt shortens names", () => {
    assert.ok(mentions("he touches the brass key", KEY));
    assert.ok(mentions("a telegraph key on the desk", KEY));
  });

  test("MATCHING IS ON WORD BOUNDARIES", () => {
    // A guard that fires on "key" inside "monkey" or "keyboard" is a guard
    // somebody switches off within a day.
    const bare = { name: "key", aliases: [] };
    assert.ok(!mentions("she typed on the keyboard", bare));
    assert.ok(!mentions("a monkey in the corner", bare));
    assert.ok(mentions("the key turned", bare));
  });

  test("case and internal spacing do not matter", () => {
    assert.ok(mentions("THE BRASS   TELEGRAPH   KEY glints", KEY));
  });

  test("an unmentioned subject does not match", () => {
    assert.ok(!mentions("she walks up the hill road at dusk", KEY));
  });
});

describe("coverage", () => {
  test("a named subject with a reference that was not wired BLOCKS", () => {
    const r = checkSubjectCoverage({
      prompt: "his hand settles on the brass telegraph key",
      subjects: [KEY],
      refNodes: [approved("image_17")],
    });
    assert.match(r.blocked, /neither wired to this shot nor in its lineage/);
    assert.match(r.blocked, /--ref-source-id image_22/, "it must say exactly how to fix it");
    assert.match(r.blocked, /rebuild the anchor image/, "the video fix is different from the image fix");
  });

  test("A SUBJECT INHERITED THROUGH THE ANCHOR COUNTS AS COVERED", () => {
    // The bug this pins: demanding a prop's reference be passed to
    // generate_video would make that product shot the clip's LAST FRAME. Props
    // reach a clip through the anchor, and the anchor records what built it.
    const edges = [
      { from: "image_22", to: "image_24", kind: "derived" },  // key -> beat-3 anchor
      { from: "image_24", to: "image_29", kind: "derived" },  // beat-3 -> beat-6 anchor
    ];
    const r = checkSubjectCoverage({
      prompt: "his finger presses the knob of the brass telegraph key",
      subjects: [KEY],
      refNodes: [approved("image_29")],   // only the anchor is wired, two steps down
      edges,
    });
    assert.equal(r.blocked, null, "lineage is coverage");
    assert.equal(r.warning, null);
  });

  test("lineage does not invent coverage that is not there", () => {
    const edges = [{ from: "image_8", to: "image_29", kind: "derived" }];
    const r = checkSubjectCoverage({
      prompt: "his finger presses the knob of the brass telegraph key",
      subjects: [KEY],
      refNodes: [approved("image_29")],
      edges,
    });
    assert.match(r.blocked, /telegraph key/);
  });

  test("a cycle in the edges does not hang the walk", () => {
    const edges = [
      { from: "a", to: "b", kind: "derived" },
      { from: "b", to: "a", kind: "derived" },
    ];
    const r = checkSubjectCoverage({
      prompt: "the brass telegraph key",
      subjects: [KEY],
      refNodes: [approved("a")],
      edges,
    });
    assert.match(r.blocked, /telegraph key/);
  });

  test("a named subject with no reference at all BLOCKS, and names the command", () => {
    const r = checkSubjectCoverage({
      prompt: "she sets the folded telegram down",
      subjects: [{ name: "the telegram", kind: "item", aliases: ["telegram"], node_id: null }],
      refNodes: [],
    });
    assert.match(r.blocked, /no reference exists/);
    assert.match(r.blocked, /reference_sheet\.js --kind item/);
  });

  test("a named subject that IS wired and approved passes", () => {
    const r = checkSubjectCoverage({
      prompt: "his hand settles on the brass telegraph key",
      subjects: [KEY],
      refNodes: [approved("image_22"), approved("image_17")],
    });
    assert.equal(r.blocked, null);
    assert.equal(r.warning, null);
  });

  test("wired but unreviewed warns rather than blocks", () => {
    const r = checkSubjectCoverage({
      prompt: "the brass key on the desk",
      subjects: [KEY],
      refNodes: [pending("image_22")],
    });
    assert.equal(r.blocked, null, "it is anchored; review is a separate gate");
    assert.match(r.warning, /not reviewed/);
  });

  test("a subject the prompt never mentions is not required", () => {
    // Shot 1 is a woman on a hill road. Demanding the telegraph key there
    // would make the guard an obstacle rather than a check.
    const r = checkSubjectCoverage({
      prompt: "she climbs the rutted hill road at dusk, wind in her coat",
      subjects: [KEY],
      refNodes: [],
    });
    assert.equal(r.blocked, null);
    assert.deepEqual(r.missing, []);
  });

  test("an empty subject list blocks nothing — and that is the hazard", () => {
    // Declaring is the step being enforced elsewhere (subjects.js --audit
    // fails on an empty list). This function can only honour what it is told.
    const r = checkSubjectCoverage({ prompt: "anything at all", subjects: [], refNodes: [] });
    assert.equal(r.blocked, null);
  });

  test("several missing subjects are all reported, not just the first", () => {
    const r = checkSubjectCoverage({
      prompt: "the brass telegraph key beside the folded telegram",
      subjects: [KEY, { name: "the telegram", kind: "item", aliases: ["telegram"], node_id: null }],
      refNodes: [],
    });
    assert.equal(r.missing.length, 2);
    assert.match(r.blocked, /telegram/);
    assert.match(r.blocked, /telegraph key/);
  });
});
