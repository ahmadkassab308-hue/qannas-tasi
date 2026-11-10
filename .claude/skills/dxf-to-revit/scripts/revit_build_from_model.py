# -*- coding: utf-8 -*-
"""
revit_build_from_model.py  -  Route A: build NATIVE Revit elements from model.json

Runs inside Revit (2021 - 2026) with any of:
  * pyRevit          : put this file in a pushbutton folder, or run it with
                       "pyRevit > Run Script" (IronPython or CPython engine)
  * RevitPythonShell : File > Run script
  * Dynamo           : paste into a Python Script node (IN[0] = path to model.json)

What it creates (all names prefixed "DXF" so they are easy to find / purge):
  Levels (+ floor plan views), Grids, Basic wall types per thickness, Walls
  joined at corners with top constrained to the level above, Floors, Columns
  (structural if a structural column family is loaded, else architectural),
  Doors & Windows hosted in their walls with types per size, Rooms with
  names / numbers.

Units: model.json is in metres; Revit internal units are feet.
"""
import os
import sys
import math
import json
import io

import clr
clr.AddReference("RevitAPI")
clr.AddReference("RevitAPIUI")
from Autodesk.Revit.DB import *                      # noqa
from Autodesk.Revit.DB.Structure import StructuralType

FT = 0.3048
LOG = []


def log(msg):
    LOG.append(msg)
    try:
        print(msg)
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# document / input
# --------------------------------------------------------------------------- #
def get_doc():
    try:
        return __revit__.ActiveUIDocument.Document            # pyRevit / RPS
    except NameError:
        pass
    try:
        clr.AddReference("RevitServices")
        from RevitServices.Persistence import DocumentManager
        return DocumentManager.Instance.CurrentDBDocument     # Dynamo
    except Exception:
        raise Exception("Run this script inside Revit (pyRevit, RevitPythonShell or Dynamo).")


def pick_model_path():
    try:
        return IN[0]                                          # Dynamo input  # noqa
    except NameError:
        pass
    env = os.environ.get("DXF2REVIT_MODEL")
    if env and os.path.exists(env):
        return env
    here = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else ""
    try:
        from pyrevit import forms
        p = forms.pick_file(file_ext="json", init_dir=here or None, title="Select model.json (DXF to Revit)")
        if p:
            return p
    except Exception:
        pass
    clr.AddReference("System.Windows.Forms")
    from System.Windows.Forms import OpenFileDialog, DialogResult
    dlg = OpenFileDialog()
    dlg.Filter = "DXF2Revit model (*.json)|*.json"
    dlg.Title = "Select model.json"
    if dlg.ShowDialog() == DialogResult.OK:
        return dlg.FileName
    raise Exception("No model.json selected")


def load_model(path):
    with io.open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def ft(v):
    return v / FT


def xyz(p, z=0.0):
    return XYZ(ft(p[0]), ft(p[1]), ft(z))


def eid_val(eid):
    try:
        return eid.Value          # Revit 2024+
    except Exception:
        return eid.IntegerValue


# --------------------------------------------------------------------------- #
# warnings swallower (keeps "walls overlap" etc. from stopping the run)
# --------------------------------------------------------------------------- #
try:
    class Swallow(IFailuresPreprocessor):
        __namespace__ = "dxf2revit"

        def PreprocessFailures(self, fa):
            for m in fa.GetFailureMessages():
                if m.GetSeverity() == FailureSeverity.Warning:
                    fa.DeleteWarning(m)
            return FailureProcessingResult.Continue
except Exception:          # some Python engines cannot subclass .NET interfaces
    Swallow = None


def start(doc, name):
    t = Transaction(doc, name)
    t.Start()
    if Swallow is None:
        return t
    try:
        opts = t.GetFailureHandlingOptions()
        opts.SetFailuresPreprocessor(Swallow())
        t.SetFailureHandlingOptions(opts)
    except Exception:
        pass
    return t


