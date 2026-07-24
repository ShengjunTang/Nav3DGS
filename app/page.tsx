"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import * as pc from "playcanvas";
import { convertPlyToSog, isSogFile } from "./sog-converter";

type Point = { x: number; y: number; world?: [number, number, number]; view?: { yaw: number; pitch: number } };
type Poi = Point & { name: string; category: string; detail: string };
type GraphEdge = [number, number];
type PublishedScene = {
  slug: string;
  title: string;
  projectUrl?: string;
  projectParts?: string[];
  manifestUrl?: string;
  sogUrl?: string;
  size: number;
  routeNodes: number;
  poiCount: number;
  publishedAt: string;
};

const defaultPois: Poi[] = [];

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const pointKey = (p: Point) => `${p.x},${p.y}`;
const pointDistance = (a: Point, b: Point) => a.world && b.world
  ? Math.hypot(a.world[0] - b.world[0], a.world[1] - b.world[1], a.world[2] - b.world[2])
  : Math.hypot(a.x - b.x, a.y - b.y);

function planarPointToSegmentDistance(point: Point, from: Point, to: Point) {
  const p = point.world ?? [point.x, point.y, point.z];
  const a = from.world ?? [from.x, from.y, from.z];
  const b = to.world ?? [to.x, to.y, to.z];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const amount = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + dx * amount), p[1] - (a[1] + dy * amount));
}

