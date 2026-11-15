# SPHEREx time explorer - progress and handoff

Snapshot date: 2026-11-15

This document is the "where are we?" file for the project.  It covers what
has been built, what is currently on disk, the decisions behind it, and what
to do next.  For user-facing instructions, see `README_APP.md`.

## Status at a glance

- Local Flask prototype, not deployed publicly yet.
- Code is on `main`; the last code commit before this document is `c5de775`
  (`Show which build is ahead of a queued request`).
- Working tree was clean when this snapshot was written.
- Start it with `.venv/bin/python app.py` (or
  `PORT=... .venv/bin/python app.py`); it listens on
  `http://127.0.0.1:5000/` by default.
- The default 0.3 degree WISE 0855 dataset is built and cached.  Barnard's
  Star is also cached at 0.30, 0.25 and 0.20 degrees, including a tracked
  0.20 degree version.
- No formal test suite.  Browser and API checks are described below.

## What this is

A public-facing exploration tool for NASA Space Apps 2026, currently running
as a local prototype.  A user picks a target, sees every SPHEREx exposure of
that position, blinks through time, compares two frames, chooses the field of
view and date range, and can share the exact view by URL.

The project is deliberately a simple local prototype:

- Plain HTML/CSS/JavaScript, no framework and no build step.
- Flask server, one dataset build at a time.
- Heavy astronomy is still in `test.py`; the web app does not reimplement it.
- Working prototype over polish.  The visuals are intentionally plain.

## Repo layout

| path | purpose |
|---|---|
| `test.py` | Original SPHEREx pipeline: SIA query, cutout download, measurement and alignment.  Extended with optional arguments, footprint pre-check, gzip downloads, and cooperative cancellation. |
| `dataset.py` | Runs the pipeline for one web request, progressive preview, renders PNGs, writes `manifest.json` (schema v2), and defines the dataset id and fetch tiers. |
| `app.py` | Flask routes, request validation, curated targets, build queue/jobs with cooperative cancellation, diff endpoint, and progressive preview serving. |
| `static/index.html` | One page: target controls, canvas viewer, transport, compare controls, frame table, and Guide modal. |
| `static/controls.js` | Reusable slider + number input components (`SliderControls`), declarative mounting via `<template id="sliderTemplate">`. |
| `static/viewer.js` | WebGL canvas frame viewer with user-selectable display interpolation kernels (nearest, bilinear, bicubic, lanczos, gaussian) and 2D fallback. |
| `static/app.js` | Front-end behavior: form state, builds, polling, preview loading, playback, URL state, compare view, and image preloading. |
| `static/style.css` | Layout, component styling, and Guide dialog prose. |
| `GUIDE.md` | Comprehensive walkthrough for users and developers. |
| `precompute.py` | Warms the cache for curated targets before a demo (`--all-curated`, repeatable `--fov`). |
| `README_APP.md` | How to run and use the app, URL parameters and caveats. |
| `requirements.txt` | Runtime dependencies. |
| `PROGRESS.md` | This handoff/status document. |

Generated data is ignored by git:

- `.venv/`
- `cutout_cache/`
- `data/`
- pipeline figures, tables and other `*.ecsv` files

## How to run

```bash
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
# open http://127.0.0.1:5000
```

Useful environment variables:

```bash
PORT=8080 HOST=0.0.0.0 .venv/bin/python app.py
SPHEREX_DOWNLOAD_WORKERS=16 .venv/bin/python app.py
```

The download worker override is optional.  Eight threads is the default;
pushing much higher can cause more archive 502/503 responses and retries.

Precompute a demo:

```bash
.venv/bin/python precompute.py
.venv/bin/python precompute.py --only "Barnard's Star" --fov 0.2
.venv/bin/python precompute.py --only "RW Aurigae,R Draconis"
```

## Feature set

### Targets

The curated list lives in `app.py` and carries coordinates and proper motion
where they are known.

| target | RA (deg) | Dec (deg) | proper motion (mas/yr) | note |
|---|---:|---:|---|---|
| WISE 0855-0714 | 133.818908 | -7.247048 | -8123.7, 673.2 | coldest known brown dwarf, very red |
| Barnard's Star | 269.452077 | 4.693365 | -798.71, 10337.77 | fastest proper motion of any star |
| Epsilon Indi B | 331.044147 | -56.782844 | 3960.9, -2539.2 | T dwarf companion, 7 arcmin from Epsilon Indi A |
| RW Aurigae | 76.956526 | 30.401438 | 0, 0 | young star with deep eclipses |
| R Draconis | 248.167611 | 66.754979 | 0, 0 | Mira variable, large brightness changes |