# --------------------------------------------------------------------------- #
# levels / views / grids
# --------------------------------------------------------------------------- #
def build_levels(doc, M):
    existing = list(FilteredElementCollector(doc).OfClass(Level))
    plan_vft = None
    for vft in FilteredElementCollector(doc).OfClass(ViewFamilyType):
        if vft.ViewFamily == ViewFamily.FloorPlan:
            plan_vft = vft
            break
    has_plan = set()
    for v in FilteredElementCollector(doc).OfClass(ViewPlan):
        if not v.IsTemplate and v.GenLevel is not None:
            has_plan.add(eid_val(v.GenLevel.Id))
    levels = {}
    for lv in M["levels"]:
        elev = ft(lv["elevation"])
        match = None
        for L in existing:
            if L.Name == lv["name"] or abs(L.Elevation - elev) < ft(0.001):
                match = L
                break
        if match is None:
            match = Level.Create(doc, elev)
            existing.append(match)
            log("Level created: %s @ %.2f m" % (lv["name"], lv["elevation"]))
        else:
            if abs(match.Elevation - elev) > ft(0.001):
                match.Elevation = elev
        try:
            if match.Name != lv["name"]:
                match.Name = lv["name"]
        except Exception:
            log("  could not rename level %s -> %s (name in use)" % (match.Name, lv["name"]))
        if plan_vft is not None and eid_val(match.Id) not in has_plan:
            try:
                vp = ViewPlan.Create(doc, plan_vft.Id, match.Id)
                vp.Name = lv["name"]
            except Exception:
                pass
        levels[lv["name"]] = match
    return levels


def build_grids(doc, M):
    names = set(g.Name for g in FilteredElementCollector(doc).OfClass(Grid))
    n = 0
    for g in M["grids"]:
        if g["name"] in names:
            continue
        gr = Grid.Create(doc, Line.CreateBound(xyz(g["start"]), xyz(g["end"])))
        try:
            gr.Name = g["name"]
        except Exception:
            pass
        n += 1
    log("Grids: %d" % n)


def level_above(levels_sorted, name):
    for i, lv in enumerate(levels_sorted):
        if lv["name"] == name and i + 1 < len(levels_sorted):
            return levels_sorted[i + 1]["name"]
    return None


# --------------------------------------------------------------------------- #
# types
# --------------------------------------------------------------------------- #
def element_name(el):
    try:
        return el.Name
    except Exception:
        return Element.Name.GetValue(el)


def wall_type_for(doc, cache, thickness, name):
    if name in cache:
        return cache[name]
    base = None
    for wt in FilteredElementCollector(doc).OfClass(WallType):
        if wt.Kind != WallKind.Basic:
            continue
        if element_name(wt) == name:
            cache[name] = wt
            return wt
        if base is None or "generic" in element_name(wt).lower():
            base = wt
    if base is None:
        raise Exception("No basic wall type in this project - start from an architectural template.")
    new = base.Duplicate(name)
    cs = CompoundStructure.CreateSingleLayerCompoundStructure(MaterialFunctionAssignment.Structure, ft(thickness),
                                                              ElementId.InvalidElementId)
    new.SetCompoundStructure(cs)
    cache[name] = new
    return new


def symbols_of(doc, bic):
    return list(FilteredElementCollector(doc).OfCategory(bic).OfClass(FamilySymbol))


def try_load_family(doc, candidates):
    roots = []
    for year in range(2026, 2019, -1):
        for lang in ("English", "English-Imperial", "English_I", "US Metric", "English_M"):
            roots.append(os.path.join("C:\\ProgramData\\Autodesk", "RVT %d" % year, "Libraries", lang))
    for root in roots:
        for rel in candidates:
            p = os.path.join(root, rel)
            if os.path.exists(p):
                try:
                    if doc.LoadFamily(p):
                        log("Family loaded: " + p)
                        return True
                except Exception:
                    pass
    return False