function simplifyPolyline(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let index = from + 1; index < to; index++) {
      const distance = planarPointToSegmentDistance(points[index], points[from], points[to]);
      if (distance > farthestDistance) {
        farthest = index;
        farthestDistance = distance;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([from, farthest], [farthest, to]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

function straightenTrajectory(points: Point[], tolerance = 0.25, breakDistance = 3): Point[] {
  if (points.length <= 2) return points;
  const result: Point[] = [];
  let segmentStart = 0;
  for (let index = 1; index <= points.length; index++) {
    const isBreak = index === points.length ||
      pointDistance(points[index - 1], points[index]) > breakDistance;
    if (!isBreak) continue;
    const simplified = simplifyPolyline(points.slice(segmentStart, index), tolerance);
    if (result.length && simplified.length && pointDistance(result[result.length - 1], simplified[0]) < 0.001) {
      result.push(...simplified.slice(1));
    } else {
      result.push(...simplified);
    }
    segmentStart = index;
  }
  return result;
}

function samplePolyline(points: Point[], progress: number): Point {
  if (points.length <= 1) return points[0];
  const lengths = [0];
  for (let index = 1; index < points.length; index++) {
    lengths.push(lengths[index - 1] + pointDistance(points[index - 1], points[index]));
  }
  const target = Math.max(0, Math.min(1, progress)) * lengths[lengths.length - 1];
  let index = 0;
  while (index < lengths.length - 2 && lengths[index + 1] < target) index++;
  const segmentLength = Math.max(0.0001, lengths[index + 1] - lengths[index]);
  return interpolatePoint(points[index], points[index + 1], (target - lengths[index]) / segmentLength);
}

function reconstructWalkGraph(rawRoute: Point[], mergeRadius = 0.65): { nodes: Point[]; edges: GraphEdge[] } {
  const nodes: Point[] = [];
  const counts: number[] = [];
  const cells = new Map<string, number[]>();
  const sampleNodes: number[] = [];
  const cellKey = (x: number, y: number) => `${x},${y}`;

  for (const sample of rawRoute) {
    const world = sample.world!;
    const cellX = Math.floor(world[0] / mergeRadius);
    const cellY = Math.floor(world[1] / mergeRadius);
    let nearest = -1;
    let nearestDistance = mergeRadius;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const index of cells.get(cellKey(cellX + dx, cellY + dy)) ?? []) {
          const candidate = nodes[index].world!;
          // Intentionally use planar distance: repeated captures of the same
          // walkway are merged even when their estimated height has drifted.
          const distance = Math.hypot(world[0] - candidate[0], world[1] - candidate[1]);
          if (distance < nearestDistance) { nearest = index; nearestDistance = distance; }
        }
      }
    }
    if (nearest < 0) {
      nearest = nodes.length;
      nodes.push({ x: sample.x, y: sample.y, world: [...world] });
      counts.push(1);
      const key = cellKey(cellX, cellY);
      cells.set(key, [...(cells.get(key) ?? []), nearest]);
    } else {
      const count = counts[nearest] + 1;
      const node = nodes[nearest];
      node.x += (sample.x - node.x) / count;
      node.y += (sample.y - node.y) / count;
      node.world = [
        node.world![0] + (world[0] - node.world![0]) / count,
        node.world![1] + (world[1] - node.world![1]) / count,
        node.world![2] + (world[2] - node.world![2]) / count
      ];
      counts[nearest] = count;
    }
    sampleNodes.push(nearest);
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < sampleNodes.length; index++) {
    const from = sampleNodes[index - 1];
    const to = sampleNodes[index];
    if (from === to) continue;
    const key = from < to ? `${from}:${to}` : `${to}:${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([from, to]);
  }
  return { nodes, edges };
}

function normalizeRoute(worldPoints: [number, number, number][]): Point[] {
  const xs = worldPoints.map(point => point[0]);
  const ys = worldPoints.map(point => point[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return worldPoints.map(world => ({
    x: 6 + ((world[0] - minX) / Math.max(0.0001, maxX - minX)) * 88,
    y: 94 - ((world[1] - minY) / Math.max(0.0001, maxY - minY)) * 88,
    world
  }));
}

function smoothRoamHeights(points: Point[], radius = 18, cameraDrop = 0.3): Point[] {
  if (!points.length) return [];
  const prefix = [0];
  for (const point of points) prefix.push(prefix[prefix.length - 1] + point.world![2]);
  return points.map((point, index) => {
    const from = Math.max(0, index - radius);
    const to = Math.min(points.length, index + radius + 1);
    const smoothedZ = (prefix[to] - prefix[from]) / (to - from) - cameraDrop;
    return { ...point, world: [point.world![0], point.world![1], smoothedZ] };
  });
}

function interpolatePoint(from: Point, to: Point, amount: number): Point {
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
    world: from.world && to.world ? [
      from.world[0] + (to.world[0] - from.world[0]) * amount,
      from.world[1] + (to.world[1] - from.world[1]) * amount,
      from.world[2] + (to.world[2] - from.world[2]) * amount
    ] : undefined
  };
}

function nearestPointOnEdge(point: Point, from: Point, to: Point): Point {
  const p = point.world!, a = from.world!, b = to.world!;
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const amount = lengthSquared
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / lengthSquared))
    : 0;
  return interpolatePoint(from, to, amount);
}

function insertTopologyPoint(point: Point, nodes: Point[], edges: GraphEdge[]) {
  let nearestEdgeIndex = 0;
  let insertedPoint = nearestPointOnEdge(point, nodes[edges[0][0]], nodes[edges[0][1]]);
  edges.forEach(([from, to], index) => {
    const candidate = nearestPointOnEdge(point, nodes[from], nodes[to]);
    if (pointDistance(point, candidate) < pointDistance(point, insertedPoint)) {
      insertedPoint = candidate;
      nearestEdgeIndex = index;
    }
  });
  const newNodeIndex = nodes.length;
  const [from, to] = edges[nearestEdgeIndex];
  return {
    point: insertedPoint,
    nodes: [...nodes, insertedPoint],
    edges: edges.flatMap((edge, index) =>
      index === nearestEdgeIndex ? [[from, newNodeIndex], [newNodeIndex, to]] as GraphEdge[] : [edge])
  };
}

async function parseTrajectoryFile(file: File): Promise<Point[]> {
  const text = await file.text();
  if (file.name.toLowerCase().endsWith(".json")) {
    const data = JSON.parse(text);
    const points = Array.isArray(data) ? data : data.points;
    const parsed = points.map((point: { x: number; y: number; z?: number; world?: [number, number, number] }) =>
      point.world ? point : ({ x: point.x, y: point.y, world: [point.x, point.y, point.z ?? 0] })
    );
    if (parsed.length < 2) throw new Error("轨迹中没有足够的有效位姿");
    return parsed;
  }

  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const deviceRows = lines
    .map(line => line.split(",").map(value => Number(value.trim())))
    .filter(row => row.length >= 8 && row.slice(0, 8).every(Number.isFinite));
  if (deviceRows.length >= 2) {
    // Device export: timestamp,x,y,z,qx,qy,qz,qw. Positions already share
    // the scanner's local Cartesian coordinates with the exported PLY.
    return normalizeRoute(deviceRows.map(row => [row[1], row[2], row[3]]));
  }

  const rows = lines.map(line => line.split(/\s+/)).filter(row =>
    row.length >= 8 && row.slice(1, 8).every(value => Number.isFinite(Number(value)))
  );
  const centers: [number, number, number][] = rows.map(row => {
    const [qw, qx, qy, qz] = row.slice(1, 5).map(Number);
    const translation = row.slice(5, 8).map(Number);
    const rotation = [
      [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy)],
      [2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx)],
      [2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)]
    ];
    return [0, 1, 2].map(column =>
      -rotation.reduce((sum, values, rowIndex) => sum + values[column] * translation[rowIndex], 0)
    ) as [number, number, number];
  });
  if (centers.length < 2) {
    throw new Error("无法识别轨迹格式；设备 CSV 应为 timestamp,x,y,z,qx,qy,qz,qw");
  }
  return normalizeRoute(centers);
}

const openProjectDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("gaussnav-projects", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("projects");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function writeLocalProject(key: string, value: unknown) {
  const db = await openProjectDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite");
    transaction.objectStore("projects").put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function readLocalProject(key: string) {
  const db = await openProjectDb();
  const value = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction("projects").objectStore("projects").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

async function createProjectBundle(project: Record<string, unknown>, sceneFile: File) {
  const manifest = new TextEncoder().encode(JSON.stringify({
    ...project,
    sceneFile: undefined,
    sceneName: sceneFile.name,
    sceneType: sceneFile.type
  }));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, manifest.byteLength, true);
  return new Blob(["GAUSSNAV1", header, manifest, sceneFile], { type: "application/x-gaussnav-project" });
}

async function parseProjectBundle(file: File) {
  const header = await file.slice(0, 13).arrayBuffer();
  const headerBytes = new Uint8Array(header);
  if (new TextDecoder().decode(headerBytes.slice(0, 9)) !== "GAUSSNAV1") throw new Error("不是有效的 GaussNav 工程文件");
  const manifestLength = new DataView(header, 9, 4).getUint32(0, true);
  const manifestEnd = 13 + manifestLength;
  const manifest = JSON.parse(await file.slice(13, manifestEnd).text());
  const sceneFile = new File([file.slice(manifestEnd)], manifest.sceneName, { type: manifest.sceneType });
  return { ...manifest, sceneFile };
}

function findRoute(startName: string, endName: string, pois: Poi[], route: Point[], graphEdges: GraphEdge[]): Point[] {
  if (!route.length || !graphEdges.length || pois.length < 2) return [];
  const edges = new Map<number, { to: number; cost: number }[]>(route.map((_, index) => [index, []]));
  for (const [from, to] of graphEdges) {
    if (!route[from] || !route[to]) continue;
    const cost = pointDistance(route[from], route[to]);
    edges.get(from)!.push({ to, cost });
    edges.get(to)!.push({ to: from, cost });
  }

  const startPoi = pois.find(poi => poi.name === startName) ?? pois[0];
  const endPoi = pois.find(poi => poi.name === endName) ?? pois[pois.length - 1];
  const nearestKey = (poi: Point) => route.reduce((best, point, index) =>
    pointDistance(poi, point) < pointDistance(poi, route[best]) ? index : best, 0);
  const startKey = nearestKey(startPoi);
  const endKey = nearestKey(endPoi);
  if (startKey === endKey) return [route[startKey]];

  const open = new Set([startKey]);
  const cameFrom = new Map<number, number>();
  const gScore = new Map<number, number>([[startKey, 0]]);
  const fScore = new Map<number, number>([[startKey, pointDistance(route[startKey], route[endKey])]]);

  while (open.size) {
    const current = [...open].reduce((best, key) => (fScore.get(key) ?? Infinity) < (fScore.get(best) ?? Infinity) ? key : best);
    if (current === endKey) {
      const result = [current];
      while (cameFrom.has(result[0])) result.unshift(cameFrom.get(result[0])!);
      return result.map(key => route[key]);
    }
    open.delete(current);
    for (const edge of edges.get(current) ?? []) {
      const tentative = (gScore.get(current) ?? Infinity) + edge.cost;
      if (tentative >= (gScore.get(edge.to) ?? Infinity)) continue;
      cameFrom.set(edge.to, current);
      gScore.set(edge.to, tentative);
      fScore.set(edge.to, tentative + pointDistance(route[edge.to], route[endKey]));
      open.add(edge.to);
    }
  }
  return [];
}

function RouteCanvas({ progress, selecting, onSelect, start, end, path, cursorRoute, pois, route, graphEdges, cleaned }: { progress: number; selecting: "start" | "end" | null; onSelect: () => void; start: string; end: string; path: Point[]; cursorRoute: Point[]; pois: Poi[]; route: Point[]; graphEdges: GraphEdge[]; cleaned: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(rect.width, rect.height);
    };
    const draw = (w: number, h: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(129,148,184,.08)";
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 36) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y < h; y += 36) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      const px = (p: Point) => ({ x: p.x / 100 * w, y: p.y / 100 * h });
      if (!cleaned) {
        ctx.beginPath();
        route.forEach((p, i) => { const q = px(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
        ctx.strokeStyle = "rgba(114,130,232,.35)";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      graphEdges.forEach(([from, to]) => {
        const a = px(route[from]), b = px(route[to]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = "rgba(185,107,255,.62)"; ctx.lineWidth = 2.5; ctx.stroke();
      });
      route.forEach(p => { const q = px(p); ctx.fillStyle = "#8190ee"; ctx.beginPath(); ctx.arc(q.x, q.y, cleaned ? 2.8 : 2.2, 0, Math.PI * 2); ctx.fill(); });
      pois.forEach(poi => {
        const q = px(poi);
        const selected = poi.name === start || poi.name === end;
        ctx.fillStyle = selected ? (poi.name === start ? "#59e8c5" : "#ff927a") : "rgba(11,23,31,.92)";
        ctx.strokeStyle = selected ? ctx.fillStyle : "rgba(169,187,199,.45)";
        ctx.lineWidth = selected ? 2 : 1;
        ctx.beginPath(); ctx.arc(q.x, q.y, selected ? 7 : 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = selected ? "#eaf3f1" : "rgba(193,207,214,.78)";
        ctx.font = `${selected ? "700" : "500"} ${selected ? 10 : 9}px sans-serif`;
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(poi.name, q.x + 9, q.y - 9);
      });
      ctx.beginPath();
      path.forEach((p, i) => { const q = px(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      const gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, "#59e8c5"); gradient.addColorStop(1, "#8efe8a");
      ctx.strokeStyle = gradient; ctx.lineWidth = 5; ctx.shadowColor = "rgba(89,232,197,.55)"; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0;
      if (cursorRoute.length) {
        const current = samplePolyline(cursorRoute, progress);
        const dot = px(current);
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(dot.x, dot.y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#59e8c5"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(dot.x, dot.y, 10, 0, Math.PI * 2); ctx.stroke();
      }
      const startPoint = pois.find(p => p.name === start) ?? path[0];
      const endPoint = pois.find(p => p.name === end) ?? path[path.length - 1];
      [["起", startPoint, "#59e8c5"], ["终", endPoint, "#ff927a"]].forEach(([label, p, color]) => {
        if (!p) return;
        const q = px(p as Point); ctx.fillStyle = color as string; ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#06111d"; ctx.font = "700 10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label as string, q.x, q.y);
      });
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [progress, start, end, path, cursorRoute, route, graphEdges, cleaned]);

  return <button className={`route-canvas ${selecting ? "is-selecting" : ""}`} onClick={onSelect} aria-label="选择路网节点">
    <canvas ref={canvasRef} />
    {selecting && <span className="canvas-tip">请在路网上选择{selecting === "start" ? "起点" : "终点"}</span>}
  </button>;
}

function PoiSearch({ kind, value, onChoose, onMap, pois }: { kind: "start" | "end"; value: string; onChoose: (poi: Poi) => void; onMap: () => void; pois: Poi[] }) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  useEffect(() => setQuery(value), [value]);
  const results = pois.filter(poi => `${poi.name}${poi.category}${poi.detail}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 5);
  const choose = (poi: Poi) => { setQuery(poi.name); setOpen(false); onChoose(poi); };

  return <div className="poi-field">
    <label>{kind === "start" ? "起点" : "终点"}<button onClick={onMap}>地图选点</button></label>
    <div className={`location ${open ? "focused" : ""}`}>
      <i className={kind} />
      <input
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => { if (e.key === "Enter" && results[0]) choose(results[0]); if (e.key === "Escape") setOpen(false); }}
        placeholder="搜索地点或设施"
        aria-label={`搜索${kind === "start" ? "起点" : "终点"} POI`}
      />
      <span className="search-icon">⌕</span>
    </div>
    {open && <div className="poi-results">
      <div className="result-caption">{query ? `找到 ${results.length} 个地点` : "推荐地点"}</div>
      {(query ? results : pois.slice(0, 5)).map(poi => <button key={poi.name} onMouseDown={() => choose(poi)}>
        <span className="poi-pin">●</span><div><b>{poi.name}</b><small>{poi.category} · {poi.detail}</small></div><em>›</em>
      </button>)}
      {query && results.length === 0 && <p>未找到相关 POI，请尝试其他名称</p>}
    </div>}
  </div>;
}

