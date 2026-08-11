#!/usr/bin/env node
// Preflight for the deAPI media layer. Read-only and free — it never
// submits a generation.
//
//   node scripts/deapi-doctor.mjs
//
// Checks, in order:
//   1. DEAPI_KEY is set and authenticates (GET /api/v2/account/balance).
//   2. The account's model catalog is reachable and fully paged.
//   3. Every configured slug (model_registry.js + DEAPI_*_MODEL overrides)
//      exists in THIS account's catalog and advertises the inference type
//      the client will call it with.
//   4. A price quote for a representative call of each capability, so the
//      real per-call cost is visible before committing to the provider.
//
// Exits 0 when every check passes, 1 otherwise. Every failure names the
// env var to change.

import { MODELS, getDefault } from "../server/model_registry.js";
import { listModels, getJson, quotePrice, deapiBaseUrl } from "../server/deapi_client.js";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const ok = (m) => console.log(`${GREEN}✓${RESET} ${m}`);
const bad = (m) => console.log(`${RED}✗${RESET} ${m}`);
const warn = (m) => console.log(`${YELLOW}!${RESET} ${m}`);
const dim = (m) => console.log(`${DIM}  ${m}${RESET}`);

let failures = 0;

// Which deAPI inference types each capability's routes require. The
// primary slug must cover the primary route; the edit slug covers refs.
const REQUIREMENTS = [
  { kind: "image",     field: "deapi_slug",          env: "DEAPI_IMAGE_MODEL",          needs: "txt2img",  what: "text-to-image" },
  { kind: "image",     field: "deapi_edit_slug",     env: "DEAPI_IMAGE_EDIT_MODEL",     needs: "img2img",  what: "image refs (images/edits)" },
  { kind: "image_pro", field: "deapi_slug",          env: "DEAPI_IMAGE_PRO_MODEL",      needs: "txt2img",  what: "pro text-to-image" },
  { kind: "image_pro", field: "deapi_edit_slug",     env: "DEAPI_IMAGE_PRO_EDIT_MODEL", needs: "img2img",  what: "pro image refs" },
  { kind: "video",     field: "deapi_slug",          env: "DEAPI_VIDEO_MODEL",          needs: "txt2video", what: "text-to-video" },
  { kind: "video",     field: "deapi_slug",          env: "DEAPI_VIDEO_MODEL",          needs: "img2video", what: "image-to-video (first/last frame)", optional: true },
  { kind: "video",     field: "deapi_slug",          env: "DEAPI_VIDEO_MODEL",          needs: "audio2video", what: "audio-conditioned video", optional: true },
  { kind: "voice",     field: "deapi_slug",          env: "DEAPI_TTS_MODEL",            needs: "txt2audio", what: "text-to-speech" },
  { kind: "upscale",   field: "deapi_slug",          env: "DEAPI_UPSCALE_MODEL",        needs: "vid-upscale", what: "video upscaling" },
];

console.log(`\ndeAPI preflight — ${deapiBaseUrl()}\n`);

// ── 1. Auth + balance ───────────────────────────────────────────────
if (!process.env.DEAPI_KEY) {
  bad("DEAPI_KEY is not set. Add it to .env (get one at https://app.deapi.ai/dashboard/api-keys).");
  process.exit(1);
}
let balance = null;
try {
  const body = await getJson({ path: "account/balance", logTag: "doctor" });
  balance = Number(body?.data?.balance);
  ok(`key authenticates — balance $${Number.isFinite(balance) ? balance.toFixed(4) : "?"}`);
  if (Number.isFinite(balance) && balance <= 0) {
    warn("balance is zero — generations will fail until you top up.");
  }
} catch (e) {
  bad(`auth failed (${e.klass}): ${e.message}`);
  process.exit(1);
}

// ── 2. Catalog ──────────────────────────────────────────────────────
let catalog = [];
try {
  catalog = await listModels({ logTag: "doctor" });
  ok(`catalog reachable — ${catalog.length} models visible to this key`);
} catch (e) {
  bad(`could not read the model catalog (${e.klass}): ${e.message}`);
  process.exit(1);
}
const bySlug = new Map(catalog.map((m) => [m.slug, m]));

