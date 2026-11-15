/* Reusable slider + number controls.
 *
 * A slider is declared once by name and mounted wherever a
 * `data-slider="<name>"` element appears:
 *
 *     <div class="field wide" data-slider="fov"></div>
 *     <span class="transport-slider" data-slider="frame"></span>
 *
 * The markup comes from <template id="sliderTemplate">.  The factory keeps the
 * range and number inputs in sync, clamps and snaps typed values, and calls
 * optional onInput/onCommit callbacks.  This replaces the three hand-written
 * copies of the same logic in app.js.
 *
 * No frameworks, no build step.
 */

"use strict";

const SliderControls = (() => {
  const specs = new Map();
  const mounted = new Map();

  function decimalsOf(step) {
    const text = String(step);
    if (text.includes("e-")) {
      return Math.min(12, Number(text.split("e-")[1]) + 6);
    }
    const dot = text.indexOf(".");
    return dot < 0 ? 0 : Math.min(12, text.length - dot - 1);
  }

  /** Clamp to the bounds and snap to the nearest step. */
  function normalise(value, min, max, step) {
    let number = Number(value);
    if (!Number.isFinite(number)) return null;
    number = Math.min(Math.max(number, min), max);
    if (Number.isFinite(step) && step > 0) {
      number = min + Math.round((number - min) / step) * step;
      // Kill floating-point dust such as 0.30000000000000004.  The display
      // precision is applied separately.
      number = Number(number.toFixed(decimalsOf(step)));
      number = Math.min(Math.max(number, min), max);
    }
    return number;
  }

  function display(value, precision) {
    if (precision === null || precision === undefined) return String(value);
    return Number(value).toFixed(precision);
  }

  /** Declare a slider by name.  Safe to call before or after mount(). */
  function register(name, spec) {
    specs.set(name, { ...spec, name });
    return api(name);
  }

  function mount(name, root) {
    const spec = specs.get(name);
    if (!spec) {
      console.warn(`SliderControls: no spec registered for "${name}"`);
      return null;
    }

    const template = document.getElementById("sliderTemplate");
    if (!template) {
      console.warn("SliderControls: missing #sliderTemplate");
      return null;
    }

    const fragment = template.content.cloneNode(true);
    const wrap = fragment.querySelector(".slider");
    const label = fragment.querySelector('[data-role="label"]');
    const hint = fragment.querySelector('[data-role="hint"]');
    const range = fragment.querySelector('[data-role="range"]');
    const number = fragment.querySelector('[data-role="number"]');
    const unit = fragment.querySelector('[data-role="unit"]');

    const rangeId = `${name}Range`;
    const numberId = `${name}Number`;
    range.id = rangeId;
    number.id = numberId;
    label.textContent = spec.label || name;
    label.htmlFor = rangeId;
    number.setAttribute("aria-label", spec.label || name);

    let min = Number.isFinite(spec.min) ? spec.min : 0;
    let max = Number.isFinite(spec.max) ? spec.max : 100;

    function writeBounds() {
      for (const input of [range, number]) {
        input.min = String(min);
        input.max = String(max);
        input.step = String(spec.step ?? 1);
      }
    }

    let current = normalise(spec.value ?? min, min, max, spec.step ?? 1);
    if (current === null) current = min;

    function paint() {
      range.value = String(current);
      number.value = display(current, spec.precision);
    }

    function setValue(value, options = {}) {
      const { silent = false, commit = false, input = false } = options;
      const next = normalise(value, min, max, spec.step ?? 1);
      if (next === null) return current;
      const changed = next !== current;
      current = next;
      paint();
      if (!silent && changed) {
        if (input && spec.onInput) spec.onInput(current, controller);
        if (commit && spec.onCommit) spec.onCommit(current, controller);
      }
      return current;
    }

    function setBounds(nextMin, nextMax) {
      min = Number.isFinite(nextMin) ? nextMin : min;
      max = Number.isFinite(nextMax) ? nextMax : max;
      if (max < min) max = min;
      writeBounds();
      // Keep the current value inside the new range, but do not fire a
      // callback: bounds usually change because a dataset just loaded.
      return setValue(current, { silent: true });
    }

    function setDisabled(flag) {
      range.disabled = Boolean(flag);
      number.disabled = Boolean(flag);
      wrap.classList.toggle("disabled", Boolean(flag));
    }

    function refresh() {
      const fromNumber = normalise(number.value, min, max, spec.step ?? 1);
      const fromRange = normalise(range.value, min, max, spec.step ?? 1);
      return setValue(fromNumber ?? fromRange ?? current, { silent: true });
    }

    // Drag the slider: update the number live.  onInput is for cheap live
    // previews such as frame scrubbing; the expensive action waits for the
    // release (onCommit).
    range.addEventListener("input", () => {
      const next = normalise(range.value, min, max, spec.step ?? 1);
      if (next === null) return;
      current = next;
      number.value = display(current, spec.precision);
      if (spec.onInput) spec.onInput(current, controller);
    });
    range.addEventListener("change", () => {
      setValue(range.value, { commit: true });
    });

    // Type a value: move the thumb immediately, but only commit on blur or
    // Enter (the native "change" event).
    number.addEventListener("input", () => {
      const next = normalise(number.value, min, max, spec.step ?? 1);
      if (next !== null) range.value = String(next);
    });
    number.addEventListener("change", () => {
      const raw = number.value.trim();
      const next = raw === "" ? null : normalise(raw, min, max, spec.step ?? 1);
      if (next === null) {
        // Empty or unparseable input: restore the last good value instead of
        // submitting a build for nonsense.
        paint();
        return;
      }
      setValue(next, { commit: true });
    });

    writeBounds();
    paint();

    if (hint) {
      if (spec.hint) hint.textContent = spec.hint;
      else hint.hidden = true;
    }
    if (unit) {
      if (spec.unit) unit.textContent = spec.unit;
      else unit.hidden = true;
    }

    const controller = {
      name,
      root,
      elements: { wrap, label, hint, range, number, unit },
      get value() { return current; },
      get min() { return min; },
      get max() { return max; },
      setValue,
      setBounds,
      setDisabled,
      refresh,
    };

    mounted.set(name, controller);
    root.replaceChildren(fragment);
    return controller;
  }

  function mountAll(root = document) {
    root.querySelectorAll("[data-slider]").forEach(element => {
      const name = element.dataset.slider;
      if (mounted.has(name)) return;
      mount(name, element);
    });
  }

  function get(name) {
    return mounted.get(name) || null;
  }

  function api(name) {
    return {
      setValue: (value, options) => get(name)?.setValue(value, options),
      setBounds: (min, max) => get(name)?.setBounds(min, max),
      setDisabled: flag => get(name)?.setDisabled(flag),
      refresh: () => get(name)?.refresh(),
      get value() { return get(name)?.value ?? null; },
    };
  }

  return { register, mount, mountAll, get };
})();