Custom targets:

- The name, RA and Dec fields are always editable.
- Typing a name switches the drop-down to "custom" and clears the old
  coordinates, so stale coordinates cannot silently override the new name.
- Editing a coordinate clears a name that came from the curated list.
- Entering only RA or only Dec is an error:
  `Enter both RA and Dec, or use a target name.`
- A custom name with no coordinates is resolved by CDS Sesame.
- Curated names are resolved locally.  This matters because names such as
  "WISE 0855-0714" are not valid Sesame names; the canonical query is
  "WISE J085510.83-071442.5".

### Field of view and time window

- FOV is user-controlled from 0.1 to 1.0 degrees; default is 0.3.
- Every numeric control has both a slider and a direct number input.
- Date range is user-controlled and inclusive.  Empty means the full archive.
- Detector checkboxes select D1-D6.
- `track` toggles between a sky-locked grid (default) and a grid that follows
  the target's proper motion.

### Movie and comparison

- Play/pause, step forward/back, frame slider plus number box, and fps
  control.
- Space plays; left/right arrows step.
- Frame metadata: date, detector, wavelength, flux, error, peak S/N, target
  flags, target offset and background level.
- A target marker shows where the target should be on the displayed frame.
  It is hidden when tracking is on because the target is already centred.
- A/B selectors for two frames.
- Difference modes:
  - `A - B`
  - `(A + B) / 2`
- Difference images are allowed only within one detector.  Comparing two
  bands is refused with an explanation.
- "Back to movie" returns from the comparison view.

### Sharing

The URL is the state.  The page updates it with `history.replaceState`, and a
URL always rebuilds the same request.

| parameter | meaning |
|---|---|
| `name` | target name; curated names use built-in coordinates, others go through Sesame |
| `ra`, `dec` | J2000 coordinates in degrees; take precedence over `name` |
| `fov` | field of view in degrees, 0.1 to 1.0 |
| `t0`, `t1` | ISO dates, inclusive |
| `bands` | comma-separated `D1`..`D6` |
| `track` | `1` to track target motion |
| `fps` | playback rate |
| `frame` | frame index to show |
| `play` | `1` to start playing |
| `embed` | `1` to hide the form and side panels |

Examples:

```
/?name=Barnard%27s%20Star&fov=0.3&t0=2025-05-01&bands=D5&fps=6&play=1
/?ra=133.818908&dec=-7.247048&fov=0.2&embed=1
```

Name-only links for curated targets were fixed during browser testing.  The
page now fills the form first, and the server also checks the curated list
before calling Sesame.  The display name is never sent to Sesame on its own
when built-in coordinates are available.

## How a dataset is built

1. Query IRSA SIA for all collections in `test.COLLECTIONS`:
   `spherex_dr1` and `spherex_qr3`.
2. Keep exposures whose footprint covers the target position.
3. Apply the user's date range and detector selection.
4. Download one cutout per exposure into `cutout_cache/`.
5. Measure the target in each cutout (aperture flux, peak S/N, flags,
   background, centroid).
6. Reproject every frame onto one common north-up TAN grid at
   6.1577 arcsec/pixel.  The default is sky-locked; `track=1` shifts each
   frame so the moving target stays centred.
7. Render one 8-bit PNG per frame.  For each detector, subtract the median sky
   and use a common 1-99.5 percentile stretch.  NaN is pure black (0); valid
   pixels are 1..255, so black always means "no data".
8. Write `manifest.json` last, so a half-finished build is never served.

`dataset_id` is a 12-hex SHA1 of the request: version, rounded position, FOV,
dates, bands and track.  Same request means same directory and an instant
answer from disk.  Proper motion is not part of the id; bump `dataset.VERSION`
after changing a curated target's coordinates or proper motion.

Cutout sizes are fixed tiers: 0.3, 0.5, 0.8, 1.0 and 1.5 degrees, chosen as
the smallest tier that covers `1.5 * fov`.  The 1.5 factor exists because the
archive cutout is rotated on the sky.  Fixed tiers mean moving the FOV slider
usually reuses the same download.  At the web default of 0.3 degrees the
cutout tier is 0.5 degrees and the output grid is 175 x 175 pixels.

The command-line pipeline still defaults to 0.2 degrees
(`FIELD_OF_VIEW_DEG`); the web app passes its own FOV (0.3 by default).

