/* SPHEREx time explorer - front end.
 *
 * The server has already aligned every exposure onto one north-up grid and
 * rendered it to a PNG, so this file only has to:
 *   - ask for a dataset, poll the build progress and show a preview early,
 *   - preload the PNGs and draw one canvas frame at the requested rate,
 *   - let the user choose the display interpolation kernel,
 *   - show the metadata that comes with each frame,
 *   - ask the server for an A-B or (A+B)/2 image.
 *
 * Changing the target, field, dates, detectors or alignment only marks the
 * form as modified.  Pressing Show (or Enter) applies the settings and starts
 * a build.  Playback controls are immediate.
 *
 * No frameworks, no build step.
 */

"use strict";

const BANDS = ["SPHEREx-D1", "SPHEREx-D2", "SPHEREx-D3",
               "SPHEREx-D4", "SPHEREx-D5", "SPHEREx-D6"];
const BAND_SHORT = Object.fromEntries(BANDS.map(b => [b, b.slice(-2)]));
const INTERP_MODES = ["nearest", "bilinear", "bicubic", "lanczos", "gaussian"];
const LEVEL_GAP = 2;      // minimum distance between black and white level, percent
const FAINT_SNR = 3;      // "Drop faint" removes frames with peak S/N below this
const BLEND_PX = 0.5;     // centroid further than this from the target = blended

const STAGE_LABEL = {
  queued: "Queued",
  query: "Searching the archive",
  downloading: "Downloading cutouts",
  measuring: "Measuring frames",
  aligning: "Aligning frames",
  rendering: "Rendering images",
  preview: "Preview ready",
  loading: "Loading images into the browser",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  ready: "Ready",
};

const $ = id => document.getElementById(id);

const state = {
  targets: [],
  params: null,        // the build request currently on screen
  datasetId: null,
  manifest: null,
  frames: [],
  images: new Map(),   // frame URL -> loaded HTMLImageElement
  index: 0,
  fps: 4,
  playing: false,
  timer: null,
  buildToken: 0,
  jobId: null,
  mode: "movie",       // or "diff"
  wantFrame: null,
  wantPlay: false,
  interp: "bilinear",
  viewer: null,
  dirty: false,
  // Frame filters (client-side only; nothing here triggers a rebuild).
  excluded: new Set(),            // frameKey() of every frame the user unticked
  filter: { wl: null },           // null, or [min, max] wavelength window in um
  wlBounds: null,                 // [min, max] of the loaded frames, rounded outwards
  visible: [],                    // visible[i] is true when frames[i] passes the filters
  order: [],                      // manifest indices of the visible frames, ascending
  levels: { black: 0, white: 1 }, // display window inside the PNG's stretch, 0..1
  plots: null,
  wantSkip: null,                 // unticked indices from the URL, applied to the full manifest
  compareRefresh: 0,
  urlTimer: null,
  colorbarKey: "",
};

// --------------------------------------------------------------------------
// Start-up
// --------------------------------------------------------------------------

init();

async function init() {
  const query = new URLSearchParams(location.search);
  if (query.get("embed") === "1") document.body.classList.add("embed");

  state.interp = normaliseInterp(query.get("interp"));
  setupViewer(query.get("viewer") === "2d");

  $("targetSelect").innerHTML =
    '<option value="custom">Custom RA / Dec or name</option>';

  try {
    state.targets = await getJSON("/api/targets");
  } catch (err) {
    showError("Could not reach the server.");
    return;
  }

  for (const target of state.targets) {
    const option = document.createElement("option");
    option.value = target.name;
    option.textContent = target.name;
    $("targetSelect").appendChild(option);
  }

  buildBandCheckboxes();
  wireControls();
  state.plots = createFramePlots($("plots"), {
    onPick: index => { pause(); setIndex(index); },
    getFilename: () =>
      `spherex_${(state.params?.name || "frames").replace(/[^A-Za-z0-9_-]+/g, "_")}.csv`,
  });
  readViewStateFromQuery(query);

  if (query.get("guide") === "1") openGuide();

  const params = paramsFromQuery(query);
  if (params) {
    fillForm(params);
    // Use the form rather than the raw URL: fillForm may have matched a
    // curated target and filled in its coordinates.  That avoids a pointless
    // Sesame lookup and makes name-only links work for names like
    // "WISE 0855-0714" that Sesame does not recognise.
    startBuild(requestFromForm());
  } else {
    const first = state.targets[0];
    if (!first) {
      showError("The server has no target list.");
      return;
    }
    selectTarget(first.name);
    applyForm();
  }
}

function buildBandCheckboxes() {
  const box = $("bands");
  for (const band of BANDS) {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = band;
    input.checked = true;
    input.name = "band";
    label.appendChild(input);
    label.appendChild(document.createTextNode(" " + BAND_SHORT[band]));
    box.appendChild(label);
  }
}

// --------------------------------------------------------------------------
// Reusable sliders.  Declared once here, mounted wherever the page has a
// [data-slider="name"] element.
// --------------------------------------------------------------------------

function registerSliders() {
  SliderControls.register("fov", {
    label: "Field of view",
    min: 0.1, max: 1, step: 0.05, value: 0.3,
    unit: "deg", precision: 2,
    hint: "Bigger fields download more archive data: about 1.3 GB at 0.3 deg "
        + "and 4.5 GB at 1.0 deg. Cached after the first view.",
    // Dragging does not rebuild the images; it only marks the form dirty.
    onCommit: markDirty,
  });

  SliderControls.register("fps", {
    label: "fps",
    min: 0.5, max: 12, step: 0.5, value: 4,
    precision: 1,
    onCommit: changePlaybackRate,
  });

  SliderControls.register("frame", {
    label: "Frame",
    min: 0, max: 0, step: 1, value: 0,
    precision: 0,
    onInput: pauseAndSetIndex,
    onCommit: pauseAndSetIndex,
  });

  // Display window inside the PNG's stretch, in percent of that stretch.
  SliderControls.register("black", {
    label: "Black level", min: 0, max: 100 - LEVEL_GAP, step: 1, value: 0,
    unit: "%", precision: 0,
    onInput: changeLevels, onCommit: changeLevels,
  });
  SliderControls.register("white", {
    label: "White level", min: LEVEL_GAP, max: 100, step: 1, value: 100,
    unit: "%", precision: 0,
    onInput: changeLevels, onCommit: changeLevels,
  });

  // Wavelength window.  Bounds are replaced when a dataset loads.
  SliderControls.register("wlmin", {
    label: "Min wavelength", min: 0.7, max: 5.2, step: 0.01, value: 0.7,
    unit: "um", precision: 2,
    onInput: changeWavelength, onCommit: changeWavelength,
  });
  SliderControls.register("wlmax", {
    label: "Max wavelength", min: 0.7, max: 5.2, step: 0.01, value: 5.2,
    unit: "um", precision: 2,
    onInput: changeWavelength, onCommit: changeWavelength,
  });

  SliderControls.mountAll();
  SliderControls.get("wlmin")?.setDisabled(true);
  SliderControls.get("wlmax")?.setDisabled(true);
}

