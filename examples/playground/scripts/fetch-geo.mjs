// Fetches the Xuzhou base map for the WMS demo's logistics network (spatial spec §12.4) and writes it, simplified, to
// src/wms/geo/xuzhou.json, which is committed: the playground never fetches at run time.
//
//   NODE_USE_ENV_PROXY=1 node examples/playground/scripts/fetch-geo.mjs [--cache <dir>]
//
// (NODE_USE_ENV_PROXY: Node's fetch then honours HTTPS_PROXY, where the network is reached through one.)
//
// Sources (both public; the map's footer credits them: "© OpenStreetMap contributors · DataV"; the roads and water
// are OSM data, so the extract is under the ODbL 1.0, which its `source.osm` names):
//   - districts: DataV GeoAtlas, 320300_full (徐州市's districts and counties, GCJ-02 as DataV publishes them);
//   - roads and water: OpenStreetMap via the Overpass API, for the city's bbox: highway motorway / trunk / primary /
//     secondary and their _links; waterway=river, the Grand Canal (waterway=canal named …运河); natural=water lakes and
//     reservoirs (ways and multipolygon relations) whose area is at least LAKE_MIN_KM2.
// The district outlines are taken from GCJ-02 (as DataV publishes them) to WGS-84 (as OSM's), so roads meet them. Roads
// and rivers are joined into long lines where their ways meet, simplified with Douglas–Peucker at TOLERANCE_M metres,
// and kept only in and next to the city's districts (the map shows the city); lakes are kept when they touch it. Every
// coordinate is rounded to 5 decimals (about 1 m), stored flat: [lon, lat, lon, lat, …].
// `--cache <dir>` keeps the raw responses there and reads them back on the next run (to tune the simplification
// without asking the servers again).
//
// The requests carry a generic User-Agent (Overpass refuses requests without one) and nothing that names a person.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '../src/wms/geo/xuzhou.json')
const USER_AGENT = 'glassui-playground/0.1'
const DATAV = 'https://geo.datav.aliyun.com/areas_v3/bound/320300_full.json'
const OVERPASS = 'https://overpass-api.de/api/interpreter'
/** The query's bbox round the city: west, south, east, north (degrees). */
const BBOX = [116.36, 33.72, 118.67, 34.97]
const TOLERANCE_M = 25
const LAKE_MIN_KM2 = 0.4
const DECIMALS = 5

const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary']
const bbox = `${BBOX[1]},${BBOX[0]},${BBOX[3]},${BBOX[2]}`
const QUERIES = {
  roads: `[out:json][timeout:60];way["highway"~"^(motorway|trunk|primary|secondary)(_link)?$"](${bbox});out geom;`,
  water: `[out:json][timeout:60];(way["waterway"="river"](${bbox});way["waterway"="canal"]["name"~"运河"](${bbox});` +
    `way["natural"="water"]["water"~"^(lake|reservoir|river|oxbow)$"](${bbox});relation["natural"="water"]["water"~"^(lake|reservoir)$"](${bbox}););out geom;`,
}

const args = process.argv.slice(2)
const cacheDir = args[0] === '--cache' ? args[1] : undefined

/** The day the OSM data was fetched (YYYY-MM-DD): today, or the cached response's date when it came from `--cache`. */
let fetchedOn = new Date().toISOString().slice(0, 10)

async function cached(name, fetcher) {
  const file = cacheDir && join(cacheDir, `${name}.json`)
  if (file) {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'))
      if (name.startsWith('osm')) fetchedOn = (await stat(file)).mtime.toISOString().slice(0, 10)
      return data
    } catch { /* not cached yet */ }
  }
  const text = await fetcher()
  if (file) { await mkdir(cacheDir, { recursive: true }); await writeFile(file, text) }
  return JSON.parse(text)
}

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