def set_first(el, names, bips, value):
    for b in bips:
        try:
            p = el.get_Parameter(b)
            if p is not None and not p.IsReadOnly:
                p.Set(value)
                return True
        except Exception:
            pass
    for n in names:
        p = el.LookupParameter(n)
        if p is not None and not p.IsReadOnly and p.StorageType == StorageType.Double:
            p.Set(value)
            return True
    return False


def sized_symbol(doc, cache, base, type_name, sizes):
    """Duplicate `base` FamilySymbol into `type_name` and set width/height/depth."""
    if type_name in cache:
        return cache[type_name]
    for s in FilteredElementCollector(doc).OfClass(FamilySymbol):
        if s.Family.Id == base.Family.Id and element_name(s) == type_name:
            cache[type_name] = s
            return s
    try:
        sym = base.Duplicate(type_name)
    except Exception:
        sym = base
    for names, bips, val in sizes:
        if not set_first(sym, names, bips, ft(val)):
            log("  type %s: parameter %s not found - size kept from family" % (type_name, names[0]))
    cache[type_name] = sym
    return sym


def pick_symbol(symbols, prefer):
    for kw in prefer:
        for s in symbols:
            if kw.lower() in (s.Family.Name + " " + element_name(s)).lower():
                return s
    return symbols[0] if symbols else None


# --------------------------------------------------------------------------- #
# builders
# --------------------------------------------------------------------------- #
def build_walls(doc, M, levels):
    lv_sorted = sorted(M["levels"], key=lambda l: l["elevation"])
    cache, out = {}, {}
    for w in M["walls"]:
        lvl = levels[w["level"]]
        a, b = xyz(w["start"], 0), xyz(w["end"], 0)
        a = XYZ(a.X, a.Y, lvl.Elevation)
        b = XYZ(b.X, b.Y, lvl.Elevation)
        if a.DistanceTo(b) < ft(0.05):
            continue
        wt = wall_type_for(doc, cache, w["thickness"], w["type_name"])
        wall = Wall.Create(doc, Line.CreateBound(a, b), wt.Id, lvl.Id, ft(w["height"]), 0.0, False, False)
        up = level_above(lv_sorted, w["level"])
        if up and up in levels:
            try:
                wall.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE).Set(levels[up].Id)
            except Exception:
                pass
        try:
            wall.get_Parameter(BuiltInParameter.WALL_KEY_REF_PARAM).Set(0)   # location line = wall centreline
        except Exception:
            pass
        try:
            p = wall.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)
            p.Set(w["id"])
        except Exception:
            pass
        out[w["id"]] = wall
    log("Walls: %d (types: %s)" % (len(out), ", ".join(sorted(cache))))
    return out


def curve_loop(boundary, z):
    loop = CurveLoop()
    n = len(boundary)
    pts = [XYZ(ft(p[0]), ft(p[1]), z) for p in boundary]
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        if a.DistanceTo(b) > ft(0.005):
            loop.Append(Line.CreateBound(a, b))
    return loop


def build_floors(doc, M, levels):
    ftypes = list(FilteredElementCollector(doc).OfClass(FloorType))
    ftypes = [t for t in ftypes if not getattr(t, "IsFoundationSlab", False)] or ftypes
    if not ftypes:
        log("No floor type - floors skipped")
        return
    base = ftypes[0]
    cache = {}
    n = 0
    for s in M["slabs"]:
        lvl = levels[s["level"]]
        name = "DXF Slab %dmm" % round(s["thickness"] * 1000)
        if name not in cache:
            ex = [t for t in ftypes if element_name(t) == name]
            if ex:
                cache[name] = ex[0]
            else:
                t = base.Duplicate(name)
                try:
                    cs = CompoundStructure.CreateSingleLayerCompoundStructure(
                        MaterialFunctionAssignment.Structure, ft(s["thickness"]), ElementId.InvalidElementId)
                    t.SetCompoundStructure(cs)
                except Exception:
                    pass
                cache[name] = t
        ftype = cache[name]
        loop = curve_loop(s["boundary"], lvl.Elevation)
        try:
            from System.Collections.Generic import List
            loops = List[CurveLoop]()
            loops.Add(loop)
            Floor.Create(doc, loops, ftype.Id, lvl.Id)                    # Revit 2022+
        except Exception:
            arr = CurveArray()
            for c in loop:
                arr.Append(c)
            doc.Create.NewFloor(arr, ftype, lvl, False)                   # Revit 2021
        n += 1
    log("Floors: %d" % n)