function wireControls() {
  $("buildForm").addEventListener("submit", event => {
    event.preventDefault();
    applyForm();
  });

  $("targetSelect").addEventListener("change", () => {
    const name = $("targetSelect").value;
    if (name === "custom") {
      // The name and coordinate fields are always editable; this option just
      // makes it explicit that the next build should use them.
      $("nameInput").focus();
    } else {
      selectTarget(name);
    }
    markDirty();
  });

  // Typing a name or coordinate is itself a change to the request.
  $("nameInput").addEventListener("input", () => {
    useCustomTarget();
    // A new name means a new position.  Clearing the old coordinates stops
    // them from silently overriding the name the user just typed.
    $("raInput").value = "";
    $("decInput").value = "";
    markDirty();
  });

  for (const id of ["raInput", "decInput"]) {
    $(id).addEventListener("input", () => {
      useCustomTarget();
      // If the name came from the drop-down, it no longer describes these
      // coordinates.  Keep a label the user typed themselves.
      const name = $("nameInput").value.trim();
      if (state.targets.some(target => target.name === name)) {
        $("nameInput").value = "";
      }
      markDirty();
    });
  }

  for (const id of ["t0Input", "t1Input"]) {
    $(id).addEventListener("change", markDirty);
  }

  document.querySelectorAll('input[name="band"]').forEach(input => {
    input.addEventListener("change", markDirty);
  });

  registerSliders();

  $("playBtn").addEventListener("click", () => {
    if (state.mode === "diff") return;
    state.playing ? pause() : play();
  });
  $("prevBtn").addEventListener("click", () => { pause(); stepVisible(-1); });
  $("nextBtn").addEventListener("click", () => { pause(); stepVisible(1); });

  // The listener would otherwise pass the click event as `silent`.
  $("backBtn").addEventListener("click", () => backToMovie());
  $("subBtn").addEventListener("click", () => showDiff("sub"));
  $("addBtn").addEventListener("click", () => showDiff("add"));

  document.querySelectorAll("[data-preset]").forEach(button => {
    button.addEventListener("click", () => {
      const preset = button.dataset.preset;
      if (preset === "all") {
        $("t0Input").value = "";
        $("t1Input").value = "";
      } else {
        $("t0Input").value = `${preset}-01-01`;
        $("t1Input").value = `${preset}-12-31`;
      }
      markDirty();
    });
  });

  $("trackInput").addEventListener("change", markDirty);

  // The listeners are wrapped so the click event is not passed as an option.
  $("levelsResetBtn").addEventListener("click", () => resetLevels());
  $("resetFilterBtn").addEventListener("click", () => resetFilters());
  $("selNoneBtn").addEventListener("click", () => excludeWhere(() => true));
  $("dropFlaggedBtn").addEventListener("click", () => excludeWhere(frame => frame.target_bad));
  $("dropFaintBtn").addEventListener("click", () =>
    excludeWhere(frame => Number.isFinite(frame.peak_snr) && frame.peak_snr < FAINT_SNR));
  $("dropBlendedBtn").addEventListener("click", () => excludeWhere(isBlended));

  $("frameRows").addEventListener("click", event => {
    const box = event.target.closest("input[data-pick]");
    if (box) {
      // The checkbox has already flipped; follow it without jumping to the row.
      setExcluded(parseInt(box.dataset.pick, 10), !box.checked);
      return;
    }
    const row = event.target.closest("tr[data-i]");
    if (!row) return;
    pause();
    setIndex(parseInt(row.dataset.i, 10));
  });

  $("interpSelect").addEventListener("change", () => {
    if (!setInterp($("interpSelect").value)) {
      $("interpSelect").value = state.interp;
    }
  });

  $("cancelBtn").addEventListener("click", cancelBuild);
  $("guideBtn").addEventListener("click", openGuide);
  $("guideCloseBtn").addEventListener("click", closeGuide);
  $("guideDialog").addEventListener("close", () => {
    $("guideBtn").focus();
    const url = new URL(location.href);
    if (url.searchParams.get("guide") === "1") {
      url.searchParams.delete("guide");
      history.replaceState(null, "", url);
    }
  });

  document.addEventListener("keydown", event => {
    const tag = (event.target.tagName || "").toLowerCase();
    if (["input", "select", "textarea", "button"].includes(tag)) return;
    if (event.key === " ") { event.preventDefault(); state.playing ? pause() : play(); }
    if (event.key === "ArrowRight") { pause(); stepVisible(1); }
    if (event.key === "ArrowLeft") { pause(); stepVisible(-1); }
    if (event.key === "g" || event.key === "G") openGuide();
  });
}

function markDirty() {
  state.dirty = true;
  const button = $("showBtn");
  button.textContent = "Show changes";
  button.classList.add("dirty");
  $("dirtyHint").hidden = false;
}

function clearDirty() {
  state.dirty = false;
  const button = $("showBtn");
  button.textContent = "Show";
  button.classList.remove("dirty");
  $("dirtyHint").hidden = true;
}

// --------------------------------------------------------------------------
// Display interpolation (display only; never touches measurements)
// --------------------------------------------------------------------------

function normaliseInterp(name) {
  return INTERP_MODES.includes(name) ? name : "bilinear";
}

function setupViewer(force2d) {
  state.viewer = createFrameViewer($("view"), {
    defaultKernel: state.interp,
    force2d,
  });

  const select = $("interpSelect");
  for (const option of select.options) {
    const ok = state.viewer.supports(option.value);
    option.disabled = !ok;
    option.title = ok ? "" : "Requires WebGL";
  }

  if (!state.viewer.supports(state.interp)) state.interp = "bilinear";
  select.value = state.interp;
  state.viewer.setKernel(state.interp);
  $("viewerNotice").hidden = state.viewer.mode !== "2d";
}

function setInterp(name) {
  const wanted = normaliseInterp(name);
  if (!state.viewer.supports(wanted)) return false;
  state.interp = wanted;
  state.viewer.setKernel(wanted);
  $("interpSelect").value = wanted;
  syncURL();
  return true;
}

// --------------------------------------------------------------------------
// User guide dialog
// --------------------------------------------------------------------------

function openGuide() {
  const dialog = $("guideDialog");
  if (!dialog || dialog.open) return;
  dialog.showModal();
}

function closeGuide() {
  const dialog = $("guideDialog");
  if (dialog && dialog.open) dialog.close();
}

