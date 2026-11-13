window.__ModuleLoader__.load({
  id: "dsh-lego-io-preview",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "dsh-lego-io-preview";
    const BODY_ID = "dsh-lego-io-preview/body";
    const FILE_PREFIX = "dsh-resource://file/";
    const FOV = (35 * Math.PI) / 180;

    // Build-time payload: gzip + base64 of { parts: { "<name>.dat": { b, bbox, tris } }, colors }.
    const PAYLOAD_B64 = "__PARTS_PAYLOAD__";

    const en = {
      title: "LEGO .io preview",
      loading: "Reading model…",
      resolving: "Loading parts from the Studio library…",
      reset: "Reset view",
      grid: "Grid",
      unitParts: "parts",
      unitKinds: "kinds",
      missing: "Parts not bundled (drawn as boxes):",
      fromStudio: "from the Studio library",
      errorZip: "Not a readable .io file: the archive is damaged or unknown.",
      errorEncrypted: "This is a legacy encrypted .io file. Open it in Studio and save it again, then retry.",
      errorNoModel: "No modelv2.ldr or model.ldr inside this .io file.",
      errorWebgl: "WebGL2 is not available in this window, so the model cannot be drawn.",
      errorGeneric: "Preview failed.",
    };

    const zh = {
      title: "乐高 .io 预览",
      loading: "正在读取模型…",
      resolving: "正在从 Studio 库加载零件…",
      reset: "重置视角",
      grid: "网格",
      unitParts: "块",
      unitKinds: "种",
      missing: "以下零件未内置（用方块代替）：",
      fromStudio: "来自 Studio 库",
      errorZip: "无法读取 .io：压缩包损坏或格式未知。",
      errorEncrypted: "这是旧版加密的 .io 文件。请在 Studio 里重新保存一次再打开。",
      errorNoModel: "这个 .io 里没有 modelv2.ldr 或 model.ldr。",
      errorWebgl: "当前窗口不支持 WebGL2，无法绘制模型。",
      errorGeneric: "预览失败。",
    };

    const textDecoder = new TextDecoder("utf-8");

    // ------------------------------------------------------------------
    // Byte helpers
    // ------------------------------------------------------------------
    function base64Bytes(b64) {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    async function gunzip(bytes) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function inflateRaw(bytes) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    // ------------------------------------------------------------------
    // ZIP (stored and deflated entries; enough for .io archives)
    // ------------------------------------------------------------------
    async function readZip(buffer) {
      const u8 = new Uint8Array(buffer);
      const dv = new DataView(buffer);
      let eocd = -1;
      const lowest = Math.max(0, u8.length - 22 - 0xffff);
      for (let i = u8.length - 22; i >= lowest; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new Error("zip: no end of central directory");
      const count = dv.getUint16(eocd + 10, true);
      let offset = dv.getUint32(eocd + 16, true);
      const entries = new Map();
      for (let n = 0; n < count; n++) {
        if (offset + 46 > u8.length || dv.getUint32(offset, true) !== 0x02014b50) break;
        const method = dv.getUint16(offset + 10, true);
        const compressedSize = dv.getUint32(offset + 20, true);
        const nameLength = dv.getUint16(offset + 28, true);
        const extraLength = dv.getUint16(offset + 30, true);
        const commentLength = dv.getUint16(offset + 32, true);
        const localOffset = dv.getUint32(offset + 42, true);
        const name = textDecoder.decode(u8.subarray(offset + 46, offset + 46 + nameLength));
        const localNameLength = dv.getUint16(localOffset + 26, true);
        const localExtraLength = dv.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        entries.set(name, { method, raw: u8.subarray(start, start + compressedSize) });
        offset += 46 + nameLength + extraLength + commentLength;
      }
      return entries;
    }

    async function entryBytes(entry) {
      if (!entry) return undefined;
      if (entry.method === 0) return entry.raw;
      if (entry.method === 8) return inflateRaw(entry.raw);
      throw new Error("zip: unsupported compression " + entry.method);
    }

    async function pickModelText(entries) {
      const preferred = [];
      for (const name of entries.keys()) {
        const lower = name.toLowerCase();
        if (lower.endsWith("modelv2.ldr")) preferred.push([0, name]);
        else if (lower.endsWith("model.ldr")) preferred.push([1, name]);
      }
      preferred.sort((a, b) => a[0] - b[0]);
      for (const [, name] of preferred) {
        const bytes = await entryBytes(entries.get(name));
        const text = textDecoder.decode(bytes).replace(/^\uFEFF/u, "");
        if (text.trim() !== "") return text;
      }
      return undefined;
    }

    // ------------------------------------------------------------------
    // Studio model parsing
    // ------------------------------------------------------------------
    let matrixScratch = [];
    const rotateScratch = [1, 0, 0, 0, 1, 0, 0, 0, 1];

    /**
     * Parse type-11 (Studio v2) and type-1 (LDraw) part lines.
     * type-11: 11 colour uid selected group x y z a b c d e f g h i part
     */
    function parseModel(text) {
      const parts = [];
      for (const raw of text.split(/\r?\n/u)) {
        const line = raw.trim();
        if (line === "" || line.charCodeAt(0) === 48) continue; // '0' comments
        const tok = line.split(/\s+/u);
        if (tok[0] === "11" && tok.length >= 18) {
          matrixScratch = tok.slice(8, 17).map(Number);
          parts.push({
            color: Number(tok[1]),
            x: Number(tok[5]),
            y: Number(tok[6]),
            z: Number(tok[7]),
            m: matrixScratch.length === 9 ? matrixScratch.slice() : rotateScratch.slice(),
            file: tok[17].replace(/\\/gu, "/"),
          });
        } else if (tok[0] === "1" && tok.length >= 15) {
          const file = tok[14].replace(/\\/gu, "/");
          if (/\.(?:ldr|mpd|dat)$/iu.test(file) === false) continue;
          if (/\.(?:ldr|mpd)$/iu.test(file)) continue; // submodel reference: not flattened here
          matrixScratch = tok.slice(5, 14).map(Number);
          parts.push({
            color: Number(tok[1]),
            x: Number(tok[2]),
            y: Number(tok[3]),
            z: Number(tok[4]),
            m: matrixScratch.length === 9 ? matrixScratch.slice() : rotateScratch.slice(),
            file,
          });
        }
      }
      return parts;
    }

    function baseName(file) {
      const cut = file.replace(/\\/gu, "/").split("/");
      return cut[cut.length - 1].toLowerCase();
    }

    // ------------------------------------------------------------------
    // Bundled geometry
    // ------------------------------------------------------------------
    let payloadPromise;

    function getPayload() {
      if (payloadPromise === undefined) {
        payloadPromise = (async () => {
          if (typeof PAYLOAD_B64 !== "string" || PAYLOAD_B64 === "" || PAYLOAD_B64 === "__PARTS_PAYLOAD__") {
            return { parts: {}, colors: {} };
          }
          const json = textDecoder.decode(await gunzip(base64Bytes(PAYLOAD_B64)));
          return JSON.parse(json);
        })();
      }
      return payloadPromise;
    }

    function findEntry(file, parts) {
      const base = baseName(file);
      if (parts[base] !== undefined) return parts[base];
      const stem = base.replace(/\.dat$/u, "").replace(/[a-z]$/u, "");
      const candidates = [stem + ".dat"];
      for (const letter of ["b", "a", "c", "d"]) candidates.push(stem + letter + ".dat");
      for (const candidate of candidates) {
        if (parts[candidate] !== undefined) return parts[candidate];
      }
      return undefined;
    }

    /** Per-vertex positions plus one flat normal per triangle (18 floats per triangle). */
    function interleave(positions) {
      const triangles = Math.floor(positions.length / 9);
      const out = new Float32Array(triangles * 18);
      for (let t = 0; t < triangles; t++) {
        const o = t * 9;
        const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
        const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
        const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
        let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
        let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const w = t * 18;
        out[w] = ax; out[w + 1] = ay; out[w + 2] = az;
        out[w + 3] = nx; out[w + 4] = ny; out[w + 5] = nz;
        out[w + 6] = bx; out[w + 7] = by; out[w + 8] = bz;
        out[w + 9] = nx; out[w + 10] = ny; out[w + 11] = nz;
        out[w + 12] = cx; out[w + 13] = cy; out[w + 14] = cz;
        out[w + 15] = nx; out[w + 16] = ny; out[w + 17] = nz;
      }
      return out;
    }

    const PLACEHOLDER_RAW = (() => {
      const x = 10, y = 24, z = 10;
      const p = [
        -x, 0, -z, x, 0, -z, x, 0, z,
        -x, 0, -z, x, 0, z, -x, 0, z,
        -x, y, -z, x, y, z, x, y, -z,
        -x, y, -z, -x, y, z, x, y, z,
        -x, 0, -z, -x, y, -z, x, y, -z,
        -x, 0, -z, x, y, -z, x, 0, -z,
        x, 0, -z, x, y, -z, x, y, z,
        x, 0, -z, x, y, z, x, 0, z,
        -x, 0, z, x, y, z, -x, y, z,
        -x, 0, z, x, 0, z, x, y, z,
        -x, y, -z, -x, y, z, -x, 0, z,
        -x, y, -z, -x, 0, z, -x, 0, -z,
      ];
      return interleave(new Float32Array(p));
    })();

    const PLACEHOLDER = {
      b: "",
      bbox: [-10, 0, -10, 10, 24, 10],
      tris: 12,
      prepared: PLACEHOLDER_RAW,
    };

    function colorOf(hex, alpha, fallback) {
      if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/iu.test(hex)) return fallback;
      const value = parseInt(hex.slice(1), 16);
      const a = typeof alpha === "number" && alpha > 0 && alpha < 255 ? alpha / 255 : 1;
      return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, a];
    }

    function modelMatrix(part) {
      const m = part.m;
      return new Float32Array([
        m[0], -m[3], m[6], 0,
        m[1], -m[4], m[7], 0,
        m[2], -m[5], m[8], 0,
        part.x, -part.y, part.z, 1,
      ]);
    }

    function collectBounds(entries) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const instance of entries) {
        const bb = instance.entry.bbox;
        const m = instance.model;
        for (let i = 0; i < 8; i++) {
          const px = i & 1 ? bb[3] : bb[0];
          const py = i & 2 ? bb[4] : bb[1];
          const pz = i & 4 ? bb[5] : bb[2];
          const x = m[0] * px + m[4] * py + m[8] * pz + m[12];
          const y = m[1] * px + m[5] * py + m[9] * pz + m[13];
          const z = m[2] * px + m[6] * py + m[10] * pz + m[14];
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
      }
      if (!Number.isFinite(minX)) return { center: [0, 0, 0], radius: 100, floor: 0 };
      const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
      const radius = Math.max(1, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2);
      return { center, radius: Math.max(radius, 30), floor: minY };
    }

    // ------------------------------------------------------------------
    // Missing parts from the host (the LDraw library of Studio 2.0)
    // ------------------------------------------------------------------
    const HOST_GEOM_ROUTE = "/dsh-lego-io-preview/geom";
    const HOST_BATCH = 120;

    async function fetchGeomBatch(names) {
      const response = await fetch(HOST_GEOM_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: names }),
      });
      if (!response.ok) throw new Error("host " + response.status);
      const body = await response.json();
      if (body.ok !== true) return { parts: {}, missing: names, reason: body.reason ?? "unavailable" };
      return { parts: body.parts ?? {}, missing: body.missing ?? [] };
    }

    /**
     * Fill payload.parts with geometry the bundle does not carry. The host reads
     * the .dat files from the local LDraw library, so nothing has to be shipped.
     */
    async function resolveParts(payload, names, onProgress) {
      const wanted = [];
      for (const name of names) {
        if (findEntry(name, payload.parts) === undefined && !wanted.includes(name)) wanted.push(name);
      }
      if (wanted.length === 0) return { added: 0, missing: [], total: 0 };
      if (typeof fetch !== "function") return { added: 0, missing: wanted, total: wanted.length };
      let added = 0;
      const missing = [];
      for (let i = 0; i < wanted.length; i += HOST_BATCH) {
        const batch = wanted.slice(i, i + HOST_BATCH);
        onProgress?.({ done: i, total: wanted.length });
        const body = await fetchGeomBatch(batch);
        for (const [name, entry] of Object.entries(body.parts)) {
          if (entry !== undefined && typeof entry.b === "string") {
            payload.parts[name] = entry;
            added += 1;
          }
        }
        for (const name of body.missing) missing.push(name);
        if (body.reason === "no-library") {
          for (const name of wanted.slice(i + batch.length)) missing.push(name);
          break;
        }
      }
      onProgress?.({ done: wanted.length, total: wanted.length });
      return { added, missing, total: wanted.length };
    }

    async function loadIoModel(buffer, payload, options) {
      const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
      if (!(head[0] === 0x50 && head[1] === 0x4b)) return { error: "errorEncrypted" };
      let entries;
      try {
        entries = await readZip(buffer);
      } catch (error) {
        return { error: "errorZip" };
      }
      const text = await pickModelText(entries);
      if (text === undefined) return { error: "errorNoModel" };
      const parts = parseModel(text);
      if (parts.length === 0) return { error: "errorNoModel" };

      let resolved = { added: 0, missing: [], total: 0 };
      if (options?.resolve !== false) {
        const names = [];
        for (const part of parts) {
          const name = baseName(part.file);
          if (!names.includes(name)) names.push(name);
        }
        try {
          resolved = await resolveParts(payload, names, options?.onProgress);
        } catch (error) {
          resolved = { added: 0, missing: names, total: names.length, error: String(error) };
        }
      }

      const geometryCache = new Map();
      const instances = [];
      const kinds = new Set();
      const missing = new Map();

      for (const part of parts) {
        const entry = findEntry(part.file, payload.parts) ?? PLACEHOLDER;
        if (entry === PLACEHOLDER) missing.set(baseName(part.file), true);
        if (entry.prepared === undefined) {
          const cached = geometryCache.get(entry);
          if (cached !== undefined) entry.prepared = cached;
          else {
            entry.prepared = entry === PLACEHOLDER ? PLACEHOLDER_RAW : interleave(new Float32Array(base64Bytes(entry.b).buffer));
            geometryCache.set(entry, entry.prepared);
          }
        }
        const colorInfo = payload.colors[String(part.color)] ?? {};
        instances.push({
          entry,
          model: modelMatrix(part),
          color: colorOf(colorInfo.hex, colorInfo.alpha, [0.78, 0.1, 0.05, 1]),
        });
        kinds.add(baseName(part.file));
      }

      const bounds = collectBounds(instances);
      return {
        instances,
        count: instances.length,
        kinds: kinds.size,
        missing: Array.from(missing.keys()).sort(),
        resolved,
        center: bounds.center,
        radius: bounds.radius,
        floor: bounds.floor,
      };
    }

    // ------------------------------------------------------------------
    // Small mat4 helpers (column-major)
    // ------------------------------------------------------------------
    function perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2);
      const nf = 1 / (near - far);
      return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0,
      ]);
    }

    function lookAt(eye, center, up) {
      let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
      let len = Math.hypot(zx, zy, zz) || 1;
      zx /= len; zy /= len; zz /= len;
      let xx = up[1] * zz - up[2] * zy;
      let xy = up[2] * zx - up[0] * zz;
      let xz = up[0] * zy - up[1] * zx;
      len = Math.hypot(xx, xy, xz);
      if (len < 1e-6) { xx = 1; xy = 0; xz = 0; len = 1; }
      xx /= len; xy /= len; xz /= len;
      const yx = zy * xz - zz * xy;
      const yy = zz * xx - zx * xz;
      const yz = zx * xy - zy * xx;
      return new Float32Array([
        xx, yx, zx, 0,
        xy, yy, zy, 0,
        xz, yz, zz, 0,
        -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
        -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
        -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
        1,
      ]);
    }

    function multiply(a, b) {
      const out = new Float32Array(16);
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          out[c * 4 + r] =
            a[r] * b[c * 4] +
            a[4 + r] * b[c * 4 + 1] +
            a[8 + r] * b[c * 4 + 2] +
            a[12 + r] * b[c * 4 + 3];
        }
      }
      return out;
    }

    // ------------------------------------------------------------------
    // WebGL
    // ------------------------------------------------------------------
    const VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
