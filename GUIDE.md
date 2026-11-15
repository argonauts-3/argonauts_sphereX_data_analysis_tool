# SPHEREx Time Explorer — User & Developer Guide

Welcome to the comprehensive guide for the **SPHEREx Time Explorer**, an interactive application developed for NASA Space Apps 2026 to explore multi-epoch time-series imaging from the SPHEREx mission.

---

## 1. Quick Start

To launch the application locally:

```bash
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Then open [http://127.0.0.1:5000](http://127.0.0.1:5000) in your web browser.

- **Pick a target:** Select one of the curated targets (e.g. *WISE 0855-0714* or *Barnard's Star*) or enter your own coordinates.
- **Change parameters:** Adjust the Field of View, Date Range, Detectors, or Alignment mode.
- **Click Show:** Apply your changes to start the build.
- **Preview & Play:** A 12-frame preview of the primary detector appears quickly while the full dataset continues building in the background. Once ready, use the playback transport to blink through time.

---

## 2. Target Selection and Coordinates

You can choose targets in three different ways:

1. **Curated Targets:** The drop-down menu includes scientifically interesting benchmarks:
   - **WISE 0855-0714:** Coldest known brown dwarf (~250 K), highly red, visible primarily in long-wavelength detectors (D5 & D6).
   - **Barnard's Star:** Nearest solitary star, possessing the highest proper motion of any known star (~10.3″/yr).
   - **Epsilon Indi B:** Nearby cold T-dwarf companion, 7 arcminutes from Epsilon Indi A.
   - **RW Aurigae:** Classical T Tauri young stellar object known for dramatic dimming events.
   - **R Draconis:** Mira-type pulsating variable star exhibiting large periodic brightness changes.
2. **Name Resolution:** Type any astronomical identifier (e.g. `HD 189733`, `Trappist-1`). The server queries the CDS Sesame name resolver service to resolve J2000 ICRS coordinates.
3. **Custom RA / Dec:** Enter explicit Right Ascension (0° to 360°) and Declination (-90° to +90°) in decimal degrees.

> [!NOTE]
> Editing coordinates clears any curated name so stale positions never override custom coordinates. Likewise, typing a new name clears coordinates until resolved.

---

## 3. Field of View, Pixel Scale, and Download Size

- **Output Scale:** All images are reprojected onto a fixed north-up TAN tangent projection at **6.1577 arcseconds/pixel** (the native nominal scale of SPHEREx detectors).
- **Field of View (FOV):** Adjustable from **0.10° to 1.00°** (default: 0.30°). A larger FOV displays a wider sky area rather than more detail.
- **Cache Tiers & Download Sizes:** Because archive cutouts are rotated relative to the equatorial grid, cutouts are retrieved in standardized tiers (`0.3°`, `0.5°`, `0.8°`, `1.0°`, `1.5°`) with a 1.5× safety margin.
  - At 0.30° FOV, the download tier is 0.50° (~1.3 GB for ~260 cutouts).
  - At 1.00° FOV, the download tier is 1.50° (~4.5 GB).
  - Tiers allow changing FOV between 0.20° and 0.33° without triggering new cutout downloads.

---

## 4. Date Range, Detectors, and Alignment

- **Date Filtering:** Set `From` and `To` dates (inclusive, ISO format `YYYY-MM-DD`). Quick presets allow selecting `All`, `2025`, or `2026`.
- **Detectors:** SPHEREx carries six detectors (D1 to D6) spanning 0.75 µm to 5.0 µm:
  - **D1:** 0.75 – 1.10 µm
  - **D2:** 1.10 – 1.63 µm
  - **D3:** 1.63 – 2.42 µm
  - **D4:** 2.42 – 3.82 µm
  - **D5:** 3.82 – 4.42 µm
  - **D6:** 4.42 – 5.00 µm
  Select one or more checkboxes to isolate wavelengths.
- **Alignment Mode ("track the target"):**
  - **Off (Sky-fixed, default):** The TAN grid is pinned to fixed equatorial coordinates. Moving targets (such as Barnard's Star or WISE 0855) visibly travel across the field. A cyan reticle marks the target's computed position at each epoch.
  - **On (Track motion):** The grid shifts for each exposure by the target's proper motion, keeping the target locked at the center pixel.

---

## 5. Playback, Scrubbing, FPS, and Keyboard Shortcuts

- **Controls:**
  - **Play / Pause:** Starts or stops chronological animation.
  - **-1 / +1:** Steps backward or forward by single frames.
  - **Frame Slider & Input:** Live-scrubs to any frame index `0 .. N-1`.
  - **FPS Slider & Input:** Controls playback rate from 0.5 to 12.0 frames per second (default: 4.0 fps).
- **Keyboard Shortcuts:**
  - `Space`: Toggle Play / Pause.
  - `Arrow Left`: Step backward one frame.
  - `Arrow Right`: Step forward one frame.
  - `g` or `G`: Open this Guide dialog.

---

## 6. Frame Order and Detector Interleaving

Frames are ordered strictly **chronologically by MJD (Modified Julian Date)**. Because SPHEREx observes all six detectors simultaneously during each telescope pointing:
- Exposures taken in the same observation have the same epoch and appear adjacent in the frame list.
- Blinking across all detectors reveals spectral and color changes over time.
- To focus purely on temporal variability without detector jumping, select a single detector (e.g. check only `D5`).

---

## 7. A/B Comparison and the Same-Detector Rule

The A/B Comparison tool enables visual differencing between two epochs:
- **Frame A & Frame B:** Select two frame indices.
- **Difference Modes:**
  - **A - B:** Highlights flux changes. Blue indicates Frame A is fainter than Frame B; red indicates Frame A is brighter than Frame B (scaled to ±3σ MAD scatter).
  - **(A + B) / 2:** Displays the mean co-addition of both epochs, reducing visual noise.
- **Same-Detector Rule:** Differencing between two different detectors (e.g. D1 vs D5) is prohibited and flagged with an explanation. Detectors observe completely different wavelengths and PSFs, meaning cross-band subtraction represents chromatic color differences rather than physical variability.

### Multi-frame S/N stack

Use the **Stack similar wavelengths** panel to combine more than two images.
Choose one detector, type an exact wavelength centre (or choose a suggested
centre from wavelengths present in the frames), set the ± tolerance in microns,
and optionally set start/end dates. Only rows still ticked in the Frames table
are candidates; the stack then applies the detector, wavelength, and date
limits. At least two images must match. Stacks never mix detectors by default.

The app reprocesses the selected cached FITS cutouts, aligns each image on the
target, subtracts a local residual sky level, and calculates a per-pixel
inverse-variance weighted mean. The layer menu displays that mean, its
estimated per-pixel uncertainty, or the number of frames contributing to each
pixel. The downloadable NPZ contains the floating-point mean, uncertainty,
weight sum, and contributor count; the PNG shown on screen is stretched for
viewing. The first stack for a selection can take time, but identical stacks
are cached. Since stacking averages the selected dates, narrow the date range
when studying a variable source.

---

## 8. Reading Flux, S/N, Flags, and Offsets

The metadata card below the viewer displays measurements computed directly from the calibrated FITS data:
- **Flux (µJy) & Uncertainty:** Measured aperture photometry corrected for pixel area and background.
- **Peak S/N:** Peak signal-to-noise ratio in the target aperture.
- **Background (MJy/sr):** Median local sky background (including zodiacal light).
- **Target Offset:** Distance of the moving object from the reference center in pixels.
- **Centroid Offset:** Offset between the expected catalog position and the measured centroid.
- **Quality Flags:** Bitwise flags from SPHEREx pipeline processing (e.g. `SOURCE`, `DICHROIC`, `OVERFLOW`, `BLOOM`). Frames flagged with bad bits are marked `target_bad: True`.
- **Pure Black Pixels:** Black pixels (`value = 0`) indicate no detector coverage at that pixel. Valid sky pixels are normalized between 1 and 255.

---

## 9. Display Interpolation (Display-Only)

The viewer features selectable interpolation kernels powered by GPU WebGL shaders (with automatic 2D Canvas fallback):

| Mode | Kernel Size | Visual Character & Best Use |
|---|---|---|
| **Nearest (none)** | 1×1 | Preserves crisp raw pixel blocks without blurring; ideal for inspecting detector pixels and cosmic rays. |
| **Bilinear** | 2×2 | Smooth interpolation without ringing; balanced standard display (default). |
| **Bicubic** | 4×4 Catmull-Rom | Sharper than bilinear; slight overshoot at sharp stellar point sources. |
| **Lanczos** | 6×6 Lanczos3 | Maximum sharpness; can show slight diffraction-like ringing around bright stars. |
| **Gaussian** | 5×5 (σ=1.2) | Soft, low-pass appearance; suppresses high-frequency pixel noise. |

> [!IMPORTANT]
> Interpolation is strictly **display-only**. It scales the rendered image in your browser canvas. It does not alter FITS arrays, aperture photometry, flux values, S/N, or difference image calculations.

---

## 10. URL Parameters and Embedding

The complete application state is synchronized with the browser URL. You can bookmark or share exact views:

| Parameter | Type / Values | Description |
|---|---|---|
| `name` | string | Target name (e.g. `Barnard's Star`) |
| `ra`, `dec` | float (deg) | Coordinates (override `name` if present) |
| `fov` | float (0.10–1.00) | Field of view in degrees |
| `t0`, `t1` | `YYYY-MM-DD` | Start and end dates |
| `bands` | comma-separated | Selected detectors, e.g. `D1,D3,D5` |
| `track` | `0` or `1` | `1` enables proper-motion tracking |
| `frame` | integer | Active frame index |
| `fps` | float | Playback rate |
| `play` | `0` or `1` | `1` auto-starts animation on load |
| `interp` | `nearest`, `bilinear`, ... | Display interpolation mode |
| `embed` | `0` or `1` | `1` hides form headers and sidebars for iframe embedding |
| `guide` | `0` or `1` | `1` opens the Guide dialog on page load |

