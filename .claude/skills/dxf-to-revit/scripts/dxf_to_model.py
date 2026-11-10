#!/usr/bin/env python3
"""
dxf_to_model.py  -  Step 2 of the DXF -> Revit pipeline.

Turns 2D CAD plans into a clean building model (model.json, metres) that the
Revit script (revit_build_from_model.py) and the IFC writer (model_to_ifc.py)
both consume.  It also writes a QA/quantity report and an SVG preview so the
interpretation can be checked before anything is built in Revit.

What it recognises
  walls     : pairs of parallel face lines  -> centreline + thickness
              (or single centrelines on 'wall_centerline_layers')
  openings  : door / window blocks, door swing arcs, window lines in wall gaps
              -> wall gaps are healed and the opening is hosted in the wall
  columns   : closed polylines, 4-line rectangles, circles, column blocks
  grids     : long lines on grid layers + bubble text / attributes
  rooms     : enclosed areas between walls, named by room text
  slabs     : closed polylines on slab layers, or the building outline

Usage:
    python dxf_to_model.py project.json -o out_dir
"""
import argparse
import copy
import csv
import fnmatch
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict

try:
    import ezdxf
    from ezdxf import bbox as ezbbox
    from ezdxf.math import Vec3
except ImportError:  # pragma: no cover
    sys.exit("ezdxf is required:  pip install ezdxf shapely")
try:
    from shapely.geometry import LineString, Point, Polygon, MultiPolygon, box as sbox
    from shapely.ops import polygonize, unary_union
    from shapely import affinity
except ImportError:  # pragma: no cover
    sys.exit("shapely is required:  pip install shapely")

UNIT_TO_M = {"mm": 0.001, "cm": 0.01, "m": 1.0, "in": 0.0254, "ft": 0.3048}
INSUNITS = {1: "in", 2: "ft", 4: "mm", 5: "cm", 6: "m"}
ANG_TOL = math.radians(1.0)
SKIP_TYPES = {"HATCH", "DIMENSION", "SOLID", "VIEWPORT", "IMAGE", "WIPEOUT", "LEADER", "MULTILEADER", "ATTDEF"}


# --------------------------------------------------------------------------- #
# small 2D vector helpers (tuples, metres)
# --------------------------------------------------------------------------- #
def sub(a, b): return (a[0] - b[0], a[1] - b[1])
def add(a, b): return (a[0] + b[0], a[1] + b[1])
def mul(a, s): return (a[0] * s, a[1] * s)
def dot(a, b): return a[0] * b[0] + a[1] * b[1]
def cross(a, b): return a[0] * b[1] - a[1] * b[0]
def norm(a): return math.hypot(a[0], a[1])
def unit(a):
    n = norm(a)
    return (a[0] / n, a[1] / n) if n > 1e-12 else (0.0, 0.0)
def perp(a): return (-a[1], a[0])
def r3(v): return round(v, 4)
def pt(p): return [r3(p[0]), r3(p[1])]


def ang_diff(a, b):
    d = abs(a - b) % math.pi
    return min(d, math.pi - d)


class Seg(object):
    __slots__ = ("p1", "p2", "d", "L", "ang", "layer", "id")

    def __init__(self, p1, p2, layer="", sid=0):
        self.p1, self.p2, self.layer, self.id = p1, p2, layer, sid
        v = sub(p2, p1)
        self.L = norm(v)
        self.d = unit(v)
        self.ang = math.atan2(v[1], v[0]) % math.pi


def line_intersection(p, r, q, s):
    """p + t r  ==  q + u s   -> (t, u) or None"""
    rxs = cross(r, s)
    if abs(rxs) < 1e-9:
        return None
    qp = sub(q, p)
    return cross(qp, s) / rxs, cross(qp, r) / rxs