// --------------------------------------------------------------------------
// Target helpers
// --------------------------------------------------------------------------

function useCustomTarget() {
  if ($("targetSelect").value !== "custom") {
    $("targetSelect").value = "custom";
  }
}

function selectTarget(name) {
  const target = state.targets.find(t => t.name === name);
  if (!target) return;
  $("targetSelect").value = target.name;
  $("nameInput").value = target.name;
  $("raInput").value = target.ra.toFixed(6);
  $("decInput").value = target.dec.toFixed(6);
}

function requestFromForm() {
  const selected = $("targetSelect").value;
  const bands = [...document.querySelectorAll('input[name="band"]:checked')]
    .map(input => input.value);
  if (bands.length === 0) throw new Error("Pick at least one detector.");

  const fov = SliderControls.get("fov")?.value ?? parseFloat($("fovNumber").value);
  const request = {
    fov,
    t0: $("t0Input").value || null,
    t1: $("t1Input").value || null,
    bands,
    track: $("trackInput").checked,
  };

  if (selected !== "custom") {
    const target = state.targets.find(t => t.name === selected);
    if (!target) throw new Error("Pick a target first.");
    request.name = target.name;
    request.ra = target.ra;
    request.dec = target.dec;
  } else {
    const name = $("nameInput").value.trim();
    const ra = parseFloat($("raInput").value);
    const dec = parseFloat($("decInput").value);
    const hasRa = Number.isFinite(ra);
    const hasDec = Number.isFinite(dec);
    if (hasRa && hasDec) {
      request.name = name || "custom field";
      request.ra = ra;
      request.dec = dec;
    } else if (hasRa || hasDec) {
      throw new Error("Enter both RA and Dec, or use a target name.");
    } else if (name) {
      // The server resolves the name with Sesame and returns the coordinates.
      request.name = name;
    } else {
      throw new Error("Enter a target name, or RA and Dec in degrees.");
    }
  }
  return request;
}

function fillForm(params) {
  const curated = state.targets.find(t =>
    t.name === params.name ||
    (Math.abs(t.ra - params.ra) < 1e-5 && Math.abs(t.dec - params.dec) < 1e-5));

  if (curated) {
    selectTarget(curated.name);
  } else {
    $("targetSelect").value = "custom";
    $("nameInput").value = params.name || "";
    $("raInput").value = Number.isFinite(params.ra) ? params.ra : "";
    $("decInput").value = Number.isFinite(params.dec) ? params.dec : "";
  }

  SliderControls.get("fov")?.setValue(params.fov ?? 0.3, { silent: true });
  SliderControls.get("fps")?.setValue(state.fps, { silent: true });
  $("t0Input").value = params.t0 || "";
  $("t1Input").value = params.t1 || "";

  const wanted = params.bands || BANDS;
  document.querySelectorAll('input[name="band"]').forEach(input => {
    input.checked = wanted.includes(input.value);
  });
  $("trackInput").checked = Boolean(params.track);
}

// --------------------------------------------------------------------------
// Build a dataset (one upload per unique request)
// --------------------------------------------------------------------------

function applyForm() {
  try {
    startBuild(requestFromForm());
  } catch (err) {
    showError(err.message);
  }
}

async function startBuild(request) {
  let params;
  try {
    params = request;
    if (!Number.isFinite(params.fov) || params.fov < 0.1 || params.fov > 1.0) {
      throw new Error("Field of view must be 0.1 to 1.0 degrees.");
    }
  } catch (err) {
    showError(err.message);
    return;
  }

  const token = ++state.buildToken;
  pause();
  backToMovie(true);
  clearDirty();
  // Keep the current frame across a rebuild (FOV or date change); a brand-new
  // target just starts at frame 0 because there is no old frame list yet.
  if (state.frames.length) state.wantFrame = state.index;
  // A different field has different exposures: forget the old unticked frames.
  if (state.params && !sameField(state.params, params)) resetFilters({ quiet: true });
  state.params = params;
  state.jobId = null;
  syncURL();
  $("compareMsg").textContent =
    "Same detector only: a difference between bands is not a difference image.";
  $("compareMsg").classList.remove("error");

  showProgress("Starting build", null);
  setCancelVisible(false);

  let response;
  try {
    response = await postJSON("/api/build", params);
  } catch (err) {
    showError(`Build failed: ${err.message}`);
    return;
  }

  if (token !== state.buildToken) return;

  if (response.params) {
    state.params.name = response.params.name || state.params.name;
    if (!Number.isFinite(state.params.ra) && Number.isFinite(response.params.ra)) {
      state.params.ra = response.params.ra;
      state.params.dec = response.params.dec;
      // A name-only request was resolved by the server; show the result so
      // the form and the next shareable URL have the coordinates too.
      $("raInput").value = response.params.ra.toFixed(6);
      $("decInput").value = response.params.dec.toFixed(6);
    }
  }

  if (response.state === "ready") {
    await loadDataset(response.id, token);
    return;
  }

  state.jobId = response.id;
  setCancelVisible(true);
  let previewLoaded = false;

  while (token === state.buildToken) {
    let job;
    try {
      job = await getJSON(`/api/job/${response.id}`);
    } catch (err) {
      showError(`Lost the build: ${err.message}`);
      return;
    }
    if (token !== state.buildToken) return;

    if (job.state === "ready") {
      state.jobId = null;
      setCancelVisible(false);
      await loadDataset(response.id, token);
      return;
    }
    if (job.state === "error") {
      state.jobId = null;
      setCancelVisible(false);
      showError(job.error || "The build failed.");
      return;
    }
    if (job.state === "cancelled") {
      state.jobId = null;
      setCancelVisible(false);
      if (state.manifest && state.manifest.complete === false) {
        showProgress("Build cancelled. The preview remains available.", 0);
      } else {
        showError(job.error || "Build cancelled.");
      }
      return;
    }

    // A partial manifest is written as soon as the preview band is rendered.
    // Show it while the full build keeps running.
    if (job.preview_ready && !previewLoaded) {
      previewLoaded = true;
      try {
        await loadDataset(response.id, token, { preview: true, preserve: false });
      } catch (err) {
        showError(`Could not load the preview: ${err.message}`);
      }
      if (token !== state.buildToken) return;
    }

    if (job.state === "cancelling") {
      showProgress("Cancelling...", null);
      setCancelVisible(false);
    } else {
      const label = STAGE_LABEL[job.stage] || job.stage || "Working";
      const behind = job.queued_behind;
      let text = label + (job.total > 0 ? ` (${job.done}/${job.total})` : "");
      let fraction = job.total > 0 ? job.done / job.total : null;
      if (behind) {
        // One build runs at a time.  Show that the queue is moving instead of
        // leaving the user staring at an unexplained "Queued".
        const behindLabel = STAGE_LABEL[behind.stage] || behind.stage || "working";
        const field = Number.isFinite(behind.fov) ? `, ${behind.fov.toFixed(2)} deg` : "";
        text = `Waiting for ${behind.name}${field}: ${behindLabel}` +
               (behind.total > 0 ? ` (${behind.done}/${behind.total})` : "");
        fraction = behind.total > 0 ? behind.done / behind.total : null;
      }
      showProgress(text, fraction);
      setCancelVisible(true);
    }
    await sleep(800);
  }
}

