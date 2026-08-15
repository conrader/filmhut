// The pre-production checklist: which CATEGORIES of reference a project needs.
//
// Separate from subjects.js so it can be tested without running a CLI that
// exits on import.

export /**
 * The pre-production checklist: not "is what you declared anchored?" but
 * "have you declared the things every film has?".
 *
 * --audit answers the first question and passes a project that declared one
 * character and forgot the set. That is not hypothetical: a finished film
 * declared four subjects, passed its audit clean, and had NO LOCATION
 * REFERENCE AT ALL. The hut it was shot in stayed consistent only because two
 * later anchors happened to be built from an earlier one.
 *
 * So the categories are fixed, and their absence is the finding. A film has
 * someone or something in it and happens somewhere; a project claiming
 * otherwise is far more likely to have skipped the step than to be the
 * exception.
 */
function buildChecklist(rows) {
  const of = (...kinds) => rows.filter((r) => kinds.includes(r.kind));
  const cast = of("character", "creature");
  const places = of("location");
  const props = of("item");

  const items = [
    {
      id: "cast",
      question: "Every person or animal that appears in more than one shot has a reference.",
      declared: cast.length,
      anchored: cast.filter((r) => r.anchored).length,
      status: cast.length === 0 ? "fail" : cast.every((r) => r.anchored) ? "ok" : "fail",
      detail: cast.length === 0
        ? "nothing declared. A film with no cast reference has either no recurring subject or an undeclared one."
        : cast.map((r) => `${r.name}: ${r.anchored ? "anchored" : r.reason}`).join("; "),
    },
    {
      id: "locations",
      question: "Every place a scene is set in has a reference.",
      declared: places.length,
      anchored: places.filter((r) => r.anchored).length,
      status: places.length === 0 ? "fail" : places.every((r) => r.anchored) ? "ok" : "fail",
      detail: places.length === 0
        ? "NO LOCATION DECLARED. Every film happens somewhere, and a set drifts exactly as a face does — "
          + "the same room returning with a different window, a different floor, the door on the other wall. "
          + "reference_sheet.js --kind location"
        : places.map((r) => `${r.name}: ${r.anchored ? "anchored" : r.reason}`).join("; "),
    },
    {
      id: "props",
      question: "Every object handled or seen in more than one shot has a reference.",
      declared: props.length,
      anchored: props.filter((r) => r.anchored).length,
      // Props are the one category a piece can legitimately lack, so an empty
      // list is a prompt rather than a failure — but never a silent pass.
      status: props.length === 0 ? "unchecked" : props.every((r) => r.anchored) ? "ok" : "fail",
      detail: props.length === 0
        ? "none declared. Confirm nothing recurs — a hero prop reads as scenery until the third shot, "
          + "by which point it has been three different objects. reference_sheet.js --kind item --single"
        : props.map((r) => `${r.name}: ${r.anchored ? "anchored" : r.reason}`).join("; "),
    },
  ];

  return items;
}