function Viewer({ playing, progress, path, roamRoute, pois, poiEditing, onAddPoi, route, graphEdges, cleaned, sceneUrl, topologyBuilt, previewRequest, markerRequest }: { playing: boolean; progress: number; path: Point[]; roamRoute: Point[]; pois: Poi[]; poiEditing: boolean; onAddPoi: (point: Point) => void; route: Point[]; graphEdges: GraphEdge[]; cleaned: boolean; sceneUrl: string; topologyBuilt: boolean; previewRequest: number; markerRequest: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pathRef = useRef(path);
  const roamRouteRef = useRef(roamRoute);
  const poisRef = useRef(pois);
  const poiEditingRef = useRef(poiEditing);
  const addPoiRef = useRef(onAddPoi);
  const topologyRef = useRef(topologyBuilt);
  const playingRef = useRef(playing);
  const progressRef = useRef(progress);
  const networkRef = useRef(true);
  const nodesRef = useRef(true);
  const resetRef = useRef<() => void>(() => undefined);
  const enterFirstPersonRef = useRef<() => void>(() => undefined);
  const previewStartRef = useRef<() => void>(() => undefined);
  const captureMarkerRef = useRef<() => void>(() => undefined);
  const applyCropRef = useRef<() => void>(() => undefined);
  const viewModeRef = useRef<"orbit" | "first">("orbit");
  const cropModeRef = useRef<"all" | "route" | "tight">("all");
  const [showNetwork, setShowNetwork] = useState(true);
  const [showNodes, setShowNodes] = useState(true);
  const [viewMode, setViewMode] = useState<"orbit" | "first">("orbit");
  const [cropMode, setCropMode] = useState<"all" | "route" | "tight">("all");
  const [sceneStatus, setSceneStatus] = useState("正在载入真实场景");

  useEffect(() => { pathRef.current = path; }, [path]);
  useEffect(() => { roamRouteRef.current = roamRoute; }, [roamRoute]);
  useEffect(() => { poisRef.current = pois; }, [pois]);
  useEffect(() => { poiEditingRef.current = poiEditing; }, [poiEditing]);
  useEffect(() => { addPoiRef.current = onAddPoi; }, [onAddPoi]);
  useEffect(() => { topologyRef.current = topologyBuilt; }, [topologyBuilt]);
  useEffect(() => {
    playingRef.current = playing;
    if (playing) {
      viewModeRef.current = "first";
      setViewMode("first");
    }
  }, [playing]);
  useEffect(() => { progressRef.current = progress; }, [progress]);
  useEffect(() => { networkRef.current = showNetwork; }, [showNetwork]);
  useEffect(() => { nodesRef.current = showNodes; }, [showNodes]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => {
    if (previewRequest > 0) previewStartRef.current();
  }, [previewRequest]);
  useEffect(() => {
    if (markerRequest > 0) captureMarkerRef.current();
  }, [markerRequest]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    window.__gaussNavStage = "creating-3d-engine";
    const isMobileViewport = window.matchMedia("(max-width: 720px)").matches;
    const app = new pc.Application(canvas, {
      graphicsDeviceOptions: { antialias: !isMobileViewport, alpha: false },
      mouse: new pc.Mouse(canvas),
      touch: new pc.TouchDevice(canvas)
    });
    window.__gaussNavStage = "loading-sog";
    app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, isMobileViewport ? 1 : 3);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    app.scene.ambientLight = new pc.Color(0.7, 0.7, 0.7);
    app.scene.exposure = 1;

    const camera = new pc.Entity("Navigation camera");
    camera.addComponent("camera", {
      clearColor: new pc.Color(0.025, 0.055, 0.07),
      farClip: 2000,
      nearClip: 0.05,
      fov: 58
    });
    app.root.addChild(camera);

    const boundsMin = new pc.Vec3(Infinity, Infinity, Infinity);
    const boundsMax = new pc.Vec3(-Infinity, -Infinity, -Infinity);
    route.forEach(point => {
      boundsMin.x = Math.min(boundsMin.x, point.world![0]);
      boundsMin.y = Math.min(boundsMin.y, point.world![2]);
      boundsMin.z = Math.min(boundsMin.z, -point.world![1]);
      boundsMax.x = Math.max(boundsMax.x, point.world![0]);
      boundsMax.y = Math.max(boundsMax.y, point.world![2]);
      boundsMax.z = Math.max(boundsMax.z, -point.world![1]);
    });
    const initialFocus = new pc.Vec3().lerp(boundsMin, boundsMax, 0.5);
    const focus = initialFocus.clone();
    const routeSpan = Math.max(boundsMax.x - boundsMin.x, boundsMax.z - boundsMin.z);
    const initialDistance = Math.max(55, routeSpan * 0.96);
    const orbit = { yaw: 0.62, pitch: 0.42, distance: initialDistance };
    const firstPerson = {
      position: new pc.Vec3(),
      yaw: 0,
      pitch: 0
    };
    const positionFirstPersonCamera = () => {
      const cp = Math.cos(firstPerson.pitch);
      const direction = new pc.Vec3(
        Math.sin(firstPerson.yaw) * cp,
        Math.sin(firstPerson.pitch),
        Math.cos(firstPerson.yaw) * cp
      );
      camera.setPosition(firstPerson.position);
      camera.lookAt(firstPerson.position.clone().add(direction));
    };
    const positionCamera = () => {
      if (viewModeRef.current === "first") {
        positionFirstPersonCamera();
        return;
      }
      const cp = Math.cos(orbit.pitch);
      camera.setPosition(
        focus.x + orbit.distance * cp * Math.sin(orbit.yaw),
        focus.y + orbit.distance * Math.sin(orbit.pitch),
        focus.z + orbit.distance * cp * Math.cos(orbit.yaw)
      );
      camera.lookAt(focus);
    };
    resetRef.current = () => {
      focus.copy(initialFocus);
      orbit.yaw = 0.62; orbit.pitch = 0.42; orbit.distance = initialDistance;
      positionCamera();
    };
    enterFirstPersonRef.current = () => {
      const anchor = route.reduce((nearest, point) => {
        const scenePoint = new pc.Vec3(point.world![0], point.world![2], -point.world![1]);
        const nearestPoint = new pc.Vec3(nearest.world![0], nearest.world![2], -nearest.world![1]);
        return scenePoint.distance(focus) < nearestPoint.distance(focus) ? point : nearest;
      }, route[0]);
      const anchorIndex = Math.max(0, route.indexOf(anchor));
      const next = route[Math.min(route.length - 1, anchorIndex + 1)];
      // Device poses already represent the captured camera center. Do not add
      // another human-eye-height offset on top of the recorded sensor height.
      const from = new pc.Vec3(anchor.world![0], anchor.world![2], -anchor.world![1]);
      const toward = new pc.Vec3(next.world![0], next.world![2], -next.world![1]);
      firstPerson.position.copy(from);
      firstPerson.yaw = Math.atan2(toward.x - from.x, toward.z - from.z);
      firstPerson.pitch = 0;
      positionFirstPersonCamera();
      canvas.focus();
    };
    previewStartRef.current = () => {
      const previewPath = pathRef.current;
      if (previewPath.length < 2) return;
      const from = toScene(previewPath[0]);
      const toward = toScene(previewPath[1]);
      from.y -= 0.4;
      toward.y -= 0.4;
      firstPerson.position.copy(from);
      firstPerson.yaw = Math.atan2(toward.x - from.x, toward.z - from.z);
      firstPerson.pitch = 0;
      viewModeRef.current = "first";
      setViewMode("first");
      positionFirstPersonCamera();
      canvas.focus();
    };
    captureMarkerRef.current = () => {
      const roam = roamRouteRef.current;
      if (roam.length < 2) return;
      addPoiRef.current({
        ...samplePolyline(roam, progressRef.current),
        view: { yaw: firstPerson.yaw, pitch: firstPerson.pitch }
      });
    };
    positionCamera();

    const splat = new pc.Entity("SZU Gaussian Splat");
    // Source data is Z-up. Rotate both splat and route into PlayCanvas Y-up.
    splat.setEulerAngles(-90, 0, 0);
    app.root.addChild(splat);
    const asset = new pc.Asset("project-scene", "gsplat", { url: sceneUrl });
    app.assets.add(asset);
    const routeMinX = Math.min(...route.map(point => point.world![0]));
    const routeMaxX = Math.max(...route.map(point => point.world![0]));
    const routeMinY = Math.min(...route.map(point => point.world![1]));
    const routeMaxY = Math.max(...route.map(point => point.world![1]));
    applyCropRef.current = () => {
      if (!splat.gsplat) return;
      if (cropModeRef.current === "all") {
        splat.gsplat.setWorkBufferModifier(null);
        return;
      }
      const padding = cropModeRef.current === "tight" ? 4 : 12;
      splat.gsplat.setParameter("cropMin", new Float32Array([routeMinX - padding, routeMinY - padding, -100000]));
      splat.gsplat.setParameter("cropMax", new Float32Array([routeMaxX + padding, routeMaxY + padding, 100000]));
      splat.gsplat.setWorkBufferModifier({
        glsl: `
          uniform vec3 cropMin;
          uniform vec3 cropMax;
          void modifySplatCenter(inout vec3 center) {}
          void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {}
          void modifySplatColor(vec3 center, inout vec4 color) {
            if (center.x < cropMin.x || center.x > cropMax.x || center.y < cropMin.y || center.y > cropMax.y) color.a = 0.0;
          }
        `
      });
    };
    asset.ready(() => {
      window.__gaussNavStage = "rendering-scene";
      const bootError = document.getElementById("boot-error");
      if (bootError) bootError.style.display = "none";
      splat.addComponent("gsplat", { asset });
      splat.gsplat!.lodRangeMin = 0;
      splat.gsplat!.lodRangeMax = 0;
      applyCropRef.current();
      setSceneStatus(`工程场景 · ${Math.round(app.graphicsDevice.maxPixelRatio * 100)}% 像素密度 · 全量高斯`);
    });
    asset.on("progress", (loaded: number, total: number) => {
      if (total > 0) setSceneStatus(`正在解析最高精度场景 ${Math.round(loaded / total * 100)}%`);
    });
    asset.on("error", (error: unknown) => {
      setSceneStatus(`场景加载失败：${error instanceof Error ? error.message : "设备内存或 WebGL 资源不足"}`);
    });
    asset.on("error", () => setSceneStatus("场景载入失败，请刷新重试"));
    app.assets.load(asset);

    const toScene = (point: Point, lift = 0) =>
      new pc.Vec3(point.world![0], point.world![2] + lift, -point.world![1]);
    const routeColor = new pc.Color(0.20, 0.72, 0.95);
    const activeColor = new pc.Color(0.22, 1.0, 0.58);
    const nodeColor = new pc.Color(1.0, 0.73, 0.22);
    const topologyColor = new pc.Color(0.74, 0.42, 1.0);
    const poiColor = new pc.Color(1.0, 0.34, 0.55);
    const drawCrispLine = (from: pc.Vec3, to: pc.Vec3, color: pc.Color) => {
      app.drawLine(from, to, color, false);
    };
    const smoothedLookDirection = new pc.Vec3(0, 0, 1);
    let navigationDirectionReady = false;
    app.on("update", (deltaTime: number) => {
      const active = poiEditingRef.current ? roamRouteRef.current : pathRef.current;
      if (playingRef.current && active.length > 1) {
        const cameraPoint = samplePolyline(active, progressRef.current);
        const activeLength = active.slice(1).reduce((total, point, index) => total + pointDistance(active[index], point), 0);
        const lookPoint = samplePolyline(active, Math.min(1, progressRef.current + 1.6 / Math.max(1, activeLength)));
        const cameraPosition = toScene(cameraPoint);
        const lookAt = toScene(lookPoint);
        cameraPosition.y -= 0.4;
        lookAt.y -= 0.4;
        lookAt.y = cameraPosition.y + Math.max(-0.12, Math.min(0.12, lookAt.y - cameraPosition.y));
        const desiredDirection = lookAt.clone().sub(cameraPosition).normalize();
        const smoothing = 1 - Math.exp(-Math.max(0, deltaTime) * 7);
        if (!navigationDirectionReady) {
          smoothedLookDirection.copy(desiredDirection);
          navigationDirectionReady = true;
        } else {
          smoothedLookDirection.lerp(smoothedLookDirection, desiredDirection, smoothing).normalize();
        }
        const smoothedLookAt = cameraPosition.clone().add(smoothedLookDirection.clone().mulScalar(4));
        firstPerson.position.copy(cameraPosition);
        firstPerson.yaw = Math.atan2(smoothedLookDirection.x, smoothedLookDirection.z);
        firstPerson.pitch = Math.asin(Math.max(-1, Math.min(1, smoothedLookDirection.y)));
        camera.setPosition(cameraPosition);
        camera.lookAt(smoothedLookAt);
      } else {
        navigationDirectionReady = false;
      }
      if (networkRef.current) {
        if (!cleaned) {
          for (let index = 1; index < route.length; index++) {
            drawCrispLine(toScene(route[index - 1], 0.02), toScene(route[index], 0.02), routeColor);
          }
        }
      }
      if (topologyRef.current && networkRef.current) {
        for (const [from, to] of graphEdges) {
          if (route[from] && route[to]) drawCrispLine(toScene(route[from], 0.03), toScene(route[to], 0.03), topologyColor);
        }
      }
      if (!poiEditingRef.current && networkRef.current) for (let index = 1; index < active.length; index++) {
        drawCrispLine(toScene(active[index - 1], 0.05), toScene(active[index], 0.05), activeColor);
      }
      if (nodesRef.current) {
        for (let index = 0; index < route.length; index += 8) {
          const point = toScene(route[index], 0.06);
          const size = 0.28;
          app.drawLine(new pc.Vec3(point.x - size, point.y, point.z), new pc.Vec3(point.x + size, point.y, point.z), nodeColor, false);
          app.drawLine(new pc.Vec3(point.x, point.y, point.z - size), new pc.Vec3(point.x, point.y, point.z + size), nodeColor, false);
        }
      }
      for (const poi of poisRef.current) {
        const base = toScene(poi, 0.06);
        app.drawLine(base, new pc.Vec3(base.x, base.y + 2.2, base.z), poiColor, false);
        app.drawLine(new pc.Vec3(base.x - 0.45, base.y + 2.2, base.z), new pc.Vec3(base.x + 0.45, base.y + 2.2, base.z), poiColor, false);
      }
    });

    let dragging = false;
    let panning = false;
    let previousX = 0;
    let previousY = 0;
    let downX = 0;
    let downY = 0;
    let moved = false;
    const nearestRoutePoint = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      let nearest = route[0];
      let nearestDistance = Infinity;
      for (const point of route) {
        const screen = camera.camera!.worldToScreen(toScene(point));
        const distance = Math.hypot(screen.x - (clientX - rect.left), screen.y - (clientY - rect.top));
        if (screen.z > 0 && distance < nearestDistance) { nearest = point; nearestDistance = distance; }
      }
      return nearest;
    };
    const pointerDown = (event: PointerEvent) => {
      if (playingRef.current) return;
      canvas.focus();
      dragging = true; panning = event.button === 2 || event.shiftKey;
      downX = event.clientX; downY = event.clientY; moved = false;
      previousX = event.clientX; previousY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - previousX;
      const dy = event.clientY - previousY;
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > 4) moved = true;
      if (panning) {
        const scale = orbit.distance * 0.0018;
        const right = new pc.Vec3(Math.cos(orbit.yaw), 0, -Math.sin(orbit.yaw));
        const forward = new pc.Vec3(Math.sin(orbit.yaw), 0, Math.cos(orbit.yaw));
        focus.add(right.mulScalar(-dx * scale));
        focus.add(forward.mulScalar(dy * scale));
      } else if (viewModeRef.current === "first") {
        firstPerson.yaw -= dx * 0.006;
        firstPerson.pitch = Math.max(-1.35, Math.min(1.35, firstPerson.pitch - dy * 0.005));
      } else {
        orbit.yaw -= dx * 0.008;
        orbit.pitch = Math.max(0.08, Math.min(1.45, orbit.pitch + dy * 0.006));
      }
      previousX = event.clientX; previousY = event.clientY;
      positionCamera();
    };
    const pointerUp = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false; panning = false;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (playingRef.current) return;
      if (viewModeRef.current === "first") return;
      orbit.distance = Math.max(5, Math.min(500, orbit.distance * (1 + event.deltaY * 0.001)));
      positionCamera();
    };
    const doubleClick = (event: MouseEvent) => {
      if (poiEditingRef.current) return;
      const nearest = nearestRoutePoint(event.clientX, event.clientY);
      focus.copy(toScene(nearest));
      orbit.distance = Math.max(18, orbit.distance * 0.45);
      positionCamera();
    };
    const keyMove = (event: KeyboardEvent) => {
      if (playingRef.current) return;
      const key = event.key.toLowerCase();
      if (viewModeRef.current === "first") {
        const step = event.shiftKey ? 1.2 : 0.45;
        const forward = new pc.Vec3(Math.sin(firstPerson.yaw), 0, Math.cos(firstPerson.yaw));
        const right = new pc.Vec3(-Math.cos(firstPerson.yaw), 0, Math.sin(firstPerson.yaw));
        if (key === "w") firstPerson.position.add(forward.mulScalar(step));
        else if (key === "s") firstPerson.position.add(forward.mulScalar(-step));
        else if (key === "a") firstPerson.position.add(right.mulScalar(-step));
        else if (key === "d") firstPerson.position.add(right.mulScalar(step));
        else if (key === "q") firstPerson.position.y -= step;
        else if (key === "e") firstPerson.position.y += step;
        else return;
        event.preventDefault();
        positionFirstPersonCamera();
        return;
      }
      const step = Math.max(0.8, orbit.distance * 0.035);
      const right = new pc.Vec3(Math.cos(orbit.yaw), 0, -Math.sin(orbit.yaw));
      const forward = new pc.Vec3(Math.sin(orbit.yaw), 0, Math.cos(orbit.yaw));
      if (key === "w") focus.add(forward.mulScalar(-step));
      else if (key === "s") focus.add(forward.mulScalar(step));
      else if (key === "a") focus.add(right.mulScalar(-step));
      else if (key === "d") focus.add(right.mulScalar(step));
      else if (key === "q") focus.y -= step;
      else if (key === "e") focus.y += step;
      else return;
      event.preventDefault();
      positionCamera();
    };
    const blockContextMenu = (event: MouseEvent) => event.preventDefault();
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("dblclick", doubleClick);
    canvas.addEventListener("keydown", keyMove);
    canvas.addEventListener("contextmenu", blockContextMenu);
    const observer = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      app.resizeCanvas(rect.width, rect.height);
      app.setCanvasResolution(pc.RESOLUTION_AUTO);
    });
    observer.observe(canvas);
    app.start();

    return () => {
      observer.disconnect();
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("dblclick", doubleClick);
      canvas.removeEventListener("keydown", keyMove);
      canvas.removeEventListener("contextmenu", blockContextMenu);
      previewStartRef.current = () => undefined;
      captureMarkerRef.current = () => undefined;
      app.destroy();
    };
  }, [route, graphEdges, cleaned, sceneUrl]);

  return <div className="viewer">
    <canvas tabIndex={0} className={poiEditing ? "poi-editing" : ""} ref={canvasRef} aria-label="叠加真实道路网络的深圳大学 3DGS 场景" />
    <div className="viewer-overlay top"><span className="live-dot" /> {sceneStatus} <b>{playing ? "人眼高度修正 −0.4m · 稳定俯仰导航中" : viewMode === "first" ? "拖动转向 · 左侧按钮记录当前 POI · WASD / Q/E 移动" : poiEditing ? "左键拖动旋转 · 右键平移 · 左侧按钮记录当前 POI" : "左键旋转 · 右键平移 · 滚轮缩放 · WASD · Q/E 升降"}</b></div>
    <div className="viewer-tools">
      <button className={viewMode === "orbit" ? "active" : ""} onClick={() => { viewModeRef.current = "orbit"; setViewMode("orbit"); resetRef.current(); }}>自由观察</button>
      <button className={viewMode === "first" ? "active" : ""} onClick={() => { viewModeRef.current = "first"; setViewMode("first"); enterFirstPersonRef.current(); }}>第一人称</button>
      <button className={cropMode === "all" ? "active" : ""} onClick={() => { cropModeRef.current = "all"; setCropMode("all"); applyCropRef.current(); }}>全景</button>
      <button className={cropMode === "route" ? "active" : ""} onClick={() => { cropModeRef.current = "route"; setCropMode("route"); applyCropRef.current(); }}>沿路线裁剪</button>
      <button className={cropMode === "tight" ? "active" : ""} onClick={() => { cropModeRef.current = "tight"; setCropMode("tight"); applyCropRef.current(); }}>紧凑裁剪</button>
      <button className={showNetwork ? "active" : ""} onClick={() => setShowNetwork(value => !value)}>路网</button>
      <button className={showNodes ? "active" : ""} onClick={() => setShowNodes(value => !value)}>节点</button>
      <button onClick={() => resetRef.current()}>复位</button>
    </div>
    <div className="axis-legend"><span className="x">X</span><span className="y">Z↑</span><span className="z">Y</span></div>
    <div className="viewer-overlay bottom"><span>导航进度</span><div className="mini-progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div><b>{Math.round(progress * 100)}%</b></div>
  </div>;
}

