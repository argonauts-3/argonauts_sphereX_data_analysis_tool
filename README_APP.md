# SPHEREx time explorer

A small web app for looking at every SPHEREx exposure of one position.  It
finds the exposures in the IRSA archive, cuts a patch around the target from
each one, aligns them all onto the same north-up grid, and lets you blink
through them.  There is also an A-B / (A+B)/2 view for comparing two epochs.

For the complete in-depth user and developer walkthrough, see [GUIDE.md](GUIDE.md).
For a dated snapshot of what is built, what is cached and what remains, see `PROGRESS.md`.

## Run it

```bash
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
# open http://127.0.0.1:5000
```

`PORT` and `HOST` are environment variables:

```bash
PORT=8080 HOST=0.0.0.0 .venv/bin/python app.py
```

The first visit to a new position downloads one cutout per exposure.  At the
default 0.3 degree field that is about 1.3 GB and 10-20 minutes on a slow
link; the page shows progress.  Larger fields cost more: about 4.5 GB at 1.0
degree.  The page draws the first frame as soon as the manifest arrives and
preloads the rest in the background.

Downloads use 8 threads by default.  On a fast link you can ask for more, at
the risk of more archive retries:

```bash
SPHEREX_DOWNLOAD_WORKERS=16 .venv/bin/python app.py
```

Everything is cached afterwards:

- `cutout_cache/` - the archive cutouts, keyed by the cutout URL.  Shared by
  the app and `test.py`, and reused when you change the date range.
- `data/<id>/` - one built dataset: `manifest.json` plus one PNG per frame.
  Changing the dates rebuilds this from the cache in a few seconds.  Changing
  the field of view does too, as long as the new field still fits inside the
  same downloaded cutout size (the tiers are 0.3, 0.5, 0.8, 1.0 and 1.5
  degrees).  Frame PNGs and difference images are sent with a one-year
  `Cache-Control`, so revisiting a dataset does not download them again.

## The page

- Target drop-down with five curated objects, or any name / RA / Dec.  The
  name and coordinate fields are always editable: typing in them switches the
  drop-down to "custom", and typing a new name clears the old coordinates so
  they cannot silently override it.  A custom name with no coordinates is
  resolved by the server through Sesame; the five curated names use the
  coordinates already in the target list.
- Field of view from 0.1 to 1.0 degrees using unified, declarative sliders
  (`static/controls.js`) that snap and synchronize range and numeric inputs.
  The frames are always 6.16 arcsec/pixel, so a larger field shows more sky,
  not more detail.
- Date range with "All / 2025 / 2026" shortcuts.
- Detector checkboxes D1-D6.
- Play / pause / step, frame slider plus number box, fps slider plus number
  box.  Space also plays, arrow keys step.
- Display interpolation kernel selector (Nearest, Bilinear, Bicubic, Lanczos,
  Gaussian) powered by WebGL fragment shaders in `static/viewer.js` (with 2D
  Canvas fallback). Display-only: does not alter photometry or difference images.
- A and B selectors, "A - B" and "(A + B) / 2".
- Progressive preview: a 12-frame quick-look movie appears in seconds while
  the remaining detectors continue downloading and processing in the background.
- Cancel button: stop an active build immediately and automatically cancel
  running builds when a new target is submitted.
- Per-frame metadata: date, detector, wavelength, flux, peak S/N, target-pixel
  flags, offset from the grid centre.
- Colourbar under the image (MJy/sr above each frame's median sky, for the detector
  on screen) and black / white level sliders.  The levels re-window the 8-bit PNG
  in the shader; they cannot recover pixels clipped at the 1st / 99.5th percentile.
  Difference images are never re-windowed.
- Frame filters in the Frames panel: a tick box per frame, a wavelength window
  (min / max um) and quick buttons (Drop flagged, Drop S/N < 3, Drop blended).
  Hidden frames are skipped by Play, the frame slider, the A/B lists and the plots,
  and drawn hollow in the plots.  The filter is client-side only; no rebuild.
- Measurements panel: spectrum (aperture flux vs wavelength) and light curve
  (flux vs date), both with error bars, clickable points and a CSV download.
  The light curve warns when the plotted frames span a wide wavelength range.
- "track the target" switches the alignment: off (default) keeps the sky
  fixed so everything moves as it really does; on keeps the moving target at
  the centre.
- In-app Guide dialog (press 'g' or click "Guide") with comprehensive usage tips.

The current view is always in the URL, so it can be shared or embedded:

```text
/?name=Barnard%27s%20Star&fov=0.3&t0=2025-05-01&bands=D5&fps=6&play=1
/?ra=133.818908&dec=-7.247048&fov=0.2&embed=1
```