# --------------------------------------------------------------------------- #
# DXF reading
# --------------------------------------------------------------------------- #
class Collector(object):
    """Walks model space (and nested blocks) and sorts raw geometry by role."""

    def __init__(self, doc, cfg, scale, log):
        self.doc, self.cfg, self.s, self.log = doc, cfg, scale, log
        L = cfg.get("layers", {})
        self.layer_role = {}
        for role in ("walls", "columns", "doors", "windows", "grids", "rooms", "slabs"):
            for name in L.get(role, []):
                self.layer_role.setdefault(name.lower(), role)
        for name in cfg.get("wall_centerline_layers", []):
            self.layer_role[name.lower()] = "wall_cl"
        self.block_pats = {k: [p.lower() for p in v] for k, v in cfg.get("blocks", {}).items()}
        self.wall_segs, self.cl_segs, self.col_segs, self.grid_segs = [], [], [], []
        self.col_polys, self.col_circles, self.col_inserts = [], [], []
        self.door_inserts, self.window_inserts = [], []
        self.door_arcs, self.window_marks = [], []
        self.texts = defaultdict(list)          # role -> [(text, (x, y))]
        self.slab_polys = []
        self.curved_wall_count = 0

    # -- helpers ---------------------------------------------------------
    def P(self, v):
        return (v[0] * self.s, v[1] * self.s)

    def role_of_layer(self, layer):
        return self.layer_role.get(layer.lower())

    def role_of_block(self, name):
        low = name.lower()
        for role in ("doors", "windows", "columns"):
            if any(fnmatch.fnmatch(low, p) for p in self.block_pats.get(role, [])):
                return role
        return None

    def poly_points(self, e):
        """WCS points of an LWPOLYLINE / 2D POLYLINE plus 'has_bulge' flag."""
        ocs = e.ocs()
        if e.dxftype() == "LWPOLYLINE":
            elev = e.dxf.elevation
            raw = [(x, y, b) for x, y, b in e.get_points("xyb")]
            closed = e.closed
        else:
            if not e.is_2d_polyline:
                raw = [(v.dxf.location.x, v.dxf.location.y, 0.0) for v in e.vertices]
                return [self.P(r) for r in raw], e.is_closed, False
            elev = e.dxf.elevation.z
            raw = [(v.dxf.location.x, v.dxf.location.y, v.dxf.bulge) for v in e.vertices]
            closed = e.is_closed
        pts = [self.P(ocs.to_wcs(Vec3(x, y, elev))) for x, y, _ in raw]
        bulges = [b for _, _, b in raw]
        if not closed and len(pts) > 2 and norm(sub(pts[0], pts[-1])) < 1e-6:
            closed, pts, bulges = True, pts[:-1], bulges[:-1]
        has_bulge = any(abs(b) > 1e-6 for b in (bulges if closed else bulges[:-1]))
        return pts, closed, has_bulge, bulges

    def segments_of(self, e):
        t = e.dxftype()
        if t == "LINE":
            return [(self.P(e.dxf.start), self.P(e.dxf.end))], 0
        if t in ("LWPOLYLINE", "POLYLINE"):
            res = self.poly_points(e)
            if len(res) == 3:
                pts, closed, _ = res
                bulges = [0.0] * len(pts)
            else:
                pts, closed, _, bulges = res
            out, curved = [], 0
            n = len(pts)
            rng = range(n) if closed else range(n - 1)
            for i in rng:
                if abs(bulges[i]) > 1e-6:
                    curved += 1
                    continue
                out.append((pts[i], pts[(i + 1) % n]))
            return out, curved
        return [], 0

    # -- main walk -------------------------------------------------------
    def walk(self, entities, inherited_layer=None, depth=0):
        for e in entities:
            t = e.dxftype()
            if t in SKIP_TYPES:
                continue
            layer = e.dxf.layer
            if inherited_layer and layer == "0":
                layer = inherited_layer
            role = self.role_of_layer(layer)
            if t == "INSERT":
                brole = self.role_of_block(e.dxf.name)
                if role in ("doors", "windows", "columns") or brole in ("doors", "windows", "columns"):
                    self.add_insert(e, brole or role)
                    continue
                if role in ("grids", "rooms"):
                    for a in e.attribs:
                        self.add_text(role, a.dxf.text, a.dxf.insert)
                if depth < 6:
                    try:
                        self.walk(e.virtual_entities(), layer, depth + 1)
                    except Exception as ex:  # broken blocks happen
                        self.log("skip block %s: %s" % (e.dxf.name, ex))
                continue
            if role is None:
                continue
            if t in ("TEXT", "MTEXT", "ATTRIB"):
                txt = e.plain_text() if t != "ATTRIB" else e.dxf.text
                if t == "TEXT":
                    ins = e.dxf.align_point if (e.dxf.halign or e.dxf.valign) and e.dxf.hasattr("align_point") else e.dxf.insert
                    ins = e.ocs().to_wcs(ins)
                else:
                    ins = e.dxf.insert
                self.add_text(role, txt, ins)
                continue
            if role in ("walls", "wall_cl", "columns", "grids", "slabs", "windows"):
                if role == "slabs" and t in ("LWPOLYLINE", "POLYLINE"):
                    res = self.poly_points(e)
                    if res[1] and len(res[0]) >= 3:
                        self.slab_polys.append(res[0])
                    continue
                if role == "columns":
                    if t == "CIRCLE":
                        c = self.P(e.ocs().to_wcs(e.dxf.center))
                        self.col_circles.append((c, e.dxf.radius * self.s))
                        continue
                    if t in ("LWPOLYLINE", "POLYLINE"):
                        res = self.poly_points(e)
                        if res[1] and len(res[0]) >= 3:
                            self.col_polys.append(res[0])
                            continue
                segs, curved = self.segments_of(e)
                if role == "walls":
                    self.curved_wall_count += curved
                target = {"walls": self.wall_segs, "wall_cl": self.cl_segs, "columns": self.col_segs,
                          "grids": self.grid_segs, "windows": None}[role]
                if role == "windows":
                    for a, b in segs:
                        self.window_marks.append(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))
                    continue
                for a, b in segs:
                    if norm(sub(b, a)) > 1e-4:
                        target.append(Seg(a, b, layer))
                continue
            if role == "doors" and t == "ARC":
                c = self.P(e.ocs().to_wcs(e.dxf.center))
                self.door_arcs.append((c, e.dxf.radius * self.s))

    def add_text(self, role, txt, ins):
        txt = (txt or "").strip()
        if txt:
            self.texts[role].append((txt, self.P(ins)))

    def add_insert(self, e, role):
        """Store an opening / column block with its rotated world rectangle."""
        corners = None
        try:
            blk = self.doc.blocks.get(e.dxf.name)
            ext = ezbbox.extents([x for x in blk if x.dxftype() not in ("ATTDEF", "TEXT", "MTEXT")], fast=True)
            if ext.has_data:
                m = e.matrix44()
                lo, hi = ext.extmin, ext.extmax
                loc = [Vec3(lo.x, lo.y, 0), Vec3(hi.x, lo.y, 0), Vec3(hi.x, hi.y, 0), Vec3(lo.x, hi.y, 0)]
                corners = [self.P(m.transform(v)) for v in loc]
        except Exception:
            corners = None
        ins = self.P(e.dxf.insert)
        if not corners:
            corners = [ins]
        rec = {"block": e.dxf.name, "insert": ins, "corners": corners,
               "rotation": e.dxf.rotation, "center": centroid(corners)}
        {"doors": self.door_inserts, "windows": self.window_inserts, "columns": self.col_inserts}[role].append(rec)


def centroid(pts):
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