async function cancelBuild() {
  if (!state.jobId) return;
  $("cancelBtn").disabled = true;
  try {
    await postJSON(`/api/job/${state.jobId}/cancel`, {});
    showProgress("Cancelling...", null);
    setCancelVisible(false);
  } catch (err) {
    $("cancelBtn").disabled = false;
    showError(`Could not cancel: ${err.message}`);
  }
}

function setCancelVisible(flag) {
  const button = $("cancelBtn");
  button.hidden = !flag;
  button.disabled = false;
}

// --------------------------------------------------------------------------
// Manifest and image loading
// --------------------------------------------------------------------------

function frameURL(frame) {
  const version = state.manifest?.render_version;
  return `/data/${state.datasetId}/${frame.png}` +
         (version ? `?v=${encodeURIComponent(version)}` : "");
}

function diffURL(a, b, mode) {
  const version = state.manifest?.render_version;
  return `/api/diff/${state.datasetId}?a=${a}&b=${b}&mode=${mode}` +
         (version ? `&v=${encodeURIComponent(version)}` : "");
}

function currentFrameKey() {
  const frame = state.frames[state.index];
  if (!frame) return null;
  return { obs_id: frame.obs_id, band: frame.band, mjd: frame.mjd };
}

function indexMatching(frames, key) {
  if (!key) return null;
  let index = frames.findIndex(f => f.obs_id === key.obs_id && f.band === key.band);
  if (index >= 0) return index;
  // obs_id is not unique across detectors; a band match is preferred above.
  index = frames.findIndex(f => f.obs_id === key.obs_id);
  if (index >= 0) return index;
  if (Number.isFinite(key.mjd)) {
    let best = null;
    let delta = Infinity;
    frames.forEach((frame, i) => {
      const distance = Math.abs(frame.mjd - key.mjd);
      if (distance < delta) {
        delta = distance;
        best = i;
      }
    });
    return best;
  }
  return null;
}

function applyManifest(manifest, options = {}) {
  const previousKey = options.previousKey || null;
  state.manifest = manifest;
  state.frames = manifest.frames || [];
  state.mode = "movie";

  adoptPendingSkip(manifest);
  renderSummary(manifest);
  renderTable(state.frames);
  setupWavelengthSliders(state.frames);
  recomputeVisible({ resetCompare: true });
  updatePreviewBanner(manifest);

  const last = Math.max(0, state.frames.length - 1);

  let wanted = options.frame;
  if (!Number.isInteger(wanted)) {
    const matched = indexMatching(state.frames, previousKey);
    if (matched !== null) wanted = matched;
    else if (Number.isInteger(state.wantFrame)) wanted = state.wantFrame;
    else wanted = 0;
  }
  state.wantFrame = null;

  setIndex(Math.min(Math.max(wanted, 0), last));
}

async function loadDataset(id, token, options = {}) {
  let manifest;
  try {
    manifest = await getJSON(`/api/dataset/${id}`);
  } catch (err) {
    showError(`Could not load the dataset: ${err.message}`);
    return;
  }
  if (token !== state.buildToken) return;
  if (!manifest.frames || !manifest.frames.length) {
    showError("The dataset has no frames yet.");
    return;
  }

  const previousKey = options.preserve === false ? null : currentFrameKey();
  state.datasetId = id;
  state.images = new Map();
  applyManifest(manifest, { previousKey, frame: options.frame });

  // Show a frame immediately, then load the rest in the background.  Waiting
  // for all 258 PNGs before drawing made the page feel much slower than it is.
  const total = manifest.frames.length;
  const urls = manifest.frames.map(frameURL);
  const prefix = options.preview ? "Loading preview" : "Loading images";
  showProgress(`${prefix} (0/${total})`, 0);

  // Load every PNG once.  Blinking afterwards is then a pure texture swap
  // with no network request, which is what makes the movie smooth.
  const images = await state.viewer.preload(urls, done => {
    if (token === state.buildToken && (done % 8 === 0 || done === total)) {
      showProgress(`${prefix} (${done}/${total})`, done / total);
    }
  });
  if (token !== state.buildToken) return;

  state.images = images;
  // The current frame may have been shown through showURL() before its
  // preload finished; redraw it now that the map is complete.
  setIndex(state.index);

  if (options.preview) {
    const planned = manifest.planned?.frames;
    showProgress(
      `Preview ready: ${manifest.frames.length} of ${planned ?? "?"} frames. ` +
      "Still building the full dataset.", null);
    return;
  }

  hideProgress();
  if (state.wantPlay) {
    state.wantPlay = false;
    play();
  }
  syncURL();
}

function updatePreviewBanner(manifest) {
  const banner = $("previewBanner");
  if (!manifest || manifest.complete !== false) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  const band = manifest.preview_band
    ? (BAND_SHORT[manifest.preview_band] || manifest.preview_band)
    : "preview";
  const planned = manifest.planned?.frames;
  banner.hidden = false;
  banner.textContent =
    `Preview: ${band}, ${manifest.frames.length} of ${planned ?? "?"} frames ` +
    "— building the other detectors";
}

// --------------------------------------------------------------------------
// Playback
// --------------------------------------------------------------------------

function pauseAndSetIndex(value) {
  pause();
  setIndex(value);
}

function changePlaybackRate(value) {
  state.fps = value;
  if (state.playing) {
    pause();
    play();
  }
  syncURL();
}

function play() {
  if (state.playing || state.mode === "diff" || !state.order.length) return;
  state.playing = true;
  $("playBtn").textContent = "Pause";
  const interval = Math.max(80, 1000 / state.fps);
  state.timer = setInterval(() => stepVisible(1), interval);
  syncURL();
}

function pause() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.playing = false;
  $("playBtn").textContent = "Play";
  syncURL();
}

