// Guard: refuse to spend on a clip anchored to a REJECTED reference.
//
// Sibling of _ref_guard.js, and called from the same place — before staging,
// before any paid call — so every agent and every script gets it without
// opting in.
//
// The asymmetry between blocking and warning is deliberate:
//
//   rejected   → BLOCK. Someone looked and said this is wrong. Spending on it
//                is spending money to reproduce a known defect.
//   pending /  → WARN. The reference may well be fine. Refusing here would
//   unreviewed   turn a nudge into an obstacle and get the guard switched off,
//                which is how safety rails die. Say it clearly and continue.
//
// Reviews live on the node as `data.review`, written by review_reference.js.

/**
 * @param nodes         image_result nodes for the ids being referenced
 * @returns { blocked: string|null, warning: string|null }
 */
export function checkRefsReviewed(nodes = []) {
  const rejected = [];
  const unreviewed = [];

  for (const n of nodes) {
    if (!n || n.type !== "image_result") continue;
    const verdict = n.data?.review?.verdict ?? "unreviewed";
    if (verdict === "rejected") {
      rejected.push({ id: n.id, reason: n.data?.review?.reason ?? "no reason recorded" });
    } else if (verdict !== "approved") {
      unreviewed.push({ id: n.id, verdict });
    }
  }

  const blocked = rejected.length
    ? `reference${rejected.length > 1 ? "s" : ""} rejected in review: `
      + rejected.map((r) => `${r.id} (${r.reason})`).join("; ")
      + ". Re-roll the sheet, or approve it explicitly if the rejection was wrong."
    : null;

  const warning = unreviewed.length
    ? `unreviewed reference${unreviewed.length > 1 ? "s" : ""}: `
      + unreviewed.map((u) => `${u.id} (${u.verdict})`).join(", ")
      + ". A defect in a reference is inherited by every clip anchored on it; "
      + "run review_reference.js --node-id <id> before showing any of this to a human."
    : null;

  return { blocked, warning };
}