def build_columns(doc, M, levels):
    if not M["columns"]:
        return
    syms = symbols_of(doc, BuiltInCategory.OST_StructuralColumns)
    structural = True
    if not syms:
        try_load_family(doc, ["Structural Columns\\Concrete\\M_Concrete-Rectangular-Column.rfa",
                              "Structural Columns\\Concrete\\Concrete-Rectangular-Column.rfa"])
        syms = symbols_of(doc, BuiltInCategory.OST_StructuralColumns)
    if not syms:
        syms = symbols_of(doc, BuiltInCategory.OST_Columns)
        structural = False
    if not syms:
        log("No column family loaded - columns skipped. Load a rectangular column family and re-run.")
        return
    rect = pick_symbol(syms, ["rectangular", "rect", "square"])
    rnd = pick_symbol([s for s in syms if "round" in s.Family.Name.lower() or "circ" in s.Family.Name.lower()], ["round"]) or rect
    lv_sorted = sorted(M["levels"], key=lambda l: l["elevation"])
    cache = {}
    n = 0
    for c in M["columns"]:
        lvl = levels[c["level"]]
        if c["shape"] == "round" and rnd is not rect:
            sym = sized_symbol(doc, cache, rnd, c["type_name"],
                               [(["b", "Diameter", "D", "d"], [], c["width"])])
        else:
            sym = sized_symbol(doc, cache, rect, c["type_name"],
                               [(["b", "Width", "Breite"], [], c["width"]),
                                (["h", "Depth", "Tiefe"], [], c["depth"])])
        if not sym.IsActive:
            sym.Activate()
            doc.Regenerate()
        p = XYZ(ft(c["center"][0]), ft(c["center"][1]), lvl.Elevation)
        inst = doc.Create.NewFamilyInstance(p, sym, lvl, StructuralType.Column if structural else StructuralType.NonStructural)
        up = level_above(lv_sorted, c["level"])
        try:
            if up and up in levels:
                inst.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_PARAM).Set(levels[up].Id)
                inst.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_OFFSET_PARAM).Set(0.0)
            else:
                inst.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_OFFSET_PARAM).Set(ft(c["height"]))
        except Exception:
            pass
        if abs(c["rotation"]) > 0.01:
            axis = Line.CreateBound(p, p + XYZ.BasisZ)
            ElementTransformUtils.RotateElement(doc, inst.Id, axis, math.radians(c["rotation"]))
        n += 1
    log("Columns: %d (%s)" % (n, "structural" if structural else "architectural"))