function setIndex(index) {
  if (!state.frames.length) return;
  const n = state.frames.length;
  state.index = ((index % n) + n) % n;
  const frame = state.frames[state.index];

  // Any frame change leaves the difference view.
  state.mode = "movie";
  $("backBtn").hidden = true;
  $("legend").hidden = true;
  $("playBtn").disabled = false;

  pushLevels();

  const url = frameURL(frame);
  const image = state.images.get(url);
  if (image) state.viewer.show(image);
  else state.viewer.showURL(url);

  SliderControls.get("frame")?.setValue(sliderPosition(state.index), { silent: true });
  updateCaption();
  renderFrameInfo(frame);
  updateMarker(frame);
  updateColorbar();
  highlightRow();
  state.plots?.setCurrent(state.index);
  if (!state.playing) syncURL();
}

function captionFor(frame, index, total) {
  const flux = frame.flux_ujy === null ? "flux -" : `flux ${fmt(frame.flux_ujy, 1)} uJy`;
  const snr = frame.peak_snr === null ? "S/N -" : `peak S/N ${fmt(frame.peak_snr, 1)}`;
  return `${positionText(index, total)}   ${frame.date}   ${frame.band_label}   ` +
         `${fmt(frame.wavelength_um, 2)} um   ${flux}   ${snr}` +
         (frame.target_bad ? "   [target pixel flagged]" : "");
}

function updateMarker(frame) {
  const marker = $("targetMarker");
  if (state.mode !== "movie" || !state.manifest) {
    marker.hidden = true;
    return;
  }
  // With tracking on, the reprojection has already put the target at the
  // centre, so the sky-motion offset in the manifest is not where the target
  // is in this image.
  if (state.manifest.request.track) {
    marker.hidden = true;
    return;
  }
  const offset = frame.target_offset_px;
  if (!offset) {
    marker.hidden = true;
    return;
  }
  const n = state.manifest.grid.n;
  const x = 0.5 + offset[0] / n;
  const y = 0.5 - offset[1] / n;
  if (Math.abs(x - 0.5) < 0.004 && Math.abs(y - 0.5) < 0.004) {
    marker.hidden = true;
    return;
  }
  marker.style.left = `${x * 100}%`;
  marker.style.top = `${y * 100}%`;
  marker.hidden = false;
}

// --------------------------------------------------------------------------
// Frame filters: ticked frames and the wavelength window.  Client-side only.
//
// A frame is "visible" when it is ticked and inside the wavelength window.
// Visible frames drive Play, +1/-1, the frame slider, the A/B lists and the
// plots.  Every frame keeps its manifest index, so the server never sees the
// filter and /api/diff still takes original indices.
// --------------------------------------------------------------------------

function frameKey(frame) {
  return `${frame.obs_id}|${frame.band}`;
}

function isBlended(frame) {
  const off = frame.centroid_offset_px;
  if (!Array.isArray(off) || !Number.isFinite(off[0]) || !Number.isFinite(off[1])) {
    return false;
  }
  return Math.hypot(off[0], off[1]) > BLEND_PX;
}

function passesFilters(frame) {
  if (state.excluded.has(frameKey(frame))) return false;
  const wl = state.filter.wl;
  if (wl) {
    const lam = frame.wavelength_um;
    if (!Number.isFinite(lam) || lam < wl[0] - 1e-9 || lam > wl[1] + 1e-9) return false;
  }
  return true;
}

function sameField(a, b) {
  if (!a || !b) return false;
  if (Number.isFinite(a.ra) && Number.isFinite(b.ra)) {
    return Math.abs(a.ra - b.ra) < 1e-6 && Math.abs(a.dec - b.dec) < 1e-6;
  }
  return a.name === b.name;
}

/** Indices from a shared URL refer to the complete dataset, not the preview. */
function adoptPendingSkip(manifest) {
  if (!state.wantSkip || manifest.complete === false) return;
  for (const index of state.wantSkip) {
    const frame = manifest.frames?.[index];
    if (frame) state.excluded.add(frameKey(frame));
  }
  state.wantSkip = null;
}

function recomputeVisible({ resetCompare = false } = {}) {
  const frames = state.frames;
  state.visible = frames.map(passesFilters);
  state.order = [];
  state.visible.forEach((ok, i) => { if (ok) state.order.push(i); });

  const slider = SliderControls.get("frame");
  slider?.setBounds(0, Math.max(0, state.order.length - 1));
  slider?.setDisabled(state.order.length === 0);
  slider?.setValue(sliderPosition(state.index), { silent: true });

  paintTableVisibility();
  updateFilterCount();
  if (resetCompare) fillCompare({ reset: true });
  else scheduleCompareRefresh();
  state.plots?.update(frames, state.visible);
  if (state.order.length === 0 && state.playing) pause();
  updateCaption();
}

function scheduleCompareRefresh() {
  if (state.compareRefresh) return;
  state.compareRefresh = requestAnimationFrame(() => {
    state.compareRefresh = 0;
    fillCompare();
  });
}

/** Position in `order` of the first visible frame at or after `index`. */
function visiblePosition(index) {
  const order = state.order;
  let low = 0;
  let high = order.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (order[mid] < index) low = mid + 1;
    else high = mid;
  }
  return low;
}

function sliderPosition(index) {
  return Math.min(visiblePosition(index), Math.max(0, state.order.length - 1));
}

/** Move by one visible frame, wrapping at both ends. */
function stepVisible(delta) {
  const order = state.order;
  if (!order.length) return;
  const pos = visiblePosition(state.index);
  let next;
  if (order[pos] === state.index) {
    next = pos + delta;
  } else {
    // The current frame is hidden: `pos` is the first visible frame after it.
    next = delta > 0 ? pos + delta - 1 : pos + delta;
  }
  next = ((next % order.length) + order.length) % order.length;
  setIndex(order[next]);
}

function positionText(index, total) {
  const shown = state.order.length;
  if (shown === total) return `${index + 1}/${total}`;
  if (!state.visible[index]) return `${index + 1}/${total} (hidden by filters)`;
  return `${index + 1}/${total} (${visiblePosition(index) + 1}/${shown} shown)`;
}

function updateCaption() {
  const frame = state.frames[state.index];
  if (!frame || state.mode !== "movie") return;
  $("caption").textContent = captionFor(frame, state.index, state.frames.length);
}

function paintTableVisibility() {
  const rows = $("frameRows").rows;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle("off", !state.visible[i]);
  }
}

function syncCheckboxes() {
  $("frameRows").querySelectorAll("input[data-pick]").forEach(box => {
    const frame = state.frames[parseInt(box.dataset.pick, 10)];
    if (frame) box.checked = !state.excluded.has(frameKey(frame));
  });
}

function updateFilterCount() {
  const note = $("filterCount");
  const total = state.frames.length;
  if (!total) {
    note.textContent = "";
    note.classList.remove("error");
    return;
  }
  const shown = state.order.length;
  const parts = [`Showing ${shown} of ${total} frames.`];
  let unticked = 0;
  for (const frame of state.frames) {
    if (state.excluded.has(frameKey(frame))) unticked += 1;
  }
  if (unticked) parts.push(`${unticked} unticked.`);
  if (state.filter.wl) {
    parts.push(`Window ${fmt(state.filter.wl[0], 2)} to ${fmt(state.filter.wl[1], 2)} um.`);
  }
  if (shown === 0) parts.push("Nothing to play: widen the window or tick some frames.");
  note.textContent = parts.join(" ");
  note.classList.toggle("error", shown === 0);
}