export default function Home() {
  const [projectReady, setProjectReady] = useState(false);
  const [consumerMode, setConsumerMode] = useState(false);
  const [projectName, setProjectName] = useState("未命名导航工程");
  const [sceneFile, setSceneFile] = useState<File | null>(null);
  const [sceneUrl, setSceneUrl] = useState("");
  const [rawRoute, setRawRoute] = useState<Point[]>([]);
  const [route, setRoute] = useState<Point[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [workflow, setWorkflow] = useState<"align" | "clean" | "topology" | "poi" | "navigate">("align");
  const [pois, setPois] = useState<Poi[]>(defaultPois);
  const [draftPois, setDraftPois] = useState<Poi[]>([]);
  const [poiName, setPoiName] = useState("新地点");
  const [pendingPoi, setPendingPoi] = useState<Point | null>(null);
  const [cleaned, setCleaned] = useState(false);
  const [topologyBuilt, setTopologyBuilt] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(.12);
  const [previewRequest, setPreviewRequest] = useState(0);
  const [markerRequest, setMarkerRequest] = useState(0);
  const [selecting, setSelecting] = useState<"start" | "end" | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [fileName, setFileName] = useState("尚未导入轨迹");
  const [notice, setNotice] = useState("请先创建或打开一个本地工程");
  const [sceneConverting, setSceneConverting] = useState(false);
  const [sceneSourceSize, setSceneSourceSize] = useState(0);
  const [straightenTolerance, setStraightenTolerance] = useState(0.25);
  const [publishedScenes, setPublishedScenes] = useState<PublishedScene[]>([]);
  const [publishedSceneLoading, setPublishedSceneLoading] = useState("");
  const path = useMemo(() => start && end ? findRoute(start, end, pois, route, graphEdges) : [], [start, end, pois, route, graphEdges]);
  const distance = useMemo(() => Math.round(path.slice(1).reduce((total, point, index) => total + pointDistance(path[index], point), 0)), [path]);
  const roamDistance = useMemo(() => route.slice(1).reduce((total, point, index) => total + pointDistance(route[index], point), 0), [route]);
  const durationSeconds = Math.max(15, Math.round(distance / 1.1));
  const durationLabel = `${Math.floor(durationSeconds / 60)} 分 ${String(durationSeconds % 60).padStart(2, "0")} 秒`;

  useEffect(() => {
    if (!playing) return;
    const activeDistance = workflow === "poi" ? roamDistance : distance;
    const step = (1.1 * 0.08) / Math.max(1, activeDistance);
    const timer = window.setInterval(() => setProgress(p => p >= 1 ? 0 : p + step), 80);
    return () => window.clearInterval(timer);
  }, [playing, workflow, roamDistance, distance]);

  const importTrack = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setNotice(`正在解析 ${file.name}…`);
    try {
      const parsed = await parseTrajectoryFile(file);
      setRawRoute(parsed);
      setRoute(parsed);
      setGraphEdges([]);
      setDraftPois([]);
      setCleaned(false);
      setTopologyBuilt(false);
      setNotice(`已读取 ${file.name}，生成 ${parsed.length.toLocaleString()} 个采样节点`);
    } catch (error) {
      setFileName("轨迹解析失败");
      setRawRoute([]);
      setRoute([]);
      setGraphEdges([]);
      setNotice(error instanceof Error ? error.message : "轨迹文件解析失败");
    }
  };

  const useSceneFile = (file: File) => {
    if (sceneUrl) URL.revokeObjectURL(sceneUrl.split("#")[0]);
    setSceneFile(file);
    setSceneUrl(`${URL.createObjectURL(file)}#${encodeURIComponent(file.name)}`);
  };

  const prepareSceneFile = async (file: File) => {
    setSceneSourceSize(file.size);
    if (isSogFile(file)) {
      useSceneFile(file);
      setNotice(`已读取 SOG 场景 ${file.name}`);
      return file;
    }
    setSceneConverting(true);
    setNotice(`正在本机将 ${file.name} 转换为 SOG，请保持页面打开…`);
    try {
      const sog = await convertPlyToSog(file);
      useSceneFile(sog);
      const ratio = Math.round((1 - sog.size / file.size) * 100);
      setNotice(`SOG 转换完成：${formatBytes(file.size)} → ${formatBytes(sog.size)}（缩小 ${Math.max(0, ratio)}%）`);
      return sog;
    } finally {
      setSceneConverting(false);
    }
  };

  const importScene = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await prepareSceneFile(file);
    } catch (error) {
      setSceneFile(null);
      setSceneUrl("");
      setNotice(error instanceof Error ? `场景转换失败：${error.message}` : "场景转换失败");
    } finally {
      e.target.value = "";
    }
  };

  const downloadSog = () => {
    if (!sceneFile || !isSogFile(sceneFile)) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(sceneFile);
    link.download = sceneFile.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  };

  const chooseNode = () => {
    if (selecting === "start") { setStart("访客中心"); setProgress(0); setNotice("已实时生成：访客中心出发的新路线"); }
    if (selecting === "end") { setEnd("图书馆东门"); setProgress(0); setNotice("已实时生成：前往图书馆东门的新路线"); }
    setSelecting(null);
  };

  const choosePoi = (kind: "start" | "end", poi: Poi) => {
    if (kind === "start") setStart(poi.name);
    else setEnd(poi.name);
    setProgress(0);
    setNotice(`已实时生成：${kind === "start" ? "从" : "前往"} ${poi.name} 的最短路线`);
  };

  const cleanTrajectory = () => {
    if (rawRoute.length < 2) return;
    const heightSmoothedRoute = smoothRoamHeights(rawRoute, 18, 0);
    const straightenedRoute = straightenTrajectory(heightSmoothedRoute, straightenTolerance);
    const graph = reconstructWalkGraph(straightenedRoute);
    setRoute(graph.nodes);
    setGraphEdges(graph.edges);
    setCleaned(true);
    setTopologyBuilt(false);
    setNotice(`轨迹拉直与重复线路融合完成：${rawRoute.length.toLocaleString()} 个位姿经 Douglas–Peucker 简化为 ${straightenedRoute.length.toLocaleString()} 个，再融合为 ${graph.nodes.length.toLocaleString()} 个拓扑节点`);
  };

  const addPoi = (point: Point) => {
    if (!topologyBuilt || !graphEdges.length) {
      setNotice("请先完成拓扑重构，再沿拓扑线路标记 POI");
      return;
    }
    const projected = graphEdges.reduce((best, [from, to]) => {
      const candidate = nearestPointOnEdge(point, route[from], route[to]);
      return pointDistance(point, candidate) < pointDistance(point, best) ? candidate : best;
    }, nearestPointOnEdge(point, route[graphEdges[0][0]], route[graphEdges[0][1]]));
    setPendingPoi({ ...projected, view: point.view });
    setPoiName(`地点 ${pois.length + 1}`);
  };

  const confirmPoi = () => {
    if (!pendingPoi) return;
    const name = poiName.trim() || `POI ${pois.length + 1}`;
    const nextPoi: Poi = { ...pendingPoi, name, category: "场景标记", detail: "待批量写入拓扑" };
    setPois(current => [...current.filter(poi => poi.name !== name), nextPoi]);
    setDraftPois(current => [...current.filter(poi => poi.name !== name), nextPoi]);
    setPendingPoi(null);
    setNotice(`${name} 已暂存；完成全部标记后再统一更新拓扑`);
  };

  const finishPoiMarking = () => {
    if (!draftPois.length) {
      setNotice("当前没有待写入的 POI 标记");
      return;
    }
    let nextNodes = route;
    let nextEdges = graphEdges;
    const finalized = new Map<string, Poi>();
    for (const poi of draftPois) {
      const result = insertTopologyPoint(poi, nextNodes, nextEdges);
      nextNodes = result.nodes;
      nextEdges = result.edges;
      finalized.set(poi.name, { ...result.point, view: poi.view, name: poi.name, category: "场景标记", detail: "拓扑内新增节点" });
    }
    setRoute(nextNodes);
    setGraphEdges(nextEdges);
    setPois(current => current.map(poi => finalized.get(poi.name) ?? poi));
    setDraftPois([]);
    setPlaying(false);
    setWorkflow("navigate");
    setNotice(`POI 标记完成：已批量新增 ${finalized.size} 个拓扑节点并重构道路边`);
  };

  const saveProject = async () => {
    if (!sceneFile) return;
    const project = {
      projectName, rawRoute, route, graphEdges, cleaned, topologyBuilt, pois, start, end,
      savedAt: new Date().toISOString()
    };
    setNotice("正在打包场景与工程数据…");
    const bundle = await createProjectBundle(project, sceneFile);
    const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker;
    if (picker) {
      const handle = await picker({ suggestedName: `${projectName}.gaussnav`, types: [{ description: "GaussNav 工程", accept: { "application/x-gaussnav-project": [".gaussnav"] } }] });
      const writable = await handle.createWritable();
      await writable.write(bundle);
      await writable.close();
    } else {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(bundle);
      link.download = `${projectName}.gaussnav`;
      link.click();
      URL.revokeObjectURL(link.href);
    }
    await writeLocalProject("last-project", { ...project, sceneFile });
    setNotice("工程已保存到你选择的位置");
  };

  const restoreProject = async (stored: {
      projectName: string; sceneFile?: File; rawRoute?: Point[]; route: Point[]; graphEdges?: GraphEdge[]; cleaned?: boolean; topologyBuilt?: boolean; pois: Poi[]; start: string; end: string;
    }, publishedSogUrl?: string) => {
    const normalizedScene = stored.sceneFile ? await prepareSceneFile(stored.sceneFile) : null;
    if (!normalizedScene && !publishedSogUrl) throw new Error("工程缺少场景文件");
    setProjectName(stored.projectName);
    setSceneFile(normalizedScene);
    if (publishedSogUrl) setSceneUrl(publishedSogUrl);
    setRawRoute(stored.rawRoute ?? stored.route);
    setRoute(stored.route);
    setGraphEdges(stored.graphEdges ?? []);
    setCleaned(stored.cleaned ?? false);
    setTopologyBuilt(stored.topologyBuilt ?? false);
    setPois(stored.pois);
    setDraftPois([]);
    setStart(stored.start);
    setEnd(stored.end);
    setFileName("工程内轨迹");
    setProjectReady(true);
    setWorkflow("navigate");
    setNotice("工程已打开");
  };

  const openPublishedScene = async (scene: PublishedScene) => {
    setPublishedSceneLoading(scene.slug);
    try {
      window.__gaussNavStage = "downloading-scene";
      if (scene.manifestUrl && scene.sogUrl) {
        const response = await fetch(`${import.meta.env.BASE_URL}${scene.manifestUrl}`);
        if (!response.ok) throw new Error(`场景清单下载失败（${response.status}）`);
        window.__gaussNavStage = "parsing-project";
        await restoreProject(
          await response.json(),
          `${import.meta.env.BASE_URL}${scene.sogUrl}`,
        );
        window.__gaussNavStage = "opening-viewer";
        setConsumerMode(true);
        setWorkflow("navigate");
        window.history.replaceState(null, "", `${window.location.pathname}?scene=${encodeURIComponent(scene.slug)}`);
        setNotice(`已打开公开场景：${scene.title}`);
        return;
      }
      const projectPaths = scene.projectParts?.length ? scene.projectParts : scene.projectUrl ? [scene.projectUrl] : [];
      if (!projectPaths.length) throw new Error("场景清单缺少工程文件");
      const responses = await Promise.all(projectPaths.map(path => fetch(`${import.meta.env.BASE_URL}${path}`)));
      const failed = responses.find(response => !response.ok);
      if (failed) throw new Error(`场景下载失败（${failed.status}）`);
      const blob = new Blob(await Promise.all(responses.map(response => response.blob())));
      const projectFile = new File([blob], `${scene.slug}.gaussnav`, { type: "application/x-gaussnav-project" });
      window.__gaussNavStage = "parsing-project";
      await restoreProject(await parseProjectBundle(projectFile));
      window.__gaussNavStage = "opening-viewer";
      setConsumerMode(true);
      setWorkflow("navigate");
      window.history.replaceState(null, "", `${window.location.pathname}?scene=${encodeURIComponent(scene.slug)}`);
      setNotice(`已打开公开场景：${scene.title}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "公开场景打开失败");
    } finally {
      setPublishedSceneLoading("");
    }
  };

  useEffect(() => {
    let active = true;
    fetch(`${import.meta.env.BASE_URL}scenes/index.json`)
      .then(response => response.ok ? response.json() : [])
      .then((scenes: PublishedScene[]) => {
        if (!active) return;
        setPublishedScenes(scenes);
        const slug = new URLSearchParams(window.location.search).get("scene");
        const selected = slug && scenes.find(scene => scene.slug === slug);
        if (selected) void openPublishedScene(selected);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const openRecentProject = async () => {
    const stored = await readLocalProject("last-project") as Parameters<typeof restoreProject>[0] | undefined;
    if (!stored) { setNotice("本机尚未保存 GaussNav 工程"); return; }
    await restoreProject(stored);
  };

  const openProjectFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try { await restoreProject(await parseProjectBundle(file)); }
    catch (error) { setNotice(error instanceof Error ? error.message : "工程文件打开失败"); }
  };

  if (!projectReady) return <main className="blank-project">
    <div className="blank-brand"><span className="brand-mark">N</span><strong>GaussNav</strong><small>本地 3DGS 导航工程</small></div>
    <section className="project-gate">
      <span className="eyebrow">LOCAL-FIRST 3DGS WORKSPACE</span>
      <h1>从一个空白工程开始。</h1>
      <p>场景、轨迹、拓扑与 POI 均保存在你的本机浏览器中，不预置任何地点。</p>
      <label className="project-name">工程名称<input value={projectName} onChange={event => setProjectName(event.target.value)} /></label>
      <div className="project-imports">
        <label className={sceneConverting ? "converting" : ""}><input type="file" accept=".ply,.sog" onChange={importScene} disabled={sceneConverting} /><span>01</span><div><b>{sceneConverting ? "正在转换为 SOG…" : sceneFile?.name ?? "选择 3DGS 场景"}</b><small>导入 PLY 后在本机自动压缩；工程统一保存 SOG</small></div><em>{sceneConverting ? "…" : sceneFile ? "✓" : "＋"}</em></label>
        <label><input type="file" accept=".txt,.json,.csv" onChange={importTrack} /><span>02</span><div><b>{route.length ? fileName : "选择相机轨迹"}</b><small>支持设备 CSV（时间戳/位置/四元数）、COLMAP TXT、JSON</small></div><em>{route.length ? "✓" : "＋"}</em></label>
      </div>
      {sceneFile && isSogFile(sceneFile) && <div className="converter-result">
        <div><b>SOG 数据转换工具</b><small>{sceneSourceSize && sceneSourceSize !== sceneFile.size ? `${formatBytes(sceneSourceSize)} → ${formatBytes(sceneFile.size)}` : `${formatBytes(sceneFile.size)} · 已是 SOG`}</small></div>
        <button onClick={downloadSog}>下载 SOG</button>
      </div>}
      <button className="create-project" disabled={sceneConverting || !sceneFile || route.length < 2} onClick={() => {
        setProjectReady(true); setWorkflow("align"); setNotice("场景与轨迹已载入，请先检查坐标叠加");
      }}>创建工程并进入编辑 <span>→</span></button>
      <label className="open-project"><input type="file" accept=".gaussnav" onChange={openProjectFile} />打开其他 GaussNav 工程</label>
      <button className="open-project" onClick={openRecentProject}>打开最近保存的本地工程</button>
      {publishedScenes.length > 0 && <div className="published-scenes">
        <div className="published-heading"><b>公开场景</b><span>{publishedScenes.length} 个可直接浏览</span></div>
        <div className="published-grid">{publishedScenes.map(scene =>
          <button key={scene.slug} disabled={Boolean(publishedSceneLoading)} onClick={() => void openPublishedScene(scene)}>
            <span className="published-mark">3D</span>
            <div><b>{scene.title}</b><small>{scene.routeNodes.toLocaleString()} 节点 · {scene.poiCount} POI · {formatBytes(scene.size)}</small></div>
            <em>{publishedSceneLoading === scene.slug ? "载入中…" : "打开 →"}</em>
          </button>
        )}</div>
      </div>}
      <small className="local-note">转换完全在本机完成，原始 PLY 不会上传；大型场景转换期间请保持页面打开。</small>
    </section>
  </main>;

  return <main className={consumerMode ? "consumer-shell" : ""}>
    <header>
      <div className="brand"><span className="brand-mark">N</span><div><strong>GaussNav</strong><small>3D 实景导航生成器</small></div></div>
      <nav>{consumerMode
        ? <><button className="active">手机导航版</button><button onClick={() => setConsumerMode(false)}>返回工程编辑</button></>
        : <><button className="active">工作台</button><button onClick={saveProject}>另存工程…</button><label className="nav-file"><input type="file" accept=".gaussnav" onChange={openProjectFile} />打开工程…</label><button onClick={() => { setWorkflow("navigate"); setConsumerMode(true); setNotice("已进入清洁版导航预览；正式微信发布仍需配置 AppID 与云端场景存储"); }}>发布小程序版</button><button onClick={() => setProjectReady(false)}>关闭工程</button></>}
      </nav>
      <div className="status"><span />引擎就绪</div>
    </header>

    <section className="hero">
      <div><span className="eyebrow">3D GAUSSIAN SPLATTING × PATH PLANNING</span><h1>让每一条路线，<em>所见即所得。</em></h1><p>导入真实场景与采集轨迹，智能整理路网，并从任意位置生成第一视角导航。</p></div>
      <div className="hero-stats"><div><b>{route.length.toLocaleString()}</b><span>轨迹节点</span></div><div><b>{pois.length}</b><span>已确认 POI</span></div><div><b>{distance}m</b><span>实时路线</span></div></div>
    </section>

    <section className="workspace">
      <aside className={consumerMode ? "consumer-panel" : ""}>
        <div className="panel-title"><span>01</span><div><b>导航数据生产链</b><small>从原始数据到可搜索 POI</small></div></div>
        <div className="pipeline">
          {[
            ["align", "1", "导入叠加"],
            ["clean", "2", "轨迹清洗"],
            ["topology", "3", "拓扑重构"],
            ["poi", "4", "POI 标记"],
            ["navigate", "5", "规划渲染"]
          ].map(([key, number, label]) => <button key={key} className={workflow === key ? "active" : ""} onClick={() => setWorkflow(key as typeof workflow)}>
            <span>{number}</span><b>{label}</b><i>{key === "clean" ? (cleaned ? "✓" : "") : key === "topology" ? (topologyBuilt ? "✓" : "") : ""}</i>
          </button>)}
        </div>
        <label className="upload">
          <input type="file" accept=".json,.txt,.csv" onChange={importTrack} />
          <span className="upload-icon">＋</span><div><b>替换相机轨迹</b><small>设备 CSV / COLMAP TXT / JSON</small></div>
        </label>
        <div className="file-chip"><span>✓</span><div><b>{sceneFile?.name}</b><small>本地 3DGS 场景 · 最高可用精度</small></div></div>
        <div className="file-chip"><span>✓</span><div><b>{fileName}</b><small>{route.length} 个轨迹节点</small></div></div>

        {workflow === "align" && <div className="edit-box workflow-box"><b>坐标叠加检查</b><p>完整 3DGS、原始相机轨迹和采样节点已在同一世界坐标系显示。先旋转场景检查路线是否贴合道路。</p><button onClick={() => { setWorkflow("clean"); setNotice("叠加关系已确认，进入轨迹清洗"); }}>确认对齐并继续</button></div>}

        {workflow === "clean" && <div className="edit-box workflow-box"><b>高度平滑、轨迹拉直与线路融合</b><p>先平滑 Pose 高度，再用 Douglas–Peucker 去除左右采集抖动，最后按平面位置融合重复道路；采集批次断点不会被错误连接。</p><label className="straighten-control">轨迹拉直强度<select value={straightenTolerance} onChange={event => setStraightenTolerance(Number(event.target.value))}><option value={0.15}>保守 · 0.15 m</option><option value={0.25}>标准 · 0.25 m</option><option value={0.4}>强力 · 0.40 m</option></select></label><div className="metric-row"><span>原始 {rawRoute.length}</span><span>唯一节点 {cleaned ? route.length : "—"}</span></div><button onClick={cleanTrajectory}>平滑、拉直并融合轨迹</button></div>}

        {workflow === "topology" && <div className="edit-box workflow-box"><b>真实行走拓扑</b><p>只根据 Pose 原有前后顺序连接清洗后的节点，不再按空间距离猜测或添加捷径。</p><div className="metric-row"><span>{route.length} 节点</span><span>{topologyBuilt ? `${graphEdges.length} 条真实边` : "待生成"}</span></div><button disabled={!cleaned} onClick={() => { setTopologyBuilt(true); setNotice(`导航拓扑已生成：${route.length.toLocaleString()} 个唯一节点、${graphEdges.length.toLocaleString()} 条真实行走边`); }}>生成可导航拓扑</button></div>}

        {workflow === "poi" && <div className="edit-box workflow-box poi-editor"><b>沿拓扑线路漫游标记 POI</b><p>漫游到目标地点后可暂停并左右观察。点击“添加当前标记点”会记录当前的位置和视角，再填写语义标签；无需点击场景。</p><button disabled={!topologyBuilt} onClick={() => setPlaying(value => !value)}>{playing ? "暂停漫游并观察" : topologyBuilt ? "沿拓扑线路开始漫游" : "请先完成拓扑重构"}</button><button disabled={!topologyBuilt} onClick={() => { setPlaying(false); setMarkerRequest(value => value + 1); }}>＋ 添加当前标记点</button><button disabled={!draftPois.length} onClick={finishPoiMarking}>完成标记并更新拓扑</button><div className="poi-count"><span>{draftPois.length}</span> 个 POI 待写入</div><div className="poi-list">{pois.slice(-4).map(poi => <div key={poi.name}><span>●</span><b>{poi.name}</b><button onClick={() => { setPois(current => current.filter(item => item.name !== poi.name)); setDraftPois(current => current.filter(item => item.name !== poi.name)); }}>×</button></div>)}</div></div>}

        {workflow === "navigate" && <div className="location-form">
          <PoiSearch pois={pois} kind="start" value={start} onChoose={poi => choosePoi("start", poi)} onMap={() => setSelecting("start")} />
          <button className="swap" onClick={() => { setStart(end); setEnd(start); setProgress(0); setNotice("起终点已互换，路线已实时更新"); }} aria-label="互换起点和终点">⇅</button>
          <PoiSearch pois={pois} kind="end" value={end} onChoose={poi => choosePoi("end", poi)} onMap={() => setSelecting("end")} />
          <button className="primary" onClick={() => {
            setPlaying(false);
            setProgress(0);
            setPreviewRequest(value => value + 1);
            setNotice(`已定位到起点，可左右拖动确认场景；路线 ${distance} 米，预计 ${durationLabel}`);
          }}>刷新并预览起点 <span>→</span></button>
        </div>}
        <div className="notice"><span>i</span>{notice}</div>
      </aside>

      <section className="stage">
        <div className="stage-head"><div><span className="live-dot" /><b>3DGS 场景数据工作台</b><small>轨迹、拓扑与 POI 同场编辑</small></div><div><span className="route-live">{workflow === "poi" ? "POI：只标记、不规划" : topologyBuilt ? "拓扑图已生成" : cleaned ? "清洗轨迹" : "原始密集轨迹"}</span><span>{workflow === "poi" ? "批量模式" : "路径算法"}</span><b>{workflow === "poi" ? `${draftPois.length} 个待写入` : "A* 最短路径"}</b><button>•••</button></div></div>
        <div className="viewer-stack">
          <Viewer playing={playing} progress={progress} path={path} roamRoute={route} pois={pois} poiEditing={workflow === "poi"} onAddPoi={addPoi} route={route} graphEdges={graphEdges} cleaned={cleaned} sceneUrl={sceneUrl} topologyBuilt={topologyBuilt} previewRequest={previewRequest} markerRequest={markerRequest} />
          <div className="route-inset">
            <div className="inset-head"><span><i />二维路线</span><b>{workflow === "poi" ? `${draftPois.length} POI` : `${distance} m`}</b></div>
            <RouteCanvas progress={progress} selecting={selecting} onSelect={chooseNode} start={start} end={end} path={workflow === "poi" ? [] : path} cursorRoute={workflow === "poi" ? route : path} pois={pois} route={route} graphEdges={topologyBuilt ? graphEdges : []} cleaned={cleaned} />
          </div>
          {pendingPoi && <div className="poi-confirm">
            <span>当前视角位置将暂存为 POI</span>
            <b>填写 POI 语义标签</b>
            <label>语义标签<input autoFocus value={poiName} placeholder="例如：北门、电梯厅、实验室" onChange={event => setPoiName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") confirmPoi(); }} /></label>
            <small>已记录当前空间位置与观察视角；完成全部标记时统一更新拓扑。</small>
            <div><button onClick={() => setPendingPoi(null)}>取消</button><button className="confirm" onClick={confirmPoi}>确认添加</button></div>
          </div>}
        </div>
        {workflow === "poi"
          ? <div className="route-summary"><span className="route-icon">●</span><div><b>POI 批量标记中</b><small>二维路线只显示拓扑、当前位置和地点标记</small></div><strong>{draftPois.length} 个</strong></div>
          : <div className="route-summary"><span className="route-icon">↗</span><div><b>{start} → {end}</b><small>预计 {durationLabel} · 途经 {path.length} 个节点</small></div><strong>{distance} m</strong></div>}
        <div className="stage-controls">
          <div className="controls">
            <button onClick={() => setProgress(Math.max(0, progress - .08))}>↶</button>
            <button className="play" onClick={() => setPlaying(p => !p)}>{playing ? "Ⅱ" : "▶"}</button>
            <button onClick={() => setProgress(Math.min(1, progress + .08))}>↷</button>
            <div className="timeline"><i style={{ width: `${progress * 100}%` }} /></div>
            <span>{Math.floor(progress * durationSeconds / 60)}:{String(Math.round(progress * durationSeconds) % 60).padStart(2, "0")} / {Math.floor(durationSeconds / 60)}:{String(durationSeconds % 60).padStart(2, "0")}</span>
          </div>
          <div className="export-row"><button onClick={() => setNotice("导航相机轨迹 JSON 已准备导出")}>导出相机轨迹</button><button className="export" onClick={() => setNotice("视频生成任务已创建")}>生成导航视频</button></div>
        </div>
      </section>
    </section>

    <footer><span>GAUSSNAV MVP · PLAYCANVAS READY</span><span>场景坐标系：World / Cartesian　·　自动保存</span></footer>
  </main>;
}
