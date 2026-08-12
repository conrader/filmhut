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
// Display-only estimates for the stage gate and auto-budget reservation.
// The clients fetch the exact figure from POST /api/v2/<resource>/price
// before every paid call, so these only need to be close and must never
// undershoot badly.
//
// The formulas below were fitted against the live /price endpoint
// (2026-08) rather than taken from the published pricing table, which
// implies a simple per-pixel rate. deAPI actually prices these routes
// AFFINELY — a fixed per-job base plus a marginal rate — so a
// proportional model overcharges short/small jobs badly (a linear fit
// put a 5s 720p clip at $0.33; it really costs $0.047).
//
// Nominal (pre-clamp) dimensions are used here, because a sync registry
// can't consult the model catalog. Models whose box is smaller bill
// less, so these read high — the safe direction for a spend gate.

function pixelsForTier(longSide, aspectRatio) {
  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(aspectRatio || "16:9").trim());
  const ratio = m ? Number(m[1]) / Number(m[2]) : 16 / 9;
  return ratio >= 1
    ? longSide * (longSide / ratio)
    : longSide * (longSide * ratio);
}

// Image standard tier. Measured on Flux1schnell:
//   $0.000922 base + px × (5.62e-10 + 2.78e-10 × steps), 4 steps default.
// Live checks: 1024x576 $0.00191, 2048x1152 $0.00487 (both within 0.1%).
function imageCostBySize(params = {}) {
  const size = String(params.image_size || params.imageSize || "2K").toLowerCase();
  const longSide = size === "1k" ? 1024 : size === "4k" ? 3840 : 2048;
  const px = pixelsForTier(longSide, params.aspect_ratio);
  return +(0.000922 + px * (5.62e-10 + 2.78e-10 * 4)).toFixed(4);
}

// Image pro tier. Measured on Flux_2_Klein_4B_BF16 (steps pinned at 4):
//   text-to-image  $0.001264 base + px × 2.296e-9  (1024x1024 → $0.00367)
//   ref/edit route flat $0.006588, independent of resolution
// Pro is the reference tier (character sheets, mosaics), so the estimate
// takes whichever route is dearer rather than assuming the ref-less one.
const IMAGE_EDIT_FLAT_USD = 0.0066;

function imageProCostBySize(params = {}) {
  const size = String(params.size || IMAGE_PRO_DEFAULT_SIZE);
  const [w, h] = size.split("x").map(Number);
  const px = Number.isFinite(w) && Number.isFinite(h)
    ? w * h
    : pixelsForTier(1024, "1:1");
  return +Math.max(0.001264 + px * 2.296e-9, IMAGE_EDIT_FLAT_USD).toFixed(4);
}

// Video tier. Measured on Ltx2_3_22B_Dist_INT8 at 24 fps:
//   $0.0388 base + px × frames × 1.159e-10 (linear in frames to <1%).
// The base dominates short clips — 1024x576 costs $0.042 at 2s and
// $0.055 at 10s — so duration moves the price far less than a
// per-second model implies.
function videoCostByResAndDuration(params = {}) {
  const res = String(params.resolution || "720p").toLowerCase();
  const dur = Number(params.duration) || 5;
  const [w, h] = res === "1080p" ? [1920, 1080] : res === "480p" ? [854, 480] : [1280, 720];
  const frames = Math.round(dur * 24);
  return +(0.0388 + w * h * frames * 1.159e-10).toFixed(4);
}

// Voice tier. Strictly linear per input character, no base fee, but the
// rate differs by an order of magnitude between models — measured
// exactly: Qwen3 TTS VoiceDesign $1.2857e-5/char ($12.86 per 1M), Kokoro
// $7.714e-7/char ($0.77 per 1M). The design model is the default, so
// price against it; DEAPI_TTS_MODEL=Kokoro is ~17× cheaper per character.
const VOICE_USD_PER_CHAR = 1.2857e-5;

function voiceCostByChars(params = {}) {
  const chars = typeof params.text_chars === "number"
    ? params.text_chars
    : (typeof params.text === "string" ? params.text.length : 0);
  return +(Math.max(chars, 1) * VOICE_USD_PER_CHAR).toFixed(6);
}