# --------------------------------------------------------------------------- #
# Walls
# --------------------------------------------------------------------------- #
def merge_collinear_segments(segs, tol=0.005):
    """Join overlapping / touching collinear face lines (drafting splits)."""
    groups = defaultdict(list)
    for s in segs:
        groups[round(s.ang / ANG_TOL)].append(s)
    out = []
    for key in sorted(groups):
        # angles near 0 / pi wrap - neighbour buckets are merged by the pair search anyway
        g = groups[key]
        used = [False] * len(g)
        for i, s in enumerate(g):
            if used[i]:
                continue
            used[i] = True
            d = s.d
            base = s.p1
            n = perp(d)
            off = dot(sub(s.p1, base), n)
            lo, hi = sorted((dot(sub(s.p1, base), d), dot(sub(s.p2, base), d)))
            changed = True
            while changed:
                changed = False
                for j, o in enumerate(g):
                    if used[j]:
                        continue
                    if abs(dot(sub(o.p1, base), n) - off) > tol or abs(dot(sub(o.p2, base), n) - off) > tol:
                        continue
                    a, b = sorted((dot(sub(o.p1, base), d), dot(sub(o.p2, base), d)))
                    if a <= hi + tol and b >= lo - tol:
                        lo, hi = min(lo, a), max(hi, b)
                        used[j] = changed = True
            out.append(Seg(add(base, mul(d, lo)), add(base, mul(d, hi)), s.layer))
    for i, s in enumerate(out):
        s.id = i
    return out


def pair_wall_faces(segs, D):
    tmin, tmax = D["wall_min_thickness"], D["wall_max_thickness"]
    cands = []
    order = sorted(range(len(segs)), key=lambda i: segs[i].ang)
    angs = [segs[i].ang for i in order]
    for ii, i in enumerate(order):
        a = segs[i]
        for jj in range(ii + 1, len(order)):
            j = order[jj]
            b = segs[j]
            if angs[jj] - a.ang > ANG_TOL:
                break
            if ang_diff(a.ang, b.ang) > ANG_TOL:
                continue
            cands.extend(_pair_candidate(a, b, tmin, tmax))
        # wrap-around (angles near pi vs near 0)
        if a.ang > math.pi - ANG_TOL:
            for b in segs:
                if b.ang < ANG_TOL - (math.pi - a.ang):
                    cands.extend(_pair_candidate(a, b, tmin, tmax))
    cands.sort(key=lambda c: (round(c[0], 3), -c[4]))
    covered = defaultdict(list)  # seg id -> [(lo, hi)]

    def free(sid, lo, hi):
        need = hi - lo
        used = 0.0
        for a, b in covered[sid]:
            used += max(0.0, min(b, hi) - max(a, lo))
        return used < 0.3 * need

    walls = []
    seen = set()
    for t, a, b, (lo, hi), ov, side, (blo, bhi) in cands:
        key = (min(a.id, b.id), max(a.id, b.id), round(lo, 3))
        if key in seen:
            continue
        seen.add(key)
        if not free(a.id, lo, hi) or not free(b.id, blo, bhi):
            continue
        covered[a.id].append((lo, hi))
        covered[b.id].append((blo, bhi))
        off = mul(perp(a.d), side * t / 2.0)
        p1 = add(add(a.p1, mul(a.d, lo)), off)
        p2 = add(add(a.p1, mul(a.d, hi)), off)
        walls.append({"start": p1, "end": p2, "thickness": t, "faces": [a.id, b.id]})
    used_len = defaultdict(float)
    for sid, ivs in covered.items():
        used_len[sid] = sum(b - a for a, b in ivs)
    unpaired = [s for s in segs if used_len[s.id] < 0.5 * s.L and s.L > tmax + 0.01]
    return walls, unpaired


def _pair_candidate(a, b, tmin, tmax):
    n = perp(a.d)
    d1 = dot(sub(b.p1, a.p1), n)
    d2 = dot(sub(b.p2, a.p1), n)
    if abs(d1 - d2) > 0.01 or d1 * d2 <= 0:
        return []
    t = abs(d1 + d2) / 2.0
    if t < tmin or t > tmax:
        return []
    s1, s2 = sorted((dot(sub(b.p1, a.p1), a.d), dot(sub(b.p2, a.p1), a.d)))
    lo, hi = max(0.0, s1), min(a.L, s2)
    ov = hi - lo
    if ov < max(0.05, 0.25 * min(a.L, b.L)) or ov < t * 0.8:
        return []
    # interval on b (in b's own parameter)
    b_lo = dot(sub(add(a.p1, mul(a.d, lo)), b.p1), b.d)
    b_hi = dot(sub(add(a.p1, mul(a.d, hi)), b.p1), b.d)
    side = 1.0 if d1 > 0 else -1.0
    t = round(t / 0.005) * 0.005  # snap to 5 mm
    return [(t, a, b, (lo, hi), ov, side, tuple(sorted((b_lo, b_hi))))]


def wall_dir(w):
    return unit(sub(w["end"], w["start"]))


def wall_len(w):
    return norm(sub(w["end"], w["start"]))


def opening_projection(rec, w):
    """Project an insert's rectangle onto wall w -> (lo, hi, perp_dist) in wall params."""
    d = wall_dir(w)
    n = perp(d)
    ps = [dot(sub(c, w["start"]), d) for c in rec["corners"]]
    cdist = abs(dot(sub(rec["center"], w["start"]), n))
    return min(ps), max(ps), cdist


