#!/usr/bin/env python3
"""
model_to_ifc.py  -  Route B: model.json -> IFC4 file.

Revit opens it directly (File > Open > IFC) or links it (Insert > Link IFC),
so the model can be reviewed on any machine without running scripts inside
Revit.  Native Revit families are created by Route A
(revit_build_from_model.py); use this route for coordination, review, or when
scripts are not allowed on the Revit workstation.

Usage:
    python model_to_ifc.py out/model.json -o out/model.ifc
"""
import argparse
import json
import math
import sys

try:
    import numpy as np
    import ifcopenshell
    import ifcopenshell.api
    import ifcopenshell.guid
except ImportError:  # pragma: no cover
    sys.exit("ifcopenshell is required:  pip install ifcopenshell")

api = ifcopenshell.api


def placement_matrix(x, y, z, angle_rad):
    m = np.eye(4)
    c, s = math.cos(angle_rad), math.sin(angle_rad)
    m[0, 0], m[0, 1], m[1, 0], m[1, 1] = c, -s, s, c
    m[0, 3], m[1, 3], m[2, 3] = x, y, z
    return m


def set_pset(f, el, name, props):
    ps = api.run("pset.add_pset", f, product=el, name=name)
    api.run("pset.edit_pset", f, pset=ps, properties=props)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("-o", "--out", default="model.ifc")
    args = ap.parse_args()
    with open(args.model, encoding="utf-8") as fh:
        M = json.load(fh)

    f = ifcopenshell.file(schema="IFC4")
    project = api.run("root.create_entity", f, ifc_class="IfcProject", name=M["project"].get("name") or "DXF Project")
    api.run("unit.assign_unit", f, length={"is_metric": True, "raw": "METERS"})
    model_ctx = api.run("context.add_context", f, context_type="Model")
    body = api.run("context.add_context", f, context_type="Model", context_identifier="Body",
                   target_view="MODEL_VIEW", parent=model_ctx)
    plan_ctx = api.run("context.add_context", f, context_type="Plan")
    axis = api.run("context.add_context", f, context_type="Plan", context_identifier="Axis",
                   target_view="GRAPH_VIEW", parent=plan_ctx)
    site = api.run("root.create_entity", f, ifc_class="IfcSite", name="Site")
    bldg = api.run("root.create_entity", f, ifc_class="IfcBuilding", name=M["project"].get("name") or "Building")
    api.run("aggregate.assign_object", f, relating_object=project, products=[site])
    api.run("aggregate.assign_object", f, relating_object=site, products=[bldg])

    storeys = {}
    for lv in M["levels"]:
        st = api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name=lv["name"])
        st.Elevation = lv["elevation"]
        api.run("aggregate.assign_object", f, relating_object=bldg, products=[st])
        api.run("geometry.edit_object_placement", f, product=st,
                matrix=placement_matrix(0, 0, lv["elevation"], 0))
        storeys[lv["name"]] = (st, lv["elevation"])

    # grids on the lowest storey
    if M["grids"]:
        grid = api.run("root.create_entity", f, ifc_class="IfcGrid", name="Grid")
        first = storeys[M["levels"][0]["name"]][0]
        api.run("spatial.assign_container", f, relating_structure=first, products=[grid])
        api.run("geometry.edit_object_placement", f, product=grid, matrix=np.eye(4))
        u_axes, v_axes = [], []
        for g in M["grids"]:
            dx, dy = g["end"][0] - g["start"][0], g["end"][1] - g["start"][1]
            ga = api.run("grid.create_grid_axis", f, axis_tag=g["name"],
                         uvw_axes="UAxes" if abs(dy) > abs(dx) else "VAxes", grid=grid)
            api.run("grid.create_axis_curve", f, p1=np.array(g["start"] + [0.0]), p2=np.array(g["end"] + [0.0]), grid_axis=ga)
        # representation so viewers draw the grid
        try:
            api.run("geometry.assign_representation", f, product=grid,
                    representation=f.createIfcShapeRepresentation(
                        axis, "FootPrint", "GeometricCurveSet",
                        [f.createIfcGeometricCurveSet([a.AxisCurve for a in (grid.UAxes or []) + (grid.VAxes or [])])]))
        except Exception:
            pass

    walls = {}
    wall_types = {}
    for w in M["walls"]:
        st, z = storeys[w["level"]]
        x1, y1 = w["start"]
        x2, y2 = w["end"]
        L = math.hypot(x2 - x1, y2 - y1)
        ang = math.atan2(y2 - y1, x2 - x1)
        t = w["thickness"]
        el = api.run("root.create_entity", f, ifc_class="IfcWall", name=w["type_name"])
        el.Tag = w["id"]
        tn = w["type_name"]
        if tn not in wall_types:
            wt = api.run("root.create_entity", f, ifc_class="IfcWallType", name=tn)
            wall_types[tn] = wt
        api.run("type.assign_type", f, related_objects=[el], relating_type=wall_types[tn])
        # wall rep is built along +X from origin with thickness to +Y -> shift by -t/2 normal
        nx, ny = -math.sin(ang) * t / 2.0, math.cos(ang) * t / 2.0
        api.run("geometry.edit_object_placement", f, product=el,
                matrix=placement_matrix(x1 - nx, y1 - ny, z, ang))
        rep = api.run("geometry.add_wall_representation", f, context=body, length=L, height=w["height"], thickness=t)
        api.run("geometry.assign_representation", f, product=el, representation=rep)
        api.run("spatial.assign_container", f, relating_structure=st, products=[el])
        set_pset(f, el, "Pset_WallCommon", {"IsExternal": False, "LoadBearing": False})
        walls[w["id"]] = (el, x1, y1, ang, t, z)

    for o in M["openings"]:
        if o["host"] not in walls:
            continue
        wall, x1, y1, ang, t, z = walls[o["host"]]
        st, _ = storeys[o["level"]]
        px, py = o["point"]
        along = (px - x1) * math.cos(ang) + (py - y1) * math.sin(ang)
        start = along - o["width"] / 2.0
        ox = x1 + math.cos(ang) * start + math.sin(ang) * (t / 2.0 + 0.05)
        oy = y1 + math.sin(ang) * start - math.cos(ang) * (t / 2.0 + 0.05)
        sill = o["sill"]
        op = api.run("root.create_entity", f, ifc_class="IfcOpeningElement", name="Opening " + o["id"])
        api.run("geometry.edit_object_placement", f, product=op, matrix=placement_matrix(ox, oy, z + sill, ang))
        api.run("geometry.assign_representation", f, product=op, representation=api.run(
            "geometry.add_wall_representation", f, context=body, length=o["width"], height=o["height"], thickness=t + 0.1))
        api.run("feature.add_feature", f, feature=op, element=wall)
        cls = "IfcDoor" if o["kind"] == "door" else "IfcWindow"
        el = api.run("root.create_entity", f, ifc_class=cls, name=o["type_name"])
        el.Tag = o["id"]
        el.OverallWidth, el.OverallHeight = o["width"], o["height"]
        # thin panel in the middle of the wall
        pt = 0.05
        cx = x1 + math.cos(ang) * start + math.sin(ang) * (pt / 2.0)
        cy = y1 + math.sin(ang) * start - math.cos(ang) * (pt / 2.0)
        api.run("geometry.edit_object_placement", f, product=el, matrix=placement_matrix(cx, cy, z + sill, ang))
        api.run("geometry.assign_representation", f, product=el, representation=api.run(
            "geometry.add_wall_representation", f, context=body, length=o["width"], height=o["height"], thickness=pt))
        api.run("spatial.assign_container", f, relating_structure=st, products=[el])
        api.run("feature.add_filling", f, opening=op, element=el)

    for c in M["columns"]:
        st, z = storeys[c["level"]]
        el = api.run("root.create_entity", f, ifc_class="IfcColumn", name=c["type_name"])
        el.Tag = c["id"]
        if c["shape"] == "round":
            prof = f.createIfcCircleProfileDef("AREA", None, None, c["width"] / 2.0)
        else:
            prof = f.createIfcRectangleProfileDef("AREA", None, None, c["width"], c["depth"])
        api.run("geometry.edit_object_placement", f, product=el,
                matrix=placement_matrix(c["center"][0], c["center"][1], z, math.radians(c["rotation"])))
        rep = api.run("geometry.add_profile_representation", f, context=body, profile=prof, depth=c["height"])
        api.run("geometry.assign_representation", f, product=el, representation=rep)
        api.run("spatial.assign_container", f, relating_structure=st, products=[el])

    for s in M["slabs"]:
        st, z = storeys[s["level"]]
        el = api.run("root.create_entity", f, ifc_class="IfcSlab", name="Slab %dmm" % round(s["thickness"] * 1000),
                     predefined_type="FLOOR")
        el.Tag = s["id"]
        api.run("geometry.edit_object_placement", f, product=el, matrix=placement_matrix(0, 0, z - s["thickness"], 0))
        rep = api.run("geometry.add_slab_representation", f, context=body, depth=s["thickness"],
                      polyline=[tuple(p) for p in s["boundary"]])
        api.run("geometry.assign_representation", f, product=el, representation=rep)
        api.run("spatial.assign_container", f, relating_structure=st, products=[el])

    for r in M["rooms"]:
        st, z = storeys[r["level"]]
        lv = next(l for l in M["levels"] if l["name"] == r["level"])
        sp = api.run("root.create_entity", f, ifc_class="IfcSpace", name=r["number"] or r["id"])
        sp.LongName = r["name"]
        api.run("aggregate.assign_object", f, relating_object=st, products=[sp])
        api.run("geometry.edit_object_placement", f, product=sp, matrix=placement_matrix(0, 0, z, 0))
        rep = api.run("geometry.add_slab_representation", f, context=body, depth=lv["height"] or 3.0,
                      polyline=[tuple(p) for p in r["boundary"]])
        api.run("geometry.assign_representation", f, product=sp, representation=rep)
        qto = api.run("pset.add_qto", f, product=sp, name="Qto_SpaceBaseQuantities")
        api.run("pset.edit_qto", f, qto=qto, properties={"NetFloorArea": r["area"], "GrossPerimeter": r["perimeter"]})

    f.write(args.out)
    print("IFC written:", args.out, "| products:", len(f.by_type("IfcProduct")))


if __name__ == "__main__":
    main()
