// Single source of truth for the models pai-pro uses, indexed by
// kind. Adding a model is one edit here; the provider clients import
// getDefault(kind) rather than inlining strings. The renderer reads
// MODELS as JSON via the viewer's GET /models route — adding a model
// auto-flows its label to canvas card chrome and the expand overlay,
// no separate UI edit.
//
// Every capability routes through the deAPI v2 media API
// (https://deapi.ai — see server/deapi_client.js). The `id` field stays
// a provider-neutral capability id (stamped onto canvas node
// metadata.model and referenced by skills/templates); the deAPI model
// slug actually sent on the wire lives in `deapi_slug` (and
// `deapi_edit_slug` for the ref-based edit route) and is overridable
// per-capability via env so accounts can pick different catalog models
// without a code edit.
//
// Schema per entry:
//   id              capability id (stable across providers). Stamped
//                   onto canvas node metadata.model.
//   provider        always "deapi" in this codebase.
//   kind            "image" | "image_pro" | "video" | "voice" | "asset"
//   deapi_slug      deAPI model slug for the primary route.
//   deapi_edit_slug deAPI model slug for the ref-based edit route
//                   (image kinds only).
//   label           human-readable name (UI-friendly).
//   cost_approx_usd number, function(params) -> number, or null when
//                   unknown. Display-only; the clients fetch the exact
//                   quote from deAPI's /price endpoints at call time.
//                   Used by the agent for stage-gate cost previews.
//   capabilities    tags for future routing / UI filters.
//   default_params  sane defaults (informational; CLI parseArgs owns
//                   runtime defaults).
//   notes           one-liner for humans skimming the file.
//   hidden          optional bool. true → omitted from GET /models
//                   so it doesn't render as a card.
//
// v1 invariant: exactly one model per kind. getDefault() looks it up
// directly.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import {
  IMAGE_PRO_DEFAULT_SIZE,
  imageProSizeTier,
} from "./image_pro_sizes.js";

// Load .env defensively. local_viewer.js calls config() after it has
// already imported this module (ES modules evaluate imports before the
// importer's body), so without this the env overrides below would be
// undefined when MODELS initializes. dotenv.config() does not overwrite
// already-set vars, so re-loading is safe.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, "..", ".env") });

function envSlug(name, fallback) {
  const v = String(process.env[name] ?? "").trim();
  return v || fallback;
}

// ── Cost functions ──────────────────────────────────────────────────
//
// deAPI prices dynamically per task (resolution × steps for images,
// pixels × frames for video, characters for TTS). The numbers below are
// display-only approximations anchored to live /price readings from the
// deAPI pricing table (2026-08); the clients quote the exact price via
// POST /api/v2/<resource>/price before every paid call.

// Image standard tier (Flux-class, 4 steps). Anchor: 1024x1024 ≈ $0.0027.
function imageCostBySize(params = {}) {
  const size = String(params.image_size || params.imageSize || "2K").toLowerCase();
  if (size === "1k") return 0.003;
  if (size === "2k") return 0.011;
  if (size === "4k") return 0.043;
  return 0.011; // 2K default
}

// Image pro tier. Ref-less pro runs price like the standard tier;
// ref-based edits are steps-driven and resolution-independent
// (QwenImageEdit_Plus_NF4 @ 40 steps ≈ $0.035). Show the edit-path
// ceiling so stage-gate previews don't undershoot.
function imageProCostBySize(params = {}) {
  const tier = imageProSizeTier(params.size || IMAGE_PRO_DEFAULT_SIZE);
  const base = tier === "1K" ? 0.003 : tier === "4K" ? 0.043 : 0.011;
  return Math.max(base, 0.035);
}

// Video tier (LTX-class). Anchor: 512x512 × 49 frames ≈ $0.038 →
// ~3.0e-9 USD per pixel-frame. Assumes 24 fps.
function videoCostByResAndDuration(params = {}) {
  const res = String(params.resolution || "720p").toLowerCase();
  const dur = Number(params.duration) || 5;
  const [w, h] = res === "1080p" ? [1920, 1080] : res === "480p" ? [854, 480] : [1280, 720];
  const frames = Math.round(dur * 24);
  return +(w * h * frames * 3.0e-9).toFixed(3);
}

// Voice tier. deAPI TTS is priced per input character (Kokoro ≈
// $0.77 per 1M chars; Qwen3 TTS models are in the same order of
// magnitude). Kept block-rounded so stage previews never show $0.00.
function voiceCostByChars(params = {}) {
  const chars = typeof params.text_chars === "number"
    ? params.text_chars
    : (typeof params.text === "string" ? params.text.length : 0);
  const usd = Math.max(chars, 1) * 0.77e-6;
  return +Math.max(usd, 0.0001).toFixed(4);
}

