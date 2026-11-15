"""
SPHEREx cutout pipeline
=======================

What this script does, in plain English
---------------------------------------
SPHEREx is a NASA space telescope that photographs the whole sky in infrared
light, split into many narrow colours (wavelengths).  For one chosen target
(a star, say), this script:

  1. Works out where the target is on the sky (from its name or coordinates).
  2. Asks the IRSA archive which SPHEREx exposures cover that spot.
  3. Downloads a small square image ("cutout") around the target from each.
  4. Measures how bright the target is in each cutout.
  5. Re-draws every cutout on one shared grid, north up, so they line up.
  6. Saves a contact sheet of the images and a brightness-vs-wavelength plot.

Mini-glossary
-------------
RA / Dec        Sky coordinates, like longitude / latitude.  RA is 0-360
                degrees (or 0-24 hours); Dec is -90 to +90 degrees.
J2000           The coordinates are quoted "as of the year 2000".
Proper motion   Nearby stars drift across the sky.  Our target moves ~8
                arcseconds per year, so we must correct its position for the
                date of each exposure.  (1 arcsecond = 1/3600 of a degree.)
IRSA / SIA      IRSA is NASA's infrared data archive.  SIA (Simple Image
                Access) is the web service we use to search it.
FITS            The standard astronomy image file format.  One file holds
                several named layers ("extensions"): IMAGE, VARIANCE, ...
WCS             "World Coordinate System": the recipe that converts between
                pixel positions (x, y) and sky positions (RA, Dec).
Band            SPHEREx has six detectors, D1..D6.  Each sees a different
                range of wavelengths, so together they give a rough spectrum.
Flux            Brightness.  The images are in MJy/sr (brightness per patch
                of sky); we convert the target's total to microjanskys (uJy).
Aperture        A small circle around the target.  We add up the light inside
                it and subtract the sky glow measured in a ring around it.
PSF             The blur a telescope makes of a point-like star.
Zodiacal light  Sunlight scattered by dust in our solar system.  It is a
                bright, uneven glow that we must subtract before measuring.
Flags           Each pixel carries a number whose bits mark problems
                (bad pixel, cosmic ray, ...).  We ignore pixels with bad bits.
"""

import hashlib
import io
import sys
import time
import warnings
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple, Optional

import astropy.units as u
import numpy as np
import requests
from astropy import log as astropy_log
from astropy.coordinates import Angle, SkyCoord
from astropy.coordinates.name_resolve import NameResolveError
from astropy.io import fits
from astropy.io.votable import parse_single_table
from astropy.table import Table, vstack
from astropy.time import Time
from astropy.wcs import WCS

# Silence two harmless sources of console noise.
try:
    from erfa import ErfaWarning
    warnings.filterwarnings("ignore", category=ErfaWarning)
except ImportError:
    pass
astropy_log.setLevel("ERROR")  # WCS(..., key="W") logs an INFO line every call

try:
    from reproject import reproject_interp
except ImportError:  # install with: pip install reproject
    reproject_interp = None


# ==========================================================================
# Settings: edit these to change what the script does
# ==========================================================================

# The target.  If TARGET_NAME resolves, it is used.  Otherwise we fall back to
# the coordinates below.  Hand-typed coordinates MUST be J2000: positions baked
# into designations like "085510.83-071442.5" are for the discovery date, and
# for a star moving 8"/yr that is ~85" away from the J2000 position.
TARGET_NAME = "WISE J085510.83-071442.5"
FALLBACK_RA = "133.818908"    # degrees; same spot as "08h55m16.5s" or "08:55:16.5" (hours)
FALLBACK_DEC = "-7.247048"    # degrees; same spot as "-07d14m49.4s" or "-07:14:49.4"

# Proper motion of the target, in milliarcseconds per year (WISE 0855).
PM_RA = -8123.7 * u.mas / u.yr    # along RA (already scaled by cos(Dec))
PM_DEC = 673.2 * u.mas / u.yr

FIELD_OF_VIEW_DEG = 0.2      # width of the final aligned images
SEARCH_RADIUS_DEG = 0.02     # archive search circle (see note in main())

# Only keep exposures taken in this date range (ISO dates, end date included).
# None means "no limit on that side".  Changing this does NOT invalidate the
# cutout cache, because cutouts stay centred on the full archive span.
TIME_RANGE = (None, None)    # e.g. ("2025-05-01", "2025-11-30")

# Cutouts are ~4 MB each.  None = every exposure the archive has for this
# position (258 files here, ~1.1 GB on disk, ~1 minute the first time with
# DOWNLOAD_WORKERS threads; after that they are all cached).
MAX_FRAMES_PER_BAND = None

# Downloads are pure waiting (1-3 s per file), so a few threads make the run
# several times faster without touching the measurement code.  Keep it modest:
# the archive starts answering 503 if you hammer it with too many at once.
DOWNLOAD_WORKERS = 8

# The six SPHEREx detectors.
BANDS = ("SPHEREx-D1", "SPHEREx-D2", "SPHEREx-D3",
         "SPHEREx-D4", "SPHEREx-D5", "SPHEREx-D6")

# Archive details.
SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
COLLECTIONS = ("spherex_dr1", "spherex_qr3")
RETRY_STATUS_CODES = (502, 503, 504)   # "server busy / gateway problem"
CUTOUT_CACHE_DIR = "cutout_cache"