def heal_openings(walls, faces, C, D, log):
    """Merge collinear walls of equal thickness across gaps; gaps that hold a
    door/window become hosted openings. Returns (walls, openings)."""
    max_gap = D["max_opening_width"]
    pending = {"door": list(C.door_inserts), "window": list(C.window_inserts)}
    arcs = list(C.door_arcs)
    wmarks = list(C.window_marks)
    openings = []
    changed = True
    while changed:
        changed = False
        for i in range(len(walls)):
            wi = walls[i]
            di = wall_dir(wi)
            ni = perp(di)
            a0, a1 = 0.0, wall_len(wi)
            best = None   # (gap, j, g0, g1) nearest collinear neighbour; gap<0 = overlap
            for j in range(len(walls)):
                if i == j:
                    continue
                wj = walls[j]
                if abs(wi["thickness"] - wj["thickness"]) > 0.006:
                    continue
                dj = wall_dir(wj)
                if ang_diff(math.atan2(di[1], di[0]), math.atan2(dj[1], dj[0])) > ANG_TOL:
                    continue
                if abs(dot(sub(wj["start"], wi["start"]), ni)) > 0.02 or abs(dot(sub(wj["end"], wi["start"]), ni)) > 0.02:
                    continue
                b0, b1 = sorted((dot(sub(wj["start"], wi["start"]), di), dot(sub(wj["end"], wi["start"]), di)))
                if b0 >= a1 - 1e-6:
                    g0, g1 = a1, b0
                elif a0 >= b1 - 1e-6:
                    g0, g1 = b1, a0
                else:
                    g0 = g1 = None                 # overlap
                gap = -1.0 if g0 is None else g1 - g0
                if gap <= max_gap and (best is None or gap < best[0]):
                    best = (gap, j, g0, g1, b0, b1)
            if best is None:
                continue
            gap, j, g0, g1, b0, b1 = best
            if gap > 0.02 and not _face_spans(faces, wi, di, ni, g0, g1):
                kind, src = _find_gap_filler(wi, di, ni, g0, g1, pending, arcs, wmarks)
                if kind is None:
                    continue                       # genuine passage - keep apart
                mid = add(wi["start"], mul(di, (g0 + g1) / 2.0))
                openings.append({"kind": kind, "point": mid, "width": round(gap, 3), "block": src})
            lo, hi = min(a0, b0), max(a1, b1)
            walls[i] = {"start": add(wi["start"], mul(di, lo)), "end": add(wi["start"], mul(di, hi)),
                        "thickness": wi["thickness"], "faces": wi.get("faces", []) + walls[j].get("faces", [])}
            walls.pop(j)
            changed = True
            break
    # inserts in continuous walls (gap not drawn) -> host by nearest wall
    for kind in ("door", "window"):
        for rec in pending[kind]:
            best = None
            for k, w in enumerate(walls):
                lo, hi, dist = opening_projection(rec, w)
                L = wall_len(w)
                c = (lo + hi) / 2.0
                if dist <= w["thickness"] / 2.0 + 0.6 and -0.05 <= c <= L + 0.05:
                    if best is None or dist < best[0]:
                        best = (dist, k, lo, hi)
            if best is None:
                log("%s block '%s' at (%.2f, %.2f) has no host wall - skipped" %
                    (kind, rec["block"], rec["center"][0], rec["center"][1]))
                continue
            _, k, lo, hi = best
            w = walls[k]
            d = wall_dir(w)
            width = hi - lo
            if width < 0.3 or width > max_gap:
                log("%s block '%s' gives odd width %.2f m - default 0.9 used" % (kind, rec["block"], width))
                width = 0.9
            mid = add(w["start"], mul(d, (lo + hi) / 2.0))
            openings.append({"kind": kind, "point": mid, "width": round(width, 3), "block": rec["block"]})
    return walls, openings


def _face_spans(faces, w, d, n, g0, g1):
    """True when a wall face line runs straight across the gap (T-junction,
    one face interrupted by an abutting wall) - i.e. not a real opening."""
    half = w["thickness"] / 2.0
    for f in faces:
        if ang_diff(f.ang, math.atan2(d[1], d[0]) % math.pi) > ANG_TOL:
            continue
        o1 = dot(sub(f.p1, w["start"]), n)
        if abs(abs(o1) - half) > 0.01 or abs(dot(sub(f.p2, w["start"]), n) - o1) > 0.01:
            continue
        s1, s2 = sorted((dot(sub(f.p1, w["start"]), d), dot(sub(f.p2, w["start"]), d)))
        if s1 <= g0 + 0.005 and s2 >= g1 - 0.005:
            return True
    return False


def _find_gap_filler(w, d, n, g0, g1, pending, arcs, wmarks):
    reach = w["thickness"] / 2.0 + 0.15
    for kind in ("door", "window"):
        for rec in pending[kind]:
            c = dot(sub(rec["center"], w["start"]), d)
            dist = abs(dot(sub(rec["center"], w["start"]), n))
            if g0 - 0.1 <= c <= g1 + 0.1 and dist <= reach + (g1 - g0):
                pending[kind].remove(rec)
                return kind, rec["block"]
    for arc in arcs:
        c = dot(sub(arc[0], w["start"]), d)
        dist = abs(dot(sub(arc[0], w["start"]), n))
        if g0 - 0.15 <= c <= g1 + 0.15 and dist <= reach and 0.4 * (g1 - g0) <= arc[1] <= 1.3 * (g1 - g0):
            arcs.remove(arc)
            return "door", "ARC"
    for m in wmarks:
        c = dot(sub(m, w["start"]), d)
        dist = abs(dot(sub(m, w["start"]), n))
        if g0 - 0.01 <= c <= g1 + 0.01 and dist <= reach:
            return "window", "LINES"
    return None, None


def join_wall_ends(walls):
    """Extend / trim wall ends to meet the centreline of the wall they butt into."""
    for _ in range(2):
        for i, w in enumerate(walls):
            for end in ("start", "end"):
                E = w[end]
                other = w["end"] if end == "start" else w["start"]
                u = unit(sub(E, other))          # outward direction
                best = None
                for j, o in enumerate(walls):
                    if i == j:
                        continue
                    od = sub(o["end"], o["start"])
                    oL = norm(od)
                    if oL < 1e-6:
                        continue
                    r = line_intersection(E, u, o["start"], od)
                    if r is None:
                        continue
                    delta, uo = r
                    if ang_diff(math.atan2(u[1], u[0]), math.atan2(od[1], od[0])) < math.radians(10):
                        continue
                    ext_ok = o["thickness"] / 2.0 + w["thickness"] + 0.05
                    if not (-w["thickness"] / 2.0 - 0.01 <= delta <= ext_ok):
                        continue
                    tol_o = (w["thickness"] / 2.0 + 0.05) / oL
                    if not (-tol_o <= uo <= 1 + tol_o):
                        continue
                    if best is None or abs(delta) < abs(best):
                        best = delta
                if best is not None and abs(best) > 1e-4:
                    w[end] = add(E, mul(u, best))
    return walls


def walls_from_centerlines(segs, D):
    return [{"start": s.p1, "end": s.p2, "thickness": D["centerline_wall_thickness"], "faces": []}
            for s in merge_collinear_segments(segs)]