// ── Registry ────────────────────────────────────────────────────────

export const MODELS = [
  // ───────────── image (standard tier) ─────────────
  {
    id: "image-generation",
    provider: "deapi",
    kind: "image",
    deapi_slug: envSlug("DEAPI_IMAGE_MODEL", "Flux1schnell"),
    deapi_edit_slug: envSlug("DEAPI_IMAGE_EDIT_MODEL", "QwenImageEdit_Plus_NF4"),
    label: "Image (deAPI Flux / Qwen Edit)",
    cost_approx_usd: imageCostBySize,
    capabilities: ["text-to-image", "image-to-image", "multi-ref"],
    default_params: { aspect_ratio: "16:9", image_size: "2K" },
    notes: "Async image generation via deAPI. Drafts, illustrative, stylized. Refs route to images/edits. ~10-60s.",
  },

  // ───────────── image (pro tier) ─────────────
  {
    id: "image-generation-pro",
    provider: "deapi",
    kind: "image_pro",
    deapi_slug: envSlug("DEAPI_IMAGE_PRO_MODEL", "Flux_2_Klein_4B_BF16"),
    deapi_edit_slug: envSlug("DEAPI_IMAGE_PRO_EDIT_MODEL", "QwenImageEdit_Plus_NF4"),
    label: "Image Pro (deAPI Flux 2 / Qwen Edit)",
    cost_approx_usd: imageProCostBySize,
    capabilities: ["text-to-image", "image-to-image", "multi-ref"],
    default_params: { size: IMAGE_PRO_DEFAULT_SIZE, output_format: "png" },
    notes: "Async pro image generation/editing via deAPI. Edits run at the edit model's full default steps. ~1-4 min.",
  },

  // ───────────── video ─────────────
  {
    id: "video-generation",
    provider: "deapi",
    kind: "video",
    deapi_slug: envSlug("DEAPI_VIDEO_MODEL", "Ltx2_3_22B_Dist_INT8"),
    label: "Video (deAPI LTX-2)",
    cost_approx_usd: videoCostByResAndDuration,
    capabilities: ["text-to-video", "image-to-video", "audio-to-video"],
    default_params: { duration: 5, aspect_ratio: "16:9", resolution: "720p" },
    notes: "Async video via deAPI: text-to-video, first/last-frame animation, or audio-sync. No video refs. ~2-8 min.",
  },

  // ───────────── voice ─────────────
  {
    id: "tts",
    provider: "deapi",
    kind: "voice",
    deapi_slug: envSlug("DEAPI_TTS_MODEL", "Kokoro"),
    label: "Voice (deAPI TTS)",
    cost_approx_usd: voiceCostByChars,
    capabilities: ["tts", "voice-design"],
    default_params: {},
    notes: "Async TTS via deAPI. voice_design mode when the model supports it, preset voices otherwise. ~5-30s.",
  },

  // ───────────── video upscale ─────────────
  {
    id: "video-upscale",
    provider: "deapi",
    kind: "upscale",
    deapi_slug: envSlug("DEAPI_UPSCALE_MODEL", "FlashVSR_Tiny"),
    label: "Upscaler (deAPI FlashVSR)",
    cost_approx_usd: null, // quoted exactly via videos/upscales/price
    capabilities: ["video-upscale"],
    default_params: {},
    notes: "Async video upscaling via deAPI. Cost quoted per call; scales linearly with duration. Hidden from cards.",
    hidden: true,
  },

  // ───────────── asset preupload (retired with the PAI provider) ─────────────
  {
    id: "video-generation-assets",
    provider: "deapi",
    kind: "asset",
    label: "Asset preupload (retired)",
    cost_approx_usd: 0,
    capabilities: ["asset-upload"],
    default_params: {},
    notes: "deAPI takes refs as direct multipart uploads — no preupload step, no cost. Kept so getCost callers stay valid.",
    hidden: true,
  },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));
const BY_KIND = new Map(MODELS.map((m) => [m.kind, m]));

export function getModel(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Resolve the default model for a capability.
 *
 * The optional second arg is accepted but ignored — v1 has exactly one
 * provider per kind. Single-arg form is preferred: getDefault("image").
 */
export function getDefault(kind, _provider) {
  const m = BY_KIND.get(kind);
  if (!m) {
    throw new Error(`model_registry: no model registered for kind="${kind}"`);
  }
  return m;
}

export function getModelsByKind(kind) {
  return MODELS.filter((m) => m.kind === kind);
}

export function getCost(modelOrId, params = {}) {
  const m = typeof modelOrId === "string" ? getModel(modelOrId) : modelOrId;
  if (!m) return null;
  const c = m.cost_approx_usd;
  if (typeof c === "function") return c(params);
  return typeof c === "number" ? c : null;
}