# Measuring brightness.  The PSF is 3.1" wide but one pixel is 6.15", so a
# star is barely spread over more than one pixel.  Measured on bright stars,
# ~80% of the light falls within 2 pixels (12") of the centre, so we add up
# the pixels within 2 px and multiply by 1.25 to recover the missing light.
# This is a relative measurement, contaminated by anything within ~12".
APERTURE_RADIUS_PX = 2.0
APERTURE_CORRECTION = 1.25

# Flag bits that are normal, not problems.  Every other bit marks a bad pixel.
BENIGN_FLAGS = {"SOURCE", "FULLSAMPLE"}


# ==========================================================================
# Step 1: where is the target?
# ==========================================================================

def parse_angle_deg(text: str, label: str, bare_unit) -> float:
    """Convert text like "133.8", "08h55m10.8s" or "08:55:10.8" to degrees.

    A plain number is always degrees.  Colon/space-separated values have no
    units written out, so they are read in `bare_unit` (hours for RA,
    degrees for Dec, by astronomical convention).
    """
    text = text.strip()
    if not text:
        raise ValueError(f"{label} is empty")

    try:
        degrees = float(text)
    except ValueError:
        degrees = _angle_to_deg(text)                   # units written in text
        if degrees is None:
            degrees = _angle_to_deg(text, bare_unit)    # colon-separated
        if degrees is None:
            raise ValueError(f"cannot parse {label} {text!r}")

    if not np.isfinite(degrees):
        raise ValueError(f"{label} is not finite: {text!r}")
    return degrees


def _angle_to_deg(text, unit=None):
    """Parse with astropy; return None instead of raising if it fails."""
    try:
        return Angle(text, unit=unit).to_value(u.deg)
    except (ValueError, u.UnitsError):
        return None


def make_target(ra_text: str, dec_text: str) -> SkyCoord:
    """Build a sky position from RA and Dec given as text."""
    ra = parse_angle_deg(ra_text, "RA", u.hourangle) % 360.0
    if ra == 360.0:     # tiny negative inputs can round up to exactly 360
        ra = 0.0
    dec = parse_angle_deg(dec_text, "Dec", u.deg)
    if not -90.0 <= dec <= 90.0:
        raise ValueError(f"Dec out of range: {dec}")
    return SkyCoord(ra=ra * u.deg, dec=dec * u.deg, frame="icrs")


def resolve_name(name: str) -> SkyCoord:
    """Look a name up in the Sesame service (returns J2000 coordinates)."""
    name = name.strip()
    if not name:
        raise ValueError("name is empty")
    try:
        coord = SkyCoord.from_name(name)
    except NameResolveError as exc:
        raise ValueError(
            f"name not found: {name!r}. Try the canonical designation "
            f"(e.g. 'WISE J085510.83-071442.5') or enter RA/Dec directly."
        ) from exc
    if not (np.isfinite(coord.ra.deg) and np.isfinite(coord.dec.deg)):
        raise ValueError(f"resolved non-finite coordinate for {name!r}")
    return coord


def find_target() -> SkyCoord:
    """Use TARGET_NAME if it resolves, otherwise the fallback coordinates."""
    if TARGET_NAME:
        try:
            target = resolve_name(TARGET_NAME)
            print(f"{TARGET_NAME} -> J2000 {target.ra.deg:.6f} {target.dec.deg:.6f}")
            return target
        except ValueError as exc:
            print(exc)
            print("falling back to the J2000 coordinates in FALLBACK_RA/FALLBACK_DEC")
    return make_target(FALLBACK_RA, FALLBACK_DEC)


def target_position_at(target: SkyCoord, when: Time) -> SkyCoord:
    """Where is the target at time `when`?  Applies the proper motion above.

    Example: WISE 0855 moves about -8.12" in RA per year, so ten years after
    J2000 it sits ~81" away from its J2000 position.
    """
    moving = SkyCoord(ra=target.ra, dec=target.dec,
                      pm_ra_cosdec=PM_RA, pm_dec=PM_DEC,
                      obstime=Time("J2000"), frame="icrs")
    return moving.apply_space_motion(new_obstime=when)


# ==========================================================================
# Step 2: ask the archive which exposures cover the target
# ==========================================================================

def query_sia(ra_deg, dec_deg, radius_deg, collections=COLLECTIONS) -> Table:
    """Search every collection and stack the results into one table.

    Each row of the result is one exposure image.  Collections are queried
    one at a time: smaller responses and clearer error messages.
    """
    tables = []
    for collection in collections:
        try:
            table = _query_one_collection(collection, ra_deg, dec_deg, radius_deg)
        except RuntimeError as exc:
            print(f"  {collection}: {exc}")
            continue
        print(f"  {collection}: {len(table)} rows")
        if len(table) > 0:
            tables.append(table)

    if not tables:
        raise RuntimeError("the archive returned no exposures")
    return vstack(tables)


def _query_one_collection(collection, ra_deg, dec_deg, radius_deg,
                          attempts=3, timeout=(10, 60)) -> Table:
    """One plain web request to IRSA's SIA service, with retries."""
    params = {
        "COLLECTION": collection,
        "POS": f"CIRCLE {ra_deg:.6f} {dec_deg:.6f} {radius_deg:.6f}",
        "RESPONSEFORMAT": "votable",
    }
    for attempt in range(1, attempts + 1):
        started = time.time()
        try:
            response = requests.get(SIA_URL, params=params, timeout=timeout)
        except (requests.Timeout, requests.ConnectionError) as exc:
            print(f"  [{attempt}/{attempts}] {type(exc).__name__} "
                  f"after {time.time() - started:.0f}s")
            time.sleep(5 * attempt)
            continue

        print(f"  [{attempt}/{attempts}] HTTP {response.status_code}, "
              f"{len(response.content)} bytes in {time.time() - started:.0f}s")

        if response.status_code == 200:
            return _votable_to_table(response.content)
        if response.status_code in RETRY_STATUS_CODES:
            time.sleep(5 * attempt)
            continue
        response.raise_for_status()      # e.g. 400 = our parameters are wrong

    raise RuntimeError("archive unavailable after several attempts")


