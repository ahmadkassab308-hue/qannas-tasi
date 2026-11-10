# Running the result in Revit

## Route A - native elements (recommended)

1. Open Revit and create a new project from the **architectural metric
   template** (or open the target project).
2. Check the families loaded in the project:
   - Doors: a single door family such as `M_Single-Flush`
   - Windows: e.g. `M_Fixed`
   - Columns: a structural column family such as
     `M_Concrete-Rectangular-Column` (the script tries to load it from the
     default library if none is loaded)
3. Run `revit_build_from_model.py` with one of:
   - **pyRevit**: `pyRevit` tab → `Run Script` (or drop the file into a
     pushbutton folder). Use the IronPython engine.
   - **RevitPythonShell**: `Run script`.
   - **Dynamo**: a `Python Script` node, paste the file content,
     `IN[0]` = File Path node pointing at `model.json`, then Run.
4. Pick `model.json` when asked. Everything is created in one undoable
   transaction group called "DXF to Revit"; a log is written next to the
   json as `revit_build_log.txt`.

What gets created: levels (renaming template levels at the same elevation),
floor plan views, grids, wall types per thickness, walls on the centre line
with their top attached to the level above, floors, columns, doors and
windows hosted in their walls with one type per size, and rooms with names
and numbers.

After the run: replace `DXF ...` types with company standard types, check
door swings, and run Revit's Review Warnings.

## Route B - IFC

`File → Open → IFC` opens `model.ifc` as a new Revit project (walls, doors,
windows, columns, slabs, spaces, grids and storeys).
`Insert → Link IFC` keeps it as a reference model for coordination. IFC
elements in Revit are less editable than native ones, so use Route A when
the model will be developed further.
