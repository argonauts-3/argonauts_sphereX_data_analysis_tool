/* Canvas frame viewer with selectable interpolation.
 *
 * The server renders 8-bit PNGs.  This module scales them to the stage with
 * one of five display kernels:
 *
 *   nearest   hard pixel edges (best for inspecting individual pixels)
 *   bilinear  smooth, cheap, no ringing
 *   bicubic   4x4 Catmull-Rom; sharper, slight overshoot
 *   lanczos   6x6 Lanczos3; sharpest, can ring around bright stars
 *   gaussian  5x5 Gaussian; soft, no ringing
 *
 * Interpolation is display-only: the PNG, the manifest and every measured
 * value are unchanged.  WebGL gives exact kernels; a plain 2D canvas is used
 * as a fallback and supports only nearest and smooth (bilinear) scaling.
 *
 * No dependencies, no build step.
 */

"use strict";

const FRAME_KERNELS = ["nearest", "bilinear", "bicubic", "lanczos", "gaussian"];

function createFrameViewer(canvas, options = {}) {
  const defaultKernel = FRAME_KERNELS.includes(options.defaultKernel)
    ? options.defaultKernel
    : "bilinear";
  const force2d = Boolean(options.force2d);

  let mode = "none";                 // "webgl" | "2d" | "none"
  let gl = null;
  let program = null;
  let buffer = null;
  let texture = null;
  let uniforms = {};
  let ctx2d = null;
  let textureSize = [1, 1];
  let kernel = defaultKernel;
  let currentImage = null;
  let requestToken = 0;
  let destroyed = false;
  let levels = [0, 1];               // black / white point, texture units 0..1

  const imageCache = new Map();

  const VERTEX_SHADER = `
    attribute vec2 aPos;
    varying vec2 vUV;
    void main() {
      vUV = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  const FRAGMENT_SHADER = `
    precision mediump float;

    uniform sampler2D uTex;
    uniform int uKernel;
    uniform vec2 uTexSize;
    uniform float uBlack;
    uniform float uWhite;
    varying vec2 vUV;

    float cubicWeight(float x) {
      const float a = -0.5;
      x = abs(x);
      if (x <= 1.0) {
        return ((a + 2.0) * x - (a + 3.0)) * x * x + 1.0;
      }
      if (x < 2.0) {
        return (((x - 5.0) * x + 8.0) * x - 4.0) * a;
      }
      return 0.0;
    }

    float sinc(float x) {
      if (abs(x) < 1.0e-5) return 1.0;
      float p = 3.141592653589793 * x;
      return sin(p) / p;
    }

    float lanczosWeight(float x) {
      x = abs(x);
      if (x >= 3.0) return 0.0;
      return sinc(x) * sinc(x / 3.0);
    }

    float gaussianWeight(float x) {
      // sigma = 1.2 texels: visibly soft without turning stars into blobs.
      return exp(-0.5 * x * x / 1.44);
    }

    vec4 sampleTexel(vec2 texel) {
      return texture2D(uTex, (texel + 0.5) / uTexSize);
    }

    void main() {
      vec2 texel = vUV * uTexSize - 0.5;
      vec2 base = floor(texel);
      vec2 f = texel - base;
      vec4 color = sampleTexel(base);

      if (uKernel == 0) {
        color = sampleTexel(base);
      } else if (uKernel == 1) {
        color =
          sampleTexel(base) * (1.0 - f.x) * (1.0 - f.y) +
          sampleTexel(base + vec2(1.0, 0.0)) * f.x * (1.0 - f.y) +
          sampleTexel(base + vec2(0.0, 1.0)) * (1.0 - f.x) * f.y +
          sampleTexel(base + vec2(1.0, 1.0)) * f.x * f.y;
      } else if (uKernel == 2) {
        vec4 sum = vec4(0.0);
        float total = 0.0;
        for (int j = -1; j <= 2; j++) {
          for (int i = -1; i <= 2; i++) {
            float w = cubicWeight(float(i) - f.x) *
                      cubicWeight(float(j) - f.y);
            sum += sampleTexel(base + vec2(float(i), float(j))) * w;
            total += w;
          }
        }
        color = sum / total;
      } else if (uKernel == 3) {
        vec4 sum = vec4(0.0);
        float total = 0.0;
        for (int j = -2; j <= 3; j++) {
          for (int i = -2; i <= 3; i++) {
            float w = lanczosWeight(float(i) - f.x) *
                      lanczosWeight(float(j) - f.y);
            sum += sampleTexel(base + vec2(float(i), float(j))) * w;
            total += w;
          }
        }
        color = sum / total;
      } else {
        vec4 sum = vec4(0.0);
        float total = 0.0;
        for (int j = -2; j <= 2; j++) {
          for (int i = -2; i <= 2; i++) {
            float w = gaussianWeight(float(i) - f.x) *
                      gaussianWeight(float(j) - f.y);
            sum += sampleTexel(base + vec2(float(i), float(j))) * w;
            total += w;
          }
        }
        color = sum / total;
      }

      // Black / white point.  (0, 1) leaves the image unchanged.
      vec3 leveled = clamp((color.rgb - vec3(uBlack)) / max(uWhite - uBlack, 1.0e-4), 0.0, 1.0);
      gl_FragColor = vec4(leveled, 1.0);
    }
  `;

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("viewer shader:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function setupWebGL() {
    if (force2d) return false;
    try {
      gl = canvas.getContext("webgl", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      }) || canvas.getContext("experimental-webgl");
    } catch (_) {
      gl = null;
    }
    if (!gl) return false;

    const vertex = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertex || !fragment) return false;

    program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("viewer program:", gl.getProgramInfoLog(program));
      return false;
    }

    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const position = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    uniforms = {
      texture: gl.getUniformLocation(program, "uTex"),
      kernel: gl.getUniformLocation(program, "uKernel"),
      size: gl.getUniformLocation(program, "uTexSize"),
      black: gl.getUniformLocation(program, "uBlack"),
      white: gl.getUniformLocation(program, "uWhite"),
    };

    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    mode = "webgl";
    return true;
  }

  function setup2d() {
    try {
      ctx2d = canvas.getContext("2d");
    } catch (_) {
      ctx2d = null;
    }
    mode = ctx2d ? "2d" : "none";
    return Boolean(ctx2d);
  }

  canvas.addEventListener("webglcontextlost", event => {
    // Without preventDefault() the context is never restored.
    event.preventDefault();
    gl = null;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    if (destroyed) return;
    gl = null;
    if (setupWebGL()) {
      if (currentImage) upload(currentImage);
      draw();
    }
  });

  function upload(image) {
    if (!gl || !texture) return;
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    textureSize = [Math.max(1, width), Math.max(1, height)];
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  }

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return [width, height];
  }

  function draw() {
    if (destroyed || mode === "none") return;
    const [width, height] = resize();

    if (mode === "webgl") {
      if (!gl) return;
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!currentImage) return;
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(uniforms.texture, 0);
      gl.uniform1i(uniforms.kernel, FRAME_KERNELS.indexOf(kernel));
      gl.uniform2f(uniforms.size, textureSize[0], textureSize[1]);
      gl.uniform1f(uniforms.black, levels[0]);
      gl.uniform1f(uniforms.white, levels[1]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }

    ctx2d.clearRect(0, 0, width, height);
    if (!currentImage) return;
    // A 2D canvas only offers nearest or browser-smoothed scaling.  The page
    // disables the other menu entries when this fallback is active.
    ctx2d.imageSmoothingEnabled = kernel !== "nearest";
    ctx2d.imageSmoothingQuality = "high";
    ctx2d.drawImage(currentImage, 0, 0, width, height);
    if (levels[0] > 0 || levels[1] < 1) applyLevels2d(width, height);
  }

  function supports(name) {
    if (mode === "webgl") return FRAME_KERNELS.includes(name);
    if (mode === "2d") return name === "nearest" || name === "bilinear";
    return false;
  }

  function setKernel(name) {
    if (!supports(name)) return false;
    kernel = name;
    draw();
    return true;
  }

  /** 2D fallback: apply the black / white point to the drawn pixels. */
  function applyLevels2d(width, height) {
    let data;
    try {
      data = ctx2d.getImageData(0, 0, width, height);
    } catch (_) {
      return;
    }
    const span = Math.max(levels[1] - levels[0], 1e-4);
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      lut[v] = Math.round(255 * Math.min(Math.max((v / 255 - levels[0]) / span, 0), 1));
    }
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      px[i] = lut[px[i]];
      px[i + 1] = lut[px[i + 1]];
      px[i + 2] = lut[px[i + 2]];
    }
    ctx2d.putImageData(data, 0, 0);
  }

  /**
   * Black and white point as texture values (0 = black, 1 = white).  The app
   * passes (0, 1) for difference images so they keep their own stretch.
   */
  function setLevels(black, white) {
    const b = Math.min(Math.max(Number(black), 0), 1);
    const w = Math.min(Math.max(Number(white), 0), 1);
    if (!Number.isFinite(b) || !Number.isFinite(w) || w <= b) return false;
    if (b === levels[0] && w === levels[1]) return true;
    levels = [b, w];
    draw();
    return true;
  }

  function show(image) {
    if (!image) return;
    currentImage = image;
    requestToken += 1;
    if (mode === "webgl") upload(image);
    draw();
  }

  function loadImage(url) {
    if (imageCache.has(url)) return Promise.resolve(imageCache.get(url));
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => {
        imageCache.set(url, image);
        resolve(image);
      };
      image.onerror = () => resolve(null);
      image.src = url;
    });
  }

  function showURL(url) {
    const token = ++requestToken;
    return loadImage(url).then(image => {
      if (image && token === requestToken && !destroyed) show(image);
      return image;
    });
  }

  async function preload(urls, onProgress = null) {
    const unique = [...new Set(urls)];
    const loaded = new Map();
    let done = 0;
    await Promise.all(unique.map(async url => {
      const image = await loadImage(url);
      if (image) loaded.set(url, image);
      done += 1;
      if (onProgress) onProgress(done, unique.length);
    }));
    return loaded;
  }

  function redraw() {
    draw();
  }

  function destroy() {
    destroyed = true;
    if (observer) observer.disconnect();
    if (gl) {
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
    }
    gl = null;
    mode = "none";
  }

  let observer = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
  } else {
    window.addEventListener("resize", draw);
  }

  if (!setupWebGL()) setup2d();

  return {
    get mode() { return mode; },
    get kernel() { return kernel; },
    get levels() { return [...levels]; },
    get supportedKernels() {
      return mode === "webgl" ? [...FRAME_KERNELS] : ["nearest", "bilinear"];
    },
    supports,
    setKernel,
    setLevels,
    show,
    showURL,
    preload,
    redraw,
    destroy,
  };
}