// ── 3. Configured slugs ─────────────────────────────────────────────
console.log("\nconfigured models:");
const seen = new Set();
for (const req of REQUIREMENTS) {
  let entry;
  try {
    entry = getDefault(req.kind);
  } catch {
    bad(`no registry entry for kind "${req.kind}"`);
    failures++;
    continue;
  }
  const slug = entry[req.field];
  if (!slug) {
    if (!req.optional) { bad(`${req.kind}.${req.field} is unset (set ${req.env})`); failures++; }
    continue;
  }
  const model = bySlug.get(slug);
  const key = `${slug}::${req.needs}`;
  if (seen.has(key)) continue;
  seen.add(key);

  if (!model) {
    bad(`${slug} (${req.what}) is NOT in this account's catalog — set ${req.env} to a visible slug`);
    failures++;
    continue;
  }
  const types = Array.isArray(model.inference_types) ? model.inference_types : [];
  if (!types.includes(req.needs)) {
    const msg = `${slug} does not advertise ${req.needs} — ${req.what} will fail`;
    if (req.optional) {
      warn(`${msg} (optional; other routes still work)`);
    } else {
      bad(`${msg}. Set ${req.env} to a model with ${req.needs}.`);
      failures++;
    }
    continue;
  }
  ok(`${slug} — ${req.what}`);
  const lim = model?.info?.limits ?? {};
  const notable = [
    lim.max_width ? `max ${lim.max_width}x${lim.max_height}` : null,
    lim.resolution_step ? `grid ${lim.resolution_step}px` : null,
    lim.min_steps != null ? `steps ${lim.min_steps}-${lim.max_steps}` : null,
    lim.min_frames != null ? `frames ${lim.min_frames}-${lim.max_frames}` : null,
    lim.min_fps != null ? `fps ${lim.min_fps}-${lim.max_fps}` : null,
    lim.max_input_images != null ? `max ${lim.max_input_images} ref img` : null,
    lim.min_scale != null ? `scale ${lim.min_scale}-${lim.max_scale}` : "",
    lim.max_video_duration_seconds != null ? `≤${lim.max_video_duration_seconds}s in` : null,
    lim.min_text != null ? `text ${lim.min_text}-${lim.max_text}` : null,
  ].filter(Boolean);
  if (notable.length) dim(notable.join(" · "));
}

// ── 4. Representative price quotes ──────────────────────────────────
console.log("\nlive price quotes (what a typical call actually costs):");
const imageSlug = getDefault("image").deapi_slug;
const editSlug = getDefault("image").deapi_edit_slug;
const videoSlug = getDefault("video").deapi_slug;
const ttsSlug = getDefault("voice").deapi_slug;
const upscaleSlug = getDefault("upscale").deapi_slug;

const QUOTES = [
  { label: "image 2K (2048x1152, 4 steps)", path: "images/generations", body: { model: imageSlug, width: 2048, height: 1152, steps: 4 } },
  { label: "image edit (1 ref, 20 steps)",  path: "images/edits",       body: { model: editSlug, width: 1024, height: 1024, steps: 20 } },
  { label: "video 720p 5s (1312x736@24)",   path: "videos/generations", body: { model: videoSlug, width: 1312, height: 736, steps: 8, frames: 120, fps: 24 } },
  { label: "voice 500 chars",               path: "audio/speech",       body: { model: ttsSlug, count_text: 500, speed: 1, lang: "en-us", format: "mp3", sample_rate: 24000 } },
  { label: "upscale 1280x720 5s",           path: "videos/upscales",    body: { model: upscaleSlug, width: 1280, height: 720, duration: 5 } },
];

for (const q of QUOTES) {
  try {
    const price = await quotePrice({ path: q.path, body: q.body, logTag: "doctor" });
    ok(`${q.label.padEnd(32)} $${price.toFixed(6)}`);
  } catch (e) {
    // A quote failure is informative, not fatal — /price validation
    // differs per model and some params only matter to the real call.
    warn(`${q.label.padEnd(32)} quote failed (${e.klass}): ${e.message.slice(0, 120)}`);
  }
}

console.log("");
if (failures > 0) {
  bad(`${failures} blocking problem(s) — fix the named env vars before generating.`);
  process.exit(1);
}
ok("preflight clean — the media CLIs should work against this account.");