/** One query at a time; a busy server (429, 502, 503, 504) is asked again after 15, 30, 60, 120 s, as it asks. */
async function overpass(query) {
  for (let attempt = 0, wait = 15; ; attempt++, wait *= 2) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }),
    })
    if (res.ok) return res.text()
    const why = `${OVERPASS}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`
    if (![429, 502, 503, 504].includes(res.status) || attempt === 4) throw new Error(why)
    console.warn(`overpass busy (HTTP ${res.status}); again in ${wait} s`)
    await new Promise(r => setTimeout(r, wait * 1000))
  }
}

// ---- geometry -------------------------------------------------------------------------------------------------------

const LAT0 = (BBOX[1] + BBOX[3]) / 2
const KX = 111_320 * Math.cos(LAT0 * Math.PI / 180), KY = 110_540   // metres per degree
const round = v => Math.round(v * 10 ** DECIMALS) / 10 ** DECIMALS

/** Douglas–Peucker on [lon, lat] points, `tol` metres (measured in a local equirectangular frame). */
function simplify(pts, tol = TOLERANCE_M) {
  if (pts.length <= 2) return pts
  const xy = pts.map(([lon, lat]) => [lon * KX, lat * KY])
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
    let worst = -1, at = -1
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i]
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
      t = Math.max(0, Math.min(1, t))
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy)
      if (d > worst) { worst = d; at = i }
    }
    if (worst > tol) { keep[at] = 1; stack.push([a, at], [at, b]) }
  }
  return pts.filter((_, i) => keep[i])
}

/** Flat [lon, lat, lon, lat, …], rounded, consecutive duplicates dropped. */
function flat(pts) {
  const out = []
  for (const [lon, lat] of pts) {
    const x = round(lon), y = round(lat)
    if (out.length && out[out.length - 2] === x && out[out.length - 1] === y) continue
    out.push(x, y)
  }
  return out
}

/** km² of a closed ring (shoelace in the local frame). */
function areaKm2(ring) {
  let s = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] * KX) * (ring[i][1] * KY) - (ring[i][0] * KX) * (ring[j][1] * KY)
  return Math.abs(s) / 2 / 1e6
}

const geomOf = w => (w.geometry ?? []).map(p => [p.lon, p.lat])
const same = (p, q) => p[0] === q[0] && p[1] === q[1]

/** Joins open ways end to end into closed rings (a multipolygon's outer members); open leftovers are dropped. */
function assemble(lines) {
  const rings = [], open = lines.filter(l => l.length > 1).map(l => [...l])
  while (open.length) {
    let ring = open.pop()
    for (let grew = true; grew && !same(ring[0], ring[ring.length - 1]);) {
      grew = false
      for (let i = 0; i < open.length; i++) {
        const l = open[i], end = ring[ring.length - 1]
        if (same(l[0], end)) ring = ring.concat(l.slice(1))
        else if (same(l[l.length - 1], end)) ring = ring.concat([...l].reverse().slice(1))
        else if (same(l[l.length - 1], ring[0])) ring = l.concat(ring.slice(1))
        else if (same(l[0], ring[0])) ring = [...l].reverse().concat(ring.slice(1))
        else continue
        open.splice(i, 1); grew = true; break
      }
    }
    if (ring.length > 3 && same(ring[0], ring[ring.length - 1])) rings.push(ring)
  }
  return rings
}

// ---- GCJ-02 → WGS-84 ------------------------------------------------------------------------------------------------
// DataV publishes AMap's GCJ-02 coordinates, OSM is WGS-84: about 500 m apart round Xuzhou, which shows at the map's
// closer zooms (district edges off the roads). The usual GCJ-02 formulas, inverted by fixed-point iteration (< 0.1 m).

