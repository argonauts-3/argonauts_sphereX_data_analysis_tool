/* SPHEREx time explorer - front end.
 *
 * The server has already aligned every exposure onto one north-up grid and
 * rendered it to a PNG, so this file only has to:
 *   - ask for a dataset, poll the build progress,
 *   - preload the PNGs and swap one <img> at the requested rate,
 *   - show the metadata that comes with each frame,
 *   - ask the server for an A-B or (A+B)/2 image.
 *
 * No frameworks, no build step.
 */

"use strict";

const BANDS = ["SPHEREx-D1", "SPHEREx-D2", "SPHEREx-D3",
               "SPHEREx-D4", "SPHEREx-D5", "SPHEREx-D6"];
const BAND_SHORT = Object.fromEntries(BANDS.map(b => [b, b.slice(-2)]));
const STAGE_LABEL = {
  queued: "Queued",
  query: "Searching the archive",
  downloading: "Downloading cutouts",
  measuring: "Measuring frames",
  aligning: "Aligning frames",
  rendering: "Rendering images",
  loading: "Loading images into the browser",
  ready: "Ready",
};

const $ = id => document.getElementById(id);

const state = {
  targets: [],
  params: null,        // the build request currently on screen
  datasetId: null,
  manifest: null,
  frames: [],
  index: 0,
  fps: 4,
  playing: false,
  timer: null,
  buildToken: 0,
  mode: "movie",       // or "diff"
  wantFrame: null,
  wantPlay: false,
};

// --------------------------------------------------------------------------
// Start-up
// --------------------------------------------------------------------------

init();

async function init() {
  const query = new URLSearchParams(location.search);
  if (query.get("embed") === "1") document.body.classList.add("embed");

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

  const params = paramsFromQuery(query);
  if (params) {
    fillForm(params);
    startBuild(params);
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
// Controls.  Every numeric control is a slider paired with a number input:
// dragging updates the number, typing updates the slider.
// --------------------------------------------------------------------------

function linkPair(rangeId, numberId, commit) {
  const range = $(rangeId);
  const number = $(numberId);

  range.addEventListener("input", () => { number.value = range.value; });
  range.addEventListener("change", () => {
    number.value = range.value;
    commit(parseFloat(range.value));
  });

  number.addEventListener("change", () => {
    let value = parseFloat(number.value);
    if (!Number.isFinite(value)) value = parseFloat(range.value);
    value = Math.min(Math.max(value, parseFloat(number.min)), parseFloat(number.max));
    number.value = value;
    range.value = value;
    commit(value);
  });
}

function wireControls() {
  $("buildForm").addEventListener("submit", event => {
    event.preventDefault();
    applyForm();
  });

  $("targetSelect").addEventListener("change", () => {
    const name = $("targetSelect").value;
    if (name === "custom") {
      $("nameInput").disabled = false;
      $("raInput").disabled = false;
      $("decInput").disabled = false;
      $("nameInput").focus();
    } else {
      selectTarget(name);
      applyForm();
    }
  });

  linkPair("fovRange", "fovNumber", () => applyForm());
  linkPair("fpsRange", "fpsNumber", value => {
    state.fps = value;
    if (state.playing) {
      pause();
      play();
    }
    syncURL();
  });
  linkPair("frameRange", "frameNumber", value => {
    pause();
    setIndex(value);
  });

  $("frameRange").addEventListener("input", () => {
    pause();
    setIndex(parseInt($("frameRange").value, 10));
  });

  $("playBtn").addEventListener("click", () => {
    if (state.mode === "diff") return;
    state.playing ? pause() : play();
  });
  $("prevBtn").addEventListener("click", () => { pause(); setIndex(state.index - 1); });
  $("nextBtn").addEventListener("click", () => { pause(); setIndex(state.index + 1); });

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
      applyForm();
    });
  });

  $("trackInput").addEventListener("change", () => applyForm());

  $("frameRows").addEventListener("click", event => {
    const row = event.target.closest("tr[data-i]");
    if (!row) return;
    pause();
    setIndex(parseInt(row.dataset.i, 10));
  });

  document.addEventListener("keydown", event => {
    const tag = (event.target.tagName || "").toLowerCase();
    if (["input", "select", "textarea", "button"].includes(tag)) return;
    if (event.key === " ") { event.preventDefault(); state.playing ? pause() : play(); }
    if (event.key === "ArrowRight") { pause(); setIndex(state.index + 1); }
    if (event.key === "ArrowLeft") { pause(); setIndex(state.index - 1); }
  });
}