function setExcluded(index, excluded) {
  const frame = state.frames[index];
  if (!frame) return;
  if (excluded) state.excluded.add(frameKey(frame));
  else state.excluded.delete(frameKey(frame));
  recomputeVisible();
  syncURLSoon();
}

function excludeWhere(predicate) {
  for (const frame of state.frames) {
    if (predicate(frame)) state.excluded.add(frameKey(frame));
  }
  syncCheckboxes();
  recomputeVisible();
  syncURLSoon();
}

function resetFilters({ quiet = false } = {}) {
  state.excluded.clear();
  state.filter.wl = null;
  if (state.wlBounds) paintWavelengthSliders();
  syncCheckboxes();
  recomputeVisible();
  if (!quiet) syncURLSoon();
}

// --- wavelength window ----------------------------------------------------

function setupWavelengthSliders(frames) {
  const low = SliderControls.get("wlmin");
  const high = SliderControls.get("wlmax");
  if (!low || !high) return;

  const lams = frames.map(f => f.wavelength_um).filter(Number.isFinite);
  if (!lams.length) {
    state.wlBounds = null;
    low.setDisabled(true);
    high.setDisabled(true);
    return;
  }
  // Round outwards to the slider step so the full range is always reachable.
  const min = Math.floor(Math.min(...lams) * 100) / 100;
  const max = Math.ceil(Math.max(...lams) * 100) / 100;
  state.wlBounds = [min, max];
  low.setDisabled(false);
  high.setDisabled(false);
  low.setBounds(min, max);
  high.setBounds(min, max);
  paintWavelengthSliders();
}

/** Show state.filter.wl (or the full range) on the two sliders, silently. */
function paintWavelengthSliders() {
  if (!state.wlBounds) return;
  const [min, max] = state.wlBounds;
  const wl = state.filter.wl;
  SliderControls.get("wlmin")?.setValue(wl ? wl[0] : min, { silent: true });
  SliderControls.get("wlmax")?.setValue(wl ? wl[1] : max, { silent: true });
}

function changeWavelength(value, controller) {
  const low = SliderControls.get("wlmin");
  const high = SliderControls.get("wlmax");
  if (!low || !high) return;
  // Keep min <= max by pushing the other handle along.
  if (controller.name === "wlmin" && value > high.value) high.setValue(value, { silent: true });
  if (controller.name === "wlmax" && value < low.value) low.setValue(value, { silent: true });

  if (!state.wlBounds) {
    state.filter.wl = null;
    return;
  }
  const [min, max] = state.wlBounds;
  const full = low.value <= min + 1e-9 && high.value >= max - 1e-9;
  state.filter.wl = full ? null : [low.value, high.value];
  recomputeVisible();
  syncURLSoon();
}

// --------------------------------------------------------------------------
// Display levels and the colourbar
//
// The PNG maps each frame's stretch [lo, hi] (MJy/sr above the frame's median
// sky) onto grey levels 1..255, with 0 reserved for "no data".  A level g is
// therefore  lo + (g - 1) / 254 * (hi - lo).  The black and white levels are
// fractions s of that stretch (0 = lo, 1 = hi); in the shader they become the
// texture values (1 + 254 s) / 255.  This can only re-window what the PNG
// already holds: pixels clipped at the 1st or 99.5th percentile stay clipped.
// --------------------------------------------------------------------------

function changeLevels(value, controller) {
  const black = SliderControls.get("black");
  const white = SliderControls.get("white");
  if (!black || !white) return;
  if (controller.name === "black" && value > white.value - LEVEL_GAP) {
    black.setValue(white.value - LEVEL_GAP, { silent: true });
  }
  if (controller.name === "white" && value < black.value + LEVEL_GAP) {
    white.setValue(black.value + LEVEL_GAP, { silent: true });
  }
  state.levels = { black: black.value / 100, white: white.value / 100 };
  applyLevelsToView();
  syncURLSoon();
}

function resetLevels() {
  SliderControls.get("black")?.setValue(0, { silent: true });
  SliderControls.get("white")?.setValue(100, { silent: true });
  state.levels = { black: 0, white: 1 };
  applyLevelsToView();
  syncURLSoon();
}

function levelsForViewer() {
  const { black, white } = state.levels;
  // Difference images carry their own 3-sigma stretch: never re-window them.
  if (state.mode !== "movie" || (black <= 0 && white >= 1)) return [0, 1];
  return [(1 + black * 254) / 255, (1 + white * 254) / 255];
}

function pushLevels() {
  state.viewer.setLevels(...levelsForViewer());
}

function applyLevelsToView() {
  pushLevels();
  updateColorbar();
}

function updateColorbar() {
  const bar = $("colorbar");
  const frame = state.frames[state.index];
  const stretch = frame ? state.manifest?.stretch?.[frame.band] : null;
  const ok = state.mode === "movie" && Array.isArray(stretch) &&
             Number.isFinite(stretch[0]) && Number.isFinite(stretch[1]) &&
             stretch[1] > stretch[0];
  if (!ok) {
    bar.hidden = true;
    state.colorbarKey = "";
    return;
  }
  bar.hidden = false;

  const key = `${frame.band}|${state.levels.black}|${state.levels.white}`;
  if (key === state.colorbarKey) return;
  state.colorbarKey = key;

  const [lo, hi] = stretch;
  const span = hi - lo;
  const from = lo + state.levels.black * span;
  const to = lo + state.levels.white * span;
  // Enough decimals that neighbouring ticks (a quarter of the range apart)
  // still differ in their second significant digit.
  const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10((to - from) / 4)) + 1));
  const ticks = $("cbTicks").children;
  for (let k = 0; k < ticks.length; k++) {
    ticks[k].textContent = (from + ((to - from) * k) / (ticks.length - 1)).toFixed(decimals);
  }
  $("cbCaption").textContent =
    `MJy/sr above sky, ${frame.band_label} scale (each frame's median removed)`;
}

// --------------------------------------------------------------------------
// Shareable view state: wavelength window, unticked frames, display levels
// --------------------------------------------------------------------------

