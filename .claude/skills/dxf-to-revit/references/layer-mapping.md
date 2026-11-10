# Layer mapping notes

## Common naming standards
| Role | AIA / NCS | ISO 13567 style | Arabic offices (typical) |
|---|---|---|---|
| Walls | A-WALL, A-WALL-EXTR, A-WALL-INTR | A-221-WALL | جدران، حوائط، بلوك |
| Columns | S-COLS, A-COLS | S-231-COLS | أعمدة |
| Doors | A-DOOR | A-312-DOOR | أبواب |
| Windows | A-GLAZ, A-WIND | A-313-WIND | شبابيك |
| Grids | S-GRID, A-GRID | S-GRID | محاور |
| Room names | A-AREA-IDEN, A-ROOM | A-ROOM-IDEN | أسماء الفراغات |

## Tricky cases
- **Wall hatch** on the wall layer: hatches are ignored automatically.
- **Walls with finishes drawn as extra lines** (plaster, cladding): the
  thinnest pair wins, so the core is modelled. Move finish lines to another
  layer if the full thickness is wanted.
- **Walls inside blocks / xrefs bound as blocks**: nested blocks are
  exploded virtually; layer `0` inherits the insert's layer.
- **Doors without blocks** (exploded): a swing ARC on a door layer inside a
  wall gap becomes a door with width = gap.
- **Windows without blocks**: lines on a window layer inside a wall gap
  become a window with width = gap.
- **Gaps with nothing in them** stay as open passages (wall is not joined).
- **Single-line walls**: list the layer under `wall_centerline_layers`.
- **Several floors in one DXF**: split them first; the script reads all of
  model space as one floor.
- **Units**: if `$INSUNITS` is wrong (common in old drawings) set
  `project.units` explicitly. A 12 m house reading as 12 000 m means mm
  were assumed metres.

## Tuning (`defaults`)
| Key | Default | Use |
|---|---|---|
| wall_min_thickness / wall_max_thickness | 0.05 / 0.60 m | face-pair search window |
| wall_min_length | 0.15 m | drop slivers |
| max_opening_width | 3.5 m | largest gap that can be healed by a door/window |
| door_height, window_height, window_sill | 2.10, 1.50, 0.90 m | opening sizes (plans do not hold heights) |
| slab_thickness | 0.20 m | floors and roof |
| column_min_size / column_max_size | 0.15 / 2.0 m | filter column shapes |
| grid_min_length | 2.0 m | ignore short lines on grid layers |
