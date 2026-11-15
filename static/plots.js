/* Spectrum and light-curve plots for the frames in the manifest.
 *
 * Everything is drawn from numbers the manifest already carries (flux_ujy,
 * err_ujy, wavelength_um, mjd, peak_snr, flags, centroid offset), so this
 * needs no new server work.  Plain inline SVG, no libraries, no build step.
 *
 *   - Frames hidden by the filters stay on the plot as hollow grey circles.
 *   - Click a point to open that frame.
 *   - The white ring follows the frame that is on screen.
 *
 * SPHEREx samples a different wavelength on every visit, so a light curve
 * that spans a wide wavelength range mixes the target's spectrum with real
 * variability.  The note under the plot says so when the plotted frames span
 * more than PLOT_WIDE_BAND of their mean wavelength.
 */

"use strict";

const PLOT_BAND_COLORS = {
  "SPHEREx-D1": "#56b4e9",
  "SPHEREx-D2": "#2ecc9a",
  "SPHEREx-D3": "#f0e442",
  "SPHEREx-D4": "#e69f00",
  "SPHEREx-D5": "#cc79a7",
  "SPHEREx-D6": "#a78bfa",
};
const PLOT_FAINT_SNR = 3;       // peak S/N below this is drawn faint
const PLOT_BLEND_PX = 0.5;      // centroid further than this from the target = blended
const PLOT_WIDE_BAND = 0.03;    // (max - min) / mean wavelength before the light-curve warning

