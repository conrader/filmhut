// Cost estimates against deAPI's real quotes.
//
// These numbers were read off the live /price endpoint on 2026-08-14 and are
// pinned here as literals. The point is not to re-derive them — it is that when
// deAPI moves its prices again, a test says so instead of the stage gate
// quietly quoting last year's figures.
//
// It has already happened once: every route in this registry was found to be
// EXACTLY 1.800× above the live quote — image, image-pro, video, and both TTS
// models alike. A uniform factor across unrelated routes is a supplier price
// change, not measurement drift, and nothing in the code would have noticed.
//
// Offline by design: no network here, so a deAPI outage cannot fail the build.
// `npm run price-check` is the online counterpart.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { getCost, getDefault } from "../model_registry.js";

/** Live /price quotes, 2026-08-14. */
const QUOTES = {
  video_h3: [
    { duration: 2.33, usd: 0.0506343 },
    { duration: 5.17, usd: 0.0815803 },
    { duration: 8.33, usd: 0.1086802 },
    { duration: 10.13, usd: 0.1221508 },
  ],
  image: [
    { image_size: "1K", aspect_ratio: "16:9", usd: 0.0010607 },
    { image_size: "2K", aspect_ratio: "16:9", usd: 0.0027065 },
  ],
  voice: [
    { chars: 200, usd: 0.00142857 },
    { chars: 1000, usd: 0.00714286 },
  ],
};

const near = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: estimate ${a}, live quote ${b}`);

describe("video pricing tracks the model that is actually default", () => {
  test("H3 is the default video model", () => {
    assert.match(getDefault("video").deapi_slug, /^MiniMaxH3/);
  });

  test("estimates match H3's live quotes across its whole range", () => {
    // The bug this pins: the default moved to H3 while the cost curve stayed
    // Ltx2's affine one, which reads a 10s clip at $0.055 against a real
    // $0.122 — less than half, in the direction that under-reserves budget.
    for (const { duration, usd } of QUOTES.video_h3) {
      near(getCost(getDefault("video").id, { duration, resolution: "720p" }), usd, 0.0002,
        `H3 ${duration}s`);
    }
  });

  test("resolution does not move the H3 price, because its dimensions are pinned", () => {
    const at = (resolution) => getCost(getDefault("video").id, { duration: 10.13, resolution });
    assert.equal(at("480p"), at("720p"));
    assert.equal(at("720p"), at("1080p"));
  });

  test("length is sublinear — four times longer is not four times dearer", () => {
    const short = getCost(getDefault("video").id, { duration: 2.33 });
    const long = getCost(getDefault("video").id, { duration: 10.13 });
    const ratio = long / short;
    assert.ok(ratio > 2 && ratio < 3, `expected ~2.4x for 4.3x the length, got ${ratio.toFixed(2)}x`);
  });

  test("duration is clamped to the frame budget rather than extrapolated", () => {
    // 60s is not purchasable on H3; quoting it as if it were invites a plan
    // built on a clip that cannot exist.
    assert.equal(
      getCost(getDefault("video").id, { duration: 60 }),
      getCost(getDefault("video").id, { duration: 10.13 }),
    );
  });
});

describe("the other estimates match their live quotes", () => {
  test("standard image", () => {
    for (const { usd, ...params } of QUOTES.image) {
      near(getCost(getDefault("image").id, params), usd, 0.0002, `image ${params.image_size}`);
    }
  });

  test("a 4K request is priced at the 2048 it will actually be clamped to", () => {
    // deAPI refuses width > 2048 on this route, so the client clamps. Pricing
    // the request at 3840 would overstate it by ~3.5x.
    const fourK = getCost(getDefault("image").id, { image_size: "4K", aspect_ratio: "16:9" });
    const twoK = getCost(getDefault("image").id, { image_size: "2K", aspect_ratio: "16:9" });
    assert.equal(fourK, twoK);
  });

  test("voice, per character", () => {
    for (const { chars, usd } of QUOTES.voice) {
      near(getCost(getDefault("voice").id, { text_chars: chars }), usd, 0.00002, `voice ${chars} chars`);
    }
  });

  test("pro image, both routes", () => {
    // Text-to-image at 1024x1024, and the flat ref/edit rate.
    near(getCost(getDefault("image_pro").id, { size: "1024x1024" }), 0.00366, 0.0002, "pro 1024 (edit floor)");
    near(getCost(getDefault("image_pro").id, { size: "1536x1440" }), 0.0035237, 0.0002, "pro 1536x1440");
  });
});