# --------------------------------------------------------------------------- #
# Columns / grids / rooms / slabs
# --------------------------------------------------------------------------- #
def rect_from_polygon(poly):
    mrr = poly.minimum_rotated_rectangle
    xs = list(mrr.exterior.coords)[:4]
    e1 = sub(xs[1], xs[0])
    e2 = sub(xs[2], xs[1])
    w, h = norm(e1), norm(e2)
    ang = math.degrees(math.atan2(e1[1], e1[0]))
    if w < h:
        w, h, ang = h, w, ang + 90.0
    ang = ((ang + 90.0) % 180.0) - 90.0
    c = poly.centroid
    rect_like = poly.area / max(mrr.area, 1e-9) > 0.85
    return (c.x, c.y), w, h, ang, rect_like


def extract_columns(C, D, log):
    lo, hi = D["column_min_size"], D["column_max_size"]
    polys = [Polygon(p) for p in C.col_polys if len(p) >= 3]
    if C.col_segs:
        lines = [LineString([s.p1, s.p2]) for s in C.col_segs]
        polys.extend(polygonize(unary_union(lines)))
    for rec in C.col_inserts:
        if len(rec["corners"]) == 4:
            polys.append(Polygon(rec["corners"]))
    cols = []
    for p in polys:
        if not p.is_valid or p.area <= 0:
            p = p.buffer(0)
            if p.is_empty:
                continue
            if isinstance(p, MultiPolygon):
                p = max(p.geoms, key=lambda g: g.area)
        c, w, h, ang, rect_like = rect_from_polygon(p)
        if not (lo <= h and w <= hi):
            continue
        cols.append({"center": c, "width": round(w, 3), "depth": round(h, 3), "rotation": round(ang, 2),
                     "shape": "rect" if rect_like else "rect"})
    for c, r in C.col_circles:
        if lo <= 2 * r <= hi:
            cols.append({"center": c, "width": round(2 * r, 3), "depth": round(2 * r, 3), "rotation": 0.0, "shape": "round"})
    # de-duplicate (outline + inner hatch boundary etc.) - keep the largest
    cols.sort(key=lambda c: -c["width"] * c["depth"])
    out = []
    for c in cols:
        if any(norm(sub(c["center"], o["center"])) < 0.5 * min(o["width"], o["depth"]) for o in out):
            continue
        out.append(c)
    return out


def extract_grids(C, D):
    segs = [s for s in merge_collinear_segments(C.grid_segs) if s.L >= D["grid_min_length"]]
    texts = C.texts.get("grids", [])
    grids = []
    for s in segs:
        best = None
        for txt, p in texts:
            for e in (s.p1, s.p2):
                dd = norm(sub(p, e))
                if dd < 2.0 and (best is None or dd < best[0]):
                    best = (dd, txt)
        grids.append({"start": s.p1, "end": s.p2, "name": best[1] if best else None})
    # auto names for missing labels: vertical -> 1,2,3 ; horizontal -> A,B,C
    vert = sorted([g for g in grids if abs(unit(sub(g["end"], g["start"]))[1]) > 0.7],
                  key=lambda g: (g["start"][0] + g["end"][0]) / 2)
    horz = sorted([g for g in grids if abs(unit(sub(g["end"], g["start"]))[1]) <= 0.7],
                  key=lambda g: (g["start"][1] + g["end"][1]) / 2)
    for i, g in enumerate(vert):
        g["name"] = g["name"] or str(i + 1)
    letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    for i, g in enumerate(horz):
        g["name"] = g["name"] or (letters[i] if i < len(letters) else "A%d" % i)
    names = Counter()
    for g in grids:
        names[g["name"]] += 1
        if names[g["name"]] > 1:
            g["name"] = "%s.%d" % (g["name"], names[g["name"]])
    return grids


def wall_polygon(w):
    d = wall_dir(w)
    n = mul(perp(d), w["thickness"] / 2.0)
    a, b = w["start"], w["end"]
    return Polygon([add(a, n), add(b, n), sub(b, n), sub(a, n)])


def footprint(walls, columns):
    shapes = [wall_polygon(w).buffer(0.01, join_style=2) for w in walls if wall_len(w) > 1e-3]
    for c in columns:
        shapes.append(col_polygon(c))
    return unary_union(shapes) if shapes else None


def col_polygon(c):
    if c["shape"] == "round":
        return Point(c["center"]).buffer(c["width"] / 2.0, 16)
    r = sbox(-c["width"] / 2, -c["depth"] / 2, c["width"] / 2, c["depth"] / 2)
    r = affinity.rotate(r, c["rotation"], origin=(0, 0))
    return affinity.translate(r, c["center"][0], c["center"][1])


def extract_rooms(fp, C, columns=()):
    if fp is None:
        return []
    obstacles = [col_polygon(c).buffer(0.05) for c in columns]
    polys = [fp] if isinstance(fp, Polygon) else list(fp.geoms)
    holes = []
    for p in polys:
        for ring in p.interiors:
            h = Polygon(ring)
            if h.area > 1.0:
                holes.append(h)
    texts = C.texts.get("rooms", [])
    rooms = []
    for h in holes:
        inside = [t for t in texts if h.contains(Point(t[1]))]
        name, number = None, None
        for txt, _ in inside:
            for line in re.split(r"[\n\r\\P]+", txt):
                line = line.strip()
                if not line or re.search(r"m2|m²|م2|م²|sqm|\d+[.,]\d+\s*$", line.lower()):
                    continue
                if re.fullmatch(r"[A-Za-z]?\d{1,4}[A-Za-z]?", line) and number is None:
                    number = line
                elif name is None:
                    name = line
        rp = h.representative_point()
        at = (rp.x, rp.y)
        for _, tp in inside:
            if not any(col.contains(Point(tp)) for col in obstacles):
                at = tp
                break
        rooms.append({"name": name or "Room", "number": number, "point": at,
                      "boundary": [tuple(c) for c in list(h.exterior.coords)[:-1]],
                      "area": round(h.area, 2), "perimeter": round(h.length, 2)})
    return rooms