function selectTarget(name) {
  const target = state.targets.find(t => t.name === name);
  if (!target) return;
  $("targetSelect").value = target.name;
  $("nameInput").value = target.name;
  $("nameInput").disabled = true;
  $("raInput").value = target.ra.toFixed(6);
  $("decInput").value = target.dec.toFixed(6);
  $("raInput").disabled = true;
  $("decInput").disabled = true;
}

function requestFromForm() {
  const selected = $("targetSelect").value;
  const bands = [...document.querySelectorAll('input[name="band"]:checked')]
    .map(input => input.value);
  if (bands.length === 0) throw new Error("Pick at least one detector.");

  const request = {
    fov: parseFloat($("fovNumber").value),
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
    if (Number.isFinite(ra) && Number.isFinite(dec)) {
      request.name = name || "custom field";
      request.ra = ra;
      request.dec = dec;
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
    $("nameInput").disabled = false;
    $("raInput").disabled = false;
    $("decInput").disabled = false;
    $("nameInput").value = params.name || "";
    $("raInput").value = Number.isFinite(params.ra) ? params.ra : "";
    $("decInput").value = Number.isFinite(params.dec) ? params.dec : "";
  }

  $("fovRange").value = $("fovNumber").value = params.fov ?? 0.3;
  $("fpsRange").value = $("fpsNumber").value = state.fps;
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
  // Keep the current frame across a rebuild (FOV or date change); a brand-new
  // target just starts at frame 0 because there is no old frame list yet.
  if (state.frames.length) state.wantFrame = state.index;
  state.params = params;
  syncURL();
  $("compareMsg").textContent =
    "Same detector only: a difference between bands is not a difference image.";
  $("compareMsg").classList.remove("error");

  showProgress("Starting build", null);

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
      await loadDataset(response.id, token);
      return;
    }
    if (job.state === "error") {
      showError(job.error || "The build failed.");
      return;
    }
    const label = STAGE_LABEL[job.stage] || job.stage || "Working";
    const fraction = job.total > 0 ? job.done / job.total : null;
    showProgress(label + (job.total > 0 ? ` (${job.done}/${job.total})` : ""), fraction);
    await sleep(800);
  }
}

async function loadDataset(id, token) {
  let manifest;
  try {
    manifest = await getJSON(`/api/dataset/${id}`);
  } catch (err) {
    showError(`Could not load the dataset: ${err.message}`);
    return;
  }
  if (token !== state.buildToken) return;

  state.datasetId = id;
  state.manifest = manifest;
  state.frames = manifest.frames;
  state.mode = "movie";

  renderSummary(manifest);
  renderTable(manifest.frames);
  fillCompare(manifest.frames);
  $("frameRange").max = Math.max(0, manifest.frames.length - 1);
  $("frameNumber").max = Math.max(0, manifest.frames.length - 1);

  // Load every PNG once.  Blinking afterwards is then a pure swap with no
  // network request, which is what makes the movie smooth.
  let loaded = 0;
  const total = manifest.frames.length;
  await Promise.all(manifest.frames.map(frame => new Promise(resolve => {
    const image = new Image();
    const done = () => {
      loaded += 1;
      if (loaded % 8 === 0 || loaded === total) {
        showProgress(`Loading images (${loaded}/${total})`, loaded / total);
      }
      resolve();
    };
    image.onload = done;
    image.onerror = done;
    image.src = `/data/${id}/${frame.png}`;
  })));
  if (token !== state.buildToken) return;

  hideProgress();
  const wanted = state.wantFrame;
  state.wantFrame = null;
  setIndex(Number.isInteger(wanted) && wanted >= 0 && wanted < total ? wanted : 0);

  if (state.wantPlay) {
    state.wantPlay = false;
    play();
  }
  syncURL();
}