function readViewStateFromQuery(query) {
  const number = key => {
    const value = parseFloat(query.get(key));
    return Number.isFinite(value) ? value : null;
  };

  const lo = number("lo");
  const hi = number("hi");
  if (lo !== null || hi !== null) {
    const black = Math.min(Math.max(lo ?? 0, 0), 100 - LEVEL_GAP);
    const white = Math.max(Math.min(hi ?? 100, 100), black + LEVEL_GAP);
    SliderControls.get("black")?.setValue(black, { silent: true });
    SliderControls.get("white")?.setValue(white, { silent: true });
    state.levels = { black: black / 100, white: white / 100 };
  }

  const w0 = number("wl0");
  const w1 = number("wl1");
  if (w0 !== null && w1 !== null && w1 >= w0) state.filter.wl = [w0, w1];

  const skip = decodeRanges(query.get("skip"));
  state.wantSkip = skip.length ? skip : null;
}

function skippedIndices() {
  const out = [];
  state.frames.forEach((frame, i) => {
    if (state.excluded.has(frameKey(frame))) out.push(i);
  });
  return out;
}

/** [3, 4, 5, 9] -> "3-5,9" */
function encodeRanges(indices) {
  const parts = [];
  let i = 0;
  while (i < indices.length) {
    let j = i;
    while (j + 1 < indices.length && indices[j + 1] === indices[j] + 1) j += 1;
    parts.push(j > i ? `${indices[i]}-${indices[j]}` : String(indices[i]));
    i = j + 1;
  }
  return parts.join(",");
}

/** "3-5,9" -> [3, 4, 5, 9]; anything that is not a number or a range is ignored. */
function decodeRanges(text) {
  const out = [];
  if (!text) return out;
  for (const part of text.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) continue;
    const first = parseInt(match[1], 10);
    const last = match[2] === undefined ? first : parseInt(match[2], 10);
    for (let k = first; k <= Math.min(last, first + 100000); k++) out.push(k);
  }
  return out;
}

/** Slider drags fire many events; history.replaceState is rate limited in some browsers. */
function syncURLSoon() {
  clearTimeout(state.urlTimer);
  state.urlTimer = setTimeout(syncURL, 200);
}

// --------------------------------------------------------------------------
// A-B / (A+B)/2
// --------------------------------------------------------------------------

function fillCompare({ reset = false } = {}) {
  const frames = state.frames;
  const previousA = $("aSelect").value;
  const previousB = $("bSelect").value;

  // Only visible frames are offered, but the option values stay manifest
  // indices because that is what /api/diff expects.
  const options = state.order.map(index => {
    const frame = frames[index];
    return `<option value="${index}">#${String(index).padStart(3, "0")}  ${frame.date}  ` +
           `${frame.band_label}  ${fmt(frame.wavelength_um, 2)} um</option>`;
  }).join("");
  $("aSelect").innerHTML = options;
  $("bSelect").innerHTML = options;

  const keepA = !reset && Boolean(state.visible[parseInt(previousA, 10)]);
  const keepB = !reset && Boolean(state.visible[parseInt(previousB, 10)]);
  if (keepA) $("aSelect").value = previousA;
  if (keepB) $("bSelect").value = previousB;

  // Otherwise default to the first and last frame of the first detector shown.
  const band = state.order.length ? frames[state.order[0]].band : null;
  const same = state.order.filter(i => frames[i].band === band);
  if (same.length) {
    if (!keepA) $("aSelect").value = same[0];
    if (!keepB) $("bSelect").value = same[same.length - 1];
  }
}

function showDiff(mode) {
  if (!state.manifest) return;
  const a = parseInt($("aSelect").value, 10);
  const b = parseInt($("bSelect").value, 10);
  const first = state.frames[a];
  const second = state.frames[b];
  if (!first || !second) return;

  if (first.band !== second.band) {
    $("compareMsg").textContent =
      "Pick two frames in the same detector. A difference between bands is " +
      "not a difference image.";
    $("compareMsg").classList.add("error");
    return;
  }

  $("compareMsg").classList.remove("error");
  $("compareMsg").textContent = mode === "sub"
    ? "Blue: A fainter than B. Red: A brighter than B. Stretched to 3 sigma."
    : "Average of A and B.";

  pause();
  state.mode = "diff";
  applyLevelsToView();          // difference images are never re-windowed
  state.viewer.showURL(diffURL(a, b, mode));
  $("legend").hidden = mode !== "sub";
  $("legend").textContent = mode === "sub"
    ? "A - B: blue = A fainter, red = A brighter (3 sigma)"
    : "A + B averaged";
  $("backBtn").hidden = false;
  $("targetMarker").hidden = true;
  $("playBtn").disabled = true;
  $("caption").textContent =
    `${mode === "sub" ? "A - B" : "(A + B) / 2"}   ` +
    `A #${a} ${first.date} ${first.band_label}   ` +
    `B #${b} ${second.date} ${second.band_label}`;
}

function backToMovie(silent = false) {
  if (silent) {
    state.mode = "movie";
    $("backBtn").hidden = true;
    $("legend").hidden = true;
    $("playBtn").disabled = false;
    applyLevelsToView();
    return;
  }
  setIndex(state.index);
}

// --------------------------------------------------------------------------
// Panels
// --------------------------------------------------------------------------

function renderSummary(manifest) {
  const summary = manifest.summary;
  const grid = manifest.grid;
  const request = manifest.request;
  const pm = manifest.target;
  const pmText = Math.abs(pm.pm_ra_mas_yr) + Math.abs(pm.pm_dec_mas_yr) > 0
    ? `${fmt(pm.pm_ra_mas_yr, 0)}, ${fmt(pm.pm_dec_mas_yr, 0)} mas/yr`
    : "not applied";

  const rows = [
    ["Target", state.params?.name || "field"],
    ["Centre", `${fmt(pm.ra_deg, 5)}, ${fmt(pm.dec_deg, 5)}`],
    ["Proper motion", pmText],
    ["Field", `${fmt(request.fov_deg, 2)} deg, ${grid.n} x ${grid.n} px, ` +
              `${fmt(grid.pixel_scale_arcsec, 2)}"/px`],
    ["Frames", `${summary.n_frames} in ${summary.n_bands} detectors`],
    ["Dates", `${summary.date_min} to ${summary.date_max}`],
    ["Wavelength", `${fmt(summary.wavelength_min, 3)} to ` +
                   `${fmt(summary.wavelength_max, 3)} um`],
    ["Alignment", request.track ? "track target motion" : "sky fixed"],
  ];
  if (manifest.complete === false) {
    rows.push(["Build", "preview (continues in background)"]);
  }
  setKV($("summary"), rows);
}