const A = 6378245.0, EE = 0.00669342162296594323
function gcjOffset(lon, lat) {
  const x = lon - 105, y = lat - 35
  let dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  dLat += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  dLat += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3
  dLat += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3
  let dLon = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  dLon += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  dLon += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3
  dLon += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3
  const rad = lat / 180 * Math.PI, magic = 1 - EE * Math.sin(rad) ** 2, sq = Math.sqrt(magic)
  return [dLon * 180 / (A / sq * Math.cos(rad) * Math.PI), dLat * 180 / ((A * (1 - EE)) / (magic * sq) * Math.PI)]
}
function gcjToWgs([lon, lat]) {
  let w = [lon, lat]
  for (let i = 0; i < 4; i++) { const [dx, dy] = gcjOffset(w[0], w[1]); w = [lon - dx, lat - dy] }
  return w
}

// ---- the city's outline: what is kept ------------------------------------------------------------------------------

/** Even–odd point in ring ([lon, lat] points). */
function inRing([x, y], ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
/** A raster of the city (every district's rings), CELL degrees a cell, grown by one cell: is a point in or near it. */
const CELL = 0.01
function cityMask(rings) {
  const nx = Math.ceil((BBOX[2] - BBOX[0]) / CELL), ny = Math.ceil((BBOX[3] - BBOX[1]) / CELL), raw = new Uint8Array(nx * ny)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = [BBOX[0] + (i + 0.5) * CELL, BBOX[1] + (j + 0.5) * CELL]
    if (rings.some(r => inRing(p, r))) raw[j * nx + i] = 1
  }
  const grown = new Uint8Array(nx * ny)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let any = 0
    for (let dj = -1; dj <= 1 && !any; dj++) for (let di = -1; di <= 1 && !any; di++) {
      const a = i + di, b = j + dj
      if (a >= 0 && b >= 0 && a < nx && b < ny && raw[b * nx + a]) any = 1
    }
    grown[j * nx + i] = any
  }
  return ([lon, lat]) => {
    const i = Math.floor((lon - BBOX[0]) / CELL), j = Math.floor((lat - BBOX[1]) / CELL)
    return i >= 0 && j >= 0 && i < nx && j < ny && grown[j * nx + i] === 1
  }
}
/** The runs of `pts` in the city (`keep`), each with one point past either end so it reaches the edge. */
function clip(pts, keep) {
  const runs = [], inside = pts.map(keep)
  let run = null
  pts.forEach((p, i) => {
    const near = inside[i] || inside[i - 1] === true || inside[i + 1] === true
    if (near) (run ??= []).push(p)
    else if (run) { runs.push(run); run = null }
  })
  if (run) runs.push(run)
  return runs.filter(r => r.length >= 2)
}

/** Joins ways that meet end to end into longer lines (fewer, longer polylines: smaller and simplified as one). */
function chain(lines) {
  const key = p => `${p[0]},${p[1]}`, ends = new Map(), used = new Uint8Array(lines.length)
  lines.forEach((l, i) => { for (const p of [l[0], l[l.length - 1]]) { const k = key(p); ends.set(k, [...(ends.get(k) ?? []), i]) } })
  const take = (p, self) => {
    const i = (ends.get(key(p)) ?? []).find(j => j !== self && !used[j])
    if (i === undefined) return null
    used[i] = 1
    return lines[i]
  }
  const out = []
  lines.forEach((l, i) => {
    if (used[i]) return
    used[i] = 1
    let line = [...l]
    for (let next; (next = take(line[line.length - 1], i));) line = line.concat(same(next[0], line[line.length - 1]) ? next.slice(1) : [...next].reverse().slice(1))
    for (let prev; (prev = take(line[0], i));) line = (same(prev[prev.length - 1], line[0]) ? prev : [...prev].reverse()).slice(0, -1).concat(line)
    out.push(line)
  })
  return out
}

// ---- the layers -----------------------------------------------------------------------------------------------------

function districts(geo) {
  return geo.features.map(f => {
    const g = f.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    // every polygon's outer ring (DataV's districts have no holes worth drawing at this scale), in WGS-84
    const rings = polys.map(p => p[0].map(gcjToWgs)).filter(r => r.length >= 4)
    return { name: f.properties.name, adcode: f.properties.adcode, center: gcjToWgs(f.properties.center), rings }
  })
}

