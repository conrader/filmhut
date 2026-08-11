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

test("model registry prices image pro by tier with the edit-path floor dominating 1K/2K", () => {
  // 1K/2K base (0.003 / 0.011) sit below the QwenImageEdit_Plus_NF4
  // edit-path ceiling (0.035), so the floor wins on both tiers; only 4K
  // (0.043) prices above the floor.
  assert.equal(getCost("image-generation-pro", { size: "1024x1024" }), 0.035);
  assert.equal(getCost("image-generation-pro", { size: "3840x2160" }), 0.043);
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
