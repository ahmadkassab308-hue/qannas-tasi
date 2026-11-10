---
name: dxf-to-revit
description: Convert 2D CAD plans (DXF, or DWG saved as DXF) into a professional Revit model - real walls with thickness, hosted doors and windows, columns, grids, levels, floors and named rooms - plus a QA report, SVG preview and quantity take-off (BOQ). Produces a pyRevit/Dynamo script that builds native Revit elements and an IFC file Revit can open directly. Use when the user asks to turn a DXF/DWG/AutoCAD plan into Revit/BIM, "تحويل ملف dxf الى ريفيت", "نمذجة مخطط اوتوكاد", "DXF to Revit", "CAD to BIM", or wants wall/door/column quantities from a CAD plan.
---

# DXF → Revit

Turns 2D architectural / structural plans into a clean BIM model. Revit is
not available in this environment, so the skill does all the drawing
interpretation here and hands Revit two ready-to-use deliverables:

| Route | File | How the user uses it | Result |
|---|---|---|---|
| A (recommended) | `model.json` + `revit_build_from_model.py` | Run the script in Revit via pyRevit, RevitPythonShell or a Dynamo Python node | **Native** walls, doors, windows, columns, floors, grids, levels, rooms |
| B | `model.ifc` | Revit → Open → IFC (or Insert → Link IFC) | Reviewable model, no scripts needed |

Both routes come from the same `model.json`, so they always agree.

## Setup (once per session)

```bash
pip install ezdxf shapely ifcopenshell
```
`SKILL_DIR` below = the folder containing this file.

## Workflow

### 1. Get a DXF
DWG is not readable directly. Ask the user to export DXF from AutoCAD
(`SAVEAS` → DXF 2013/2018), or convert with ODA File Converter if it is
installed. One DXF per floor is ideal; a single DXF with several floors must
be split by the user (or by cropping with layers) first.

### 2. Inspect and map layers
```bash
python "$SKILL_DIR/scripts/dxf_inspect.py" plan.dxf -o project.json --level "Ground Floor"
```
This prints units, extents, every layer with its entity counts and a guessed
role, and the blocks in use. It writes `project.json` with a pre-filled
mapping. **Read the printout and fix the mapping before continuing** - this is
the step that decides model quality:

- `layers.walls`: layers holding the two face lines of walls. Exclude hatch,
  dimension, furniture, finishes and axis layers.
- `wall_centerline_layers`: only if walls are drawn as single lines
  (thickness = `defaults.centerline_wall_thickness`).
- `layers.doors` / `layers.windows`: layers of door/window blocks, door
  swing arcs or window lines. `blocks.doors` / `blocks.windows` are
  name patterns (fnmatch, case-insensitive) that catch blocks on any layer.
- `layers.columns`: closed polylines, 4-line rectangles, circles or blocks.
- `layers.grids`: axis lines plus bubble text/attributes.
- `layers.rooms`: room name / number text.
- `layers.slabs`: optional closed outlines; otherwise the building outline is
  used when `defaults.auto_slab` is true.
- `levels`: name, elevation (m), height (m) and `dxf` path per floor.
  `copy_from: "<level>"` repeats a typical floor; `roof_slab_from` adds a
  roof slab from a floor's outline.
- `project.units`: `auto` reads `$INSUNITS`; force `mm`/`cm`/`m` if the
  header is wrong (the inspector warns when extents look inconsistent).

Ask the user only what the drawing cannot tell you: storey heights, number
of floors, typical-floor repetition, and which layers are ambiguous. See
`references/layer-mapping.md` for common naming standards and tricky cases.

### 3. Build the model + QA
```bash
python "$SKILL_DIR/scripts/dxf_to_model.py" project.json -o out
```
Outputs in `out/`:
- `model.json` - the building in metres (schema in `references/model-schema.md`)
- `preview_<level>.svg` - walls grey, doors green, windows blue, columns navy,
  rooms shaded with areas, grids red, **orange = wall lines that did not pair**
- `report.md` - element counts per level, QA stats, issues, BOQ table
- `quantities.csv` - BOQ (UTF-8 BOM, opens cleanly in Excel)

**Always look at the preview** (render the SVG to PNG with Playwright and
view it) before handing over. Typical fixes:
- Orange lines → a wall layer is missing, thickness is outside
  `wall_min/max_thickness`, or non-wall layers are mapped as walls.
- Missing doors/windows → add the block pattern or layer.
- Doors wider than expected → the gap holds two leaves or the block includes
  a frame; check `max_opening_width`.
- Rooms missing → walls do not close the space (open passage without a
  door, or a wall not detected). Rooms are only created for closed areas.
Iterate on `project.json` until the preview matches the drawing.

### 4. Produce deliverables
```bash
python "$SKILL_DIR/scripts/model_to_ifc.py" out/model.json -o out/model.ifc
cp "$SKILL_DIR/scripts/revit_build_from_model.py" out/
```
Package `out/` for the user (zip it if they need to download). For
professional reports, the `report.md` / `quantities.csv` can feed the xlsx or
docx skills.

### 5. Tell the user how to run it in Revit
Give the short guide from `references/revit-guide.md`: open a project from
an architectural template (metric), make sure door / window / column
families are loaded, then run `revit_build_from_model.py` and pick
`model.json`. Elements are named `DXF ...` (wall types `DXF Wall 200mm`,
door types `DXF Door 900x2100`, etc.) and marked with the model ids, so they
can be swapped for company types afterwards with Revit's Type Selector or
Select All Instances.

## Limits to state honestly
- Straight walls only; arc walls (polyline bulges) are reported, not built.
- Wall heights = storey height; parapets, beams, stairs, ramps, ceilings,
  MEP and furniture are not generated.
- Door/window families are the ones loaded in the project, resized per
  opening; swing direction and exact family must be checked in Revit.
- Quality depends on drawing hygiene. Exploded, overlapping or mixed-layer
  drawings need more mapping work; say so instead of over-promising.

## Testing the pipeline
`python scripts/make_sample_dxf.py sample.dxf` creates a 12 × 9 m test plan
(3 rooms, 3 doors, 4 windows, 6 columns, 5 grids). The expected result is
6 walls, 7 openings, 6 columns, 5 grids, 3 rooms and zero unmatched lines.