function roads(osm, keep) {
  const out = []
  for (const cls of ROAD_CLASSES) {
    const ways = osm.elements.filter(w => w.type === 'way' && (w.tags?.highway ?? '').replace(/_link$/, '') === cls).map(geomOf)
    for (const line of chain(ways)) for (const run of clip(simplify(line), keep)) {
      const c = flat(run)
      if (c.length >= 4) out.push({ cls, c })
    }
  }
  return out
}

function water(osm, keep) {
  const rivers = [], lakes = [], lines = []
  for (const e of osm.elements) {
    const t = e.tags ?? {}
    if (e.type === 'way' && (t.waterway === 'river' || t.waterway === 'canal')) lines.push(geomOf(e))
    else if (t.natural === 'water') {
      const rings = e.type === 'way' ? [geomOf(e)] : assemble((e.members ?? []).filter(m => m.type === 'way' && m.role !== 'inner').map(geomOf))
      for (const ring of rings) {
        if (ring.length < 4 || !same(ring[0], ring[ring.length - 1]) || areaKm2(ring) < LAKE_MIN_KM2 || !ring.some(keep)) continue
        const c = flat(simplify(ring))
        if (c.length >= 8) lakes.push({ ...(t.name ? { name: t.name } : {}), c })
      }
    }
  }
  for (const line of chain(lines)) for (const run of clip(simplify(line), keep)) {
    const c = flat(run)
    if (c.length >= 4) rivers.push({ c })
  }
  return { rivers, lakes }
}

// one after another: Overpass gives each client a couple of slots at most
const datav = await cached('datav-320300', () => get(DATAV))
const osmRoads = await cached('osm-roads', () => overpass(QUERIES.roads))
const osmWater = await cached('osm-water', () => overpass(QUERIES.water))
const city = districts(datav), keep = cityMask(city.flatMap(d => d.rings))
// the extract's bbox: the districts' extent, rounded out to 0.01° (DataV's outline reaches a few hundred metres past the
// query's box at three edges; the roads and rivers there end at the box)
const ext = [Infinity, Infinity, -Infinity, -Infinity]
for (const d of city) for (const r of d.rings) for (const [lon, lat] of r) {
  ext[0] = Math.min(ext[0], lon); ext[1] = Math.min(ext[1], lat); ext[2] = Math.max(ext[2], lon); ext[3] = Math.max(ext[3], lat)
}
const out = {
  // the roads and water are OSM data: the extract stays under the ODbL, and says so
  source: { districts: 'DataV GeoAtlas 320300_full', osm: `© OpenStreetMap contributors, ODbL 1.0 (https://opendatacommons.org/licenses/odbl/), via Overpass, ${fetchedOn}` },
  bbox: [Math.floor(ext[0] * 100) / 100, Math.floor(ext[1] * 100) / 100, Math.ceil(ext[2] * 100) / 100, Math.ceil(ext[3] * 100) / 100],
  districts: city.map(d => ({ ...d, center: d.center.map(round), rings: d.rings.map(flat) })),
  roads: roads(osmRoads, keep),
  ...water(osmWater, keep),
}
await mkdir(dirname(OUT), { recursive: true })
const text = JSON.stringify(out)
await writeFile(OUT, text + '\n')
const points = a => a.reduce((s, x) => s + x.c.length / 2, 0)
console.log(`wrote ${OUT}: ${(text.length / 1024).toFixed(0)} KB`)
console.log(`  districts ${out.districts.length} (${out.districts.reduce((s, d) => s + d.rings.reduce((t, r) => t + r.length / 2, 0), 0)} points)`)
for (const cls of ROAD_CLASSES) { const rs = out.roads.filter(r => r.cls === cls); console.log(`  ${cls} ${rs.length} ways, ${points(rs)} points`) }
console.log(`  rivers ${out.rivers.length} (${points(out.rivers)} points), lakes ${out.lakes.length} (${points(out.lakes)} points)`)
