"""Turn one sky position into everything the web page needs.

This is the bridge between test.py (the science pipeline) and app.py (the web
server).  It adds no new astronomy: it calls the functions in test.py, then
renders each aligned frame to a small PNG and writes a manifest.json that
describes the dataset.

Layout of one dataset (data/<id>/):

    manifest.json          everything the browser needs, written last
    frames/f000.png ...    one 8-bit image per exposure, black = no data

The PNGs are produced from Frame.image_aligned, the north-up grid that
align_frames() builds, so blinking is just swapping two <img> sources.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from collections import Counter
from pathlib import Path

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.time import Time
from PIL import Image

import test as pipeline

# Bump this when the pipeline, manifest schema or rendering changes.  It is
# part of the dataset id, so results made with old pipeline logic are ignored.
VERSION = 3

REPO = Path(__file__).resolve().parent
DATA_ROOT = REPO / "data"
CUTOUT_ROOT = REPO / "cutout_cache"

# One build should stay a few gigabytes at most.
MAX_EXPOSURES = 500

BAND_SHORT = {band: band[-2:] for band in pipeline.BANDS}

# Cutouts are downloaded at a few fixed sizes.  The archive cutout is a
# rotated box, so a north-up square of side `fov` needs a download of about
# 1.5 x fov to stay fully covered after reprojection.  Fixed sizes (rather
# than 1.5 x fov exactly) mean moving the FOV slider reuses one download.
FETCH_MARGIN = 1.5
FETCH_TIERS_DEG = (0.3, 0.5, 0.8, 1.0, 1.5)

NO_MOTION = (0.0 * u.mas / u.yr, 0.0 * u.mas / u.yr)


def fetch_tier(fov_deg: float) -> float:
    """Smallest download size that covers a north-up field of `fov_deg`."""
    needed = FETCH_MARGIN * fov_deg
    for tier in FETCH_TIERS_DEG:
        if needed <= tier + 1e-9:
            return tier
    return FETCH_TIERS_DEG[-1]


def dataset_id(ra_deg, dec_deg, fov_deg, t0, t1, bands, track) -> str:
    """Stable short id for one set of user choices.

    Same request -> same id -> the server can answer from disk.  The position
    is rounded far below one pixel (0.1"), which also means neighbouring
    clicks on the sky share a dataset.
    """
    key = {
        "v": VERSION,
        "ra": round(float(ra_deg), 4),
        "dec": round(float(dec_deg), 4),
        "fov": round(float(fov_deg), 3),
        "t0": t0 or "",
        "t1": t1 or "",
        "bands": list(bands),
        "track": bool(track),
    }
    blob = json.dumps(key, sort_keys=True).encode()
    return hashlib.sha1(blob).hexdigest()[:12]


def _num(value, digits=6):
    """numpy/NaN-safe float for JSON."""
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(value):
        return None
    return round(value, digits)


def _png_from_frame(image, lo, hi):
    """Map MJy/sr to uint8, with a reserved value for "no data".

    Valid pixels are mapped to 1..255 and NaN to 0, so pure black in the
    figure always means "this frame does not cover that pixel", never "the
    faintest real pixel".
    """
    scaled = (image - lo) / (hi - lo)
    scaled = np.clip(scaled, 0.0, 1.0)
    out = np.where(np.isfinite(scaled), 1 + scaled * 254.0, 0.0)
    return out.astype(np.uint8)


def render_frames(frames, out_dir: Path, progress=None, subdir="frames",
                  stretch_override=None, should_cancel=None):
    """Write one PNG per frame and return (stretch, frame_entries).

    The stretch is shared by all frames of a band so that a change in
    brightness between visits is visible instead of being stretched away.
    Each frame's own sky level is removed first (a constant per frame), which
    stops a visit with a brighter zodiacal residual from washing out the rest.
    """
    frames = [f for f in frames if f.image_aligned is not None]
    frames.sort(key=lambda f: f.mjd)

    by_band = {}
    for frame in frames:
        by_band.setdefault(frame.band, []).append(frame)

    background = {id(f): float(np.nanmedian(f.image_aligned)) for f in frames}
    stretch = {}
    if stretch_override:
        stretch.update(stretch_override)

    for band, band_frames in by_band.items():
        if band in stretch:
            continue
        values = np.concatenate([
            (f.image_aligned - background[id(f)]).ravel()
            for f in band_frames
        ])
        values = values[np.isfinite(values)]
        lo, hi = np.nanpercentile(values, [1.0, 99.5])
        if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
            lo, hi = 0.0, 1.0
        stretch[band] = (float(lo), float(hi))

    frames_dir = out_dir / subdir
    frames_dir.mkdir(parents=True, exist_ok=True)

    entries = []
    for i, frame in enumerate(frames):
        if should_cancel is not None and should_cancel():
            raise pipeline.BuildCancelled("build cancelled")
        lo, hi = stretch[frame.band]
        image = frame.image_aligned - background[id(frame)]
        name = f"{subdir}/f{i:03d}.png"
        # The WCS array has row 0 at the south edge; PIL writes row 0 at the
        # top.  Flip so the PNG is north-up like any normal image, and the
        # browser's (left, top) = (east, north) mapping needs no extra maths.
        Image.fromarray(np.flipud(_png_from_frame(image, lo, hi))).save(
            out_dir / name, optimize=True)

        scale_deg = frame.pixel_scale_arcsec / 3600.0
        entries.append({
            "index": i,
            "png": name,
            "band": frame.band,
            "band_label": BAND_SHORT[frame.band],
            "obs_id": frame.obs_id,
            "mjd": round(float(frame.mjd), 6),
            "iso": frame.obs_time.iso,
            "date": frame.obs_time.iso[:10],
            "wavelength_um": _num(frame.wavelength_um, 4),
            "bandwidth_um": _num(frame.bandwidth_um, 4),
            "flux_ujy": _num(frame.flux_ujy, 2),
            "err_ujy": _num(frame.err_ujy, 2),
            "peak_snr": _num(frame.peak_snr, 2),
            "target_flag": int(frame.target_flag),
            "target_flag_names": frame.target_flag_names,
            "target_bad": bool(frame.target_flag & frame.bad_bits),
            "target_offset_px": [
                _num(-frame.shift_ra_deg / scale_deg, 2),
                _num(frame.shift_dec_deg / scale_deg, 2),
            ],
            "centroid_offset_px": (
                None if frame.centroid_offset_px is None
                else [_num(v, 2) for v in frame.centroid_offset_px]
            ),
            "background_mjy_sr": _num(background[id(frame)], 6),
        })

        if progress is not None and (i % 16 == 0 or i == len(frames) - 1):
            progress(i + 1, len(frames))

    stretch_json = {
        band: [_num(lo, 6), _num(hi, 6)]
        for band, (lo, hi) in stretch.items()
    }
    return stretch_json, entries


def build_dataset(ra_deg, dec_deg, dataset_key, fov_deg, t0, t1, bands,
                  track=False, proper_motion=NO_MOTION, max_frames=None,
                  progress=None, should_cancel=None):
    """Run the pipeline and write data/<dataset_key>/.

    `progress(stage, done, total)` is called often enough for a progress bar.
    Stages: query, downloading, measuring, aligning, rendering, preview.
    """
    out_dir = DATA_ROOT / dataset_key
    manifest_file = out_dir / "manifest.json"
    if manifest_file.exists():
        try:
            m = json.loads(manifest_file.read_text())
            if m.get("complete", True):
                return out_dir
        except Exception:
            pass

    def report(stage, done=0, total=0):
        if progress is not None:
            progress(stage, done, total)

    try:
        if should_cancel is not None and should_cancel():
            raise pipeline.BuildCancelled("build cancelled")

        target = SkyCoord(ra=ra_deg * u.deg, dec=dec_deg * u.deg, frame="icrs")
        ra = target.ra.deg
        dec = target.dec.deg

        # --- 1. Which exposures cover this position? --------------------------
        report("query", 0, 1)
        position_now = pipeline.target_position_at(target, Time.now(), proper_motion)
        # Ensure the cutout cache directory exists before writing
        CUTOUT_ROOT.mkdir(parents=True, exist_ok=True)
        sia_path = CUTOUT_ROOT / f"exposures_{ra:.3f}_{dec:.3f}.ecsv".replace("-", "m")
        exposures = pipeline.get_exposures(position_now, pipeline.SEARCH_RADIUS_DEG,
                                           sia_path)
        if len(exposures) == 0:
            raise RuntimeError("the archive has no exposures at this position")

        if should_cancel is not None and should_cancel():
            raise pipeline.BuildCancelled("build cancelled")

        t_min = np.asarray(exposures["t_min"], dtype=float)
        reference_time = Time(float(np.nanmedian(t_min)), format="mjd")
        reference = pipeline.target_position_at(target, reference_time,
                                                proper_motion)

        # The cutout centre is fixed on the full archive span, not on the chosen
        # date window, so changing the dates never invalidates the download cache.
        exposures = pipeline.select_time_range(exposures, t0, t1)
        if len(exposures) == 0:
            raise RuntimeError("no exposures in that time range")

        # Footprint pre-check: skip exposures whose detector polygon does not contain target
        exposures = pipeline.filter_footprint(exposures, target, proper_motion)
        if len(exposures) == 0:
            raise RuntimeError("no exposures cover the target footprint")

        wanted = set(bands)
        bands_present = [b for b in pipeline.BANDS
                         if b in wanted
                         and any(exposures["energy_bandpassname"] == b)]
        if not bands_present:
            raise RuntimeError("no exposures in the selected bands")

        # Safety net: a position near the galactic plane can return thousands of
        # exposures, and every one is a multi-megabyte download.  Refuse clearly
        # rather than fill the disk; the user can pick a shorter date range.
        n_planned = int(sum(np.sum(exposures["energy_bandpassname"] == b)
                            for b in bands_present))
        if n_planned > MAX_EXPOSURES:
            raise RuntimeError(
                f"{n_planned} exposures match; narrow the date range or pick "
                f"fewer detectors (limit is {MAX_EXPOSURES})")

        out_wcs, n = pipeline.north_up_wcs(reference.ra.deg, reference.dec.deg,
                                           fov_deg)
        cd = np.asarray(out_wcs.wcs.cd, dtype=float)
        scale_arcsec = abs(float(cd[0, 0])) * 3600.0
        cutout_size = fetch_tier(fov_deg)

        preview_stretch = None
        # --- Progressive Preview (Phase 4) ------------------------------------
        # Choose preview band: detector with the most exposures among bands_present
        band_counts = Counter(exposures["energy_bandpassname"])
        preview_band = max(bands_present, key=lambda b: band_counts[b])
        preview_mask = exposures["energy_bandpassname"] == preview_band
        preview_all_rows = exposures[preview_mask]
        preview_all_rows = preview_all_rows[np.argsort(np.asarray(preview_all_rows["t_min"], dtype=float))]

        # Up to 12 frames evenly spaced across the exposure list, including first and last
        if len(preview_all_rows) <= 12:
            preview_rows = preview_all_rows
        else:
            indices = np.round(np.linspace(0, len(preview_all_rows) - 1, 12)).astype(int)
            preview_rows = preview_all_rows[indices]

        # Check if a partial preview already exists on disk
        has_partial_manifest = False
        if manifest_file.exists():
            try:
                m = json.loads(manifest_file.read_text())
                has_partial_manifest = (m.get("preview") is True)
                if has_partial_manifest and m.get("stretch"):
                    preview_stretch = {k: (v[0], v[1]) for k, v in m["stretch"].items()}
            except Exception:
                pass

        if not has_partial_manifest and len(preview_rows) > 0:
            report("downloading", 0, len(preview_rows))
            preview_frames = pipeline.download_frames(
                preview_rows, [preview_band], target, reference, cutout_size,
                cutout_dir=CUTOUT_ROOT, proper_motion=proper_motion,
                reuse_sizes=FETCH_TIERS_DEG, should_cancel=should_cancel,
                progress=lambda d, t: report("downloading", d, t),
                measure_progress=lambda d, t: report("measuring", d, t))

            if preview_frames:
                report("aligning", 0, len(preview_frames))
                pipeline.align_frames(preview_frames, reference.ra.deg, reference.dec.deg,
                                      fov_deg=fov_deg, track=track, release_source=True,
                                      aux_planes=False, should_cancel=should_cancel)
                preview_frames = [f for f in preview_frames if f.image_aligned is not None]

                if preview_frames:
                    report("rendering", 0, len(preview_frames))
                    preview_stretch_dict, preview_entries = render_frames(
                        preview_frames, out_dir, subdir="preview",
                        should_cancel=should_cancel,
                        progress=lambda d, t: report("rendering", d, t))
                    if preview_band in preview_stretch_dict:
                        preview_stretch = {
                            preview_band: (preview_stretch_dict[preview_band][0],
                                           preview_stretch_dict[preview_band][1])
                        }

                    p_dates = [e["date"] for e in preview_entries]
                    p_wavelengths = [e["wavelength_um"] for e in preview_entries
                                     if e["wavelength_um"] is not None]
                    partial_manifest = {
                        "version": VERSION,
                        "id": dataset_key,
                        "complete": False,
                        "preview": True,
                        "preview_band": preview_band,
                        "planned": {"frames": n_planned, "bands": len(bands_present)},
                        "render_version": "preview",
                        "created_utc": Time.now().iso,
                        "target": {
                            "ra_deg": _num(ra, 6),
                            "dec_deg": _num(dec, 6),
                            "pm_ra_mas_yr": _num(proper_motion[0].to_value(u.mas / u.yr), 2),
                            "pm_dec_mas_yr": _num(proper_motion[1].to_value(u.mas / u.yr), 2),
                        },
                        "request": {
                            "fov_deg": float(fov_deg),
                            "t0": t0,
                            "t1": t1,
                            "bands": list(bands),
                            "bands_present": bands_present,
                            "track": bool(track),
                            "cutout_size_deg": cutout_size,
                        },
                        "grid": {
                            "n": int(n),
                            "pixel_scale_arcsec": _num(scale_arcsec, 4),
                            "crval": [_num(out_wcs.wcs.crval[0], 7),
                                      _num(out_wcs.wcs.crval[1], 7)],
                            "crpix": [_num(out_wcs.wcs.crpix[0], 3),
                                      _num(out_wcs.wcs.crpix[1], 3)],
                            "cd_deg": [[_num(v, 10) for v in row] for row in cd],
                        },
                        "stretch": preview_stretch_dict,
                        "summary": {
                            "n_frames": len(preview_entries),
                            "n_bands": 1,
                            "date_min": min(p_dates) if p_dates else None,
                            "date_max": max(p_dates) if p_dates else None,
                            "wavelength_min": min(p_wavelengths) if p_wavelengths else None,
                            "wavelength_max": max(p_wavelengths) if p_wavelengths else None,
                        },
                        "frames": preview_entries,
                    }
                    out_dir.mkdir(parents=True, exist_ok=True)
                    tmp = out_dir / "manifest.json.part"
                    tmp.write_text(json.dumps(partial_manifest, indent=1))
                    tmp.replace(manifest_file)
                    report("preview", len(preview_entries), n_planned)

        # --- 2. Full download and measure -------------------------------------
        report("downloading", 0, len(exposures))
        frames = pipeline.download_frames(
            exposures, bands_present, target, reference, cutout_size,
            max_frames=max_frames, cutout_dir=CUTOUT_ROOT,
            proper_motion=proper_motion,
            reuse_sizes=FETCH_TIERS_DEG, should_cancel=should_cancel,
            progress=lambda d, t: report("downloading", d, t),
            measure_progress=lambda d, t: report("measuring", d, t))

        if not frames:
            raise RuntimeError("no cutouts could be retrieved (the archive refused "
                               "every exposure)")

        # --- 3. One common north-up grid --------------------------------------
        report("aligning", 0, len(frames))
        pipeline.align_frames(frames, reference.ra.deg, reference.dec.deg,
                              fov_deg=fov_deg, track=track, release_source=True,
                              aux_planes=False, should_cancel=should_cancel)
        frames = [f for f in frames if f.image_aligned is not None]
        if not frames:
            raise RuntimeError("reproject produced no aligned frames")

        # The footprint and the per-frame variance/flags were needed only for the
        # alignment; dropping them keeps the render phase to one image per frame.
        for frame in frames:
            frame.footprint = None
            frame.variance_aligned = None
            frame.flags_aligned = None

        # --- 4. PNGs + manifest ----------------------------------------------
        report("rendering", 0, len(frames))
        stretch, entries = render_frames(
            frames, out_dir, subdir="frames",
            stretch_override=preview_stretch,
            should_cancel=should_cancel,
            progress=lambda d, t: report("rendering", done=d, total=t))

        dates = [e["date"] for e in entries]
        wavelengths = [e["wavelength_um"] for e in entries
                       if e["wavelength_um"] is not None]
        manifest = {
            "version": VERSION,
            "id": dataset_key,
            "complete": True,
            "preview": False,
            "preview_band": None,
            "planned": {"frames": len(entries), "bands": len(bands_present)},
            "render_version": "1",
            "created_utc": Time.now().iso,
            "target": {
                "ra_deg": _num(ra, 6),
                "dec_deg": _num(dec, 6),
                "pm_ra_mas_yr": _num(proper_motion[0].to_value(u.mas / u.yr), 2),
                "pm_dec_mas_yr": _num(proper_motion[1].to_value(u.mas / u.yr), 2),
            },
            "request": {
                "fov_deg": float(fov_deg),
                "t0": t0,
                "t1": t1,
                "bands": list(bands),
                "bands_present": bands_present,
                "track": bool(track),
                "cutout_size_deg": cutout_size,
            },
            "grid": {
                "n": int(n),
                "pixel_scale_arcsec": _num(scale_arcsec, 4),
                "crval": [_num(out_wcs.wcs.crval[0], 7),
                          _num(out_wcs.wcs.crval[1], 7)],
                "crpix": [_num(out_wcs.wcs.crpix[0], 3),
                          _num(out_wcs.wcs.crpix[1], 3)],
                "cd_deg": [[_num(v, 10) for v in row] for row in cd],
            },
            "stretch": stretch,
            "summary": {
                "n_frames": len(entries),
                "n_bands": len({e["band"] for e in entries}),
                "date_min": min(dates) if dates else None,
                "date_max": max(dates) if dates else None,
                "wavelength_min": min(wavelengths) if wavelengths else None,
                "wavelength_max": max(wavelengths) if wavelengths else None,
            },
            "frames": entries,
        }

        # Write to a temporary file and rename, so a crash never leaves a
        # half-written manifest that the server would treat as a finished dataset.
        tmp = out_dir / "manifest.json.part"
        tmp.write_text(json.dumps(manifest, indent=1))
        tmp.replace(manifest_file)

        # Remove preview directory after final manifest is in place
        preview_dir = out_dir / "preview"
        if preview_dir.exists():
            shutil.rmtree(preview_dir, ignore_errors=True)

        return out_dir
    except pipeline.BuildCancelled:
        # Keep partial preview if one exists; otherwise clean up incomplete dataset
        if not manifest_file.exists():
            remove_dataset(dataset_key)
        raise


def remove_dataset(dataset: str):
    """Delete one dataset directory (used by the tests / cleanup button)."""
    path = DATA_ROOT / dataset
    if path.exists():
        shutil.rmtree(path)
