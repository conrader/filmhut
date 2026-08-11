import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODELS,
  getCost,
  getDefault,
  getModel,
} from "../model_registry.js";

test("model registry exposes image-generation-pro without changing image default", () => {
  assert.equal(getDefault("image").id, "image-generation");
  assert.equal(getDefault("image_pro").id, "image-generation-pro");

  const pro = getModel("image-generation-pro");
  assert.ok(pro);
  assert.equal(pro.kind, "image_pro");
  assert.equal(pro.hidden, undefined);
  assert.ok(MODELS.some((m) => m.id === "image-generation-pro"));
});

test("model registry prices image pro by tier with the flat edit floor dominating small sizes", () => {
  // Small sizes (1024x1024) sit below the $0.0066 flat edit-path floor,
  // so the floor wins; only large sizes (3840x2160) price above it.
  assert.equal(getCost("image-generation-pro", { size: "1024x1024" }), 0.0066);
  assert.equal(getCost("image-generation-pro", { size: "3840x2160" }), 0.0203);
});

test("model registry keeps the image (standard) default on deAPI Flux1schnell", () => {
  const img = getModel("image-generation");
  assert.equal(img.id, "image-generation");
  assert.equal(img.provider, "deapi");
  assert.equal(img.deapi_slug, "Flux1schnell");
});

test("model registry points the upscale and video-generation-assets kinds at their deAPI entries", () => {
  assert.equal(getDefault("upscale").id, "video-upscale");
  const assets = getModel("video-generation-assets");
  assert.equal(getCost(assets), 0);
});