// ── Registry ────────────────────────────────────────────────────────

export const MODELS = [
  // ───────────── image (standard tier) ─────────────
  {
    id: "image-generation",
    provider: "deapi",
    kind: "image",
    deapi_slug: envSlug("DEAPI_IMAGE_MODEL", "Flux1schnell"),
    // Flux.2 Klein serves the ref/edit route on both tiers: it takes 3
    // input images where QwenImageEdit_Plus_NF4 takes 1, costs ~10× less,
    // and supports a custom output size. Set DEAPI_IMAGE_EDIT_MODEL to
    // QwenImageEdit_Plus_NF4 for precision single-ref instruction edits.
    deapi_edit_slug: envSlug("DEAPI_IMAGE_EDIT_MODEL", "Flux_2_Klein_4B_BF16"),
    label: "Image (deAPI Flux)",
    cost_approx_usd: imageCostBySize,
    capabilities: ["text-to-image", "image-to-image", "multi-ref"],
    default_params: { aspect_ratio: "16:9", image_size: "2K" },
    notes: "Async image generation via deAPI. Drafts, illustrative, stylized. Refs route to images/edits (≤3). ~10-60s.",
  },

  // ───────────── image (pro tier) ─────────────
  {
    id: "image-generation-pro",
    provider: "deapi",
    kind: "image_pro",
    deapi_slug: envSlug("DEAPI_IMAGE_PRO_MODEL", "Flux_2_Klein_4B_BF16"),
    deapi_edit_slug: envSlug("DEAPI_IMAGE_PRO_EDIT_MODEL", "Flux_2_Klein_4B_BF16"),
    label: "Image Pro (deAPI Flux.2 Klein)",
    cost_approx_usd: imageProCostBySize,
    capabilities: ["text-to-image", "image-to-image", "multi-ref"],
    default_params: { size: IMAGE_PRO_DEFAULT_SIZE, output_format: "png" },
    notes: "Async pro image generation/editing via deAPI. Up to 3 refs — the tier for character sheets and mosaics. ~30-90s.",
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
    // Qwen3 TTS VoiceDesign advertises supports_voice_design, so the
    // CLI's --prompt voice brief drives the voice exactly as it did on
    // the previous provider. DEAPI_TTS_MODEL=Kokoro switches to preset
    // voices (cheaper, 3-char minimum, no design brief).
    deapi_slug: envSlug("DEAPI_TTS_MODEL", "Qwen3_TTS_12Hz_1_7B_VoiceDesign"),
    label: "Voice (deAPI Qwen3 TTS VoiceDesign)",
    cost_approx_usd: voiceCostByChars,
    capabilities: ["tts", "voice-design"],
    default_params: {},
    notes: "Async TTS via deAPI. voice_design mode: --prompt is the voice brief. Min 10 chars of text. ~5-30s.",
  },

  // ───────────── music ─────────────
  {
    id: "music-generation",
    provider: "deapi",
    kind: "music",
    deapi_slug: envSlug("DEAPI_MUSIC_MODEL", "AceStep_1_5_Turbo"),
    label: "Music (deAPI AceStep)",
    cost_approx_usd: null, // quoted exactly via audio/music/price
    capabilities: ["music-generation"],
    default_params: {},
    notes: "Async music via deAPI. 10-300s in one call. guidance_scale must be <= 1 on AceStep.",
  },

  // ───────────── transcription ─────────────
  {
    id: "transcription",
    provider: "deapi",
    kind: "transcription",
    deapi_slug: envSlug("DEAPI_TRANSCRIBE_MODEL", "WhisperLargeV3Ct2"),
    label: "Transcription (deAPI Whisper)",
    cost_approx_usd: null, // priced by audio duration, quoted per call
    capabilities: ["transcription", "diarization"],
    default_params: {},
    hidden: true, // consumes an asset rather than producing a canvas card
    notes: "Async speech-to-text via deAPI. Timestamps + optional diarization. Input side of the pipeline.",
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