Example embed link:
```
/?name=WISE%200855-0714&fov=0.3&bands=D5,D6&fps=6&play=1&embed=1
```

---

## 11. Cache Behavior, `precompute.py`, and Demo Warm-Up

- **Cutout Cache (`cutout_cache/`):** Raw FITS cutouts from IRSA SIA are stored with uncompressed canonical cache keys. Subsequent requests for the same target and tier run instantly offline.
- **Dataset Cache (`data/<dataset_id>/`):** Contains `manifest.json` and rendered PNG frames.
- **Precomputing Targets:** Warm up targets before demonstrations using `precompute.py`:
  ```bash
  # Precompute all curated targets at 0.3°:
  .venv/bin/python precompute.py --all-curated

  # Precompute specific targets at multiple fields of view:
  .venv/bin/python precompute.py --only "Barnard's Star,RW Aurigae" --fov 0.2 --fov 0.3
  ```

---

## 12. Progressive Preview

When requesting a new or wide-field target for the first time:
1. The server runs SIA queries and evaluates footprint polygons.
2. It immediately selects the most populated detector (`preview_band`) and downloads up to 12 evenly-spaced frames spanning the entire epoch baseline.
3. A partial preview manifest is generated (`complete: false`), and the browser begins playing the 12-frame preview movie within seconds.
4. An amber banner informs: `Preview: D5, 12 of 258 frames — building the other detectors`.
5. The full build proceeds in the background, downloading and measuring remaining detectors. Once finished, the preview seamlessly updates to the full multi-detector movie without interrupting playback position.

