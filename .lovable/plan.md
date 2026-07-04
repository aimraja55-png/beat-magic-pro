## Project Aethel-Infinity — Realistic Implementation Plan

आपकी सारी माँगें ब्राउज़र की असली सीमाओं में मैप करके नीचे दे रहा हूँ। जो चीज़ें ब्राउज़र में सच में possible हैं वो सब एक साथ लागू होंगी। जो शब्द marketing-level हैं (जैसे "50 trillion power", "quantum RAM") उनके पीछे का असली intent — यानी *तेज़, smooth, non-hanging, cinematic* — पूरा करूँगा।

---

### 1. Performance Core (RAM + GPU + Threads)

- **Zero-copy pipeline**: `<canvas>` को `OffscreenCanvas` में shift करेंगे और drawing को dedicated Web Worker में ले जाएँगे → main thread free, UI कभी नहीं अटकेगी।
- **GPU-accelerated compositing**: सारे transforms `transform: translate3d/scale3d` + `will-change` + `filter` पर, ताकि browser GPU layer use करे।
- **Image decode ahead-of-time**: सारी photos को render से पहले `createImageBitmap()` से decode करेंगे (main thread block नहीं होगा)।
- **Memory hygiene**: हर render के बाद bitmaps `.close()`, blob URLs revoke, AudioContext close — इससे heat/hang नहीं होगा।
- **Adaptive quality**: device की `hardwareConcurrency` + `deviceMemory` देखकर auto: high-end → 1080p@60fps, low-end → 720p@30fps (कोई crash नहीं)।

### 2. Infinite Visual Effects Library

- Current `stylePack` को expand करके एक **procedural effect engine** बनाएँगे:
  - Base motions: kenburns, punchIn, orbit, dolly, whipPan, handheld, parallax3D, tilt-shift, dutch-angle, spiralZoom (10+)
  - Entries: irisIn, blurIn, spinIn, slide (4 dir), glitchIn, chromaSplit, lightLeak, filmBurn, particleWipe (10+)
  - Exits: matching set (10+)
  - Grades: warm, cool, noir, sepia, teal-orange, bleach, neon, VHS (8)
  - Overlays: bokeh, grain, dust, lens-flare, RGB-split, vignette
- Randomizer seeded per-render, **no transition repeats within last 4 cuts** → हर video unique।
- **Fake 3D parallax**: single photo को foreground/background में separate करने के लिए edge-detect + radial mask (cheap approximation of "smart masking") — पूरा AI segmentation ब्राउज़र में real-time भारी होता है, यह visually 90% वैसा दिखता है बिना lag के।

### 3. Neural Beat-Sync (already partly done — deepen it)

- Bass intensity → effect **strength scalar** (अभी fixed था, अब continuous 0–1 mapping)।
- Soft passage detect (low RMS + low bass for >2s) → auto-switch to smooth ease-in-out kenburns, कोई cut नहीं।
- Heavy bass drop → pulse + zoom-punch + screen-shake।
- Hi-hat density → micro-cuts frequency auto-tune।

### 4. Zero-Friction UX

- Empty slot पर tap → सीधे native file picker खुलेगा (कोई gallery half-screen नहीं)।
- Picked photo → slot में smooth scale-in animation (200ms) से "teleport" जैसा feel।
- Filled slot पर tap → replace/remove menu।
- Slots के नीचे सिर्फ: audio picker, render button, quality toggle। बस।

### 5. Payment Popups (exact spec)

- **State 1 — Welcome popup**: app open के 60 सेकंड बाद, once/day।
  - Title: "अपने वीडियो को प्रोफेशनल बनाएं!"
  - Message + 3 checkmarks (no watermark / ad-free / unlimited)
  - CTA: "अभी Pro बनें (₹99/महीना)" → UPI link
  - Close (X)
- **State 2 — Limit popup**: free user के 10th video complete होते ही।
  - Title: "आज की लिमिट खत्म!"
  - Ads + Watermark icons visible
  - Same CTA + "कल फिर 10 free credits" line
  - Close (X)
- Free daily limit **5 → 10** (आपकी नई spec के हिसाब से)।
- Pro price **₹49 → ₹99/month** update।
- Pro state 30-दिन तक `localStorage` में, expiry पर auto free mode।

### 6. Rendering Stability

- 60fps lock रहेगा; अगर device drop करे तो auto 30fps fallback (crash से बेहतर)।
- MP4 (mp4-muxer) primary, WebM fallback, duration-fix दोनों में।
- Progress bar smooth interpolation — कोई 70% पर freeze नहीं।

---

### Technical Section (dev-facing)

- **File**: पूरा काम `src/routes/index.tsx` में + नया `src/workers/renderCompositor.worker.ts` (OffscreenCanvas drawing loop)।
- **Deps**: कुछ new चाहिए नहीं (mp4-muxer, fix-webm-duration पहले से हैं)।
- **Architecture**:
  ```
  Main thread          Worker (OffscreenCanvas)      Encoder Worker
  --------------       ------------------------      ---------------
  UI + file pick  -->  ImageBitmap decode       -->  MediaRecorder
  Audio analysis  -->  Draw frames @ 60fps      -->  MP4 mux + duration fix
  Progress UI    <--   postMessage(progress)    <--  Blob out
  ```
- **Effect engine**: pure functions `(t, intensity, seed) => {transform, filter, overlay}` — deterministic, testable, infinite combos.
- **No breaking changes** to payment/session/watermark logic beyond price + limit constants.

---

### Out of scope (browser reality check)

- "Suspend background OS processes" — browser tab यह नहीं कर सकता; adaptive quality यही role निभाएगा।
- "Real-time neural segmentation" of every pixel — MediaPipe/TF.js से possible पर 5–10s/frame लगेगा; fake-3D parallax से visually cover करेंगे।
- "50 trillion x power" — hardware limit; अपने goal यानी *smooth, cinematic, no-hang* पूरा करेंगे।

अगर यह ठीक है तो approve करो, मैं build mode में एक ही बार में सब लागू कर दूँगा।