| parameter | meaning |
| --- | --- |
| `name` | target name; curated names use their built-in coordinates, others are resolved with Sesame |
| `ra`, `dec` | J2000 coordinates in degrees (take precedence over `name`) |
| `fov` | field of view in degrees, 0.1 to 1.0 |
| `t0`, `t1` | ISO dates, inclusive |
| `bands` | comma-separated `D1`..`D6` |
| `track` | `1` to track the target's proper motion |
| `fps` | playback rate |
| `frame` | frame index to show |
| `interp` | display interpolation kernel (`nearest`, `bilinear`, `bicubic`, `lanczos`, `gaussian`) |
| `wl0`, `wl1` | wavelength window in um (both needed) |
| `skip` | unticked frame indices, e.g. `3-5,9`; they refer to the complete dataset |
| `lo`, `hi` | black / white level in percent of the stretch |
| `play` | `1` to start playing |
| `embed` | `1` to hide the form and side panels |
| `guide` | `1` to automatically open the Guide modal on load |

## Files

- `test.py` - the original pipeline.  It gained optional arguments only
  (`max_frames`, `workers`, `cutout_dir`, `fov_deg`, `track`, `proper_motion`,
  progress callbacks); `python test.py` behaves as before.
- `dataset.py` - calls the pipeline, renders one PNG per frame and writes
  `manifest.json`.
- `app.py` - Flask routes, request validation, one build at a time, the
  difference endpoint.
- `static/` - one HTML page, four JS files (`app.js`, `viewer.js`, `controls.js`,
  `plots.js`) and one CSS file.  No build step.

## How the images are made

`align_frames()` in `test.py` reprojects every exposure onto one TAN grid,
north up, at 6.1577 arcsec/pixel.  `dataset.py` then, per detector, removes
each frame's median sky level and picks a common 1-99.5 percentile stretch, so
a real change in brightness between visits is visible instead of being
stretched away.  NaN (no coverage) is written as pure black; valid pixels are
never 0, so black in the figure always means "no data".

The PNGs are 8-bit.  For the A-B view the server subtracts the displayed
values, estimates the scatter from the difference itself (MAD) and stretches
to +/- 3 sigma.  At the default field one grey level is about 2 uJy, below the
per-pixel noise, so this is a visual quick-look; use `flux_ujy` in the
manifest for measurements.

## Adding a new data release

IRSA publishes each SPHEREx release as a SIA collection.  Add its id to the
list in `test.py`:

```python
COLLECTIONS = ("spherex_dr1", "spherex_qr3", "spherex_dr2")
```

The query stacks every collection into one exposure list, so new frames appear
in the same movie.  Two caches must be refreshed after changing the list:

- Delete the relevant `cutout_cache/exposures_*.ecsv` file(s).  Otherwise the
  old archive answer is reused and the new release stays invisible.
- Bump `dataset.VERSION`.  It is part of the dataset id, so existing datasets
  rebuild instead of being served with the old frame list (or an old manifest
  schema).

## Not in this prototype

- No per-pixel spectrum.  The Measurements panel plots the target's aperture
  flux per frame, not a spectrum for every pixel.
- No period search and no stacked image (the notebook's inverse-variance stack
  needs float data the PNGs do not hold).
- No pan/zoom beyond the browser's own image scaling.  The field is fixed by
  the FOV control.
- No user accounts or server-side persistence.  The URL is the whole state.

## Caveats worth knowing

- **Difference images are only allowed within one detector.**  D1 and D5 are
  different wavelengths and different PSFs; subtracting them is not a
  difference image.  The endpoint refuses cross-band pairs.
- **Not every archive row becomes a frame.**  An exposure can intersect the
  72" SIA search circle while the target itself falls just outside the
  detector.  The archive then returns a thin edge cutout that does not contain
  the target, and the pipeline skips it.  At WISE 0855 that leaves 258 usable
  frames out of 272 archive rows; the table and manifest list only frames that
  really have the target on a pixel.
- **A one-year baseline is short for motion.**  At 6.16 arcsec/pixel, Barnard's
  Star moves 1.7 pixels per year and WISE 0855 moves 1.3.  Motion appears as a
  small dipole in A-B, not as a visible streak.  The app is better at
  variability (R Draconis, RW Aurigae) than at finding fast movers.
- **The archive cutout is mostly overhead.**  A 4.4 MB cutout contains ~3.8 MB
  of `EPSF` extension that this pipeline does not use.  Fetch tiers are fixed
  (0.3, 0.5, 0.8, 1.0, 1.5 degrees) so changing the FOV slider reuses one
  download.
- **CDS services were unreachable from here** (Aladin Lite, hips2fits, some
  Vizier endpoints all returned 404), so the prototype does not depend on
  them.  A WISE or Gaia overlay is the obvious next step; IRSA serves WISE
  cutouts from the same host that already works.
- The build limit is 500 exposures per request.  A crowded field or a very
  wide date range is refused with a message rather than filling the disk.

## Precomputing a demo

To warm curated targets before a presentation:

```bash
# Warm all curated targets at default 0.3°:
.venv/bin/python precompute.py --all-curated

# Or specific targets and fields:
.venv/bin/python precompute.py --only "Barnard's Star" --fov 0.2 --fov 0.3
```

This downloads cutouts into `cutout_cache/` (~1.3 GB per target at 0.3°). The app works without it; the first
visit to an uncached target shows a 12-frame preview while building the full dataset.
