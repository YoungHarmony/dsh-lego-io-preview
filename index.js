/**
 * dsh-lego-io-preview — host half.
 *
 * The browser half renders `.io` models with WebGL2. Parts that are not baked
 * into the client bundle are resolved here, from the LDraw library that ships
 * with BrickLink Studio 2.0 (or any other LDraw library the user points us at),
 * and handed to the client as triangle soups over one local route.
 *
 * Routes (same origin as the DSH web server):
 *   GET  /dsh-lego-io-preview/status  -> { ok, root, parts, cached, configured }
 *   POST /dsh-lego-io-preview/geom    -> { parts: { name: { b, bbox, tris } }, missing: [] }
 */
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const ROUTE_PREFIX = "/dsh-lego-io-preview";
const LIBRARY_DIRS = ["parts", "p", "LEGO", "UnOfficial"];
const MAX_PARTS_PER_REQUEST = 2000;
const MAX_BODY_BYTES = 512 * 1024;
const MOVED = /^\s*0\s+~Moved to\s+(\S+)/i;

function candidateRoots(config) {
  const list = [];
  if (typeof config?.libraryPath === "string" && config.libraryPath !== "") list.push(config.libraryPath);
  if (typeof process.env.DSH_IO_PREVIEW_LDRAW === "string" && process.env.DSH_IO_PREVIEW_LDRAW !== "") {
    list.push(process.env.DSH_IO_PREVIEW_LDRAW);
  }
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    for (const base of [programFiles, programFilesX86]) {
      list.push(path.join(base, "Studio 2.0", "ldraw"));
      list.push(path.join(base, "Studio 2.0", "LDraw"));
      list.push(path.join(base, "BrickLink", "Studio 2.0", "ldraw"));
    }
    for (const drive of ["C:", "D:", "E:"]) {
      list.push(path.join(drive + "\\", "Program Files", "Studio 2.0", "ldraw"));
    }
  } else if (process.platform === "darwin") {
    const home = os.homedir();
    list.push(path.join(home, "Library", "Application Support", "Studio 2.0", "ldraw"));
    list.push("/Applications/Studio 2.0.app/Contents/Resources/ldraw");
    list.push(path.join(home, "Documents", "Studio 2.0", "ldraw"));
  } else {
    list.push(path.join(os.homedir(), "Studio 2.0", "ldraw"));
    list.push("/opt/studio2/ldraw");
  }
  return list;
}

function detectLibrary(config) {
  const attempted = candidateRoots(config);
  for (const root of attempted) {
    try {
      if (existsSync(path.join(root, "parts")) && existsSync(path.join(root, "LDConfig.ldr"))) {
        return { root, attempted };
      }
    } catch {
      /* keep looking */
    }
  }
  return { root: undefined, attempted };
}

async function indexLibrary(root) {
  const index = new Map();
  for (const sub of LIBRARY_DIRS) {
    const dir = path.join(root, sub);
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true, recursive: true });
    } catch {
      continue;
    }
    // readdir({recursive:true}) gives paths relative to `dir` when supported.
    for (const entry of entries) {
      const fileName = entry.name.toLowerCase();
      if (!fileName.endsWith(".dat") || index.has(fileName)) continue;
      const relative = entry.parentPath !== undefined ? path.relative(dir, path.join(entry.parentPath, entry.name)) : entry.name;
      index.set(fileName, path.join(dir, relative));
    }
  }
  return index;
}

class GeometryStore {
  constructor() {
    this.root = undefined;
    this.index = new Map();
    this.byName = new Map();
    this.cacheFile = path.join(cacheDir(), "geom-cache.json");
    this.persisted = new Map();
    this.dirty = false;
    this.saveTimer = undefined;
    this.indexPromise = undefined;
  }

  async ensureIndexed() {
    if (this.root !== undefined) return;
    const detected = detectLibrary(this.config);
    this.root = detected.root;
    this.attempted = detected.attempted;
    if (this.root === undefined) return;
    this.indexPromise = (async () => {
      this.index = await indexLibrary(this.root);
      await this.loadPersisted();
    })();
    await this.indexPromise;
  }

  async loadPersisted() {
    try {
      const raw = await fsp.readFile(this.cacheFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.root !== this.root || typeof parsed.entries !== "object") return;
      for (const [name, entry] of Object.entries(parsed.entries)) {
        if (entry && typeof entry.b === "string") this.persisted.set(name, entry);
      }
    } catch {
      /* no cache yet */
    }
  }

  scheduleSave() {
    if (this.dirty) return;
    this.dirty = true;
    this.saveTimer = setTimeout(() => {
      this.dirty = false;
      const entries = {};
      for (const [name, entry] of this.byName) entries[name] = entry;
      const payload = JSON.stringify({ version: 1, root: this.root, entries });
      fsp
        .mkdir(path.dirname(this.cacheFile), { recursive: true })
        .then(() => fsp.writeFile(this.cacheFile, payload, "utf8"))
        .catch(() => {
          /* cache is best effort */
        });
    }, 1500);
    this.saveTimer.unref?.();
  }

  resolve(name) {
    const base = String(name).replace(/\\/g, "/").split("/").pop().toLowerCase();
    const withExt = base.endsWith(".dat") ? base : base + ".dat";
    const direct = this.index.get(withExt);
    if (direct !== undefined) return direct;
    const stem = withExt.slice(0, -4);
    for (const letter of "abcd") {
      const alt = this.index.get(stem + letter + ".dat");
      if (alt !== undefined) return alt;
    }
    return undefined;
  }

