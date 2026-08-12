<div align="center">

# filmhut

**A local-first AI filmmaking studio, running on decentralised GPU compute.**

Canvas · timeline · agent terminal — with every media capability served by [deAPI](https://deapi.ai) instead of a single vendor's hosted API.

</div>

---

# 🔑 Setup: get your API key

**filmhut ships with no API key. You bring your own.** It takes about two minutes, and new accounts get **$5 free** — enough for roughly 90 ten-second clips or several hundred images.

### Step 1 — Create a deAPI account

Go to **[app.deapi.ai](https://app.deapi.ai)** and sign up. The $5 credit is applied automatically.

### Step 2 — Create the key

Open **[Dashboard → API keys](https://app.deapi.ai/dashboard/api-keys)** and click **Create key**.

Your key looks like this — an id, a pipe character, then the secret:

```
12345|AbCdEf0123456789abcdef0123456789abcdef01
```

⚠️ **Copy it right away.** deAPI shows the secret **only once**. If you lose it, delete the key and make a new one.

### Step 3 — Put it in `.env`

```bash
cp .env.example .env
```

Open `.env` and set your key — **with quotes around it**:

```bash
DEAPI_KEY='12345|AbCdEf0123456789abcdef0123456789abcdef01'
```

> ### ⚠️ The quotes are required
> deAPI keys contain a `|`. `scripts/start.sh` reads `.env` as a shell file, and **unquoted, the shell treats that pipe as a command** — the app dies at boot with a confusing `command not found`.
>
> ✅ `DEAPI_KEY='12345|AbCdEf…'` &nbsp;&nbsp; ❌ `DEAPI_KEY=12345|AbCdEf…`

### Step 4 — Check it works (free)

```bash
node scripts/deapi-doctor.mjs
```

This costs nothing. It confirms your key authenticates, prints your balance, lists the models your account can actually see, checks each configured model supports the job it will be given, and quotes live prices. **If something is wrong later, run this first.**

```
✓ key authenticates — balance $5.0000
✓ catalog reachable — 25 models visible to this key
✓ Flux1schnell — text-to-image
✓ Ltx2_3_22B_Dist_INT8 — text-to-video
✓ preflight clean — the media CLIs should work against this account.
```

### Step 5 — Start it

```bash
./scripts/start.sh          # then open http://localhost:7443
```

### Keeping the key safe

- `.env` is listed in `.gitignore` — **leave it there**. Never commit it.
- Never paste a key into an issue, a PR, or a screenshot.
- A key is a **live billing credential**. If one leaks, revoke it in the dashboard immediately.
- Top up and watch spend at [app.deapi.ai/dashboard](https://app.deapi.ai/dashboard).

### If it doesn't work

| Symptom | Cause | Fix |
|---|---|---|
| `command not found` at boot | key not quoted in `.env` | wrap the value in `'single quotes'` |
| `DEAPI_KEY not set in env` | no `.env`, or the line is blank | `cp .env.example .env` and fill it in |
| `deAPI 401 (auth): Unauthenticated` | key wrong, revoked, or partly copied | make a fresh key; copy the **whole** string including the `12345|` prefix |
| `deAPI 402` / balance $0 | out of credit | top up on the dashboard |
| `model "X" not in this account's catalog` | that model isn't on your account | run `deapi-doctor.mjs` to see yours, then set the matching `DEAPI_*_MODEL` in `.env` |

---

## What this is

filmhut is a derivative of [**Utopai-Research/pai-pro**](https://github.com/Utopai-Research/pai-pro). The canvas, timeline, project model, embedded agent terminal, and filmmaking skills are upstream's work. The change here is the **compute supplier**: every image, video, voice, music, and upscale call now goes to deAPI's open-model fleet rather than the PAI hosted service.

The upstream README is preserved verbatim at [`docs/UPSTREAM_README.md`](docs/UPSTREAM_README.md).

**Why swap it.** deAPI runs open models (FLUX, LTX-2, Qwen, Whisper, AceStep) on a decentralised GPU network, priced per task. For this workload it lands roughly 10–30× cheaper than the hosted alternative, and every model is selectable — you are not locked to one vendor's opinion of "the video model". The trade is a smaller reference budget and a lower resolution ceiling; both are documented honestly below.

> **Licence:** upstream ships under the PAI PRO Sustainable Use License — *not* open source. It permits internal business, research, and personal use, and **forbids commercial use and commercial derivative works**, singling out the Skills. Distributing it publicly free of charge for non-commercial use is permitted; selling it or building a commercial product on it is not. See [LICENSE.md](LICENSE.md); the Utopai Studios notices must stay intact.

---

## Continuity across clips

Holding a character's face, a hero prop, a location, a visual style, and a sound bed steady across
twenty shots is the hard part of AI filmmaking, and it is not something a prompt does for you. The
`continuity-compose` skill makes it recorded state instead: write the constraints down once, hand
them to each clip, and check what lands against what was promised.

It ships with the repo — `skills/continuity-compose/` — and installs with every other skill through
`./scripts/setup`. There is nothing separate to fetch.

**The production packet.** Before generating a sequence, the agent writes four plain-text files
under `projects/<active>/production/`:

| File | Holds |
|---|---|
| `brief.md` | premise, format, duration, narrative spine, visual and audio approach |
| `bibles.md` | one section per character, prop, location, style, and audio motif, each with a stable ID |
| `shot-ledger.md` | the ordered clip list and the authoritative continuity state of each clip |
| `reference-plan.md` | which asset anchors what, its provenance, and the clips it serves |

Every clip then carries a contract: what must be true in its first readable moment, and what it
promises the next cut. Recurring elements get stable IDs (`CHAR-MARA-01`, `PROP-COMPASS-01`) used
verbatim in every contract, with locked traits separated from state that legitimately changes.

**Inspect, classify, repair the smallest unit.** After a clip lands and passes the per-asset prompt
alignment check, it is compared against its neighbours and its anchors — never from memory. Breaks
are classified as `identity`, `prop`, `location_style`, `seam`, or `audio`, and the verdict is
recorded on the node. Clips that pass are **frozen**; only the failed clip is regenerated, reusing
its approved inputs and changing only what the classified break points at. The replacement is
re-checked against both adjacent contracts.

Generated media is probabilistic and inspection is partly subjective, so this raises consistency —
it does **not** guarantee it. When two repairs fail, the skill says what the models will not hold
and offers a story or edit compromise rather than spending again.

**Why the packet is plain text.** It is not tied to one agent's memory or one runtime. Codex, other
coding agents, and cloud runners can read the same files, and the constraints survive a lost session
or a change of tool. That is a portability promise about the production context, not a claim that
every agent is embedded in filmhut or supports the same commands. Give any remote runner only the
project access it needs, and keep deAPI keys out of prompts, ledgers, logs, and shared assets.

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
