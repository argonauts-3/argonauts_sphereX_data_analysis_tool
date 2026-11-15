"""Flask server for the SPHEREx time-series explorer.

The app is deliberately thin.  All the astronomy is in test.py, the dataset
building and PNG rendering is in dataset.py, and this file only does:

    * validate what the page asks for,
    * run one build at a time in a worker thread (downloads are slow),
    * serve the manifest, the frame PNGs and the difference images.

Run it with:

    .venv/bin/python app.py
    # then open http://127.0.0.1:5000

Everything the page needs is also accepted as URL parameters, e.g.

    /?name=Barnard%27s%20Star&fov=0.3&t0=2025-05-01&bands=D5&play=1
    /?ra=133.818908&dec=-7.247048&fov=0.2&embed=1
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np
from astropy import units as u
from astropy.time import Time
from flask import Flask, jsonify, request, send_file, send_from_directory
from PIL import Image

import dataset
import test as pipeline

REPO = Path(__file__).resolve().parent
STATIC = REPO / "static"
DATA_ROOT = dataset.DATA_ROOT

# One build at a time.  Each build can download a gigabyte, so two at once
# would only make both slower and hammer the archive.
EXECUTOR = ThreadPoolExecutor(max_workers=1)
JOBS = {}
STACK_JOBS = {}
JOBS_LOCK = threading.Lock()

ID_RE = re.compile(r"^[0-9a-f]{12}$")
STACK_ID_RE = re.compile(r"^[0-9a-f]{16}$")

# Small curated list for the drop-down.  Proper motions are included only
# where they are well known; the rest are slow enough to be irrelevant over
# the one-year archive baseline.  "pm" is [pm_ra_cosdec, pm_dec] in mas/yr.
TARGETS = [
    {
        "name": "WISE 0855-0714",
        "query": "WISE J085510.83-071442.5",
        "ra": 133.818908,
        "dec": -7.247048,
        "pm": [-8123.7, 673.2],
        "note": "coldest known brown dwarf, very red",
    },
    {
        "name": "Barnard's Star",
        "query": "Barnard's Star",
        "ra": 269.452077,
        "dec": 4.693365,
        "pm": [-798.71, 10337.77],
        "note": "fastest proper motion of any star",
    },
    {
        "name": "Epsilon Indi B",
        "query": "Epsilon Indi B",
        "ra": 331.044147,
        "dec": -56.782844,
        "pm": [3960.9, -2539.2],
        "note": "T dwarf companion, 7 arcmin from Epsilon Indi A",
    },
    {
        "name": "RW Aurigae",
        "query": "RW Aurigae",
        "ra": 76.956526,
        "dec": 30.401438,
        "pm": [0.0, 0.0],
        "note": "young star with deep eclipses",
    },
    {
        "name": "R Draconis",
        "query": "R Draconis",
        "ra": 248.167611,
        "dec": 66.754979,
        "pm": [0.0, 0.0],
        "note": "Mira variable, large brightness changes",
    },
]

app = Flask(__name__, static_folder=str(STATIC), static_url_path="/static")


@app.after_request
def cache_immutable_files(response):
    """Let the browser keep dataset files forever.

    A dataset id is a hash of the request, so `/data/<id>/...` never changes
    once it exists.  The same is true of a difference image for a given pair
    of frames.  Only successful responses are marked cacheable: a 404 while a
    build is still running must not stick in the browser cache.
    """
    if response.status_code == 200 and (
            request.path.startswith("/data/")
            or request.path.startswith("/api/diff/")):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


# ==========================================================================
# Request parsing
# ==========================================================================

def _band_list(items):
    """Accept 'D5', 'SPHEREx-D5' or a mixed list; return full band names."""
    if not items:
        return list(pipeline.BANDS)
    out = []
    for item in items:
        item = str(item).strip()
        full = item if item in pipeline.BANDS else f"SPHEREx-{item.upper()}"
        if full not in pipeline.BANDS:
            raise ValueError(f"unknown band: {item}")
        if full not in out:
            out.append(full)
    return out


def _match_curated(ra_deg, dec_deg):
    """The curated entry at these coordinates, if any (for its proper motion)."""
    for target in TARGETS:
        if abs(target["ra"] - ra_deg) < 3e-4 and abs(target["dec"] - dec_deg) < 3e-4:
            return target
    return None


def parse_build_request(data):
    """Turn JSON from the page into the arguments of dataset.build_dataset."""
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object")

    name = (data.get("name") or "").strip()
    ra = data.get("ra")
    dec = data.get("dec")

    if ra is None or dec is None:
        # Check the curated list before Sesame: its display names are not
        # always resolvable there ("WISE 0855-0714" vs the canonical
        # "WISE J085510.83-071442.5"), and we already know the coordinates.
        curated = next(
            (t for t in TARGETS if t["query"].lower() == name.lower()
             or t["name"].lower() == name.lower()), None)
        if curated:
            ra_deg, dec_deg = curated["ra"], curated["dec"]
        else:
            if not name:
                raise ValueError("give a target name or ra/dec")
            coord = pipeline.resolve_name(name)
            ra_deg, dec_deg = float(coord.ra.deg), float(coord.dec.deg)
    else:
        try:
            ra_deg, dec_deg = float(ra), float(dec)
        except (TypeError, ValueError):
            raise ValueError("ra and dec must be numbers in degrees")
        if not (0.0 <= ra_deg < 360.0 and -90.0 <= dec_deg <= 90.0):
            raise ValueError("ra must be 0..360 and dec -90..90")
        curated = _match_curated(ra_deg, dec_deg)

    pm = curated["pm"] if curated else [0.0, 0.0]
    label = curated["name"] if curated else (name or "custom field")

    try:
        fov = float(data.get("fov", 0.3))
    except (TypeError, ValueError):
        raise ValueError("fov must be a number in degrees")
    if not 0.1 <= fov <= 1.0:
        raise ValueError("fov must be between 0.1 and 1.0 degrees")
    fov = round(fov, 3)

    t0 = (data.get("t0") or "").strip() or None
    t1 = (data.get("t1") or "").strip() or None
    try:
        if t0:
            Time(t0)
        if t1:
            Time(t1)
        if t0 and t1 and Time(t0) > Time(t1):
            raise ValueError("start date is after end date")
    except ValueError:
        raise
    except Exception:
        raise ValueError("dates must look like 2026-01-31")

    bands = _band_list(data.get("bands"))

    return {
        "name": label,
        "ra": ra_deg,
        "dec": dec_deg,
        "fov": fov,
        "t0": t0,
        "t1": t1,
        "bands": bands,
        "track": bool(data.get("track", False)),
        "pm": pm,
    }


def public_params(params):
    """The part of a parsed request that belongs in a shareable URL."""
    return {
        "name": params["name"],
        "ra": float(params["ra"]),
        "dec": float(params["dec"]),
        "fov": params["fov"],
        "t0": params["t0"],
        "t1": params["t1"],
        "bands": [b[-2:] for b in params["bands"]],
        "track": params["track"],
    }


# ==========================================================================
# Build jobs
# ==========================================================================

def _set_job(key, **fields):
    with JOBS_LOCK:
        job = JOBS.setdefault(key, {})
        job.update(fields)


def _run_build(key, params):
    cancel_event = None
    with JOBS_LOCK:
        job = JOBS.get(key)
        if job and "cancel_event" in job:
            cancel_event = job["cancel_event"]

    def progress(stage, done, total):
        if stage == "preview":
            _set_job(key, preview_ready=True, preview_frames=int(done),
                     planned_frames=int(total), stage="preview")
        else:
            _set_job(key, stage=stage, done=int(done), total=int(total))

    _set_job(key, state="running", stage="query", done=0, total=0, error=None)
    try:
        dataset.build_dataset(
            params["ra"], params["dec"], key, params["fov"],
            params["t0"], params["t1"], params["bands"],
            track=params["track"],
            proper_motion=(params["pm"][0] * u.mas / u.yr,
                           params["pm"][1] * u.mas / u.yr),
            progress=progress,
            should_cancel=cancel_event.is_set if cancel_event is not None else None,
        )
        _set_job(key, state="ready", stage="ready", error=None,
                 done=1, total=1)
    except pipeline.BuildCancelled:
        print(f"build cancelled for {key}")
        _set_job(key, state="cancelled", stage="cancelled",
                 error="Build was cancelled.")
    except Exception as exc:                    # noqa: BLE001 - report to the page
        traceback.print_exc()
        _set_job(key, state="error", stage="error", error=str(exc))
        # A failed build leaves no manifest; do not keep its half-written
        # frames around pretending to be a dataset.
        dataset.remove_dataset(key)


def _set_stack_job(dataset_key, stack_key, **fields):
    with JOBS_LOCK:
        job = STACK_JOBS.setdefault((dataset_key, stack_key), {})
        job.update(fields)


def _run_stack(dataset_key, stack_key, manifest, entries, params):
    def progress(phase, done, total):
        _set_stack_job(dataset_key, stack_key, phase=phase,
                       done=int(done), total=int(total))

    _set_stack_job(dataset_key, stack_key, state="running", phase="starting",
                   done=0, total=len(entries), error=None)
    try:
        result = dataset.build_stack_from_cutouts(
            dataset_key, stack_key, manifest, entries, params, progress=progress)
        _set_stack_job(dataset_key, stack_key, state="ready", phase="ready",
                       done=len(entries), total=len(entries), result=result,
                       error=None)
    except Exception as exc:                    # noqa: BLE001 - report to the UI
        traceback.print_exc()
        _set_stack_job(dataset_key, stack_key, state="error", phase="error",
                       error=str(exc))


# ==========================================================================
# Routes
# ==========================================================================

@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/guide")
def guide():
    return send_file(REPO / "GUIDE.md", mimetype="text/markdown")


@app.get("/api/targets")
def api_targets():
    return jsonify([{k: t[k] for k in ("name", "ra", "dec", "pm", "note")}
                    for t in TARGETS])


@app.get("/api/resolve")
def api_resolve():
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify(error="missing name"), 400
    try:
        coord = pipeline.resolve_name(name)
    except ValueError as exc:
        return jsonify(error=str(exc)), 404
    return jsonify(ra=float(coord.ra.deg), dec=float(coord.dec.deg))


@app.post("/api/build")
def api_build():
    try:
        params = parse_build_request(request.get_json(force=True, silent=True))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    key = dataset.dataset_id(params["ra"], params["dec"], params["fov"],
                             params["t0"], params["t1"], params["bands"],
                             params["track"])
    manifest = DATA_ROOT / key / "manifest.json"
    if manifest.exists():
        try:
            m = json.loads(manifest.read_text())
            if m.get("complete", True):
                return jsonify(id=key, state="ready", params=public_params(params))
        except Exception:
            pass

    with JOBS_LOCK:
        job = JOBS.get(key)
        # No job, a failed job, a cancelled job, or a "ready" job whose directory was deleted:
        # all of those need a new build.  A queued/running job is left alone.
        if job is None or job.get("state") in ("error", "cancelled", "ready"):
            # The newest request wins.  A build that is already running or
            # queued is cancelled so the worker can immediately start the new target.
            for other_key, other in JOBS.items():
                if other_key != key and other.get("state") in ("queued", "running"):
                    if "cancel_event" in other:
                        other["cancel_event"].set()
                    other.update(
                        state="cancelled", stage="cancelled",
                        error="That build was replaced by a newer request. "
                              "Click Show again to run it.")
            cancel_event = threading.Event()
            JOBS[key] = {"state": "queued", "stage": "queued",
                         "done": 0, "total": 0, "error": None,
                         "name": params["name"], "fov": params["fov"],
                         "cancel_event": cancel_event,
                         "preview_ready": False}
            EXECUTOR.submit(_run_build, key, params)
    return jsonify(id=key, state="queued", params=public_params(params))


@app.post("/api/job/<key>/cancel")
def api_job_cancel(key):
    if not ID_RE.match(key):
        return jsonify(error="bad dataset id"), 400
    with JOBS_LOCK:
        job = JOBS.get(key)
        if not job:
            return jsonify(error="unknown job"), 404
        if "cancel_event" in job:
            job["cancel_event"].set()
        job.update(state="cancelling", stage="cancelling")
    return jsonify(status="cancelling")


@app.get("/api/job/<key>")
def api_job(key):
    if not ID_RE.match(key):
        return jsonify(error="bad dataset id"), 400
    manifest = DATA_ROOT / key / "manifest.json"
    is_ready = False
    if manifest.exists():
        try:
            m = json.loads(manifest.read_text())
            if m.get("complete", True):
                is_ready = True
        except Exception:
            pass
    if is_ready:
        return jsonify(id=key, state="ready")

    with JOBS_LOCK:
        raw_job = JOBS.get(key)
        if not raw_job:
            return jsonify(error="unknown dataset"), 404
        job = {k: v for k, v in raw_job.items() if k != "cancel_event"}
        if job.get("state") == "queued":
            # Say what the one build worker is doing, otherwise "Queued" can
            # look like a frozen page when a long download is ahead of it.
            for other_key, other in JOBS.items():
                if other_key != key and other.get("state") == "running":
                    job["queued_behind"] = {
                        "name": other.get("name") or "another build",
                        "fov": other.get("fov"),
                        "stage": other.get("stage"),
                        "done": other.get("done", 0),
                        "total": other.get("total", 0),
                    }
                    break
    return jsonify(id=key, **job)


def _iso_date(value, label):
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be an ISO date")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO date such as 2026-01-31") from exc


@app.post("/api/stack/<key>")
def api_stack(key):
    """Queue a same-detector inverse-variance stack from cached FITS cutouts."""
    if not ID_RE.match(key):
        return jsonify(error="bad dataset id"), 400
    body = request.get_json(force=True, silent=True)
    if not isinstance(body, dict):
        return jsonify(error="expected a JSON object"), 400

    manifest_path = DATA_ROOT / key / "manifest.json"
    if not manifest_path.exists():
        return jsonify(error="dataset not built"), 404
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError):
        return jsonify(error="dataset manifest could not be read"), 500
    if manifest.get("complete") is False:
        return jsonify(error="wait for the full dataset before stacking"), 409

    band = body.get("band")
    if band not in pipeline.BANDS:
        return jsonify(error="choose one valid detector"), 400
    try:
        wavelength_center = float(body.get("wavelength_center_um"))
        wavelength_tolerance = float(body.get("wavelength_tolerance_um"))
    except (TypeError, ValueError):
        return jsonify(error="wavelength centre and tolerance must be numbers"), 400
    if (not np.isfinite(wavelength_center) or not 0.0 < wavelength_center < 20.0
            or not np.isfinite(wavelength_tolerance)
            or not 0.0 <= wavelength_tolerance <= 1.0):
        return jsonify(error="invalid wavelength centre or tolerance"), 400
    try:
        date_start = _iso_date(body.get("date_start"), "start date")
        date_end = _iso_date(body.get("date_end"), "end date")
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    if date_start and date_end and date_start > date_end:
        return jsonify(error="start date is after end date"), 400

    raw_indices = body.get("indices")
    if not isinstance(raw_indices, list):
        return jsonify(error="frame indices must be a list"), 400
    valid_indices = set()
    for value in raw_indices:
        if isinstance(value, bool) or not isinstance(value, int):
            return jsonify(error="frame indices must be integers"), 400
        valid_indices.add(value)

    all_frames = manifest.get("frames", [])
    if len(valid_indices) > len(all_frames):
        return jsonify(error="too many frame indices"), 400
    selected = []
    for entry in all_frames:
        index = entry.get("index")
        if index not in valid_indices or entry.get("band") != band:
            continue
        wavelength = entry.get("wavelength_um")
        if wavelength is None or not np.isfinite(float(wavelength)):
            continue
        if abs(float(wavelength) - wavelength_center) > wavelength_tolerance + 1e-12:
            continue
        frame_date = entry.get("date")
        if date_start and frame_date < date_start:
            continue
        if date_end and frame_date > date_end:
            continue
        selected.append(entry)

    if len(selected) < 2:
        return jsonify(error=f"only {len(selected)} checked frame(s) match; "
                              "at least two are needed"), 400

    params = {
        "band": band,
        "wavelength_center_um": round(wavelength_center, 8),
        "wavelength_tolerance_um": round(wavelength_tolerance, 8),
        "date_start": date_start,
        "date_end": date_end,
        "indices": [int(entry["index"]) for entry in selected],
        "version": dataset.VERSION,
    }
    signature = json.dumps({"dataset": key, **params}, sort_keys=True,
                           separators=(",", ":")).encode()
    stack_key = hashlib.sha256(signature).hexdigest()[:16]
    stack_dir = DATA_ROOT / key / "stacks" / stack_key
    metadata_path = stack_dir / "metadata.json"
    if metadata_path.exists():
        try:
            result = json.loads(metadata_path.read_text())
            return jsonify(id=stack_key, state="ready", result=result)
        except (OSError, json.JSONDecodeError):
            pass

    job_key = (key, stack_key)
    with JOBS_LOCK:
        existing = STACK_JOBS.get(job_key)
        if existing and existing.get("state") in ("queued", "running"):
            return jsonify(id=stack_key, state=existing["state"]), 202
        STACK_JOBS[job_key] = {
            "state": "queued", "phase": "queued", "done": 0,
            "total": len(selected), "error": None,
        }
        EXECUTOR.submit(_run_stack, key, stack_key, manifest, selected, params)
    return jsonify(id=stack_key, state="queued", total=len(selected)), 202


@app.get("/api/stack/<key>/<stack_key>")
def api_stack_status(key, stack_key):
    if not ID_RE.match(key) or not STACK_ID_RE.match(stack_key):
        return jsonify(error="bad stack id"), 400
    metadata_path = DATA_ROOT / key / "stacks" / stack_key / "metadata.json"
    if metadata_path.exists():
        try:
            result = json.loads(metadata_path.read_text())
            return jsonify(id=stack_key, state="ready", result=result)
        except (OSError, json.JSONDecodeError):
            pass
    with JOBS_LOCK:
        job = STACK_JOBS.get((key, stack_key))
        if not job:
            return jsonify(error="unknown stack job"), 404
        return jsonify(id=stack_key, **job)


@app.get("/api/dataset/<key>")
def api_dataset(key):
    if not ID_RE.match(key):
        return jsonify(error="bad dataset id"), 400
    return send_from_directory(DATA_ROOT / key, "manifest.json")


@app.get("/data/<key>/<path:filename>")
def api_file(key, filename):
    if not ID_RE.match(key):
        return jsonify(error="bad dataset id"), 400
    return send_from_directory(DATA_ROOT / key, filename)


@app.get("/api/diff/<key>")
def api_diff(key):
    """Quick-look A-B or (A+B)/2 from two rendered frames.

    The arithmetic is done on the displayed 8-bit values, not the original
    float images: the page only has the PNGs, and at ~2 uJy per grey level the
    quantisation is below the per-pixel noise.  This is a visual tool, not a
    photometric measurement; flux values stay in the manifest.
    """
    if not ID_RE.match(key):
        return jsonify(error="bad dataset id"), 400
    try:
        a = int(request.args.get("a"))
        b = int(request.args.get("b"))
    except (TypeError, ValueError):
        return jsonify(error="a and b must be frame numbers"), 400
    mode = request.args.get("mode", "sub")
    if mode not in ("sub", "add"):
        return jsonify(error="mode must be sub or add"), 400

    manifest_path = DATA_ROOT / key / "manifest.json"
    if not manifest_path.exists():
        return jsonify(error="dataset not built"), 404
    manifest = json.loads(manifest_path.read_text())
    frames = manifest["frames"]
    if not (0 <= a < len(frames) and 0 <= b < len(frames)):
        return jsonify(error="frame number out of range"), 400
    if frames[a]["band"] != frames[b]["band"]:
        return jsonify(error="pick two frames from the same detector: a "
                             "difference between bands is not a difference image"), 400

    cache = DATA_ROOT / key / f"diff_{mode}_{a:03d}_{b:03d}.png"
    if not cache.exists():
        def grey(index):
            path = DATA_ROOT / key / frames[index]["png"]
            return np.asarray(Image.open(path).convert("L"), dtype=np.float32) / 255.0

        first, second = grey(a), grey(b)
        covered = (first > 0) & (second > 0)          # 0 is the "no data" value

        if mode == "sub":
            data = first - second
            values = data[covered]
            sigma = 1.4826 * float(np.median(np.abs(values - np.median(values)))) \
                if values.size else 0.0
            scale = max(3.0 * sigma, 1e-6)
            v = np.clip(data / scale, -1.0, 1.0)
            rgb = np.empty(data.shape + (3,), dtype=np.uint8)
            # Blue = A fainter than B, white = same, red = A brighter than B.
            neg = v < 0
            rgb[..., 0] = np.where(neg, 1.0 + v, 1.0) * 255
            rgb[..., 1] = np.where(neg, 1.0 + v, 1.0 - v) * 255
            rgb[..., 2] = np.where(neg, 1.0, 1.0 - v) * 255
        else:
            data = 0.5 * (first + second)
            values = data[covered]
            lo, hi = np.percentile(values, [1, 99.5]) if values.size else (0, 1)
            scaled = np.clip((data - lo) / max(hi - lo, 1e-6), 0, 1)
            grey = 1 + scaled * 254
            rgb = np.repeat(grey[..., None], 3, axis=2).astype(np.uint8)

        rgb[~covered] = 0
        Image.fromarray(rgb).save(cache, optimize=True)

    return send_file(cache, mimetype="image/png")


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    print(f"open http://{host}:{port}")
    app.run(host=host, port=port, threaded=True)