The archive search radius is `SEARCH_RADIUS_DEG = 0.02` degrees (72 arcsec),
not half the FOV.

Limits:

- At most 500 exposures per build (`dataset.MAX_EXPOSURES`).
- A build refuses oversized requests with a clear message instead of filling
  the disk.

### Adding a new data release

Add the release's SIA collection id to `test.COLLECTIONS`:

```python
COLLECTIONS = ("spherex_dr1", "spherex_qr3", "spherex_dr2")
```

Two caches need attention after that change:

- The per-position archive query is cached as
  `cutout_cache/exposures_<ra>_<dec>.ecsv`.  Delete the relevant file (or all
  `exposures_*.ecsv` files) so the archive is queried again.  Otherwise the
  old exposure list is reused and the new release is invisible.
- Existing datasets have the same request id and will not rebuild.  Bump
  `dataset.VERSION` so new frames and any new manifest fields get a new id.

The cutout files themselves are keyed by their archive URL and can stay
cached.  A cleaner long-term fix is to include the release list in the dataset
id instead of relying on a manual version bump; that is still open.

## Manifest contents (Schema v2)

Top-level keys:

- `version` (bumped to 2), `id`, `created_utc`
- `complete`: `true` for full build, `false` for progressive preview
- `preview`: `true` during partial preview stage
- `preview_band`: detector used for preview (e.g. `SPHEREx-D5`)
- `planned`: planned total frame count and band count
- `render_version`: version string used for cache-busting frame PNG URLs
- `target`: RA, Dec and proper motion applied
- `request`: FOV, dates, bands, track and cutout size
- `grid`: `n`, pixel scale, CRVAL, CRPIX and CD matrix
- `stretch`: per-detector rendering stretch information
- `summary`: frame count, detector count, date range and wavelength range
- `frames`: one object per exposure

Each frame has:

- `index`, `png`, `band`, `band_label`, `obs_id`
- `mjd`, `iso`, `date`
- `wavelength_um`, `bandwidth_um`
- `flux_ujy`, `err_ujy`, `peak_snr`
- `target_flag`, `target_flag_names`, `target_bad`
- `target_offset_px`, `centroid_offset_px`
- `background_mjy_sr`

## Performance work already done

Loading time and responsiveness have been significantly optimized:

- **Progressive Preview (Phase 4):** A 12-frame preview of the primary detector appears in seconds, letting the user inspect and blink frames immediately while the full build continues in the background.
- **Cooperative Cancellation (Phase 3):** Running builds can be cancelled directly from the UI via the Cancel button, and submitting a new target automatically cancels previous in-flight requests.
- **Bounded Submission & Timeouts:** Prefetch submits cutouts with bounded queues (`workers * 2`) and distinct connect/read timeouts `(10, 60)` s.
- **Gzip & Thread-Local Sessions:** Cutouts are downloaded with `&gzip=1` saving ~14% bandwidth, using thread-local requests sessions with connection pooling.
- **Footprint Pre-Check:** Exposures whose SIA `s_region` polygon does not contain the target are skipped before download, eliminating unnecessary 422 errors and wasted transfers.
- **Larger-Cutout Reuse:** FOV reductions reuse already-downloaded larger cutout tiers without network transfers.
- **Display Interpolation (Phase 1B):** GPU WebGL fragment shader scaling allows instant switching between nearest, bilinear, bicubic, lanczos, and gaussian kernels without touching the server or measurements.
- **Reusable Sliders (Phase 1):** Declarative HTML template and unified controller (`controls.js`) synchronize range and numeric inputs without mismatch.
- The page draws the first frame as soon as the manifest arrives, then
  preloads the remaining PNGs in the background.  Locally the first frame
  appears in about 0.6 seconds and all 258 images finish in under a second.
- Frame PNGs and difference images get
  `Cache-Control: public, max-age=31536000, immutable`.
- The web build calls `align_frames(..., release_source=True,
  aux_planes=False)`.  It drops the source cutout arrays after reprojection
  and skips aligned variance/flags, which the page never reads.  That removes
  two of the three reprojections per frame.
- Downloads use 8 threads by default; `SPHEREX_DOWNLOAD_WORKERS` can raise it.

The remaining unavoidable cost is the archive download.  At 0.3 degrees a new
target is roughly 1.3 GB and 10-20 minutes on a slow link.  At 1.0 degree it
is roughly 4.5 GB.  `precompute.py` is the right answer for a demo.

## Build queue behavior

There is one build worker, because two simultaneous gigabyte downloads and
reprojections are a bad idea on this machine.

States:

- `queued`
- `running`, with stage `query`, `downloading`, `measuring`, `aligning` or
  `rendering`
- `ready`
- `error`

When a new request arrives:

- If its dataset is already on disk, the API returns `ready` immediately.
- If the same dataset is already queued or running, that job is reused.
- If another build is running, the new request is queued behind it.
- Older requests that are still queued are replaced by the newest request.
  The running build is left alone because it is doing real work.

The page now says what it is waiting for, for example:

```
Waiting for Barnard's Star, 0.20 deg: Downloading cutouts (95/368)
```

This was added after a real session where switching targets looked frozen on
"Queued" behind four sequential Barnard's Star builds.

## Data and cache currently on disk

Snapshot on 2026-11-15:

- `cutout_cache/`: about 8.2 GB, 1837 files.  Includes SIA tables and FITS
  cutouts.  Safe to keep for a demo; deleting it means downloading again.
- `data/`: about 21 MB across 8 built datasets.

Built datasets:

| id | target | FOV | track | frames | dates |
|---|---|---:|---|---:|---|
| `97150ca5b67d` | WISE 0855 | 0.12 | no | 12 | 2025-05-05 .. 2025-05-06 |
| `e0f4b82a0920` | WISE 0855 | 0.12 | yes | 12 | 2025-05-05 .. 2025-05-06 |
| `a993f041156c` | WISE 0855 | 0.10 | no | 252 | 2025-05-05 .. 2026-05-14 |
| `6329732a33ab` | WISE 0855 | 0.30 | no | 258 | 2025-05-05 .. 2026-05-14 |
| `3a1054147e5f` | Barnard's Star | 0.30 | no | 330 | 2025-08-15 .. 2026-09-22 |
| `4d9f8c22a955` | Barnard's Star | 0.25 | no | 358 | 2025-08-15 .. 2026-09-22 |
| `b34ee9dcdbb8` | Barnard's Star | 0.20 | no | 350 | 2025-08-15 .. 2026-09-22 |
| `ce40d1fe07de` | Barnard's Star | 0.20 | yes | 360 | 2025-08-15 .. 2026-09-22 |

The 12-frame WISE datasets were built as alignment/track-mode tests.  The
Barnard variants are real builds from the target/FOV/track controls.  Only
WISE 0855 and Barnard's Star have built datasets so far; RW Aurigae,
R Draconis and Epsilon Indi B still need their first build (some cutouts may
already be in the cache from earlier runs).

Why 258 frames from 272 archive rows at WISE 0855: 14 archive rows return a
detector-edge cutout that does not actually contain the target.  Those frames
are skipped.  This is expected, not a download failure.  See
`940949a Document why some archive rows are skipped`.

Frame count can differ slightly between sky-locked and tracking builds because
the shifted WCS changes which edge frames contain the target after
reprojection.

## Verification already done

Browser tests used headless Firefox plus `/snap/bin/geckodriver`:

- Default WISE dataset loads, plays, pauses and scrubs.
- Frame URL parameter restores the requested frame after reload.
- `?embed=1` hides the form and side panels.
- `A - B` and `(A + B) / 2` render; cross-band pairs are refused.
- Target marker moves correctly with sky-locked alignment and is hidden in
  tracking mode.
- Track mode says "track target motion" and "centred (tracking)".
- Custom target fields are always editable.
- Typing a name switches to custom and clears coordinates.
- Partial coordinates produce a clear error.
- Direct coordinate entry loads the cached WISE dataset.
- A curated name-only URL with `frame=100` shows frame 101 and adds RA/Dec to
  the URL.
- First frame is visible while the remaining images are still loading.
- Queue logic was tested with Flask's test client and a fake executor:
  queued-behind information, newest-request-wins, and the running build being
  left alone.

Static checks: `python -m py_compile app.py dataset.py test.py` and
`git diff --check` pass.  There is no pytest/unit-test suite yet.

## Known limitations and caveats

- **Local prototype, not deployed.**  No authentication, rate limiting,
  public host or persistent job store.
- **One build worker.**  A long build delays every other request.  Queue
  status is now visible, but running builds cannot be cancelled from the UI.
- **Download cost.**  About 1.3 GB at 0.3 degrees and 4.5 GB at 1.0 degree
  for a new target.  Cached cutouts make date/FOV changes much cheaper.
- **500-exposure limit.**  Crowded fields or very wide date ranges are
  refused.
- **Difference images use displayed 8-bit PNGs.**  The arithmetic is visual,
  not photometric.  At the default field one grey level is about 2 uJy, below
  the per-pixel noise.  Use `flux_ujy` in the manifest for measurements.
