#!/usr/bin/env node
// Compare the registry's cost estimates against deAPI's live /price endpoint.
//
//   npm run price-check
//
// The offline counterpart is __tests__/pricing_calibration.test.js, which pins
// the quotes as literals so the build never depends on the network. This script
// is what you run to find out those literals have gone stale.
//
// Exits non-zero if any route drifts past the tolerance, so it can sit in a
// scheduled job. Needs DEAPI_KEY.

import { quotePrice } from "../deapi_client.js";
import { getCost, getDefault } from "../model_registry.js";

const TOLERANCE = 0.05; // 5% — estimates are for the stage gate, not invoicing

const ROUTES = [
  {
    label: "video H3 2.33s",
    quote: () => q("videos/generations", vid(56)),
    estimate: () => getCost(getDefault("video").id, { duration: 2.33 }),
  },
  {
    label: "video H3 10.13s",
    quote: () => q("videos/generations", vid(243)),
    estimate: () => getCost(getDefault("video").id, { duration: 10.13 }),
  },
  {
    label: "image 1K 16:9",
    quote: () => q("images/generations", img(1024, 576)),
    estimate: () => getCost(getDefault("image").id, { image_size: "1K", aspect_ratio: "16:9" }),
  },
  {
    label: "image 2K 16:9",
    quote: () => q("images/generations", img(2048, 1152)),
    estimate: () => getCost(getDefault("image").id, { image_size: "2K", aspect_ratio: "16:9" }),
  },
  {
    // The EDIT route on purpose. The pro estimator returns whichever of
    // text-to-image and ref/edit is dearer, because pro is the reference tier
    // and most pro calls carry refs. Comparing it against the text-to-image
    // quote reports drift that is really just that deliberate conservatism.
    label: "image pro (edit route)",
    quote: () => q("images/edits", { ...img(1536, 1440), model: getDefault("image_pro").deapi_slug }),
    estimate: () => getCost(getDefault("image_pro").id, { size: "1536x1440" }),
  },
  {
    label: "voice 1000 chars",
    quote: async () => {
      const { getModelEntry } = await import("../deapi_client.js");
      const slug = getDefault("voice").deapi_slug;
      const entry = await getModelEntry(slug);
      return q("audio/speech", {
        model: slug,
        text: "a".repeat(1000),
        lang: entry?.languages?.[0]?.slug || "en-us",
        speed: 1,
        format: "mp3",
        sample_rate: 24000,
        mode: "voice_design",
        voice_description: "a calm older man",
      });
    },
    estimate: () => getCost(getDefault("voice").id, { text_chars: 1000 }),
  },
];

const q = (path, body) => quotePrice({ path, body });
const vid = (frames) => ({
  model: getDefault("video").deapi_slug,
  prompt: "a lighthouse", width: 1344, height: 768, frames, fps: 24, steps: 8, guidance: 3, seed: -1,
});
const img = (width, height) => ({
  model: getDefault("image").deapi_slug, prompt: "a lighthouse", width, height, steps: 4, seed: -1,
});

let drifted = 0;
console.log("route                      estimate       live      drift");
for (const r of ROUTES) {
  try {
    const live = await r.quote();
    const est = r.estimate();
    const drift = live > 0 ? (est - live) / live : 0;
    const bad = Math.abs(drift) > TOLERANCE;
    if (bad) drifted += 1;
    console.log(
      r.label.padEnd(24),
      est.toFixed(6).padStart(10),
      live.toFixed(6).padStart(11),
      `${(drift * 100).toFixed(1)}%`.padStart(8),
      bad ? "  DRIFTED" : "",
    );
  } catch (e) {
    drifted += 1;
    console.log(r.label.padEnd(24), `  ERROR ${e.message.slice(0, 70)}`);
  }
}

if (drifted > 0) {
  console.error(
    `\n${drifted} route(s) drifted past ${TOLERANCE * 100}%. `
    + "Re-fit the constants in model_registry.js and update the literals in "
    + "__tests__/pricing_calibration.test.js.",
  );
  process.exit(1);
}
console.log("\nall routes within tolerance");