function renderFrameInfo(frame) {
  const flagText = frame.target_bad
    ? `${frame.target_flag_names} (bad bit set)`
    : frame.target_flag_names;
  const offset = frame.target_offset_px;
  const tracked = Boolean(state.manifest?.request.track);
  setKV($("frameInfo"), [
    ["Date", frame.iso.replace("T", " ").slice(0, 19)],
    ["Detector", `${frame.band_label} (${frame.band})`],
    ["Wavelength", `${fmt(frame.wavelength_um, 4)} um ` +
                   `(width ${fmt(frame.bandwidth_um, 3)} um)`],
    ["Flux", frame.flux_ujy === null
      ? "-" : `${fmt(frame.flux_ujy, 1)} +/- ${fmt(frame.err_ujy, 1)} uJy`],
    ["Peak S/N", fmt(frame.peak_snr, 1)],
    ["Target flag", flagText],
    ["Offset", tracked
      ? "centred (tracking)"
      : (offset ? `${fmt(offset[0], 1)}, ${fmt(offset[1], 1)} px` : "-")],
    ["Sky level", `${fmt(frame.background_mjy_sr, 4)} MJy/sr removed`],
    ["Obs id", frame.obs_id],
  ]);
}

function renderTable(frames) {
  $("frameRows").innerHTML = frames.map((frame, index) => {
    const used = !state.excluded.has(frameKey(frame));
    let flag = "";
    let title = "";
    if (frame.target_bad) {
      flag = "!";
      title = "target pixel has a bad flag";
    } else if (isBlended(frame)) {
      flag = "b";
      title = "centroid is more than half a pixel from the target: probably blended";
    }
    return `<tr data-i="${index}">` +
      `<td class="pick"><input type="checkbox" data-pick="${index}" ` +
      `aria-label="Use frame ${index}"${used ? " checked" : ""}></td>` +
      `<td>${index}</td>` +
      `<td>${frame.date}</td>` +
      `<td>${frame.band_label}</td>` +
      `<td>${fmt(frame.wavelength_um, 2)}</td>` +
      `<td>${frame.flux_ujy === null ? "-" : fmt(frame.flux_ujy, 0)}</td>` +
      `<td>${fmt(frame.peak_snr, 1)}</td>` +
      `<td title="${title}">${flag}</td>` +
      `</tr>`;
  }).join("");
}

function highlightRow() {
  const previous = $("frameRows").querySelector("tr.current");
  if (previous) previous.classList.remove("current");
  const row = $("frameRows").querySelector(`tr[data-i="${state.index}"]`);
  if (!row) return;
  row.classList.add("current");
  if (!state.playing) {
    // Scroll the table box only.  scrollIntoView() would scroll the whole
    // page and push the image out of view.
    const wrap = $("tableWrap");
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < wrap.scrollTop) wrap.scrollTop = top;
    else if (bottom > wrap.scrollTop + wrap.clientHeight) {
      wrap.scrollTop = bottom - wrap.clientHeight;
    }
  }
}

function setKV(dl, pairs) {
  dl.replaceChildren();
  for (const [key, value] of pairs) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    dl.append(dt, dd);
  }
}

// --------------------------------------------------------------------------
// URL state, so every view is a shareable link
// --------------------------------------------------------------------------

function paramsFromQuery(query) {
  const hasPosition = (query.has("ra") && query.has("dec")) || query.has("name");
  if (!hasPosition) return null;

  const fov = parseFloat(query.get("fov") || "0.3");
  const fps = parseFloat(query.get("fps") || "4");
  state.fps = Number.isFinite(fps) ? Math.min(Math.max(fps, 0.5), 12) : 4;

  const frame = parseInt(query.get("frame") || "", 10);
  state.wantFrame = Number.isFinite(frame) ? frame : null;
  state.wantPlay = query.get("play") === "1";

  const bands = query.has("bands")
    ? query.get("bands").split(",").map(name => name.startsWith("SPHEREx-")
        ? name : `SPHEREx-${name}`)
    : BANDS;

  const params = {
    fov: Number.isFinite(fov) ? fov : 0.3,
    t0: query.get("t0") || null,
    t1: query.get("t1") || null,
    bands,
    track: query.get("track") === "1",
  };

  if (query.has("ra") && query.has("dec")) {
    params.ra = parseFloat(query.get("ra"));
    params.dec = parseFloat(query.get("dec"));
    params.name = query.get("name") || "custom field";
  } else {
    params.name = query.get("name");
  }
  return params;
}

function syncURL() {
  if (!state.params) return;
  const params = new URLSearchParams();
  if (state.params.name) params.set("name", state.params.name);
  if (Number.isFinite(state.params.ra)) params.set("ra", state.params.ra);
  if (Number.isFinite(state.params.dec)) params.set("dec", state.params.dec);
  params.set("fov", state.params.fov);
  if (state.params.t0) params.set("t0", state.params.t0);
  if (state.params.t1) params.set("t1", state.params.t1);
  params.set("bands", state.params.bands.map(b => BAND_SHORT[b]).join(","));
  if (state.params.track) params.set("track", "1");
  params.set("fps", state.fps);
  params.set("frame", state.index);
  params.set("interp", state.interp);
  if (state.filter.wl) {
    params.set("wl0", state.filter.wl[0]);
    params.set("wl1", state.filter.wl[1]);
  }
  // Unticked indices only mean something for the complete dataset; during a
  // preview keep whatever the shared link asked for.
  const complete = state.manifest && state.manifest.complete !== false;
  const skipText = complete
    ? encodeRanges(skippedIndices())
    : (state.wantSkip ? encodeRanges(state.wantSkip) : "");
  if (skipText) params.set("skip", skipText);
  if (state.levels.black > 0) params.set("lo", Math.round(state.levels.black * 100));
  if (state.levels.white < 1) params.set("hi", Math.round(state.levels.white * 100));
  if (state.playing) params.set("play", "1");
  if (document.body.classList.contains("embed")) params.set("embed", "1");

  history.replaceState(null, "", `${location.pathname}?${params}`);
}

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

function fmt(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "-";
  }
  return Number(value).toFixed(digits);
}

function showProgress(text, fraction) {
  const box = $("progress");
  box.hidden = false;
  box.classList.remove("error");
  $("progressText").textContent = text;
  const bar = $("progressBar");
  if (fraction === null) {
    bar.classList.add("indeterminate");
    bar.style.width = "100%";
  } else {
    bar.classList.remove("indeterminate");
    bar.style.width = `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
  }
}

function hideProgress() {
  $("progress").hidden = true;
  setCancelVisible(false);
}

function showError(message) {
  const box = $("progress");
  box.hidden = false;
  box.classList.add("error");
  barStop();
  setCancelVisible(false);
  $("progressText").textContent = message;
}

function barStop() {
  const bar = $("progressBar");
  bar.classList.remove("indeterminate");
  bar.style.width = "100%";
}

async function getJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch (_) {}
    throw new Error(message);
  }
  return response.json();
}

async function postJSON(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch (_) {}
    throw new Error(message);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