uniform mat4 uMVP;
uniform mat4 uModel;
out vec3 vNrm;
void main() {
  vNrm = mat3(uModel) * aNrm;
  gl_Position = uMVP * (uModel * vec4(aPos, 1.0));
}`;

    const FRAG = `#version 300 es
precision highp float;
in vec3 vNrm;
uniform vec4 uColor;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNrm);
  vec3 l1 = normalize(vec3(0.42, 0.86, 0.30));
  vec3 l2 = normalize(vec3(-0.55, 0.35, -0.62));
  float light = abs(dot(n, l1)) * 0.62 + abs(dot(n, l2)) * 0.22;
  outColor = vec4(uColor.rgb * (0.46 + light), uColor.a);
}`;

    const LINE_VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;

    const LINE_FRAG = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

    function compile(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error("shader: " + log);
      }
      return shader;
    }

    function program(gl, vs, fs) {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
      return p;
    }

    class Viewer {
      constructor(stage, model) {
        this.stage = stage;
        this.model = model;
        this.gridVisible = true;
        this.disposed = false;
        const canvas = document.createElement("canvas");
        canvas.className = "iov-canvas";
        stage.appendChild(canvas);
        this.canvas = canvas;
        const gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
        if (!gl) {
          canvas.remove();
          throw new Error("webgl2");
        }
        this.gl = gl;
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0, 0, 0, 0);
        this.applySurfaceColor();
        this.themeObserver = new MutationObserver(() => this.applySurfaceColor());
        this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
        this.themeQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;
        this.schemeListener = () => this.applySurfaceColor();
        this.themeQuery?.addEventListener?.("change", this.schemeListener);

        this.prog = program(gl, VERT, FRAG);
        this.lineProg = program(gl, LINE_VERT, LINE_FRAG);
        this.uni = {
          mvp: gl.getUniformLocation(this.prog, "uMVP"),
          model: gl.getUniformLocation(this.prog, "uModel"),
          color: gl.getUniformLocation(this.prog, "uColor"),
        };
        this.lineUni = {
          mvp: gl.getUniformLocation(this.lineProg, "uMVP"),
          color: gl.getUniformLocation(this.lineProg, "uColor"),
        };

        this.target = model.center.slice();
        this.radius = model.radius;
        this.floor = Number.isFinite(model.floor) ? model.floor : 0;
        this.yaw = -0.7;
        this.pitch = 0.55;
        this.dist = 0;

        this.vaos = new Map();
        this.grid = this.buildGrid();
        this.fit();

        this.resizeObserver = new ResizeObserver(() => this.invalidate());
        this.resizeObserver.observe(stage);
        this.bindPointer();
        this.frame = 0;
        this.dirty = true;
        this.loop = this.loop.bind(this);
        this.frame = requestAnimationFrame(this.loop);
      }

      buildGrid() {
        const gl = this.gl;
        const radius = this.radius;
        let half = 200;
        while (half < radius * 2.2) half *= 2;
        const step = half / 10;
        const y = this.floor - 0.05;
        const points = [];
        for (let i = -10; i <= 10; i++) {
          const v = i * step;
          points.push(-half, y, v, half, y, v);
          points.push(v, y, -half, v, y, half);
        }
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points), gl.STATIC_DRAW);
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        return { vao, buffer, count: points.length / 3 };
      }

      vaoFor(entry) {
        let vao = this.vaos.get(entry);
        if (vao !== undefined) return vao;
        const gl = this.gl;
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, entry.prepared, gl.STATIC_DRAW);
        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        gl.bindVertexArray(null);
        vao = { vao, buffer, count: entry.prepared.length / 6 };
        this.vaos.set(entry, vao);
        return vao;
      }

      fit() {
        this.dist = (this.radius / Math.sin(FOV / 2)) * 1.15;
        this.invalidate();
      }

      resetView() {
        this.target = this.model.center.slice();
        this.yaw = -0.7;
        this.pitch = 0.55;
        this.fit();
      }

      setGrid(visible) {
        this.gridVisible = visible;
        this.invalidate();
      }

      invalidate() {
        this.dirty = true;
      }

      bindPointer() {
        const canvas = this.canvas;
        let mode = null;
        let lastX = 0;
        let lastY = 0;
        const down = (event) => {
          if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
          mode = event.button === 1 || event.shiftKey ? "pan" : "orbit";
          lastX = event.clientX;
          lastY = event.clientY;
          canvas.setPointerCapture?.(event.pointerId);
          event.preventDefault();
        };
        const move = (event) => {
          if (mode === null) return;
          const dx = event.clientX - lastX;
          const dy = event.clientY - lastY;
          lastX = event.clientX;
          lastY = event.clientY;
          if (mode === "orbit") {
            this.yaw -= dx * 0.008;
            this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.008));
          } else {
            this.pan(dx, dy);
          }
          this.invalidate();
        };
        const up = (event) => {
          mode = null;
          canvas.releasePointerCapture?.(event.pointerId);
        };
        const wheel = (event) => {
          event.preventDefault();
          const scale = Math.exp(event.deltaY * 0.0012);
          this.dist = Math.max(this.radius * 0.35, Math.min(this.radius * 30, this.dist * scale));
          this.invalidate();
        };
        canvas.addEventListener("pointerdown", down);
        canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerup", up);
        canvas.addEventListener("pointercancel", up);
        canvas.addEventListener("wheel", wheel, { passive: false });
        canvas.addEventListener("dblclick", () => this.resetView());
        canvas.addEventListener("contextmenu", (event) => event.preventDefault());
        this.disposePointer = () => {
          canvas.removeEventListener("pointerdown", down);
          canvas.removeEventListener("pointermove", move);
          canvas.removeEventListener("pointerup", up);
          canvas.removeEventListener("pointercancel", up);
          canvas.removeEventListener("wheel", wheel);
        };
      }

      applySurfaceColor() {
        if (this.disposed) return;
        const color = surfaceColor(this.canvas.parentElement ?? this.stage);
        this.surface = color;
        this.gl.clearColor(color[0], color[1], color[2], color[3]);
        if (this.surfaceLogged !== true) {
          this.surfaceLogged = true;
          console.log("[dsh-lego-io-preview] surface color", color.map((v) => Math.round(v * 255)).join(","));
        }
        this.invalidate();
      }

      pan(dx, dy) {
        const cp = Math.cos(this.pitch);
        const eyeDir = [cp * Math.sin(this.yaw), Math.sin(this.pitch), cp * Math.cos(this.yaw)];
        const forward = [-eyeDir[0], -eyeDir[1], -eyeDir[2]];
        let right = [forward[2], 0, -forward[0]];
        const rightLen = Math.hypot(right[0], right[1], right[2]) || 1;
        right = right.map((v) => v / rightLen);
        const up = [
          right[1] * forward[2] - right[2] * forward[1],
          right[2] * forward[0] - right[0] * forward[2],
          right[0] * forward[1] - right[1] * forward[0],
        ];
        const k = this.dist * 0.0014;
        this.target = [
          this.target[0] - right[0] * dx * k + up[0] * dy * k,
          this.target[1] - right[1] * dx * k + up[1] * dy * k,
          this.target[2] - right[2] * dx * k + up[2] * dy * k,
        ];
      }

      loop() {
        if (this.disposed) return;
        this.frame = requestAnimationFrame(this.loop);
        if (!this.dirty) return;
        this.dirty = false;
        this.render();
      }

      resize() {
        const canvas = this.canvas;
        const width = Math.max(1, canvas.clientWidth);
        const height = Math.max(1, canvas.clientHeight);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.round(width * dpr);
        const h = Math.round(height * dpr);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        return { width, height };
      }

      render() {
        const gl = this.gl;
        const { width, height } = this.resize();
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (width < 2 || height < 2) return;

        const cp = Math.cos(this.pitch);
        const eye = [
          this.target[0] + this.dist * cp * Math.sin(this.yaw),
          this.target[1] + this.dist * Math.sin(this.pitch),
          this.target[2] + this.dist * cp * Math.cos(this.yaw),
        ];
        const near = Math.max(1, this.dist * 0.02);
        const far = this.dist * 4 + this.radius * 8;
        const proj = perspective(FOV, width / height, near, far);
        const view = lookAt(eye, this.target, [0, 1, 0]);
        const vp = multiply(proj, view);

        if (this.gridVisible) {
          gl.useProgram(this.lineProg);
          gl.uniformMatrix4fv(this.lineUni.mvp, false, vp);
          gl.uniform4f(this.lineUni.color, 0.55, 0.6, 0.68, 0.28);
          gl.bindVertexArray(this.grid.vao);
          gl.drawArrays(gl.LINES, 0, this.grid.count);
        }

        gl.useProgram(this.prog);
        gl.uniformMatrix4fv(this.uni.mvp, false, vp);
        for (const instance of this.model.instances) {
          const vao = this.vaoFor(instance.entry);
          gl.bindVertexArray(vao.vao);
          gl.uniformMatrix4fv(this.uni.model, false, instance.model);
          gl.uniform4f(this.uni.color, instance.color[0], instance.color[1], instance.color[2], instance.color[3]);
          gl.drawArrays(gl.TRIANGLES, 0, vao.count);
        }
        gl.bindVertexArray(null);
      }

      dispose() {
        this.disposed = true;
        cancelAnimationFrame(this.frame);
        this.resizeObserver?.disconnect();
        this.themeObserver?.disconnect();
        this.themeQuery?.removeEventListener?.("change", this.schemeListener);
        this.disposePointer?.();
        const gl = this.gl;
        for (const vao of this.vaos.values()) {
          gl.deleteBuffer(vao.buffer);
          gl.deleteVertexArray(vao.vao);
        }
        this.vaos.clear();
        gl.deleteBuffer(this.grid.buffer);
        gl.deleteVertexArray(this.grid.vao);
        gl.deleteProgram(this.prog);
        gl.deleteProgram(this.lineProg);
        this.canvas.remove();
      }
    }

    // ------------------------------------------------------------------
    // Address + props helpers
    // ------------------------------------------------------------------
    function parseFileAddress(address) {
      try {
        if (typeof address !== "string" || address.indexOf(FILE_PREFIX) !== 0) return undefined;
        const end = address.search(/[?#]/u);
        const parts = address.slice(FILE_PREFIX.length, end === -1 ? undefined : end).split("/");
        if (parts.shift() !== "session") return undefined;
        const sessionId = parts.shift();
        if (typeof sessionId !== "string" || sessionId === "" || parts.length === 0) return undefined;
        return {
          sessionId: decodeURIComponent(sessionId),
          path: parts.map((part) => decodeURIComponent(part)).join("/"),
        };
      } catch {
        return undefined;
      }
    }

    // ------------------------------------------------------------------
    // Surface color (match the surrounding preview pane, light or dark)
    // ------------------------------------------------------------------
    function parseCssColor(value) {
      if (typeof value !== "string") return undefined;
      const text = value.trim().toLowerCase();
      if (text === "" || text === "transparent" || text === "none") return undefined;
      const match = text.match(/^rgba?\(([^)]+)\)$/u);
      if (match !== null) {
        const parts = match[1].split(/[,/\s]+/u).filter((piece) => piece !== "");
        const nums = parts.map((piece) => (piece.endsWith("%") ? (parseFloat(piece) / 100) * 255 : parseFloat(piece)));
        if (nums.length < 3 || nums.some((n) => Number.isNaN(n))) return undefined;
        const alpha = nums.length > 3 ? (nums[3] > 1 ? nums[3] / 255 : nums[3]) : 1;
        if (alpha === 0) return undefined;
        return [nums[0] / 255, nums[1] / 255, nums[2] / 255, 1];
      }
      if (text.startsWith("#")) {
        const hex = text.slice(1);
        const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
        if (full.length !== 6 && full.length !== 8) return undefined;
        const r = parseInt(full.slice(0, 2), 16);
        const g = parseInt(full.slice(2, 4), 16);
        const b = parseInt(full.slice(4, 6), 16);
        if ([r, g, b].some((n) => Number.isNaN(n))) return undefined;
        return [r / 255, g / 255, b / 255, 1];
      }
      return undefined;
    }

    function surfaceColor(element) {
      let node = element;
      let background;
      while (node !== null && node !== undefined) {
        const color = parseCssColor(window.getComputedStyle(node).backgroundColor);
        if (color !== undefined) {
          background = color;
          break;
        }
        if (node === document.documentElement) break;
        node = node.parentElement;
      }
      const rootStyle = window.getComputedStyle(document.documentElement);
      const base = background ?? parseCssColor(rootStyle.backgroundColor) ?? [1, 1, 1, 1];
      const ink = parseCssColor(rootStyle.color) ?? [0, 0, 0, 1];
      const tint = 0.055;
      return [
        base[0] * (1 - tint) + ink[0] * tint,
        base[1] * (1 - tint) + ink[1] * tint,
        base[2] * (1 - tint) + ink[2] * tint,
        1,
      ];
    }

    function toArrayBuffer(value) {      if (value instanceof ArrayBuffer) return value;
      if (value === null || value === undefined) return undefined;
      if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      if (value.kind === "bytes" && value.data !== undefined) return toArrayBuffer(value.data);
      if (value.data !== undefined) return toArrayBuffer(value.data);
      return undefined;
    }

    function describeError(error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "webgl2") return "errorWebgl";
      return "errorGeneric";
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------
    const CSS = `
