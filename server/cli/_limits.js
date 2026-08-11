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
};

// image-generation (standard tier). The per-request ref cap is the edit
// model's max_input_images (checked live in the client); 16 is kept as
// the CLI-side sanity ceiling.
export const IMAGE_LIMITS     = { max_image_refs: 16, min_ref_image_dimension: 300 };
export const IMAGE_PRO_LIMITS = {
  max_image_refs: IMAGE_PRO_MAX_IMAGE_REFS,
  min_ref_image_dimension: 300,
  supported_sizes: IMAGE_PRO_SUPPORTED_SIZES,
};
export const VOICE_LIMITS     = {};                      // tts — no documented caps