def outline_of(fp):
    if fp is None or fp.is_empty:
        return None
    polys = [fp] if isinstance(fp, Polygon) else list(fp.geoms)
    big = max(polys, key=lambda p: p.area)
    ext = Polygon(big.exterior).simplify(0.01)
    return [tuple(c) for c in list(ext.exterior.coords)[:-1]]


# --------------------------------------------------------------------------- #
# per-level extraction
# --------------------------------------------------------------------------- #
def extract_level(dxf_path, cfg, D, log):
    doc = ezdxf.readfile(dxf_path)
    units = cfg.get("project", {}).get("units", "auto")
    if units == "auto":
        units = INSUNITS.get(doc.header.get("$INSUNITS", 0))
        if units is None:
            ext = ezbbox.extents(doc.modelspace(), fast=True)
            units = "mm" if ext.has_data and max(ext.size.x, ext.size.y) > 500 else "m"
            log("$INSUNITS not set - assumed '%s' from drawing size" % units)
    scale = UNIT_TO_M[units]
    C = Collector(doc, cfg, scale, log)
    C.walk(doc.modelspace())
    if C.curved_wall_count:
        log("%d curved wall edges (polyline bulges) ignored - model curved walls manually" % C.curved_wall_count)
    faces = merge_collinear_segments(C.wall_segs)
    walls, unpaired = pair_wall_faces(faces, D)
    walls += walls_from_centerlines(C.cl_segs, D)
    walls, openings = heal_openings(walls, faces, C, D, log)
    walls = join_wall_ends(walls)
    walls = [w for w in walls if wall_len(w) >= D["wall_min_length"]]
    # re-host openings on the final walls
    for o in openings:
        best = None
        for k, w in enumerate(walls):
            d = wall_dir(w)
            c = dot(sub(o["point"], w["start"]), d)
            dist = abs(dot(sub(o["point"], w["start"]), perp(d)))
            if -0.01 <= c <= wall_len(w) + 0.01 and dist < w["thickness"] / 2 + 0.05:
                if best is None or dist < best[0]:
                    best = (dist, k)
        o["wall_index"] = best[1] if best else None
        o.pop("_wall_pair", None)
        o.pop("wall_ref", None)
    columns = extract_columns(C, D, log)
    grids = extract_grids(C, D)
    fp = footprint(walls, columns)
    rooms = extract_rooms(fp, C, columns)
    slabs = [p for p in C.slab_polys]
    if not slabs and D.get("auto_slab", True):
        o = outline_of(fp)
        if o:
            slabs = [o]
    stats = {"units": units, "face_lines": len(faces), "unpaired_lines": len(unpaired),
             "unpaired_length": round(sum(s.L for s in unpaired), 2),
             "door_blocks": len(C.door_inserts), "window_blocks": len(C.window_inserts),
             "room_labels": len(C.texts.get("rooms", []))}
    return {"walls": walls, "openings": openings, "columns": columns, "grids": grids,
            "rooms": rooms, "slabs": slabs, "unpaired": unpaired, "outline": outline_of(fp), "stats": stats}


# --------------------------------------------------------------------------- #
# model assembly
# --------------------------------------------------------------------------- #
def build_model(cfg, log):
    D = cfg["defaults"]
    levels = sorted(cfg["levels"], key=lambda l: l["elevation"])
    model = {"schema": "dxf2revit/1", "project": cfg.get("project", {}),
             "levels": [{"name": l["name"], "elevation": l["elevation"], "height": l.get("height", 0.0)} for l in levels],
             "grids": [], "walls": [], "openings": [], "columns": [], "slabs": [], "rooms": [],
             "issues": [], "stats": {}}
    per_level, previews = {}, {}
    counters = Counter()

    def nid(prefix):
        counters[prefix] += 1
        return "%s%03d" % (prefix, counters[prefix])

    for l in levels:
        if l.get("dxf"):
            msgs = []
            res = extract_level(l["dxf"], cfg, D, lambda m: msgs.append(m))
            for m in msgs:
                log("[%s] %s" % (l["name"], m))
                model["issues"].append({"level": l["name"], "message": m})
            per_level[l["name"]] = res
    for l in levels:
        src = l.get("copy_from")
        if src:
            if src not in per_level:
                raise SystemExit("level '%s' copies unknown level '%s'" % (l["name"], src))
            per_level[l["name"]] = copy.deepcopy(per_level[src])
            per_level[l["name"]]["copied_from"] = src

    seen_grids = []
    for l in levels:
        name = l["name"]
        res = per_level.get(name)
        h = l.get("height", 3.0) or 3.0
        if res:
            model["stats"][name] = res["stats"]
            previews[name] = res
            wall_ids = []
            for w in res["walls"]:
                wid = nid("W")
                wall_ids.append(wid)
                model["walls"].append({"id": wid, "level": name, "start": pt(w["start"]), "end": pt(w["end"]),
                                       "thickness": r3(w["thickness"]), "height": r3(h),
                                       "type_name": "DXF Wall %dmm" % round(w["thickness"] * 1000)})
            for o in res["openings"]:
                if o.get("wall_index") is None:
                    model["issues"].append({"level": name, "message": "%s at %s not on a wall - skipped" % (o["kind"], pt(o["point"]))})
                    continue
                isdoor = o["kind"] == "door"
                hgt = D["door_height"] if isdoor else D["window_height"]
                model["openings"].append({
                    "id": nid("D" if isdoor else "N"), "level": name, "kind": o["kind"],
                    "host": wall_ids[o["wall_index"]], "point": pt(o["point"]), "width": r3(o["width"]),
                    "height": r3(hgt), "sill": 0.0 if isdoor else r3(D["window_sill"]),
                    "type_name": "DXF %s %dx%d" % ("Door" if isdoor else "Window", round(o["width"] * 1000), round(hgt * 1000)),
                    "source_block": o.get("block")})
            for c in res["columns"]:
                model["columns"].append({"id": nid("C"), "level": name, "center": pt(c["center"]),
                                         "width": c["width"], "depth": c["depth"], "rotation": c["rotation"],
                                         "shape": c["shape"], "height": r3(h),
                                         "type_name": ("DXF Col D%d" % round(c["width"] * 1000)) if c["shape"] == "round"
                                         else "DXF Col %dx%d" % (round(c["width"] * 1000), round(c["depth"] * 1000))})
            for s in res["slabs"]:
                model["slabs"].append({"id": nid("S"), "level": name, "boundary": [pt(p) for p in s],
                                       "thickness": D["slab_thickness"],
                                       "area": round(Polygon(s).area, 2)})
            for r in res["rooms"]:
                model["rooms"].append({"id": nid("R"), "level": name, "name": r["name"], "number": r["number"],
                                       "point": pt(r["point"]), "boundary": [pt(p) for p in r["boundary"]],
                                       "area": r["area"], "perimeter": r["perimeter"]})
            for g in res["grids"]:
                if any(norm(sub(g["start"], s["start"])) < 0.05 and norm(sub(g["end"], s["end"])) < 0.05 for s in seen_grids):
                    continue
                seen_grids.append(g)
                model["grids"].append({"name": g["name"], "start": pt(g["start"]), "end": pt(g["end"])})
        rsrc = l.get("roof_slab_from")
        if rsrc and per_level.get(rsrc) and per_level[rsrc].get("outline"):
            o = per_level[rsrc]["outline"]
            model["slabs"].append({"id": nid("S"), "level": name, "boundary": [pt(p) for p in o],
                                   "thickness": D["slab_thickness"], "area": round(Polygon(o).area, 2)})
    return model, previews


