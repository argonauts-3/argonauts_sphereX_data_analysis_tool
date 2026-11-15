# SPHEREx time explorer

A small web app for looking at every SPHEREx exposure of one position.  It
finds the exposures in the IRSA archive, cuts a patch around the target from
each one, aligns them all onto the same north-up grid, and lets you blink
through them.  There is also an A-B / (A+B)/2 view for comparing two epochs.

This is the functional prototype, not the final public tool: the visuals are
plain on purpose and everything runs locally.

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
degree.  Everything is cached afterwards:

- `cutout_cache/` - the archive cutouts, keyed by the cutout URL.  Shared by
  the app and `test.py`, and reused when you change the date range.
- `data/<id>/` - one built dataset: `manifest.json` plus one PNG per frame.
  Changing the dates rebuilds this from the cache in a few seconds.  Changing
  the field of view does too, as long as the new field still fits inside the
  same downloaded cutout size (the tiers are 0.3, 0.5, 0.8, 1.0 and 1.5
  degrees).

## The page

- Target drop-down with five curated objects, or any name / RA / Dec.
- Field of view from 0.1 to 1.0 degrees.  Slider and number box are linked.
  The frames are always 6.16 arcsec/pixel, so a larger field shows more sky,
  not more detail.
- Date range with "All / 2025 / 2026" shortcuts.
- Detector checkboxes D1-D6.
- Play / pause / step, frame slider plus number box, fps slider plus number
  box.  Space also plays, arrow keys step.
- A and B selectors, "A - B" and "(A + B) / 2".
- Per-frame metadata: date, detector, wavelength, flux, peak S/N, target-pixel
  flags, offset from the grid centre.
- "track the target" switches the alignment: off (default) keeps the sky
  fixed so everything moves as it really does; on keeps the moving target at
  the centre.

The current view is always in the URL, so it can be shared or embedded:

```
/?name=Barnard%27s%20Star&fov=0.3&t0=2025-05-01&bands=D5&fps=6&play=1
/?ra=133.818908&dec=-7.247048&fov=0.2&embed=1
```

| parameter | meaning |
|---|---|
| `name` | target name (resolved with Sesame) |
| `ra`, `dec` | J2000 coordinates in degrees (take precedence over `name`) |
| `fov` | field of view in degrees, 0.1 to 1.0 |
| `t0`, `t1` | ISO dates, inclusive |
| `bands` | comma-separated `D1`..`D6` |
| `track` | `1` to track the target's proper motion |
| `fps` | playback rate |
| `frame` | frame index to show |
| `play` | `1` to start playing |
| `embed` | `1` to hide the form and side panels |

## Files

- `test.py` - the original pipeline.  It gained optional arguments only
  (`max_frames`, `workers`, `cutout_dir`, `fov_deg`, `track`, `proper_motion`,
  progress callbacks); `python test.py` behaves as before.
- `dataset.py` - calls the pipeline, renders one PNG per frame and writes
  `manifest.json`.
- `app.py` - Flask routes, request validation, one build at a time, the
  difference endpoint.
- `static/` - one HTML page, one JS file, one CSS file.  No build step.

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

Nothing else changes: the query stacks every collection into one exposure
list, so new frames appear in the same movie.  If the manifest gains a field,
bump `dataset.VERSION`; it is part of the dataset id, so old cached datasets
are rebuilt instead of being served with a page that expects something else.

## Not in this prototype

- No pixel-level spectrum or wavelength slider.  Wavelength is shown per
  frame in the table and metadata, but each view is one detector at a time.
- No measured light curve or period search; the flux column is per exposure.
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

To warm the five curated targets at the default field before a presentation:

```bash
.venv/bin/python precompute.py
# or just one:
.venv/bin/python precompute.py --only "Barnard's Star" --fov 0.2
```

This downloads about 1.3 GB per target.  The app works without it; the first
visit is just slower.