  async geomFor(name) {
    const key = String(name).replace(/\\/g, "/").split("/").pop().toLowerCase();
    if (this.byName.has(key)) return this.byName.get(key);
    const filePath = this.resolve(key);
    if (filePath === undefined) return undefined;
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return undefined;
    }
    const cached = this.persisted.get(key);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      const entry = { b: cached.b, bbox: cached.bbox, tris: cached.tris, mtimeMs: stat.mtimeMs, size: stat.size };
      this.byName.set(key, entry);
      return entry;
    }
    const verts = await this.parseFile(filePath, 0, new Set());
    if (verts.length === 0) return undefined;
    const entry = {
      b: Buffer.from(new Float32Array(verts).buffer).toString("base64"),
      bbox: bboxOf(verts),
      tris: verts.length / 9,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
    this.byName.set(key, entry);
    this.scheduleSave();
    return entry;
  }

  async parseFile(filePath, depth, stack) {
    if (depth > 40 || stack.has(filePath)) return [];
    stack.add(filePath);
    try {
      return await this.parseFileInner(filePath, depth, stack);
    } finally {
      stack.delete(filePath);
    }
  }

  async parseFileInner(filePath, depth, stack) {
    let text;
    try {
      text = await fsp.readFile(filePath, "latin1");
    } catch {
      return [];
    }
    const moved = MOVED.exec(text.slice(0, 400));
    if (moved !== null && depth < 3) {
      const target = this.resolve(moved[1]);
      if (target !== undefined && target !== filePath) return this.parseFile(target, depth + 1, stack);
    }
    const verts = [];
    for (const raw of text.split(/\r?\n/u)) {
      if (raw.length < 2) continue;
      const tok = raw.trim().split(/\s+/u);
      const kind = tok[0];
      if (kind === "1" && tok.length >= 15) {
        const x = Number(tok[2]);
        const y = Number(tok[3]);
        const z = Number(tok[4]);
        const m = tok.slice(5, 14).map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || m.some((v) => !Number.isFinite(v))) continue;
        const target = this.resolve(tok[14]);
        if (target === undefined) continue;
        const child = await this.parseFile(target, depth + 1, stack);
        for (let i = 0; i < child.length; i += 3) {
          const cx = child[i];
          const cy = child[i + 1];
          const cz = child[i + 2];
          verts.push(m[0] * cx + m[1] * cy + m[2] * cz + x);
          verts.push(m[3] * cx + m[4] * cy + m[5] * cz + y);
          verts.push(m[6] * cx + m[7] * cy + m[8] * cz + z);
        }
      } else if (kind === "3" && tok.length >= 11) {
        const v = tok.slice(2, 11).map(Number);
        if (v.every(Number.isFinite)) verts.push(...v);
      } else if (kind === "4" && tok.length >= 14) {
        const v = tok.slice(2, 14).map(Number);
        if (!v.every(Number.isFinite)) continue;
        verts.push(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]);
        verts.push(v[0], v[1], v[2], v[6], v[7], v[8], v[9], v[10], v[11]);
      }
    }
    return verts;
  }
}

function bboxOf(verts) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const round = (v) => Math.round(v * 1000) / 1000;
  return [round(minX), round(minY), round(minZ), round(maxX), round(maxY), round(maxZ)];
}

function cacheDir() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "dsh-lego-io-preview");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "dsh-lego-io-preview");
  }
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(base, "dsh-lego-io-preview");
}

function sendJson(response, status, body) {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const compressed = json.length > 1024 ? zlib.gzipSync(json) : json;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": compressed.length,
    "cache-control": "no-store",
    ...(compressed === json ? {} : { "content-encoding": "gzip" }),
  });
  response.end(compressed);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

export function apply(ctx, config = {}) {
  const store = new GeometryStore();
  store.config = config;

  ctx.inject(["webServer"], (hostCtx) => {
    const webServer = hostCtx.webServer;
    if (webServer === undefined || typeof webServer.register !== "function") {
      console.warn("[dsh-lego-io-preview] webServer service unavailable; host part disabled");
      return;
    }
    const disposers = [];

    disposers.push(
      webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/status",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            await store.ensureIndexed();
            sendJson(response, 200, {
              ok: true,
              root: store.root ?? null,
              parts: store.index.size,
              cached: store.byName.size,
              attempted: store.root === undefined ? store.attempted ?? [] : undefined,
            });
          } catch (error) {
            sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      }),
    );

    disposers.push(
      webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/geom",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            await store.ensureIndexed();
            if (store.root === undefined) {
              sendJson(response, 200, { ok: false, reason: "no-library", parts: {}, missing: [] });
              return;
            }
            const body = await readJsonBody(request);
            const wanted = Array.isArray(body.parts) ? body.parts.slice(0, MAX_PARTS_PER_REQUEST) : [];
            const parts = {};
            const missing = [];
            for (const name of wanted) {
              if (typeof name !== "string") continue;
              const entry = await store.geomFor(name);
              if (entry === undefined) missing.push(name);
              else parts[name.replace(/\\/g, "/").split("/").pop().toLowerCase()] = { b: entry.b, bbox: entry.bbox, tris: entry.tris };
            }
            sendJson(response, 200, { ok: true, parts, missing });
          } catch (error) {
            sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      }),
    );

    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* best effort */
        }
      }
    }, "dsh-lego-io-preview: web routes");
  });
}

export const internals = { GeometryStore, detectLibrary, indexLibrary, bboxOf, ROUTE_PREFIX };