# --------------------------------------------------------------------------- #
# QA report, quantities, preview
# --------------------------------------------------------------------------- #
def write_svg(path, res, model, level):
    xs, ys = [], []
    for w in res["walls"]:
        xs += [w["start"][0], w["end"][0]]
        ys += [w["start"][1], w["end"][1]]
    for g in res["grids"]:
        xs += [g["start"][0], g["end"][0]]
        ys += [g["start"][1], g["end"][1]]
    if not xs:
        return
    pad = 2.0
    x0, x1, y0, y1 = min(xs) - pad, max(xs) + pad, min(ys) - pad, max(ys) + pad
    W = 1400.0
    k = W / (x1 - x0)
    H = (y1 - y0) * k

    def T(p):
        return "%.1f,%.1f" % ((p[0] - x0) * k, (y1 - p[1]) * k)

    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" '
           'font-family="Segoe UI, Tahoma, sans-serif">' % (W, H + 40, W, H + 40),
           '<rect width="100%" height="100%" fill="#ffffff"/>']
    for r in res["rooms"]:
        out.append('<polygon points="%s" fill="#e8f1fb" stroke="none"/>' % " ".join(T(p) for p in r["boundary"]))
    for g in res["grids"]:
        out.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="#d04040" stroke-width="1" stroke-dasharray="12,4,2,4"/>'
                   % tuple(T(g["start"]).split(",") + T(g["end"]).split(",")))
        for e in (g["start"], g["end"]):
            cx, cy = T(e).split(",")
            out.append('<circle cx="%s" cy="%s" r="13" fill="#fff" stroke="#d04040"/>'
                       '<text x="%s" y="%s" font-size="13" text-anchor="middle" dominant-baseline="central" fill="#d04040">%s</text>'
                       % (cx, cy, cx, cy, g["name"]))
    for s in res["unpaired"]:
        out.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="#ff8c00" stroke-width="2"/>'
                   % tuple(T(s.p1).split(",") + T(s.p2).split(",")))
    for w in res["walls"]:
        out.append('<polygon points="%s" fill="#5a5a5a" stroke="#222" stroke-width="0.6"/>'
                   % " ".join(T(c) for c in list(wall_polygon(w).exterior.coords)[:-1]))
    for c in res["columns"]:
        out.append('<polygon points="%s" fill="#1f4e79" stroke="#0b2540"/>'
                   % " ".join(T(p) for p in list(col_polygon(c).exterior.coords)[:-1]))
    for o in res["openings"]:
        if o.get("wall_index") is None:
            continue
        w = res["walls"][o["wall_index"]]
        d = wall_dir(w)
        a = sub(o["point"], mul(d, o["width"] / 2))
        b = add(o["point"], mul(d, o["width"] / 2))
        col = "#2e9d4a" if o["kind"] == "door" else "#1e90ff"
        out.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" stroke-width="%.1f"/>'
                   % tuple(T(a).split(",") + T(b).split(",") + [col, max(3.0, w["thickness"] * k * 1.2)]))
    for r in res["rooms"]:
        cx, cy = T(r["point"]).split(",")
        out.append('<text x="%s" y="%s" font-size="14" text-anchor="middle" fill="#123">%s</text>'
                   '<text x="%s" y="%.1f" font-size="12" text-anchor="middle" fill="#456">%.2f m²</text>'
                   % (cx, cy, esc(r["name"]), cx, float(cy) + 16, r["area"]))
    out.append('<text x="10" y="%.1f" font-size="14" fill="#333">%s  |  walls %d  doors %d  windows %d  columns %d  rooms %d'
               '  |  grey=wall  green=door  blue=window  navy=column  orange=unmatched line</text>'
               % (H + 28, esc(level), len(res["walls"]), sum(o["kind"] == "door" for o in res["openings"]),
                  sum(o["kind"] == "window" for o in res["openings"]), len(res["columns"]), len(res["rooms"])))
    out.append("</svg>")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out))


