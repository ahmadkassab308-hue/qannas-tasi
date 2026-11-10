# model.json (schema dxf2revit/1) - all lengths in metres, angles in degrees

```json
{
  "schema": "dxf2revit/1",
  "project": {"name": "...", "units": "mm"},
  "levels":   [{"name": "Ground Floor", "elevation": 0.0, "height": 3.2}],
  "grids":    [{"name": "A", "start": [x, y], "end": [x, y]}],
  "walls":    [{"id": "W001", "level": "...", "start": [x, y], "end": [x, y],
                "thickness": 0.2, "height": 3.2, "type_name": "DXF Wall 200mm"}],
  "openings": [{"id": "D001", "level": "...", "kind": "door|window", "host": "W001",
                "point": [x, y], "width": 0.9, "height": 2.1, "sill": 0.0,
                "type_name": "DXF Door 900x2100", "source_block": "DOOR-SINGLE"}],
  "columns":  [{"id": "C001", "level": "...", "center": [x, y], "width": 0.4, "depth": 0.4,
                "rotation": 0.0, "shape": "rect|round", "height": 3.2, "type_name": "DXF Col 400x400"}],
  "slabs":    [{"id": "S001", "level": "...", "boundary": [[x, y], ...], "thickness": 0.2, "area": 108.7}],
  "rooms":    [{"id": "R001", "level": "...", "name": "Bedroom", "number": "102", "point": [x, y],
                "boundary": [[x, y], ...], "area": 21.08, "perimeter": 18.6}],
  "issues":   [{"level": "...", "message": "..."}],
  "stats":    {"<level>": {"units": "mm", "face_lines": 44, "unpaired_lines": 0, ...}}
}
```
Wall `start`/`end` are on the wall centre line and already joined at
corners/T-junctions. Opening `point` is the opening centre on the host wall
centre line. Slabs are placed with their top at the level elevation.