def _votable_to_table(content: bytes) -> Table:
    """Parse the archive's VOTable (XML) answer into an astropy Table."""
    votable = parse_single_table(io.BytesIO(content))
    table = votable.to_table()
    # IRSA gives each column an ID like "col_15" next to its real name
    # (e.g. "access_url"); astropy keys off the ID, so put the names back.
    table.rename_columns(table.colnames, [field.name for field in votable.fields])
    return table


def get_exposures(position: SkyCoord, radius_deg: float, cache_path: Path) -> Table:
    """Return the exposure list, from the cache file if we already have it."""
    if cache_path.exists():
        table = Table.read(cache_path)
        print(f"loaded {len(table)} rows from {cache_path}")
        return table

    table = query_sia(position.ra.deg, position.dec.deg, radius_deg)
    table.write(cache_path, format="ecsv", overwrite=True)
    print(f"wrote {len(table)} rows to {cache_path}")
    return table


def select_time_range(exposures: Table, start=None, end=None) -> Table:
    """Keep only exposures whose start time is inside [start, end].

    Dates are ISO strings ("2025-05-01"), and the end date is included in
    full.  None means no limit on that side.  This is the user-facing "choose
    a period" control; it filters the archive table before anything is
    downloaded, so unused frames cost nothing.
    """
    if start is None and end is None:
        return exposures

    times = Time(np.asarray(exposures["t_min"], dtype=float), format="mjd")
    keep = np.ones(len(exposures), dtype=bool)
    if start is not None:
        keep &= times >= Time(start)
    if end is not None:
        keep &= times < Time(end) + 1 * u.day

    print(f"time window {start or 'any'} .. {end or 'any'}: "
          f"{keep.sum()} of {len(exposures)} exposures")
    return exposures[keep]


# ==========================================================================
# Step 3: download cutouts and read their contents
# ==========================================================================

class NotCovered(Exception):
    """The target is not on this exposure (the server answered HTTP 422)."""


def cutout_url(access_url, ra_deg, dec_deg, size_deg):
    """The exact URL of one cutout.  It is also the cache key."""
    return f"{access_url}?center={ra_deg:.7f},{dec_deg:.7f}&size={size_deg}"


def cutout_cache_path(url, cache_dir=None):
    """Where the downloaded copy of `url` lives on disk."""
    cache_dir = CUTOUT_CACHE_DIR if cache_dir is None else cache_dir
    return Path(cache_dir) / (hashlib.md5(url.encode()).hexdigest() + ".fits")


def fetch_cutout(access_url, ra_deg, dec_deg, size_deg,
                 cache_dir=None, attempts=3) -> fits.HDUList:
    """Download a square cutout (a FITS file) centred on a sky position.

    Downloaded files are saved in `cache_dir`, so re-running is fast.
    """
    url = cutout_url(access_url, ra_deg, dec_deg, size_deg)
    cache_file = cutout_cache_path(url, cache_dir) if cache_dir is not None else None
    if cache_file is not None and cache_file.exists():
        return fits.open(cache_file)

    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(url, timeout=120)
        except requests.RequestException:
            if attempt == attempts:
                raise
            time.sleep(2 ** attempt)
            continue

        if response.status_code == 200:
            if not response.content.startswith(b"SIMPLE"):   # every FITS file starts so
                raise OSError(f"not a FITS file from {access_url}")
            if cache_file is not None:
                cache_file.parent.mkdir(parents=True, exist_ok=True)
                # Write to a temporary name, then rename: a half-written file
                # would break every later run that reads the cache.
                partial = cache_file.with_name(cache_file.name + ".part")
                partial.write_bytes(response.content)
                partial.replace(cache_file)
            return fits.open(io.BytesIO(response.content))

        if response.status_code == 422:
            raise NotCovered(f"position off footprint: {access_url}")

        if response.status_code in RETRY_STATUS_CODES:
            if attempt == attempts:
                response.raise_for_status()
            time.sleep(5 * attempt)
            continue

        response.raise_for_status()


def prefetch_cutouts(rows, ra_deg, dec_deg, size_deg, workers=None) -> set:
    """Download every cutout that is not cached yet, several at a time.

    Each URL maps to its own cache file, so the threads never collide.  Only
    the downloads are parallel; the measuring loop still runs in order, so the
    printed table is identical to a serial run.

    Returns the obs_ids that could not be downloaded, so the caller can skip
    them once instead of retrying each of them slowly and serially.
    """
    workers = DOWNLOAD_WORKERS if workers is None else workers
    missing = []
    for row in rows:
        url = cutout_url(row["access_url"], ra_deg, dec_deg, size_deg)
        if not cutout_cache_path(url).exists():
            missing.append(row)
    if not missing:
        return set()

    print(f"downloading {len(missing)} cutouts, {workers} at a time")
    failed = set()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        jobs = {
            pool.submit(fetch_cutout, row["access_url"], ra_deg, dec_deg,
                        size_deg, CUTOUT_CACHE_DIR): row["obs_id"]
            for row in missing
        }
        for job in as_completed(jobs):
            obs_id = jobs[job]
            try:
                job.result().close()          # opened only to fill the cache
            except NotCovered:
                print("  skip (off footprint):", obs_id)
                failed.add(obs_id)
            except (requests.HTTPError, OSError) as exc:
                print("  skip (HTTP):", obs_id, exc)
                failed.add(obs_id)
    return failed


