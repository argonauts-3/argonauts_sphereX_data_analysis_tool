"""Warm the cache for the curated targets, e.g. before a demo.

This does exactly what the web page does on a first visit: query the archive,
download one cutout per exposure, align them, and write the dataset that the
server can then answer from disk.  Running it ahead of time only removes the
wait; the app works without it.

    .venv/bin/python precompute.py
    .venv/bin/python precompute.py --only "Barnard's Star" --fov 0.2
    .venv/bin/python precompute.py --only "RW Aurigae,R Draconis"

At the default 0.3 degree field each target is about 1.3 GB of cutouts.
"""

from __future__ import annotations

import argparse

from astropy import units as u

import app
import dataset
import test as pipeline


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fov", type=float, action="append",
                        help="field of view in degrees (may be repeated, default: 0.3)")
    parser.add_argument("--all-curated", action="store_true",
                        help="build every curated target at the given FOVs")
    parser.add_argument("--only", action="append", metavar="NAME",
                        help="curated target name, or a comma-separated list; "
                             "may be repeated (default: all)")
    return parser.parse_args()


def wanted_targets(only):
    """Filter the curated list by name, case-insensitively."""
    if not only:
        return list(app.TARGETS)

    names = {name.strip().lower()
             for item in only for name in item.split(",") if name.strip()}
    chosen = [t for t in app.TARGETS if t["name"].lower() in names]
    missing = names - {t["name"].lower() for t in chosen}
    if missing:
        known = ", ".join(t["name"] for t in app.TARGETS)
        raise SystemExit(f"unknown target(s): {', '.join(sorted(missing))}\n"
                         f"curated targets: {known}")
    return chosen


def print_progress(stage, done, total):
    """One line per stage, then a line every 10 percent."""
    if not hasattr(print_progress, "last"):
        print_progress.last = {}
    last_stage, last_step = print_progress.last.get("value", (None, -1))

    step = int(done * 10 / total) if total > 0 else 0
    if stage != last_stage:
        last_step = -1
    if stage != last_stage or step != last_step:
        suffix = f" ({done}/{total})" if total > 0 else ""
        print(f"  {stage}{suffix}")
        print_progress.last["value"] = (stage, step)


def main():
    args = parse_args()
    fov_list = args.fov or [0.3]
    for f in fov_list:
        if not 0.1 <= f <= 1.0:
            raise SystemExit(f"--fov must be between 0.1 and 1.0 degrees, got {f}")
    fovs = [round(f, 3) for f in fov_list]

    targets = list(app.TARGETS) if args.all_curated else wanted_targets(args.only)
    print(f"{len(targets)} target(s), fields {fovs} deg, all detectors")

    total_tasks = len(targets) * len(fovs)
    current = 0
    for target in targets:
        for fov in fovs:
            current += 1
            key = dataset.dataset_id(target["ra"], target["dec"], fov, None, None,
                                     pipeline.BANDS, False)
            print(f"\n[{current}/{total_tasks}] {target['name']}  fov {fov} deg  id {key}")
            out_dir = dataset.DATA_ROOT / key
            manifest_path = out_dir / "manifest.json"
            if manifest_path.exists():
                try:
                    import json
                    m = json.loads(manifest_path.read_text())
                    if m.get("complete", True):
                        print("  already built, skipping")
                        continue
                except Exception:
                    pass

            proper_motion = (target["pm"][0] * u.mas / u.yr,
                             target["pm"][1] * u.mas / u.yr)
            try:
                dataset.build_dataset(
                    target["ra"], target["dec"], key, fov, None, None,
                    list(pipeline.BANDS), track=False,
                    proper_motion=proper_motion, progress=print_progress)
            except Exception as exc:                # noqa: BLE001 - keep going
                print(f"  failed: {exc}")
                continue
            print(f"  done: {out_dir}")

    print("\nall requested targets are ready")


if __name__ == "__main__":
    main()