def build_openings(doc, M, levels, walls):
    if not M["openings"]:
        return
    dsyms = symbols_of(doc, BuiltInCategory.OST_Doors)
    if not dsyms:
        try_load_family(doc, ["Doors\\M_Single-Flush.rfa", "Doors\\Single-Flush.rfa"])
        dsyms = symbols_of(doc, BuiltInCategory.OST_Doors)
    wsyms = symbols_of(doc, BuiltInCategory.OST_Windows)
    if not wsyms:
        try_load_family(doc, ["Windows\\M_Fixed.rfa", "Windows\\Fixed.rfa"])
        wsyms = symbols_of(doc, BuiltInCategory.OST_Windows)
    dbase = pick_symbol(dsyms, ["single-flush", "single", "flush"])
    wbase = pick_symbol(wsyms, ["fixed", "casement", "window"])
    cache = {}
    nd = nw = 0
    for o in M["openings"]:
        host = walls.get(o["host"])
        if host is None:
            continue
        lvl = levels[o["level"]]
        isdoor = o["kind"] == "door"
        base = dbase if isdoor else wbase
        if base is None:
            log("No %s family loaded - %s skipped" % (o["kind"], o["id"]))
            continue
        wb = [BuiltInParameter.DOOR_WIDTH, BuiltInParameter.FAMILY_WIDTH_PARAM] if isdoor else \
             [BuiltInParameter.WINDOW_WIDTH, BuiltInParameter.FAMILY_WIDTH_PARAM]
        hb = [BuiltInParameter.DOOR_HEIGHT, BuiltInParameter.FAMILY_HEIGHT_PARAM] if isdoor else \
             [BuiltInParameter.WINDOW_HEIGHT, BuiltInParameter.FAMILY_HEIGHT_PARAM]
        sym = sized_symbol(doc, cache, base, o["type_name"],
                           [(["Width", "Rough Width"], wb, o["width"]), (["Height", "Rough Height"], hb, o["height"])])
        if not sym.IsActive:
            sym.Activate()
            doc.Regenerate()
        p = XYZ(ft(o["point"][0]), ft(o["point"][1]), lvl.Elevation)
        try:
            inst = doc.Create.NewFamilyInstance(p, sym, host, lvl, StructuralType.NonStructural)
        except Exception as ex:
            log("  %s %s failed: %s" % (o["kind"], o["id"], ex))
            continue
        if not isdoor:
            try:
                inst.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM).Set(ft(o["sill"]))
            except Exception:
                pass
        try:
            inst.get_Parameter(BuiltInParameter.ALL_MODEL_MARK).Set(o["id"])
        except Exception:
            pass
        if isdoor:
            nd += 1
        else:
            nw += 1
    log("Doors: %d  Windows: %d" % (nd, nw))


def build_rooms(doc, M, levels):
    n = 0
    for r in M["rooms"]:
        lvl = levels[r["level"]]
        try:
            room = doc.Create.NewRoom(lvl, UV(ft(r["point"][0]), ft(r["point"][1])))
            room.Name = r["name"]
            if r.get("number"):
                room.Number = r["number"]
            n += 1
        except Exception as ex:
            log("  room %s failed: %s" % (r["name"], ex))
    log("Rooms: %d" % n)


# --------------------------------------------------------------------------- #
def main():
    doc = get_doc()
    path = pick_model_path()
    M = load_model(path)
    log("DXF -> Revit : %s" % path)
    tg = TransactionGroup(doc, "DXF to Revit")
    tg.Start()
    try:
        t = start(doc, "DXF levels & grids")
        levels = build_levels(doc, M)
        build_grids(doc, M)
        t.Commit()
        t = start(doc, "DXF walls")
        walls = build_walls(doc, M, levels)
        t.Commit()
        t = start(doc, "DXF floors & columns")
        build_floors(doc, M, levels)
        build_columns(doc, M, levels)
        t.Commit()
        t = start(doc, "DXF doors & windows")
        build_openings(doc, M, levels, walls)
        t.Commit()
        t = start(doc, "DXF rooms")
        doc.Regenerate()
        build_rooms(doc, M, levels)
        t.Commit()
        tg.Assimilate()
    except Exception as ex:
        log("FAILED: %s" % ex)
        try:
            if t.HasStarted() and not t.HasEnded():
                t.RollBack()
        except Exception:
            pass
        tg.RollBack()
        raise
    finally:
        try:
            logp = os.path.join(os.path.dirname(path), "revit_build_log.txt")
            with io.open(logp, "w", encoding="utf-8") as fh:
                fh.write(u"\n".join(u"%s" % m for m in LOG))
        except Exception:
            pass
    try:
        from Autodesk.Revit.UI import TaskDialog
        TaskDialog.Show("DXF to Revit", "\n".join(LOG[-12:]))
    except Exception:
        pass
    return LOG


OUT = main()