.iov-root { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; overflow: hidden; font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
.iov-stage { position: relative; flex: 1 1 auto; min-height: 0; width: 100%; cursor: grab; touch-action: none; }
.iov-stage:active { cursor: grabbing; }
.iov-canvas { display: block; width: 100%; height: 100%; }
.iov-bar { position: absolute; left: 10px; top: 10px; display: flex; gap: 6px; align-items: center; padding: 4px 6px; border-radius: 8px; background: color-mix(in srgb, Canvas 88%, transparent); color: CanvasText; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.14); }
.iov-btn { appearance: none; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); background: transparent; color: inherit; border-radius: 6px; padding: 3px 8px; font: inherit; cursor: pointer; line-height: 1.45; }
.iov-btn:hover { background: color-mix(in srgb, CanvasText 10%, transparent); }
.iov-btn-on { background: color-mix(in srgb, CanvasText 16%, transparent); border-color: color-mix(in srgb, CanvasText 30%, transparent); }
.iov-stat { padding: 0 4px; opacity: 0.85; white-space: nowrap; }
.iov-msg { position: absolute; left: 10px; right: 10px; bottom: 10px; padding: 6px 9px; border-radius: 8px; background: color-mix(in srgb, Canvas 90%, transparent); color: CanvasText; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }
.iov-warn { background: color-mix(in srgb, #f0b429 24%, Canvas); }
.iov-err { background: color-mix(in srgb, #d64545 26%, Canvas); }
`;

    function installStyles() {
      const tag = document.createElement("style");
      tag.setAttribute("data-dsh-plugin", NS);
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
      };
    }

    // ------------------------------------------------------------------
    // Body
    // ------------------------------------------------------------------
    function Body(props) {
      console.log("[dsh-lego-io-preview] Body mounted", { address: props.resourceAddress, contentKind: props.content?.kind });
      const t = typeof props.t === "function" ? props.t : (key) => en[key] ?? key;
      const content = props.content;
      const bytes = content !== undefined && content !== null && content.kind === "bytes" ? toArrayBuffer(content.data) : undefined;
      const stageRef = React.useRef(null);
      const viewerRef = React.useRef(null);
      const [status, setStatus] = React.useState({ phase: "loading" });
      const [grid, setGrid] = React.useState(true);

      React.useEffect(() => {
        const stage = stageRef.current;
        if (stage === null) return undefined;
        let cancelled = false;
        let viewer;
        setStatus({ phase: "loading" });

        (async () => {
          try {
            const payload = await getPayload();
            let buffer = bytes;
            if (buffer === undefined) {
              const address = parseFileAddress(props.resourceAddress);
              const read = props.readWorkspaceFile;
              if (address !== undefined && typeof read === "function") {
                const result = await read(address.path, {}, undefined);
                buffer = toArrayBuffer(result);
              }
            }
            if (buffer === undefined) throw new Error("no bytes");
            const model = await loadIoModel(buffer, payload, {
              onProgress: (progress) => {
                if (!cancelled) setStatus({ phase: "loading", progress });
              },
            });
            if (cancelled) return;
            if (model.error !== undefined) {
              setStatus({ phase: "error", message: model.error });
              return;
            }
            viewer = new Viewer(stage, model);
            viewerRef.current = viewer;
            viewer.setGrid(grid);
            setStatus({
              phase: "ready",
              parts: model.count,
              kinds: model.kinds,
              missing: model.missing,
              fromStudio: model.resolved?.added ?? 0,
            });
          } catch (error) {
            if (!cancelled) setStatus({ phase: "error", message: describeError(error) });
          }
        })();

        return () => {
          cancelled = true;
          if (viewerRef.current === viewer) viewerRef.current = null;
          try {
            viewer?.dispose();
          } catch {
            /* best effort */
          }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [bytes, props.resourceAddress]);

      const reset = React.useCallback(() => {
        viewerRef.current?.resetView();
      }, []);

      const toggleGrid = React.useCallback(() => {
        setGrid((current) => {
          const next = !current;
          viewerRef.current?.setGrid(next);
          return next;
        });
      }, []);

      return h(
        "div",
        { className: "iov-root" },
        h("div", { className: "iov-stage", ref: stageRef }),
        h(
          "div",
          { className: "iov-bar" },
          h("button", { className: "iov-btn", type: "button", onClick: reset }, t("reset")),
          h("button", { className: "iov-btn" + (grid ? " iov-btn-on" : ""), type: "button", onClick: toggleGrid }, t("grid")),
          status.phase === "ready"
            ? h(
                "span",
                { className: "iov-stat" },
                status.parts + " " + t("unitParts") + " · " + status.kinds + " " + t("unitKinds") +
                  (status.fromStudio > 0 ? " · +" + status.fromStudio + " " + t("fromStudio") : ""),
              )
            : null,
        ),
        status.phase === "loading"
          ? h(
              "div",
              { className: "iov-msg" },
              status.progress !== undefined
                ? t("resolving") + " " + status.progress.done + "/" + status.progress.total
                : t("loading"),
            )
          : null,
        status.phase === "error" ? h("div", { className: "iov-msg iov-err" }, t(status.message)) : null,
        status.phase === "ready" && status.missing.length > 0
          ? h("div", { className: "iov-msg iov-warn" }, t("missing") + " " + status.missing.join(", "))
          : null,
      );
    }

    // ------------------------------------------------------------------
    // Better-sidebar file viewer (the file tree routes .io here)
    // ------------------------------------------------------------------
    function SidebarIoViewer(props) {
      let t;
      try {
        t = props.ctx !== undefined && props.ctx.locale !== undefined ? props.ctx.locale.bind(NS) : undefined;
      } catch {
        t = undefined;
      }
      if (typeof t !== "function") t = (key) => en[key] ?? key;

      const stageRef = React.useRef(null);
      const viewerRef = React.useRef(null);
      const [status, setStatus] = React.useState({ phase: "loading" });
      const [grid, setGrid] = React.useState(true);

      React.useEffect(() => {
        const stage = stageRef.current;
        if (stage === null) return undefined;
        let cancelled = false;
        let viewer;
        setStatus({ phase: "loading" });

        (async () => {
          try {
            const payload = await getPayload();
            let buffer;
            if (typeof props.mediaUrl === "string" && props.mediaUrl !== "") {
              const response = await fetch(props.mediaUrl);
              if (!response.ok) throw new Error("http " + response.status);
              buffer = await response.arrayBuffer();
            } else {
              const sessionId = props.scope?.sessionId;
              const read = props.ctx?.remote?.workspaceFiles?.readBytes;
              if (typeof sessionId === "string" && typeof read === "function") {
                buffer = toArrayBuffer(await read(sessionId, props.path, {}));
              }
            }
            if (buffer === undefined) throw new Error("no bytes");
            const model = await loadIoModel(buffer, payload, {
              onProgress: (progress) => {
                if (!cancelled) setStatus({ phase: "loading", progress });
              },
            });
            if (cancelled) return;
            if (model.error !== undefined) {
              setStatus({ phase: "error", message: model.error });
              return;
            }
            viewer = new Viewer(stage, model);
            viewerRef.current = viewer;
            viewer.setGrid(grid);
            setStatus({
              phase: "ready",
              parts: model.count,
              kinds: model.kinds,
              missing: model.missing,
              fromStudio: model.resolved?.added ?? 0,
            });
          } catch (error) {
            if (!cancelled) setStatus({ phase: "error", message: describeError(error) });
          }
        })();

        return () => {
          cancelled = true;
          if (viewerRef.current === viewer) viewerRef.current = null;
          try {
            viewer?.dispose();
          } catch {
            /* best effort */
          }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [props.mediaUrl, props.path]);

      const reset = React.useCallback(() => {
        viewerRef.current?.resetView();
      }, []);

      const toggleGrid = React.useCallback(() => {
        setGrid((current) => {
          const next = !current;
          viewerRef.current?.setGrid(next);
          return next;
        });
      }, []);

      return h(
        "div",
        { className: "iov-root", "data-io-preview": true },
        h("div", { className: "iov-stage", ref: stageRef }),
        h(
          "div",
          { className: "iov-bar" },
          h("button", { className: "iov-btn", type: "button", onClick: reset }, t("reset")),
          h("button", { className: "iov-btn" + (grid ? " iov-btn-on" : ""), type: "button", onClick: toggleGrid }, t("grid")),
          status.phase === "ready"
            ? h(
                "span",
                { className: "iov-stat" },
                status.parts + " " + t("unitParts") + " · " + status.kinds + " " + t("unitKinds") +
                  (status.fromStudio > 0 ? " · +" + status.fromStudio + " " + t("fromStudio") : ""),
              )
            : null,
        ),
        status.phase === "loading"
          ? h(
              "div",
              { className: "iov-msg" },
              status.progress !== undefined
                ? t("resolving") + " " + status.progress.done + "/" + status.progress.total
                : t("loading"),
            )
          : null,
        status.phase === "error" ? h("div", { className: "iov-msg iov-err" }, t(status.message)) : null,
        status.phase === "ready" && status.missing.length > 0
          ? h("div", { className: "iov-msg iov-warn" }, t("missing") + " " + status.missing.join(", "))
          : null,
      );
    }

    // ------------------------------------------------------------------
    // Plugin
    // ------------------------------------------------------------------
    function apply(ctx) {
      console.log("[dsh-lego-io-preview] apply() start", {
        slots: !!ctx.slots,
        locale: !!ctx.locale,
        documentPreviews: !!ctx.documentPreviews,
        remote: !!ctx.remote,
        workspaceFiles: !!(ctx.remote && ctx.remote.workspaceFiles),
      });
      try {
      const t = ctx.locale.bind(NS);
      const previews = ctx.documentPreviews;
      const workspaceFiles = ctx.remote.workspaceFiles;
      ctx.effect(() => installStyles(), "dsh-lego-io-preview: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-lego-io-preview: dictionaries");
      ctx.effect(
        () =>
          previews.register({
            id: BODY_ID,
            extensions: ["io"],
            binaryExtensions: ["io"],
            priority: "extension",
            title: () => t("title"),
            loading: "bytes-complete",
            wrap: false,
          }),
        "dsh-lego-io-preview: preview metadata",
      );
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.tab.document", () =>
            ctx.slots.register(
              {
                name: "sidebar.right.tab.document",
                key: BODY_ID,
                locale: NS,
                inject: (sessionId) => ({
                  readWorkspaceFile: (path, options, signal) => workspaceFiles.readBytes(sessionId, path, options ?? {}, signal),
                }),
              },
              Body,
            ),
          ),
        "dsh-lego-io-preview: preview body",
      );
      const viewerDescriptor = {
        id: "dsh-lego-io-preview:io",
        title: () => t("title"),
        exts: ["io"],
        priority: 50,
        fetchStrategy: "mediaUrl",
        component: SidebarIoViewer,
      };
      let better;
      try {
        better = ctx.betterSidebar;
      } catch {
        better = undefined;
      }
      if (better === undefined && typeof ctx.inject === "function") {
        try {
          ctx.inject(["betterSidebar"], (child) => {
            const service = child.betterSidebar;
            if (service === undefined) return;
            child.effect(() => service.registerFileViewer(viewerDescriptor), "dsh-lego-io-preview: better-sidebar file viewer");
            console.log("[dsh-lego-io-preview] registered better-sidebar viewer for .io (late)");
          });
        } catch (error) {
          console.warn("[dsh-lego-io-preview] ctx.inject(betterSidebar) failed", error);
        }
      }
      if (better !== undefined && typeof better.registerFileViewer === "function") {
        ctx.effect(() => better.registerFileViewer(viewerDescriptor), "dsh-lego-io-preview: better-sidebar file viewer");
        console.log("[dsh-lego-io-preview] registered better-sidebar viewer for .io");
      } else if (better === undefined) {
        console.warn("[dsh-lego-io-preview] betterSidebar service unavailable");
      }
      console.log("[dsh-lego-io-preview] apply() done");
      globalThis.__dshIoPreview = { previews, BODY_ID, NS, slots: ctx.slots, defineId: "1.0.3" };
      } catch (error) {
        console.error("[dsh-lego-io-preview] apply() threw", error);
        throw error;
      }
    }

    return {
      inject: ["slots", "locale", "documentPreviews", "remote", "remote.workspaceFiles"],
      apply,
      __internals: { readZip, parseModel, loadIoModel, getPayload, parseFileAddress, baseName, findEntry, Viewer, SidebarIoViewer },
    };
  },
});