// --------------------------------------------------------------------------
// Playback
// --------------------------------------------------------------------------

function play() {
  if (state.playing || state.mode === "diff" || !state.frames.length) return;
  state.playing = true;
  $("playBtn").textContent = "Pause";
  const interval = Math.max(80, 1000 / state.fps);
  state.timer = setInterval(() => setIndex(state.index + 1), interval);
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
  $("view").src = `/data/${state.datasetId}/${frame.png}`;

  $("frameRange").value = state.index;
  $("frameNumber").value = state.index;
  $("caption").textContent = captionFor(frame, state.index, n);
  renderFrameInfo(frame);
  updateMarker(frame);
  highlightRow();
  if (!state.playing) syncURL();
}

function captionFor(frame, index, total) {
  const flux = frame.flux_ujy === null ? "flux -" : `flux ${fmt(frame.flux_ujy, 1)} uJy`;
  const snr = frame.peak_snr === null ? "S/N -" : `peak S/N ${fmt(frame.peak_snr, 1)}`;
  return `${index + 1}/${total}   ${frame.date}   ${frame.band_label}   ` +
         `${fmt(frame.wavelength_um, 2)} um   ${flux}   ${snr}` +
         (frame.target_bad ? "   [target pixel flagged]" : "");
}

function updateMarker(frame) {
  const marker = $("targetMarker");
  if (state.mode !== "movie" || !state.manifest) {
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
// A-B / (A+B)/2
// --------------------------------------------------------------------------

function fillCompare(frames) {
  const options = frames.map((frame, index) =>
    `<option value="${index}">#${String(index).padStart(3, "0")}  ${frame.date}  ` +
    `${frame.band_label}  ${fmt(frame.wavelength_um, 2)} um</option>`).join("");
  $("aSelect").innerHTML = options;
  $("bSelect").innerHTML = options;

  // Default to the first and last frame of the first detector that appears.
  const band = frames[0]?.band;
  const same = frames.map((f, i) => f.band === band ? i : -1).filter(i => i >= 0);
  if (same.length) {
    $("aSelect").value = same[0];
    $("bSelect").value = same[same.length - 1];
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
  $("view").src = `/api/diff/${state.datasetId}?a=${a}&b=${b}&mode=${mode}`;
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

  setKV($("summary"), [
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
  ]);
}

function renderFrameInfo(frame) {
  const flagText = frame.target_bad
    ? `${frame.target_flag_names} (bad bit set)`
    : frame.target_flag_names;
  const offset = frame.target_offset_px;
  setKV($("frameInfo"), [
    ["Date", frame.iso.replace("T", " ").slice(0, 19)],
    ["Detector", `${frame.band_label} (${frame.band})`],
    ["Wavelength", `${fmt(frame.wavelength_um, 4)} um ` +
                   `(width ${fmt(frame.bandwidth_um, 3)} um)`],
    ["Flux", frame.flux_ujy === null
      ? "-" : `${fmt(frame.flux_ujy, 1)} +/- ${fmt(frame.err_ujy, 1)} uJy`],
    ["Peak S/N", fmt(frame.peak_snr, 1)],
    ["Target flag", flagText],
    ["Offset", offset ? `${fmt(offset[0], 1)}, ${fmt(offset[1], 1)} px` : "-"],
    ["Sky level", `${fmt(frame.background_mjy_sr, 4)} MJy/sr removed`],
    ["Obs id", frame.obs_id],
  ]);
}

function renderTable(frames) {
  $("frameRows").innerHTML = frames.map((frame, index) =>
    `<tr data-i="${index}">` +
    `<td>${index}</td>` +
    `<td>${frame.date}</td>` +
    `<td>${frame.band_label}</td>` +
    `<td>${fmt(frame.wavelength_um, 2)}</td>` +
    `<td>${frame.flux_ujy === null ? "-" : fmt(frame.flux_ujy, 0)}</td>` +
    `<td>${fmt(frame.peak_snr, 1)}</td>` +
    `<td>${frame.target_bad ? "!" : ""}</td>` +
    `</tr>`).join("");
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
}

function showError(message) {
  const box = $("progress");
  box.hidden = false;
  box.classList.add("error");
  barStop();
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