- **Same-detector differences only.**  D1 and D5 are different wavelengths
  and PSFs; subtracting them is not a difference image.
- **One-year baseline is short for motion.**  At 6.16 arcsec/pixel, Barnard's
  Star moves 1.7 pixels per year and WISE 0855 moves 1.3.  Motion appears as a
  small dipole, not a visible streak.  The app is better at variability than
  at fast movers.
- **Fixed pixel scale.**  Larger fields show more sky, not more detail.
  6.1577 arcsec/pixel is the output scale.
- **No spectrum, light curve, period search, pan/zoom or sky overlay.**
  Wavelength is per exposure; flux is per exposure.
- **Sesame dependency for custom names.**  Curated names work offline; a new
  name needs network access to CDS.
- **Cache headers are immutable.**  If a dataset is deleted and rebuilt with
  the same id, a browser may still hold the old PNGs.  Bump
  `dataset.VERSION` when rendering or manifest semantics change.
- **Memory is tight.**  The machine has about 7 GB RAM.  A VS Code OOM killed
  the terminal scope that was hosting the app once.  Builds release source
  arrays and skip auxiliary aligned planes to keep peaks down.
- **Server lifetime is manual.**  The current server was started in a
  terminal on port 5000.  Closing that terminal (or an OOM event) stops it.
  There is no systemd service or auto-restart yet.
- **Untracked generated data.**  `data/` and `cutout_cache/` are ignored by
  git.  A clone of the repo does not include the warmed datasets.
- **New releases need manual cache invalidation.**  Delete the cached
  `exposures_*.ecsv` query tables and bump `dataset.VERSION`; otherwise the
  old exposure list and old datasets are reused.  See "Adding a new data
  release".

## Suggested next steps

1. Precompute the remaining curated targets at the demo FOV, especially
   RW Aurigae and R Draconis.
2. Decide on the demo/deployment environment: persistent host, process
   supervision and disk budget for `cutout_cache/`.
3. Add a cache-cleanup command or admin page so the 8 GB cutout cache can be
   pruned without manual `rm`.
4. Consider cooperative cancellation for a running build, or a "cancel"
   button for queued requests.  The queue display is fixed; cancellation is
   the remaining rough edge.
5. Add a simple light curve from `flux_ujy` and an option to export the
   table/manifest.
6. Add a WISE or Gaia overlay if the CDS/IRSA endpoints are reliable from the
   deployment host.
7. Add a proper test suite for the API and the dataset id/queue logic.
8. Add the next SPHEREx release to `COLLECTIONS` when it is available, and
   include the release list in the dataset id / SIA query cache key so the
   manual invalidation goes away.

## API and useful commands

Routes:

| route | purpose |
|---|---|
| `GET /api/targets` | curated target list |
| `GET /api/resolve?name=...` | Sesame name resolution |
| `POST /api/build` | build or reuse a dataset; returns id and state |
| `GET /api/job/<id>` | job state/progress, plus `queued_behind` when waiting |
| `GET /api/dataset/<id>` | `manifest.json` |
| `GET /data/<id>/<path>` | frame PNGs and other dataset files |
| `GET /api/diff/<id>?a=&b=&mode=sub` (or `mode=add`) | rendered difference image |

Useful checks:

```bash
.venv/bin/python -m py_compile app.py dataset.py test.py
git diff --check
du -sh cutout_cache data
find data -name manifest.json
curl -s http://127.0.0.1:5000/api/targets
```

## Recent git history

| commit | summary |
|---|---|
| `c5de775` | Show which build is ahead of a queued request |
| `9ad6be3` | Speed up loading and make target fields editable |
| `940949a` | Document why some archive rows are skipped |
| `e970f01` | Keep the target marker correct when tracking is on |
| `d565e6c` | Harden the build for long exposures and polish the page |
| `d95305f` | Checkpoint: Flask app, browser front end and precompute helper |
| `5eda5e5` | Checkpoint: parameterise the pipeline and add the dataset builder |
| `7f5a4ea` | Checkpoint: SPHEREx pipeline before adding the web app |

## Bottom line

The prototype does the intended job end to end for WISE 0855 and Barnard's
Star: pick a target, see every usable exposure, blink through time, compare
frames, change FOV/dates, track motion and share the exact view by URL.

The two remaining practical issues are operational: precompute the demo
targets, and give the server a durable home.  The astronomy and UI are far
enough along to demo on a laptop today.