function createFramePlots(root, options = {}) {
  const onPick = options.onPick || (() => {});
  const getFilename = options.getFilename || (() => "spherex_frames.csv");

  const W = 760;
  const H = 300;
  const M = { left: 58, right: 16, top: 14, bottom: 44 };

  const box = root.querySelector('[data-role="box"]');
  const note = root.querySelector('[data-role="note"]');
  const legend = root.querySelector('[data-role="legend"]');
  const csvButton = root.querySelector('[data-role="csv"]');
  const tabs = [...root.querySelectorAll("[data-plot]")];

  let frames = [];
  let visible = [];
  let current = 0;
  let tab = "spectrum";
  let scale = null;
  let ring = null;

  // ------------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------------

  function xValue(frame) {
    return tab === "spectrum" ? frame.wavelength_um : frame.mjd;
  }

  function hasPoint(frame) {
    return Number.isFinite(xValue(frame)) && Number.isFinite(frame.flux_ujy);
  }

  function isBlended(frame) {
    const off = frame.centroid_offset_px;
    if (!Array.isArray(off) || !Number.isFinite(off[0]) || !Number.isFinite(off[1])) {
      return false;
    }
    return Math.hypot(off[0], off[1]) > PLOT_BLEND_PX;
  }

  function num(value, digits) {
    return Number.isFinite(value) ? value.toFixed(digits) : "-";
  }

  function esc(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function extent(values) {
    let low = Infinity;
    let high = -Infinity;
    for (const value of values) {
      if (value < low) low = value;
      if (value > high) high = value;
    }
    return [low, high];
  }

  function niceTicks(min, max, count) {
    if (!(max > min)) return [min];
    const raw = (max - min) / count;
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const normal = raw / magnitude;
    const step = (normal < 1.5 ? 1 : normal < 3 ? 2 : normal < 7 ? 5 : 10) * magnitude;
    const ticks = [];
    let value = Math.ceil(min / step) * step;
    for (let guard = 0; value <= max + step * 1e-6 && guard < 60; guard++) {
      ticks.push(Number(value.toPrecision(12)));
      value += step;
    }
    return ticks;
  }

  function decimalsFor(ticks) {
    if (ticks.length < 2) return 2;
    const step = Math.abs(ticks[1] - ticks[0]);
    return Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  }

  function mjdToDate(mjd) {
    // MJD 40587 is 1970-01-01.
    return new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);
  }

  function tipText(point) {
    const frame = point.frame;
    const bits = [
      `#${point.i}`,
      frame.date,
      frame.band_label,
      `${num(frame.wavelength_um, 3)} um`,
      `flux ${num(frame.flux_ujy, 1)} +/- ${num(frame.err_ujy, 1)} uJy`,
      `peak S/N ${num(frame.peak_snr, 1)}`,
    ];
    if (frame.target_bad) bits.push("target pixel flagged");
    else if (isBlended(frame)) bits.push("blended (centroid off target)");
    if (!point.shown) bits.push("hidden by filters");
    return bits.join("  ");
  }

  // ------------------------------------------------------------------------
  // drawing
  // ------------------------------------------------------------------------

  function draw() {
    const points = [];
    frames.forEach((frame, i) => {
      if (!hasPoint(frame)) return;
      points.push({ i, frame, shown: visible.length ? Boolean(visible[i]) : true });
    });

    ring = null;
    scale = null;
    updateLegend();
    updateNote(points);

    if (!points.length) {
      box.innerHTML = '<p class="plot-empty">No flux measurements for these frames yet.</p>';
      return;
    }

    const shown = points.filter(p => p.shown);
    const hidden = points.filter(p => !p.shown);
    // x is fixed by every measured frame so the axis does not jump while
    // filtering; y follows the frames that are shown, so a narrow wavelength
    // window zooms in on its own flux range.
    const yPoints = shown.length ? shown : points;

    let [x0, x1] = extent(points.map(p => xValue(p.frame)));
    let [y0, y1] = extent(yPoints.map(p => p.frame.flux_ujy));
    const xPad = (x1 - x0) * 0.04 || (tab === "spectrum" ? 0.05 : 5);
    const yPad = (y1 - y0) * 0.1 || Math.max(1, Math.abs(y0) * 0.1);
    x0 -= xPad; x1 += xPad;
    y0 -= yPad; y1 += yPad;

    const pw = W - M.left - M.right;
    const ph = H - M.top - M.bottom;
    const sx = v => M.left + ((v - x0) / (x1 - x0)) * pw;
    const sy = v => H - M.bottom - ((v - y0) / (y1 - y0)) * ph;
    scale = { sx, sy };

    const xTicks = niceTicks(x0, x1, 6);
    const yTicks = niceTicks(y0, y1, 5);
    const xDecimals = tab === "spectrum" ? decimalsFor(xTicks) : 0;
    const yDecimals = decimalsFor(yTicks);

    function glyph(p) {
      const frame = p.frame;
      const x = sx(xValue(frame)).toFixed(1);
      const y = sy(frame.flux_ujy).toFixed(1);
      const tip = `<title>${esc(tipText(p))}</title>`;
      const attrs = `data-i="${p.i}"`;
      if (!p.shown) {
        return `<circle ${attrs} cx="${x}" cy="${y}" r="3" fill="none" ` +
               `stroke="#6b7684" stroke-width="1" opacity="0.55">${tip}</circle>`;
      }
      const color = PLOT_BAND_COLORS[frame.band] || "#cfd6df";
      const faint = Number.isFinite(frame.peak_snr) && frame.peak_snr < PLOT_FAINT_SNR;
      const opacity = faint ? 0.5 : 1;
      if (frame.target_bad) {
        return `<path ${attrs} transform="translate(${x} ${y})" ` +
               `d="M-4 -4L4 4M-4 4L4 -4" fill="none" stroke="#ff6b6b" ` +
               `stroke-width="2" opacity="${opacity}">${tip}</path>`;
      }
      if (isBlended(frame)) {
        return `<path ${attrs} transform="translate(${x} ${y})" ` +
               `d="M0 -5L5 0L0 5L-5 0Z" fill="${color}" opacity="${opacity}">${tip}</path>`;
      }
      return `<circle ${attrs} cx="${x}" cy="${y}" r="3.4" fill="${color}" ` +
             `opacity="${opacity}">${tip}</circle>`;
    }

    function errorBar(p) {
      const err = p.frame.err_ujy;
      if (!Number.isFinite(err) || err <= 0) return "";
      const x = sx(xValue(p.frame)).toFixed(1);
      const color = PLOT_BAND_COLORS[p.frame.band] || "#cfd6df";
      return `<line x1="${x}" x2="${x}" ` +
             `y1="${sy(p.frame.flux_ujy - err).toFixed(1)}" ` +
             `y2="${sy(p.frame.flux_ujy + err).toFixed(1)}" ` +
             `stroke="${color}" stroke-opacity="0.45" stroke-width="1"/>`;
    }

    const svg = [];
    svg.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${
      tab === "spectrum" ? "Flux versus wavelength" : "Flux versus date"}">`);
    svg.push(`<defs><clipPath id="plotClip"><rect x="${M.left}" y="${M.top}" ` +
             `width="${pw}" height="${ph}"/></clipPath></defs>`);

    for (const t of yTicks) {
      const y = sy(t).toFixed(1);
      svg.push(`<line class="grid" x1="${M.left}" x2="${W - M.right}" y1="${y}" y2="${y}"/>`);
      svg.push(`<text class="tick" x="${M.left - 6}" y="${(sy(t) + 3.5).toFixed(1)}" ` +
               `text-anchor="end">${t.toFixed(yDecimals)}</text>`);
    }
    for (const t of xTicks) {
      const x = sx(t).toFixed(1);
      svg.push(`<line class="grid" x1="${x}" x2="${x}" y1="${M.top}" y2="${H - M.bottom}"/>`);
      const label = tab === "spectrum" ? t.toFixed(xDecimals) : mjdToDate(t);
      svg.push(`<text class="tick" x="${x}" y="${H - M.bottom + 15}" ` +
               `text-anchor="middle">${label}</text>`);
    }

    svg.push(`<line class="axis" x1="${M.left}" x2="${W - M.right}" ` +
             `y1="${H - M.bottom}" y2="${H - M.bottom}"/>`);
    svg.push(`<line class="axis" x1="${M.left}" x2="${M.left}" y1="${M.top}" y2="${H - M.bottom}"/>`);
    if (y0 < 0 && y1 > 0) {
      const y = sy(0).toFixed(1);
      svg.push(`<line class="zero" x1="${M.left}" x2="${W - M.right}" y1="${y}" y2="${y}"/>`);
    }

    const midY = M.top + ph / 2;
    svg.push(`<text class="label" x="${M.left + pw / 2}" y="${H - 6}" ` +
             `text-anchor="middle">${tab === "spectrum" ? "wavelength (um)" : "date (UTC)"}</text>`);
    svg.push(`<text class="label" x="14" y="${midY}" text-anchor="middle" ` +
             `transform="rotate(-90 14 ${midY})">aperture flux (uJy)</text>`);

    svg.push('<g clip-path="url(#plotClip)">');
    for (const p of hidden) svg.push(glyph(p));
    for (const p of shown) svg.push(errorBar(p));
    for (const p of shown) svg.push(glyph(p));
    svg.push("</g>");
    svg.push('<circle data-role="ring" r="7" fill="none" stroke="#ffffff" ' +
             'stroke-width="1.5" pointer-events="none" visibility="hidden"/>');
    svg.push("</svg>");

    box.innerHTML = svg.join("");
    ring = box.querySelector('[data-role="ring"]');
    placeRing();
  }

  function placeRing() {
    if (!ring || !scale) return;
    const frame = frames[current];
    if (!frame || !hasPoint(frame)) {
      ring.setAttribute("visibility", "hidden");
      return;
    }
    const x = scale.sx(xValue(frame));
    const y = scale.sy(frame.flux_ujy);
    if (y < M.top || y > H - M.bottom || x < M.left || x > W - M.right) {
      ring.setAttribute("visibility", "hidden");
      return;
    }
    ring.setAttribute("cx", x.toFixed(1));
    ring.setAttribute("cy", y.toFixed(1));
    ring.setAttribute("visibility", "visible");
  }

  function updateNote(points) {
    const shown = points.filter(p => p.shown);
    if (!shown.length) {
      note.textContent = "No visible frame has a flux measurement.";
      note.classList.remove("warn");
      return;
    }
    const lams = shown.map(p => p.frame.wavelength_um).filter(Number.isFinite);
    let text = `${shown.length} of ${frames.length} frames plotted`;
    let low = null;
    let high = null;
    if (lams.length) {
      [low, high] = extent(lams);
      text += `, ${low.toFixed(2)} to ${high.toFixed(2)} um`;
    }
    text += ".";

    let warn = false;
    if (tab === "lightcurve" && lams.length > 1) {
      const mean = lams.reduce((a, b) => a + b, 0) / lams.length;
      if ((high - low) / mean > PLOT_WIDE_BAND) {
        text += " These exposures sample different wavelengths, so differences " +
                "between epochs mix the target's spectrum with real variability. " +
                "Narrow the wavelength range in the Frames panel to compare like with like.";
        warn = true;
      } else {
        text += " Narrow wavelength range: differences between epochs are more " +
                "likely to be variability.";
      }
    }
    note.textContent = text;
    note.classList.toggle("warn", warn);
  }

  function updateLegend() {
    const bands = [...new Set(frames.map(f => f.band))].sort();
    const swatches = bands.map(band =>
      `<span class="swatch" style="background:${PLOT_BAND_COLORS[band] || "#cfd6df"}"></span>` +
      `${esc(String(band).slice(-2))}`).join(" ");
    legend.innerHTML = `${swatches} &nbsp; filled = shown, hollow grey = hidden, ` +
      "x = target pixel flagged, diamond = blended (centroid more than 0.5 px off), " +
      "faint = peak S/N below 3. Click a point to open that frame.";
  }

  // ------------------------------------------------------------------------
  // CSV
  // ------------------------------------------------------------------------

  function downloadCSV() {
    const columns = [
      "index", "obs_id", "band", "iso", "mjd", "wavelength_um", "bandwidth_um",
      "flux_ujy", "err_ujy", "peak_snr", "target_flag_names", "target_bad",
      "centroid_dx_px", "centroid_dy_px", "shown",
    ];
    const cell = value => {
      if (value === null || value === undefined) return "";
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const rows = frames.map((frame, i) => {
      const off = Array.isArray(frame.centroid_offset_px) ? frame.centroid_offset_px : [null, null];
      return [
        i, frame.obs_id, frame.band, frame.iso, frame.mjd,
        frame.wavelength_um, frame.bandwidth_um, frame.flux_ujy, frame.err_ujy,
        frame.peak_snr, frame.target_flag_names, frame.target_bad ? 1 : 0,
        off[0], off[1], visible.length ? (visible[i] ? 1 : 0) : 1,
      ].map(cell).join(",");
    });
    const text = [columns.join(","), ...rows].join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = getFilename();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------------------------------
  // wiring
  // ------------------------------------------------------------------------

  box.addEventListener("click", event => {
    const target = event.target.closest("[data-i]");
    if (!target) return;
    const index = parseInt(target.dataset.i, 10);
    if (Number.isInteger(index)) onPick(index);
  });

  tabs.forEach(button => {
    button.addEventListener("click", () => {
      tab = button.dataset.plot;
      tabs.forEach(other => other.setAttribute("aria-selected", String(other === button)));
      draw();
    });
  });

  if (csvButton) csvButton.addEventListener("click", downloadCSV);

  draw();

  return {
    /** New frame list or new filter result: redraw everything. */
    update(nextFrames, nextVisible) {
      frames = nextFrames || [];
      visible = nextVisible || [];
      draw();
    },
    /** The frame on screen changed: move the ring only. */
    setCurrent(index) {
      current = index;
      placeRing();
    },
  };
}
