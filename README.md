<div align="center">

# filmhut

**A local-first AI filmmaking studio, running on decentralised GPU compute.**

Canvas · timeline · agent terminal — with every media capability served by [deAPI](https://deapi.ai) instead of a single vendor's hosted API.

</div>

---

## What this is

filmhut is a private derivative of [**Utopai-Research/pai-pro**](https://github.com/Utopai-Research/pai-pro). The canvas, timeline, project model, embedded agent terminal, and filmmaking skills are upstream's work. The change here is the **compute supplier**: every image, video, voice, music, and upscale call now goes to deAPI's open-model fleet rather than the PAI hosted service.

The upstream README is preserved verbatim at [`docs/UPSTREAM_README.md`](docs/UPSTREAM_README.md).

**Why swap it.** deAPI runs open models (FLUX, LTX-2, Qwen, Whisper, AceStep) on a decentralised GPU network, priced per task. For this workload it lands roughly 10–30× cheaper than the hosted alternative, and every model is selectable — you are not locked to one vendor's opinion of "the video model". The trade is a smaller reference budget and a lower resolution ceiling; both are documented honestly below.

> **Licence:** upstream ships under the PAI PRO Sustainable Use License — *not* open source. It permits internal business, research, and personal use, and **forbids commercial use and commercial derivative works**, singling out the Skills. That is why this repo is private. See [LICENSE.md](LICENSE.md); the Utopai Studios notices must stay intact.

---

## Get your deAPI key

You bring your own key — **no key ships with this repo**, and none ever should.

1. Sign up at **[app.deapi.ai](https://app.deapi.ai)**. New accounts get **$5 in free credits**, which is enough for roughly 90 ten-second clips or several hundred images.
2. Go to **[Dashboard → API keys](https://app.deapi.ai/dashboard/api-keys)** and create a key. It looks like `12345|AbCdEf0123…` — an id, a pipe, then the secret.
3. Copy it now: deAPI shows the secret **once**.
4. Put it in your local `.env`:

```bash
cp .env.example .env
```

```bash
# .env  — QUOTE THE VALUE
DEAPI_KEY='12345|AbCdEf0123…'
```

> **The quotes are load-bearing.** deAPI keys contain a `|`, and `scripts/start.sh` sources `.env` as a shell file — unquoted, the shell reads that pipe as a pipeline and the boot dies with `command not found`. Single quotes fix it, and the dotenv parser strips them, so both readers agree.

`.env` is in `.gitignore` and must stay there. Never commit a key, never paste one into an issue, and if one leaks, revoke it in the dashboard immediately — it is a live billing credential. Top up or watch spend on the same dashboard.

## Quick start

```bash
node scripts/deapi-doctor.mjs # free preflight: key, balance, models, live prices
./scripts/start.sh            # http://localhost:7443
```

`deapi-doctor.mjs` costs nothing and tells you immediately whether the key works, what it can see, and what a call will cost. Run it before anything else.

**No tunnel required.** Upstream needed a Cloudflare tunnel so the provider could fetch reference files over a public URL. deAPI takes references as direct multipart uploads, so generation works with no tunnel at all.

**Reaching it from another machine:** `PAI_BIND_HOST=100.x.y.z ./scripts/start.sh` binds the viewer and web UI to that address (e.g. a Tailscale IP). It defaults to `127.0.0.1` on purpose — **the viewer's routes are unauthenticated and its terminal spawns an agent with permission prompts bypassed**, so never bind `0.0.0.0` on a box with a public IP.

---

## The compute layer

One key (`DEAPI_KEY`) covers every capability. All generation is asynchronous: submit → poll `GET /api/v2/jobs/{id}` → download a presigned result URL.

| Capability | deAPI endpoint | Client |
|---|---|---|
| Image | `POST /api/v2/images/generations` | `server/pai_image_client.js` |
| Image with references | `POST /api/v2/images/edits` (multipart) | same |
| Text-to-video | `POST /api/v2/videos/generations` | `server/pai_video_client.js` |
| Image-to-video | `POST /api/v2/videos/animations` (multipart) | same |
| Audio-conditioned video | `POST /api/v2/videos/audio-syncs` (multipart) | same |
| Voice | `POST /api/v2/audio/speech` (multipart) | `server/pai_voice_client.js` |
| Video upscale | `POST /api/v2/videos/upscales` (multipart) | `server/pai_upscale_client.js` |

Shared HTTP, retry policy, error classification, job polling, catalogue reads, and price quoting live in [`server/deapi_client.js`](server/deapi_client.js). The `pai_*_client.js` filenames were kept deliberately so the diff against upstream stays small — they speak deAPI now.

**Every paid call is quoted first.** Each client fetches the exact price from `/price` before submitting and reports it back as `cost_usd`, so what you see is what you were charged — not an estimate.

---

## Video models

The catalogue is **account-scoped**: two keys can legitimately see different models. `deapi-doctor.mjs` prints yours. Pick one per capability with the `DEAPI_*_MODEL` env vars in `.env`.

| Model | Max resolution | Clip length | Routes | Notes |
|---|---|---|---|---|
| **`Ltx2_3_22B_Dist_INT8`** (default) | 1024×1024 | 49–241 frames @ 24fps → **2.0–10.0s** | text, image, **audio** | Generates a native **audio track**. Only model supporting audio-conditioned (lip-synced) video. Supports a last frame. |
| **`Ltxv_13B_0_9_8_Distilled_FP8`** | 768×768 | 30–120 frames @ 30fps → **1.0–4.0s** | text, image | **~8.6× cheaper.** 1 inference step. No audio track, no audio-sync. Supports a last frame. |
| `Wan2_2_Animate_14B_INT8` | 852×852 | ≤8s input | character replace | Swaps a person in existing footage for a reference character. Not wired into a CLI yet. |

**Clip length is a frame budget, not a time budget.** 241 frames at a fixed 24fps is a hard 10.04s ceiling on the default model — asking for more clamps, and the CLI reports the effective duration plus a `note`. For longer scenes, chain clips: extract the last frame and use it as the next clip's opening frame.

**References are frames, not identity anchors.** A video reference image becomes the clip's literal **first frame** (a second becomes the last frame) — max 2, plus at most 1 audio reference. It is *not* a character-identity anchor. To hold a character across many shots, build a character sheet once and compose every scene's opening frame from it with the image-edit model, then animate that frame.

### Upscalers

| Model | Input cap | Scale | 10s of 1024×576 |
|---|---|---|---|
| `RealESRGAN_Vid_x2` | 1024×1024, ≤30s | fixed 2× | **$0.014** |
| `RealESRGAN_Vid_x4` | 1024×1024, ≤15s | fixed 4× | — |
| `FlashVSR_Tiny` (default) | 1024×1024, ≤10s | 2–4× | $0.074 (2×) / $0.297 (4×) |

`upscaler.js` targets 4K, so on FlashVSR it selects 4× and costs ~$0.30 per 10s clip. `RealESRGAN_Vid_x2` is ~5× cheaper for a 2× pass.

---

## Image, voice, and music models

| Capability | Model | Notes |
|---|---|---|
| Image (default) | `Flux1schnell` | 2048² max, 1–10 steps. Fast drafts. |
| Image | `ZImageTurbo_INT8` | 2048² max, 1–50 steps — more steps, more detail. |
| Image | `ZAnimeDistill_8Step_INT8` | 2048² max. Anime/stylised. |
| Refs / edit (default) | `Flux_2_Klein_4B_BF16` | 1536² max, steps pinned at 4, **3 reference images**, custom output size. |
| Refs / edit | `QwenImageEdit_Plus_NF4` | 1024² max, 1–50 steps, **1 reference only**, and **no custom output size** — output inherits the reference's dimensions. Markedly more photoreal at 40 steps. |
| Voice (default) | `Qwen3_TTS_12Hz_1_7B_VoiceDesign` | Voice **design**: the CLI's `--prompt` describes the voice. Min 10 chars. |
| Voice | `Kokoro` | Preset voices, ~17× cheaper per character, ignores the design brief. |
| Voice | `Qwen3_TTS_12Hz_1_7B_Base` | Voice **cloning** from 5–15s of reference audio. |
| Music | `AceStep_1_5_Turbo` | 10–300s in one call. `guidance_scale` must be **≤1**. |
| Transcription | `WhisperLargeV3Ct2` | Timestamps + diarization. |

---

## What it costs

Every figure below was read from deAPI's live `/price` endpoint (August 2026), not from a rate card.

### Video

| Model | Shot | Price |
|---|---|---|
| Ltx2 | 1024×576, 2.0s | $0.0422 |
| Ltx2 | 1024×576, 5.0s | $0.0470 |
| Ltx2 | 1024×576, **10.0s** | **$0.0553** |
| Ltx2 | 1024×1024, 10.0s | $0.0611 |
| Ltxv | 768×432, 4.0s | **$0.0064** |
| Ltxv | 512×288, 4.0s | $0.0041 |

**Video pricing is affine, not proportional** — a fixed ~$0.039 base per job plus ~$1.16e-10 per pixel-frame. A 2s clip costs $0.042 and a 10s clip $0.055, so **short clips are terrible value**. Prefer fewer, longer takes. A per-second mental model will overestimate long clips by up to 7×.

### Image, voice, music

| Call | Price |
|---|---|
| Flux1schnell 1024×576, 4 steps | $0.0019 |
| Flux1schnell 2048×1152, 4 steps | $0.0049 |
| Flux.2 Klein 1280×720, 4 steps | $0.0034 |
| ZImageTurbo 1024×576, 8 steps | $0.0063 |
| Flux.2 Klein **edit** (up to 3 refs) | $0.0066 — flat, any resolution |
| Qwen **edit**, 20 / 40 steps | $0.0179 / $0.0348 — flat, any resolution |
| Voice-design TTS, 500 chars | $0.0064 ($12.86 / 1M chars) |
| Kokoro TTS, 500 chars | $0.0004 ($0.77 / 1M chars) |
| Music, 185s | $0.0020 |
| Transcription, 10 min | $0.0128 |

Image generation scales with pixels × steps. **Edits are flat-rate and resolution-independent** — driven only by step count.

### Worked examples

| Piece | Build | Cost |
|---|---|---|
| One 6s establishing shot (frame + clip) | Flux1schnell + Ltx2 | **$0.051** |
| 30s, 4 shots, no dialogue | 4 frames + 4 clips | **$0.213** |
| 3 min, 18 shots, 2 characters, lip-synced dialogue + score | 18 Qwen composes + 14 voice lines + 18 audio-sync clips + music | **≈ $2.40** |
| 60 min on Ltx2 (359 shots) | the same recipe, scaled | **≈ $22.80** |
| 60 min on Ltxv (900 × 4s shots) | 768×432, no native audio | **≈ $8.00** |

Long-form is where model choice dominates: switching the video model turns an hour of footage from $23 into $8, at 768×432 with no audio track and a 4s clip ceiling.

---

## Model selection

All optional; these are the built-in defaults. Discover what your key can see with `deapi-doctor.mjs`.

```bash
DEAPI_IMAGE_MODEL=Flux1schnell
DEAPI_IMAGE_EDIT_MODEL=Flux_2_Klein_4B_BF16
DEAPI_IMAGE_PRO_MODEL=Flux_2_Klein_4B_BF16
DEAPI_IMAGE_PRO_EDIT_MODEL=Flux_2_Klein_4B_BF16
DEAPI_VIDEO_MODEL=Ltx2_3_22B_Dist_INT8
DEAPI_TTS_MODEL=Qwen3_TTS_12Hz_1_7B_VoiceDesign
DEAPI_UPSCALE_MODEL=FlashVSR_Tiny
```

`model_registry.js` keeps provider-neutral capability ids (`image-generation`, `video-generation`, `tts`) for canvas metadata, so changing a slug doesn't rewrite your project history.

---

## Preflight

`node scripts/deapi-doctor.mjs` is free and read-only. It verifies the key authenticates, reports your balance, walks the paginated catalogue, checks that **every configured slug actually supports the inference type it will be called with**, prints each model's real limits, and quotes a representative price per capability. Run it first whenever something misbehaves.

---

## Known limits

- **10.04s** maximum clip on the default model; chain clips for longer scenes.
- **2 image references** per clip (first + last frame), **1 audio reference**. Video-as-reference is not supported at all — extract a frame instead.
- **1024×576** effective video resolution; upscale afterwards if you need more.
- Reference images ≤10MB, audio ≤20MB, video ≤50MB per request.
- The catalogue is account-scoped and changes; never hardcode a slug.

## Documentation quirks worth knowing

Found the hard way, against the live API:

- `/price` validates `prompt`, `seed`, and `mode` — not merely the cost-driving fields the docs describe. Quote with the body you intend to submit.
- Pricing is **affine**, not the proportional model the public rate card implies.
- `guidance_scale` must be **≤1** on the AceStep music models.
- `scale` is **required** on upscalers exposing a min/max range, and **rejected** on fixed-factor ones.
- Models declaring `supports_custom_output_size: false` reject `width`/`height` outright and size from the input image.
- `Ltx2` reports `supports_steps: false` yet requires `steps ≥ 8`. `info.limits` is authoritative; `features` flags are advisory.

## Credits

Built on [pai-pro](https://github.com/Utopai-Research/pai-pro) by [Utopai Studios](https://www.utopaistudios.com/). Compute by [deAPI](https://deapi.ai).
