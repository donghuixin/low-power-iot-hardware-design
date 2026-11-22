/*
 * geometry.js — 二维几何工具。
 * 单位毫米；原点在板框左下角，x 向右，y 向上。所有器件旋转为 90° 的整数倍，
 * 因此器件占地都是轴对齐矩形 {x0, y0, x1, y1}。本文件不依赖 DOM，可在 Node 中测试。
 */
(function (LP) {
  'use strict';

  const EPS = 1e-9;

  function rect(x0, y0, x1, y1) {
    return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  }
  function rectFromCenter(cx, cy, w, h) {
    return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
  }
  function width(r) { return r.x1 - r.x0; }
  function height(r) { return r.y1 - r.y0; }
  function area(r) { return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0); }
  function center(r) { return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 }; }
  function expand(r, d) { return { x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d }; }
  /** 按方向分别外扩：s = {E, W, N, S}（毫米）。 */
  function expandSides(r, s) {
    return { x0: r.x0 - (s.W || 0), y0: r.y0 - (s.S || 0), x1: r.x1 + (s.E || 0), y1: r.y1 + (s.N || 0) };
  }
  function union(a, b) {
    if (!a) return b ? { ...b } : null;
    if (!b) return { ...a };
    return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
  }
  function translate(r, dx, dy) { return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy }; }

  /** 两矩形是否重叠（共边不算重叠）。gap > 0 时要求至少相距 gap。 */
  function overlaps(a, b, gap) {
    const g = gap || 0;
    return a.x0 < b.x1 + g - EPS && b.x0 < a.x1 + g - EPS && a.y0 < b.y1 + g - EPS && b.y0 < a.y1 + g - EPS;
  }
  function overlapArea(a, b) {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    return w > 0 && h > 0 ? w * h : 0;
  }
  /** 两矩形之间的最短距离；重叠时为 0。 */
  function rectDist(a, b) {
    const dx = Math.max(0, b.x0 - a.x1, a.x0 - b.x1);
    const dy = Math.max(0, b.y0 - a.y1, a.y0 - b.y1);
    return Math.hypot(dx, dy);
  }
  function pointRectDist(p, r) {
    const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1);
    const dy = Math.max(r.y0 - p.y, 0, p.y - r.y1);
    return Math.hypot(dx, dy);
  }
  function containsPoint(r, p) { return p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1; }
  function containsRect(outer, inner) {
    return inner.x0 >= outer.x0 - EPS && inner.y0 >= outer.y0 - EPS && inner.x1 <= outer.x1 + EPS && inner.y1 <= outer.y1 + EPS;
  }
  function corners(r) {
    return [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
  }
  function manhattan(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function orient(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
  /** 线段是否真正相交（端点接触、共线重叠不计）。用于统计飞线交叉。 */
  function segIntersect(p1, p2, p3, p4) {
    const d1 = orient(p3, p4, p1), d2 = orient(p3, p4, p2);
    const d3 = orient(p1, p2, p3), d4 = orient(p1, p2, p4);
    const tol = 1e-7;
    return ((d1 > tol && d2 < -tol) || (d1 < -tol && d2 > tol)) &&
           ((d3 > tol && d4 < -tol) || (d3 < -tol && d4 > tol));
  }
  function segIntersectionPoint(p1, p2, p3, p4) {
    const den = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
    if (Math.abs(den) < EPS) return null;
    const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / den;
    return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
  }
  function pointSegDist(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const L2 = vx * vx + vy * vy;
    let t = L2 > EPS ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
  }
  /** 线段是否穿过矩形内部。 */
  function segIntersectsRect(a, b, r) {
    if (containsPoint(r, a) || containsPoint(r, b)) return true;
    const c = corners(r);
    for (let i = 0; i < 4; i++) if (segIntersect(a, b, c[i], c[(i + 1) % 4])) return true;
    return false;
  }

  // ---------- 板框 ----------
  const polyCache = new Map();
  /** 把板框描述转为多边形顶点（逆时针）。outline: {type:'rect',w,h,corner_r} | {type:'circle',d} | {type:'polygon',points:[[x,y],...]} */
  function outlinePolygon(o) {
    const key = JSON.stringify(o);
    if (polyCache.has(key)) return polyCache.get(key);
    let pts = [];
    if (o.type === 'circle') {
      const r = o.d / 2;
      for (let i = 0; i < 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        pts.push({ x: r + r * Math.cos(a), y: r + r * Math.sin(a) });
      }
    } else if (o.type === 'polygon') {
      pts = o.points.map(([x, y]) => ({ x, y }));
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        s += a.x * b.y - b.x * a.y;
      }
      if (s < 0) pts.reverse();
    } else {
      const w = o.w, h = o.h;
      const r = Math.max(0, Math.min(o.corner_r || 0, w / 2, h / 2));
      if (r < 0.01) {
        pts = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
      } else {
        const arcs = [[w - r, r, -90], [w - r, h - r, 0], [r, h - r, 90], [r, r, 180]];
        for (const [cx, cy, start] of arcs) {
          for (let i = 0; i <= 8; i++) {
            const a = ((start + (i / 8) * 90) * Math.PI) / 180;
            pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
          }
        }
      }
    }
    if (polyCache.size > 64) polyCache.clear();
    polyCache.set(key, pts);
    return pts;
  }
  function outlineBBox(o) {
    if (o.type === 'circle') return { x0: 0, y0: 0, x1: o.d, y1: o.d };
    if (o.type === 'polygon') {
      const p = outlinePolygon(o);
      return p.reduce((b, q) => ({ x0: Math.min(b.x0, q.x), y0: Math.min(b.y0, q.y), x1: Math.max(b.x1, q.x), y1: Math.max(b.y1, q.y) }),
        { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    }
    return { x0: 0, y0: 0, x1: o.w, y1: o.h };
  }
  function outlineArea(o) {
    const p = outlinePolygon(o);
    let s = 0;
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y; }
    return Math.abs(s) / 2;
  }
  function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  function pointInBoard(o, p) { return pointInPolygon(p, outlinePolygon(o)); }
  /** 点到板框边界的距离（不带符号）。 */
  function distToBoardEdge(o, p) {
    const poly = outlinePolygon(o);
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) d = Math.min(d, pointSegDist(p, poly[i], poly[(i + 1) % poly.length]));
    return d;
  }
  /** 矩形是否完全位于板框内。 */
  function rectInBoard(o, r) {
    const poly = outlinePolygon(o);
    for (const c of corners(r)) if (!pointInPolygon(c, poly)) return false;
    if (o.type === 'polygon') {
      const inner = expand(r, -1e-6);
      const c = corners(r);
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if (containsPoint(inner, a) && a.x > inner.x0 && a.x < inner.x1 && a.y > inner.y0 && a.y < inner.y1) return false;
        for (let k = 0; k < 4; k++) if (segIntersect(a, b, c[k], c[(k + 1) % 4])) return false;
      }
    }
    return true;
  }
  /** 板内矩形到板边的最短距离；矩形越出板框时返回 0。 */
  function rectEdgeDistance(o, r) {
    if (!rectInBoard(o, r)) return 0;
    let d = Infinity;
    for (const c of corners(r)) d = Math.min(d, distToBoardEdge(o, c));
    if (o.type === 'polygon') for (const v of outlinePolygon(o)) d = Math.min(d, pointRectDist(v, r));
    return d;
  }
  /** 矩形某一侧外移 off 毫米后的中点是否落在板外——用来判断"开口朝外、贴板边"。 */
  function faceOutside(o, r, side, off) {
    const c = center(r);
    const p = side === 'N' ? { x: c.x, y: r.y1 + off } : side === 'S' ? { x: c.x, y: r.y0 - off }
      : side === 'E' ? { x: r.x1 + off, y: c.y } : { x: r.x0 - off, y: c.y };
    return !pointInBoard(o, p);
  }

  LP.geometry = {
    EPS, rect, rectFromCenter, width, height, area, center, expand, expandSides, union, translate,
    overlaps, overlapArea, rectDist, pointRectDist, containsPoint, containsRect, corners, manhattan, dist,
    segIntersect, segIntersectionPoint, pointSegDist, segIntersectsRect,
    outlinePolygon, outlineBBox, outlineArea, pointInPolygon, pointInBoard, distToBoardEdge,
    rectInBoard, rectEdgeDistance, faceOutside,
  };
})(globalThis.LP = globalThis.LP || {});