def flag_names(header) -> dict:
    """Map each flag bit value to its name, e.g. {1: "TRANSIENT", 2: ...}."""
    names = {}
    for i in range(64):
        if f"MSKM{i:04d}" in header:
            bit_value = int(header[f"MSKM{i:04d}"])
            names[bit_value] = header[f"MSKN{i:04d}"].strip().upper()
    return names


def bad_bits(header) -> int:
    """Combine every flag bit that is a real problem into one number."""
    combined = 0
    for bit_value, name in flag_names(header).items():
        if name not in BENIGN_FLAGS:
            combined |= bit_value
    return combined


def describe_flags(value: int, names: dict) -> str:
    """Turn a pixel's flag number into text like "SOURCE+FULLSAMPLE"."""
    active = [name for bit, name in sorted(names.items()) if value & bit]
    return "+".join(active) or "0"


def pixel_area_sr(header) -> float:
    """Sky area of one pixel in steradians (sr).

    The header gives it in arcsec^2.  Example with the typical 37.86 arcsec^2:
      1 arcsec = pi / 180 / 3600 = 4.848e-6 radians
      1 arcsec^2 = (4.848e-6)^2 = 2.350e-11 sr
      37.86 arcsec^2 = 37.86 * 2.350e-11 = 8.899e-10 sr
    """
    area_arcsec2 = float(header.get("OMEGA_MEDIAN", 37.86))
    return area_arcsec2 * (np.pi / 180.0 / 3600.0) ** 2


def to_microjansky(mjy_per_sr_sum: float, area_sr: float) -> float:
    """Convert a sum of pixel values (MJy/sr) into microjanskys.

    Worked example: pixel values in the aperture add up to 0.10 MJy/sr.
      0.10 MJy/sr * 8.899e-10 sr   = 8.899e-11 MJy   (sr cancels)
      8.899e-11 MJy * 1e12 uJy/MJy = 88.99 uJy       (1 MJy = 1e12 uJy)
      88.99 uJy * 1.25             = 111.2 uJy       (aperture correction)
    """
    return mjy_per_sr_sum * area_sr * 1e12 * APERTURE_CORRECTION