---

## 13. Troubleshooting

- **Archive 503 / 502 Errors:** IRSA occasionally rate-limits bursts. The pipeline includes automatic exponential backoff retry logic. If needed, reduce `SPHEREx_DOWNLOAD_WORKERS=4`.
- **Target Not Covered (422):** The footprint pre-check automatically skips frames where the target lies outside the active detector.
- **Too Many Exposures Warning:** Requests matching more than 500 exposures are stopped to protect system memory. Narrow the date range or select fewer detectors.
- **WebGL Unavailable:** If running in an environment without WebGL hardware acceleration, the viewer automatically switches to 2D Canvas fallback mode (supporting Nearest and Bilinear scaling). You can test this mode explicitly using `?viewer=2d`.

---

## 14. Developer Notes

- **Adding Sliders:** Declare sliders declaratively in `static/app.js` using `SliderControls.register(name, spec)`. Add markup mount points: `<div data-slider="name"></div>`. Both slider and number box stay synchronized, clamping and snapping cleanly.
- **API Endpoints:**
  - `GET /api/targets`: Curated target list.
  - `GET /api/resolve?name=...`: Sesame coordinate resolver.
  - `POST /api/build`: Trigger or resume a dataset build.
  - `POST /api/job/<id>/cancel`: Cooperatively cancel a running build.
  - `GET /api/job/<id>`: Poll job status, progress, and preview readiness.
  - `GET /api/dataset/<id>`: Retrieve `manifest.json`.
  - `GET /data/<id>/<path>`: Fetch rendered frame PNGs.
  - `GET /api/diff/<id>?a=0&b=1&mode=sub`: Retrieve dynamically rendered difference PNGs.

---

## 15. Multi-Mission Data Sources (Release B)

*Phase 6 context integration.* Integration with broader IRSA holdings (AllWISE catalog cross-matching, NEOWISE multi-epoch light curves, ZTF optical light curves, and Euclid/Spitzer reference context insets) is scheduled for Release B. These context panels remain strictly isolated from SPHEREx movie frames to preserve temporal alignment integrity.
