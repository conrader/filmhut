// Provider hard caps surfaced in CLI failure JSON (`limits` field).
// Agents compare against `sent` to recover.

import {
  IMAGE_PRO_MAX_IMAGE_REFS,
  IMAGE_PRO_SUPPORTED_SIZES,
} from "../image_pro_sizes.js";

export const VIDEO_LIMITS = {
  // video-generation via deAPI:
  //  - Image refs map to first_frame_image + optional last_frame_image
  //    (the latter only on models advertising supports_last_frame) → max 2.
  //  - One audio ref routes the request to videos/audio-syncs.
  //  - Video refs are not accepted by deAPI's video endpoints at all.
  //  - Uploaded files: images ≤10MB, audio ≤20MB (MP3/OGG for audio-syncs).
  max_image_refs: 2,
  max_audio_refs: 1,
  max_video_refs: 0,
  max_image_ref_mb: 10,
  max_audio_ref_mb: 20,
  // Frame budget, not a time budget: the default model tops out at 241
  // frames @ 24fps. Longer requests are clamped, not rejected — the
  // result reports the effective duration and a `note`.
  max_duration_sec: 10,
};

// Image tiers. The AUTHORITATIVE per-request ref cap is the configured
// edit model's `max_input_images`, read from the live catalog and
// enforced in the client — the failure message names the real number.
// The value below is what agents see in a failure banner, so it tracks
// the default edit model (Flux_2_Klein_4B_BF16, 3 refs) rather than the
// larger CLI-side sanity ceiling: quoting 16 here would send an agent
// into a retry loop that the provider rejects every time.
const DEFAULT_EDIT_MODEL_MAX_REFS = 3;

export const IMAGE_LIMITS     = {
  max_image_refs: DEFAULT_EDIT_MODEL_MAX_REFS,
  min_ref_image_dimension: 300,
};
export const IMAGE_PRO_LIMITS = {
  max_image_refs: DEFAULT_EDIT_MODEL_MAX_REFS,
  max_image_refs_ceiling: IMAGE_PRO_MAX_IMAGE_REFS,
  min_ref_image_dimension: 300,
  supported_sizes: IMAGE_PRO_SUPPORTED_SIZES,
};
export const VOICE_LIMITS     = {
  // Model-specific; the design model requires at least 10 characters.
  min_text_chars: 10,
  max_text_chars: 5000,
};