def wavelength_at_pixel(hdul, x: float, y: float):
    """Wavelength (and its bandwidth) seen by pixel (x, y), in microns.

    Each pixel sees a slightly different colour.  The file stores this as a
    second, "alternate" WCS (key "W") with a lookup table.  The colour changes
    along the detector's y direction, not x, so we let astropy read the table
    instead of interpolating by hand.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")      # noisy but harmless
        wave_wcs = WCS(hdul["IMAGE"].header, key="W", fobj=hdul)
        wavelength, bandwidth = wave_wcs.pixel_to_world(x, y)
    return float(wavelength.to_value(u.micron)), float(bandwidth.to_value(u.micron))


# ==========================================================================
# Step 4: measure brightness
# ==========================================================================
# In these functions `x, y` is the target's pixel position, and `d` is every
# pixel's distance from it, so (d <= 2) is "a circle of radius 2 pixels".

class Photometry(NamedTuple):
    flux: float              # light inside the aperture, sky removed (MJy/sr, summed)
    error: float             # uncertainty on flux
    background: float        # typical sky level in the ring
    background_noise: float  # pixel-to-pixel scatter of the sky


def aperture_photometry(image, variance, flags, bad, x, y,
                        aperture_radius=APERTURE_RADIUS_PX,
                        ring_inner=6.0, ring_outer=12.0) -> Optional[Photometry]:
    """Add up the light in a circle, after subtracting the sky from a ring.

    `image` must already have the zodiacal light removed: that glow is
    0.2-0.7 MJy/sr here, so even a slight slope across the ~13 aperture
    pixels would be bigger than the star itself.

    Returns None if there are too few good pixels to measure.
    """
    height, width = image.shape
    yy, xx = np.mgrid[0:height, 0:width]          # pixel coordinate grids
    d = np.hypot(xx - x, yy - y)

    usable = (np.isfinite(image) & np.isfinite(variance) & (variance > 0)
              & ((flags & bad) == 0))
    ring = (d >= ring_inner) & (d <= ring_outer) & usable
    if ring.sum() < 20:                            # small cutouts: use a closer ring
        ring = (d >= 4) & (d <= 15) & usable
    aperture = (d <= aperture_radius) & usable
    if aperture.sum() == 0 or ring.sum() < 20:
        return None

    sky_pixels = image[ring]
    background = float(np.median(sky_pixels))
    # 1.4826 * median absolute deviation = a robust estimate of the scatter
    background_noise = 1.4826 * float(np.median(np.abs(sky_pixels - background)))

    flux = float(np.sum(image[aperture] - background))
    # Errors add in quadrature: the archive's per-pixel variance, plus the sky
    # scatter once for each aperture pixel.
    error = float(np.sqrt(np.sum(variance[aperture])
                          + aperture.sum() * background_noise ** 2))
    return Photometry(flux, error, background, background_noise)


def peak_pixel_snr(image, variance, ix, iy, phot: Photometry) -> float:
    """Signal-to-noise of the single brightest-pixel position (ix, iy).

    With a 3.1" PSF in 6.15" pixels this is the honest detection test: an
    aperture sum over 13 noisy pixels can reach S/N 3 by chance even when no
    source is there.
    """
    pixel_variance = variance[iy, ix]
    if not np.isfinite(pixel_variance):
        pixel_variance = 0.0
    noise = np.sqrt(max(pixel_variance, 0.0) + phot.background_noise ** 2)
    return float((image[iy, ix] - phot.background) / noise)


def centroid_offset(image, flags, bad, x, y, radius=3.0):
    """Brightness-weighted centre near (x, y), as an offset (dx, dy) in pixels.

    This is a contamination check, not a measurement.  Since the PSF is only
    ~1.2 px wide, a centre 1-2 px from where the target should be means
    another object is blended into the same aperture.
    Returns None if there is too little data.
    """
    height, width = image.shape
    yy, xx = np.mgrid[0:height, 0:width]
    d = np.hypot(xx - x, yy - y)

    usable = np.isfinite(image) & ((flags & bad) == 0)
    ring = (d >= 5) & (d <= 9) & usable
    if ring.sum() < 10:
        return None
    background = float(np.median(image[ring]))

    # np.where rather than mask * array: one NaN pixel would turn
    # 0 * NaN into NaN and ruin the whole sum.
    weight = np.where((d <= radius) & usable,
                      np.clip(image - background, 0, None), 0.0)
    if weight.sum() <= 0:
        return None
    return (float((weight * xx).sum() / weight.sum() - x),
            float((weight * yy).sum() / weight.sum() - y))


# ==========================================================================
# One exposure -> one Frame
# ==========================================================================

@dataclass
class Frame:
    """Everything we know about the target in one exposure."""
    band: str                    # e.g. "SPHEREx-D3"
    obs_id: str
    mjd: float                   # observation date (Modified Julian Date)
    obs_time: Time
    wavelength_um: float         # colour at the target's pixel, in microns
    bandwidth_um: float
    image: np.ndarray            # sky image, zodiacal light removed (MJy/sr)
    variance: np.ndarray         # per-pixel noise^2
    flags: np.ndarray            # per-pixel problem bits
    wcs: WCS                     # pixel <-> sky conversion for this image
    bad_bits: int
    target_flag: int             # flag value at the target's pixel
    target_flag_names: str
    shift_ra_deg: float          # how far the target moved since the reference date
    shift_dec_deg: float
    pixel_scale_arcsec: float
    centroid_offset_px: Optional[tuple]

    # Measurements (NaN if the frame had too few good pixels)
    flux_ujy: float = np.nan
    err_ujy: float = np.nan
    peak_snr: float = np.nan

    # Filled in later by align_frames()
    image_aligned: Optional[np.ndarray] = None
    variance_aligned: Optional[np.ndarray] = None
    flags_aligned: Optional[np.ndarray] = None
    footprint: Optional[np.ndarray] = None

    @property
    def band_label(self) -> str:
        return self.band[-2:]                     # "D3"

    @property
    def snr(self) -> float:
        return self.flux_ujy / self.err_ujy if self.err_ujy > 0 else np.nan

    @property
    def offset_arcsec(self) -> float:
        if self.centroid_offset_px is None:
            return np.nan
        return self.pixel_scale_arcsec * float(np.hypot(*self.centroid_offset_px))

    @property
    def bad_pixel_percent(self) -> float:
        return 100.0 * float(np.mean((self.flags & self.bad_bits) != 0))


def load_frame(row, band, target, reference, cutout_size_deg) -> Optional[Frame]:
    """Download one cutout and measure the target in it.

    `row` is one line of the archive's exposure table.  `reference` is the
    target's position at the median observation date; every cutout is centred
    there.  Returns None (after printing why) if the exposure can't be used.
    """
    try:
        hdul = fetch_cutout(row["access_url"], reference.ra.deg, reference.dec.deg,
                            cutout_size_deg, cache_dir=CUTOUT_CACHE_DIR)
    except NotCovered:
        print("  skip (off footprint):", row["obs_id"])
        return None
    except (requests.HTTPError, OSError) as exc:
        print("  skip (HTTP):", row["obs_id"], exc)
        return None

    with hdul:   # closes the file when we leave this block
        header = hdul["IMAGE"].header
        wcs = WCS(header)                      # keep the SIP distortion terms

        # Where is the target *in this exposure*?  It moves up to 8"/yr, so
        # we re-compute its position for each exposure's date.
        obs_time = Time(row["t_min"], format="mjd")
        position = target_position_at(target, obs_time)
        x, y = wcs.world_to_pixel(position)
        x, y = float(x), float(y)
        ix, iy = int(round(x)), int(round(y))

        width, height = header["NAXIS1"], header["NAXIS2"]
        if not (0 <= ix < width and 0 <= iy < height):
            # Near a detector edge the archive returns a thin sliver that
            # does not actually contain the target.
            print(f"  skip (target off detector): {row['obs_id']} "
                  f"cutout {width}x{height}, pixel ({x:.0f}, {y:.0f})")
            return None

        flags = np.array(hdul["FLAGS"].data, dtype=np.int32)
        variance = np.array(hdul["VARIANCE"].data, dtype=float)
        image = np.array(hdul["IMAGE"].data, dtype=float)

        # Subtract the zodiacal-light model (0.18-0.68 MJy/sr here: far
        # brighter than the target, and not flat), or we would be measuring
        # the slope of the sky glow rather than the star.
        if "ZODI" in hdul:
            image -= np.array(hdul["ZODI"].data, dtype=float)

        names = flag_names(hdul["FLAGS"].header)
        bad = bad_bits(hdul["FLAGS"].header)
        wavelength, bandwidth = wavelength_at_pixel(hdul, x, y)

        # Brightness, converted from MJy/sr to microjanskys.
        flux_ujy = err_ujy = peak_snr = np.nan
        phot = aperture_photometry(image, variance, flags, bad, x, y)
        if phot is not None:
            area_sr = pixel_area_sr(header)
            flux_ujy = to_microjansky(phot.flux, area_sr)
            err_ujy = to_microjansky(phot.error, area_sr)
            peak_snr = peak_pixel_snr(image, variance, ix, iy, phot)

        return Frame(
            band=band,
            obs_id=row["obs_id"],
            mjd=float(row["t_min"]),
            obs_time=obs_time,
            wavelength_um=wavelength,
            bandwidth_um=bandwidth,
            image=image,
            variance=variance,
            flags=flags,
            wcs=wcs,
            bad_bits=bad,
            target_flag=int(flags[iy, ix]),
            target_flag_names=describe_flags(int(flags[iy, ix]), names),
            shift_ra_deg=position.ra.deg - reference.ra.deg,
            shift_dec_deg=position.dec.deg - reference.dec.deg,
            # arcsec/pixel, taken from the archive table (simpler than
            # unpacking the WCS, which returns mixed types depending on file)
            pixel_scale_arcsec=float(row["s_pixel_scale"]),
            centroid_offset_px=centroid_offset(image, flags, bad, x, y),
            flux_ujy=flux_ujy,
            err_ujy=err_ujy,
            peak_snr=peak_snr,
        )


def download_frames(exposures, bands_present, target, reference, cutout_size_deg):
    """Load frames for every band, oldest exposures first."""
    # Decide what to load before touching the network, so all the downloads
    # can happen at once in prefetch_cutouts().
    plan = []
    for band in bands_present:
        rows = exposures[exposures["energy_bandpassname"] == band]
        rows = rows[np.argsort(np.asarray(rows["t_min"], dtype=float))]
        if MAX_FRAMES_PER_BAND is not None:
            rows = rows[:MAX_FRAMES_PER_BAND]
        plan.append((band, rows))

    failed = prefetch_cutouts([row for _, rows in plan for row in rows],
                              reference.ra.deg, reference.dec.deg, cutout_size_deg)

    frames = []
    for band, rows in plan:
        print(f"\n{band}: {len(rows)} frames")
        for row in rows:
            if row["obs_id"] in failed:
                continue
            frame = load_frame(row, band, target, reference, cutout_size_deg)
            if frame is not None:
                frames.append(frame)

    frames.sort(key=lambda f: (f.band, f.mjd))
    return frames


# ==========================================================================
# Step 5: line all the images up, north up
# ==========================================================================

def north_up_wcs(ra, dec, fov_deg, pixel_scale_arcsec=6.1577):
    """Build the shared output grid: square, centred on (ra, dec), north up.

    Example: a 0.2 degree field is 0.2 * 3600 = 720 arcsec wide, and
    720 / 6.1577 = 116.9, so the grid is 117 x 117 pixels.
    """
    n = int(round(fov_deg * 3600.0 / pixel_scale_arcsec))
    scale_deg = pixel_scale_arcsec / 3600.0

    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]     # reference pixel: the centre
    w.wcs.crval = [ra, dec]                           # ...which sits at this sky spot
    w.wcs.cd = np.array([[-scale_deg, 0.0],           # minus sign: RA grows to the left
                         [0.0, scale_deg]])
    w.wcs.radesys = "ICRS"
    return w, n


def shifted_wcs(wcs, shift_ra_deg, shift_dec_deg):
    """Copy of a WCS, nudged so a moved star stays on the same pixel.

    The shift is only arcseconds, so simply adding it to the reference sky
    position is accurate to well under one pixel.
    """
    shifted = wcs.deepcopy()
    shifted.wcs.crval = [shifted.wcs.crval[0] + shift_ra_deg,
                         shifted.wcs.crval[1] + shift_dec_deg]
    return shifted


def align_frames(frames, ra, dec):
    """Resample every frame onto one common grid (stored in frame.*_aligned)."""
    out_wcs, n = north_up_wcs(ra, dec, FIELD_OF_VIEW_DEG)
    print(f"\noutput grid: {n}x{n} px, 6.1577\"/px, north up")

    for frame in frames:
        # Register on the moving target, not the background stars, so the
        # target lands on the same pixel in every epoch.
        wcs = shifted_wcs(frame.wcs, frame.shift_ra_deg, frame.shift_dec_deg)

        frame.image_aligned, frame.footprint = reproject_interp(
            (frame.image, wcs), out_wcs, shape_out=(n, n))
        frame.variance_aligned, _ = reproject_interp(
            (frame.variance, wcs), out_wcs, shape_out=(n, n))
        flags_float, _ = reproject_interp(
            (frame.flags, wcs), out_wcs, shape_out=(n, n), order="nearest-neighbor")
        # Pixels outside the footprint are NaN, which would cast to garbage.
        frame.flags_aligned = np.nan_to_num(flags_float, nan=0.0).round().astype(np.int32)

    fully_covered = [f for f in frames if f.footprint.mean() > 0.99]
    print(f"{len(fully_covered)}/{len(frames)} frames fully cover the output grid")


def alignment_scatter(frames, half=5, edge=12):
    """Cheap alignment check: track the brightest star across the frames.

    Returns (mean offset, scatter) in pixels as (x, y) pairs, or (None, None).
    """
    stack = np.nanmedian([f.image_aligned for f in frames], axis=0)
    height, width = stack.shape

    # Find the brightest pixel, ignoring the image edges.
    core = stack[edge:height - edge, edge:width - edge]
    iy, ix = np.unravel_index(np.nanargmax(core), core.shape)
    iy += edge
    ix += edge

    y0, y1 = max(0, iy - half), min(height, iy + half + 1)
    x0, x1 = max(0, ix - half), min(width, ix + half + 1)
    ys, xs = np.mgrid[y0:y1, x0:x1]

    offsets = []
    for frame in frames:
        patch = frame.image_aligned[y0:y1, x0:x1]
        if not np.all(np.isfinite(patch)):
            continue
        weight = np.clip(patch - np.median(patch), 0, None)
        if weight.sum() <= 0:
            continue
        offsets.append(((weight * xs).sum() / weight.sum() - ix,
                        (weight * ys).sum() / weight.sum() - iy))

    if not offsets:
        return None, None
    offsets = np.array(offsets)
    return offsets.mean(axis=0), offsets.std(axis=0)


# ==========================================================================
# Printing and plotting
# ==========================================================================

def print_exposure_overview(exposures, t_min):
    """Show what the archive returned."""
    print(exposures["obs_id", "energy_bandpassname", "t_min"][:5])
    print("rows:", len(exposures))
    print("columns:", exposures.colnames)
    print("bands:", Counter(exposures["energy_bandpassname"]))
    first = Time(float(np.nanmin(t_min)), format="mjd").iso
    last = Time(float(np.nanmax(t_min)), format="mjd").iso
    print("t_min range:", first, "->", last)


def print_frame_table(frames):
    """One line per frame: when, what colour, how bright, how reliable."""
    n_bands = len({f.band for f in frames})
    print(f"\n{len(frames)} frames from {n_bands} bands")
    print(f"{'band':4} {'date':11} {'MJD':>10} {'lambda':>8} {'dlam':>6} "
          f"{'flux uJy':>9} {'err':>7} {'S/N':>6} {'peakSNR':>8} "
          f"{'off arcsec':>10} {'bad %':>6}  flag@target")
    for f in frames:
        print(f"{f.band_label:4} {f.obs_time.iso[:10]:11} {f.mjd:10.3f} "
              f"{f.wavelength_um:8.3f} {f.bandwidth_um:6.3f} "
              f"{f.flux_ujy:9.1f} {f.err_ujy:7.1f} {f.snr:6.1f} {f.peak_snr:8.1f} "
              f"{f.offset_arcsec:10.1f} {f.bad_pixel_percent:6.2f}  "
              f"{f.target_flag} {f.target_flag_names}")


def print_band_summary(frames):
    """One line per band, with a verdict on whether the target is isolated."""
    print(f"\n{'band':4} {'frames':>6} {'lambda sampled (um)':>28} "
          f"{'median off':>11}  verdict")
    for band in BANDS:
        in_band = [f for f in frames if f.band == band]
        if not in_band:
            continue
        wavelengths = np.array([f.wavelength_um for f in in_band])
        offsets = [f.offset_arcsec for f in in_band if not np.isnan(f.offset_arcsec)]
        median_offset = float(np.median(offsets)) if offsets else np.nan

        # One pixel is ~6.16" and the PSF only ~1.2 px, so an offset beyond
        # half a pixel means a different object sits in the aperture; it is
        # not just centroid error.
        half_pixel = 0.5 * in_band[0].pixel_scale_arcsec
        verdict = "blended/offset" if median_offset > half_pixel else "on target"
        print(f"{in_band[0].band_label:4} {len(in_band):6d} "
              f"{wavelengths.min():12.3f} -> {wavelengths.max():.3f} "
              f"{median_offset:9.1f}\"  {verdict}")


def print_alignment_checks(frames):
    """Report how well the bright star lines up from frame to frame."""
    for band in BANDS:
        in_band = [f for f in frames if f.band == band and f.image_aligned is not None]
        if len(in_band) < 3:
            continue
        mean_offset, scatter = alignment_scatter(in_band)
        if mean_offset is not None:
            print(f"{in_band[0].band_label}: bright-star centroid offset "
                  f"({mean_offset[0]:+.2f}, {mean_offset[1]:+.2f}) px, "
                  f"scatter ({scatter[0]:.2f}, {scatter[1]:.2f}) px")


def _get_pyplot():
    """Import matplotlib lazily, set up to draw into files (no window).

    In a notebook the kernel owns the backend (inline/ipympl), so forcing Agg
    there would silently stop plt.show() from displaying anything.
    """
    import matplotlib
    if "ipykernel" not in sys.modules:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    return plt


def save_contact_sheet(frames, path="contact_sheet.png", per_band=4):
    """A grid of thumbnails: one row per detector, one column per exposure."""
    plt = _get_pyplot()

    count = Counter(f.band for f in frames)
    bands = [b for b in BANDS if count[b] > 0]
    if not bands:
        return
    cols = min(per_band, max(count.values()))

    fig, axes = plt.subplots(len(bands), cols, squeeze=False,
                             figsize=(3.0 * cols, 2.9 * len(bands)))
    for ax in axes.ravel():
        ax.axis("off")                    # hide unused cells

    for row_i, band in enumerate(bands):
        in_band = [f for f in frames if f.band == band][:cols]
        for col_i, frame in enumerate(in_band):
            ax = axes[row_i, col_i]
            img = frame.image_aligned if frame.image_aligned is not None else frame.image
            low, high = np.nanpercentile(img, [5, 99])      # clip extremes for contrast
            img = np.where(np.isfinite(img), img, low)      # blank areas black, not white
            ax.imshow(img, origin="lower", cmap="gray", vmin=low, vmax=high)
            ax.set_title(f"{frame.band_label}  {frame.obs_time.iso[5:16]}  "
                         f"{frame.wavelength_um:.2f} um", fontsize=8)
            ax.axis("on")
            ax.set_xticks([])
            ax.set_yticks([])

    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)
    print("wrote", path)


def save_spectrum(frames, path="spectrum.png"):
    """Plot brightness against wavelength, one colour per detector."""
    plt = _get_pyplot()

    fig, ax = plt.subplots(figsize=(7, 4.5))
    for band in BANDS:
        measured = [f for f in frames if f.band == band and not np.isnan(f.flux_ujy)]
        if not measured:
            continue
        measured.sort(key=lambda f: f.wavelength_um)
        ax.errorbar([f.wavelength_um for f in measured],
                    [f.flux_ujy for f in measured],
                    yerr=[f.err_ujy for f in measured],
                    fmt="o", ms=5, capsize=2, label=measured[0].band_label)

    ax.axhline(0.0, color="0.7", lw=0.8)
    ax.set_xlabel("wavelength (um)")
    ax.set_ylabel("aperture flux (uJy)")
    ax.set_title("SPHEREx spectrum of the target")
    ax.legend(fontsize=8, ncol=3)
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
    print("wrote", path)


# ==========================================================================
# Main
# ==========================================================================

def main():
    # --- 1. Where is the target? -----------------------------------------
    target = find_target()
    ra, dec = target.ra.deg, target.dec.deg
    print(f"J2000 position: {ra:.6f} {dec:.6f}")

    # --- 2. Which exposures cover it? ------------------------------------
    # The archive search is an "intersects" test against each exposure's
    # footprint, so even a tiny circle returns every exposure covering the
    # target.  Measured on IRSA:
    #   r=0.005 deg -> 258 rows, 2.1 s      r=0.05 deg -> 263 rows, 3.3 s
    #   r=0.10  deg -> read timeout
    # So the radius does NOT set the field of view; the cutout size does.
    #
    # Search around where the target is *today*, since it moves a lot.
    now = Time.now()
    position_now = target_position_at(target, now)
    print(f"epoch {now.iso[:10]}: {position_now.ra.deg:.5f} {position_now.dec.deg:.5f}")

    cache_name = f"exposures_{ra:.3f}_{dec:.3f}.ecsv".replace("-", "m")
    exposures = get_exposures(position_now, SEARCH_RADIUS_DEG, Path(cache_name))

    t_min = np.asarray(exposures["t_min"], dtype=float)
    print_exposure_overview(exposures, t_min)

    # --- 3. Download a cutout around the target from each exposure -------
    # Centre every cutout on where the target is at the middle of the *full*
    # archive span, not the selected time window.  The URL is the cache key,
    # so tying it to the window would throw the cache away on every change.
    reference_time = Time(float(np.nanmedian(t_min)), format="mjd")
    reference = target_position_at(target, reference_time)
    print(f"\nreference epoch {reference_time.iso[:10]}: "
          f"{reference.ra.deg:.5f} {reference.dec.deg:.5f}")

    # The user-facing date range is applied after the reference is fixed.
    exposures = select_time_range(exposures, *TIME_RANGE)
    if len(exposures) == 0:
        raise SystemExit("no exposures in that time range")

    # Download 1.5x the final field of view, leaving margin so the edges stay
    # filled after the images are shifted and resampled.
    cutout_size_deg = round(1.5 * FIELD_OF_VIEW_DEG, 3)
    frames_per_band = MAX_FRAMES_PER_BAND if MAX_FRAMES_PER_BAND else "all"
    print(f"cutout {cutout_size_deg} deg, {frames_per_band} frames per band")

    bands_present = [b for b in BANDS if np.any(exposures["energy_bandpassname"] == b)]
    missing = [b for b in BANDS if b not in bands_present]
    if missing:
        print("no exposures in:", ", ".join(missing))

    frames = download_frames(exposures, bands_present, target, reference, cutout_size_deg)
    if not frames:
        raise SystemExit("no cutouts retrieved")

    # --- 4. Report the measurements --------------------------------------
    print_frame_table(frames)
    print_band_summary(frames)

    # --- 5. Align everything and make the plots --------------------------
    if reproject_interp is None:
        print("\nreproject is not installed: pip install reproject")
        print("frames are still in memory in the `frames` list")
    else:
        align_frames(frames, reference.ra.deg, reference.dec.deg)
        print_alignment_checks(frames)

    save_contact_sheet(frames)
    save_spectrum(frames)
    return frames          # handy in a notebook: frames = main()


if __name__ == "__main__":
    main()