def esc(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def quantities(model):
    rows = []
    op_by_wall = defaultdict(float)
    for o in model["openings"]:
        op_by_wall[o["host"]] += o["width"] * o["height"]
    wq = defaultdict(lambda: [0.0, 0.0, 0.0, 0])
    for w in model["walls"]:
        L = norm(sub(w["end"], w["start"]))
        q = wq[(w["level"], w["thickness"])]
        q[0] += L
        q[1] += L * w["height"]
        q[2] += op_by_wall[w["id"]]
        q[3] += 1
    for (lvl, t), (L, A, Ao, n) in sorted(wq.items()):
        rows.append(["Walls", lvl, "Wall %d mm" % round(t * 1000), n, "m", round(L, 2)])
        rows.append(["Walls", lvl, "Wall %d mm - gross area" % round(t * 1000), n, "m2", round(A, 2)])
        rows.append(["Walls", lvl, "Wall %d mm - net area (less openings)" % round(t * 1000), n, "m2", round(A - Ao, 2)])
        rows.append(["Walls", lvl, "Wall %d mm - net volume" % round(t * 1000), n, "m3", round((A - Ao) * t, 3)])
    for kind, label in (("door", "Doors"), ("window", "Windows")):
        c = Counter((o["level"], o["type_name"]) for o in model["openings"] if o["kind"] == kind)
        for (lvl, tn), n in sorted(c.items()):
            rows.append([label, lvl, tn, n, "nr", n])
    cc = defaultdict(lambda: [0, 0.0])
    for c in model["columns"]:
        area = math.pi * (c["width"] / 2) ** 2 if c["shape"] == "round" else c["width"] * c["depth"]
        cc[(c["level"], c["type_name"])][0] += 1
        cc[(c["level"], c["type_name"])][1] += area * c["height"]
    for (lvl, tn), (n, v) in sorted(cc.items()):
        rows.append(["Columns", lvl, tn, n, "nr", n])
        rows.append(["Columns", lvl, tn + " - concrete", n, "m3", round(v, 3)])
    for s in model["slabs"]:
        rows.append(["Slabs", s["level"], "Slab %d mm" % round(s["thickness"] * 1000), 1, "m2", s["area"]])
        rows.append(["Slabs", s["level"], "Slab %d mm - concrete" % round(s["thickness"] * 1000), 1, "m3",
                     round(s["area"] * s["thickness"], 3)])
    for r in model["rooms"]:
        rows.append(["Rooms", r["level"], "%s%s" % (r["name"], (" (" + r["number"] + ")") if r["number"] else ""), 1, "m2", r["area"]])
    return rows


def write_report(out_dir, model, rows):
    lines = ["# تقرير تحويل DXF إلى نموذج Revit", "",
             "المشروع: **%s**" % model["project"].get("name", ""), "",
             "## ملخص العناصر لكل منسوب", "",
             "| المنسوب | المنسوب (م) | الجدران | الأبواب | الشبابيك | الأعمدة | البلاطات | الغرف |",
             "|---|---|---|---|---|---|---|---|"]
    for l in model["levels"]:
        n = l["name"]
        cnt = lambda key, f=None: sum(1 for x in model[key] if x["level"] == n and (f is None or f(x)))
        lines.append("| %s | %.2f | %d | %d | %d | %d | %d | %d |" % (
            n, l["elevation"], cnt("walls"), cnt("openings", lambda o: o["kind"] == "door"),
            cnt("openings", lambda o: o["kind"] == "window"), cnt("columns"), cnt("slabs"), cnt("rooms")))
    lines += ["", "المحاور: %s" % (", ".join(g["name"] for g in model["grids"]) or "لا يوجد"), "",
              "## فحص الجودة", ""]
    for lvl, st in model["stats"].items():
        lines.append("- **%s**: وحدات الرسم `%s`، خطوط جدران مقروءة %d، خطوط لم تُطابَق %d بطول %.2f م، "
                     "بلوكات أبواب %d، بلوكات شبابيك %d، نصوص غرف %d" % (
                         lvl, st["units"], st["face_lines"], st["unpaired_lines"], st["unpaired_length"],
                         st["door_blocks"], st["window_blocks"], st["room_labels"]))
    if model["issues"]:
        lines += ["", "### ملاحظات تحتاج مراجعة", ""]
        lines += ["- [%s] %s" % (i["level"], i["message"]) for i in model["issues"]]
    lines += ["", "## جدول الكميات", "", "| البند | المنسوب | الوصف | العدد | الوحدة | الكمية |", "|---|---|---|---|---|---|"]
    lines += ["| %s | %s | %s | %s | %s | %s |" % tuple(r) for r in rows]
    lines += ["", "> الكميات محسوبة من الرسم ثنائي الأبعاد قبل البناء في Revit، ومساحة الجدران = طول المحور × ارتفاع الدور.",
              "> راجع ملف المعاينة preview SVG لكل منسوب قبل التشغيل في Revit."]
    with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    with open(os.path.join(out_dir, "quantities.csv"), "w", encoding="utf-8-sig", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["Category", "Level", "Description", "Count", "Unit", "Quantity"])
        wr.writerows(rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("config", help="project config JSON (from dxf_inspect.py)")
    ap.add_argument("-o", "--out", default="dxf2revit_out")
    args = ap.parse_args()
    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)
    base = os.path.dirname(os.path.abspath(args.config))
    for l in cfg["levels"]:
        if l.get("dxf") and not os.path.isabs(l["dxf"]):
            l["dxf"] = os.path.join(base, l["dxf"])
    from dxf_inspect import default_config  # defaults for missing keys
    dflt = default_config("x.dxf", "L")["defaults"]
    dflt.update(cfg.get("defaults", {}))
    cfg["defaults"] = dflt
    os.makedirs(args.out, exist_ok=True)
    model, previews = build_model(cfg, print)
    with open(os.path.join(args.out, "model.json"), "w", encoding="utf-8") as f:
        json.dump(model, f, ensure_ascii=False, indent=1)
    for lvl, res in previews.items():
        safe = re.sub(r"[^\w\-]+", "_", lvl)
        write_svg(os.path.join(args.out, "preview_%s.svg" % safe), res, model, lvl)
    rows = quantities(model)
    write_report(args.out, model, rows)
    print("walls=%d openings=%d columns=%d grids=%d slabs=%d rooms=%d issues=%d" % (
        len(model["walls"]), len(model["openings"]), len(model["columns"]), len(model["grids"]),
        len(model["slabs"]), len(model["rooms"]), len(model["issues"])))
    print("output ->", os.path.abspath(args.out))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
