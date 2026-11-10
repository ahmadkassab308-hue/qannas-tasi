#!/usr/bin/env python3
"""Creates a small test plan (mm) to check the pipeline:  python make_sample_dxf.py sample.dxf"""
import sys
import ezdxf

doc = ezdxf.new("R2018", setup=True)
doc.header["$INSUNITS"] = 4
for name, color in [("A-WALL", 7), ("A-DOOR", 3), ("A-GLAZ", 5), ("S-COLS", 1), ("S-GRID", 1),
                    ("A-AREA-IDEN", 2), ("A-DIMS", 8), ("A-FURN", 9)]:
    doc.layers.add(name, color=color)
msp = doc.modelspace()

door = doc.blocks.new("DOOR-SINGLE")
door.add_line((0, 0), (0, 1000), dxfattribs={"layer": "0"})
door.add_arc((0, 0), 1000, 0, 90, dxfattribs={"layer": "0"})
win = doc.blocks.new("WINDOW-STD")
win.add_lwpolyline([(0, 0), (1000, 0), (1000, 200), (0, 200)], close=True)
win.add_line((0, 100), (1000, 100))

W = lambda a, b: msp.add_line(a, b, dxfattribs={"layer": "A-WALL"})


def hline(y, x0, x1, gaps):
    xs = [x0]
    for g0, g1 in sorted(gaps):
        xs += [g0, g1]
    xs.append(x1)
    for i in range(0, len(xs), 2):
        if xs[i + 1] - xs[i] > 1:
            W((xs[i], y), (xs[i + 1], y))


def vline(x, y0, y1, gaps):
    ys = [y0]
    for g0, g1 in sorted(gaps):
        ys += [g0, g1]
    ys.append(y1)
    for i in range(0, len(ys), 2):
        if ys[i + 1] - ys[i] > 1:
            W((x, ys[i]), (x, ys[i + 1]))


# exterior 200 mm, 12 x 9 m ; openings (start, end)
S_open = [(2000, 3000), (7000, 8500)]
N_open = [(2000, 3500), (8000, 9500)]
W_open = [(4000, 5200)]
hline(0, 0, 12000, S_open)
hline(200, 200, 11800, S_open + [(5950, 6050)])
hline(9000, 0, 12000, N_open)
hline(8800, 200, 11800, N_open + [(5950, 6050)])
vline(0, 0, 9000, W_open)
vline(200, 200, 8800, W_open)
vline(12000, 0, 9000, [])
vline(11800, 200, 8800, [(5000, 5100)])
for g0, g1 in S_open:
    W((g0, 0), (g0, 200)); W((g1, 0), (g1, 200))
for g0, g1 in N_open:
    W((g0, 8800), (g0, 9000)); W((g1, 8800), (g1, 9000))
for g0, g1 in W_open:
    W((0, g0), (200, g0)); W((0, g1), (200, g1))
# partition 100 mm at x=6000 with door 3000-3900
vline(5950, 200, 8800, [(3000, 3900)])
vline(6050, 200, 8800, [(3000, 3900), (5000, 5100)])
W((5950, 3000), (6050, 3000)); W((5950, 3900), (6050, 3900))
# partition 100 mm at y=5050 from x=6050 to 11800, door 8000-8800
hline(5000, 6050, 11800, [(8000, 8800)])
hline(5100, 6050, 11800, [(8000, 8800)])
W((8000, 5000), (8000, 5100)); W((8800, 5000), (8800, 5100))

D = lambda ins, w, rot: msp.add_blockref("DOOR-SINGLE", ins, dxfattribs={"layer": "A-DOOR", "xscale": w / 1000.0, "yscale": w / 1000.0, "rotation": rot})
D((2000, 200), 1000, 0)          # entrance
D((6050, 3000), 900, 90)         # partition door (vertical wall)
D((8000, 5100), 800, 0)          # bedroom door
Wn = lambda ins, w, t, rot: msp.add_blockref("WINDOW-STD", ins, dxfattribs={"layer": "A-GLAZ", "xscale": w / 1000.0, "yscale": t / 200.0, "rotation": rot})
Wn((7000, 0), 1500, 200, 0)
Wn((2000, 8800), 1500, 200, 0)
Wn((8000, 8800), 1500, 200, 0)
Wn((200, 4000), 1200, 200, 90)

# columns: four drawn as 4 separate lines, one round, one polyline
for cx, cy in [(100, 100), (11900, 100), (100, 8900), (11900, 8900)]:
    a, b = 200, 200
    pts = [(cx - a, cy - b), (cx + a, cy - b), (cx + a, cy + b), (cx - a, cy + b)]
    for i in range(4):
        msp.add_line(pts[i], pts[(i + 1) % 4], dxfattribs={"layer": "S-COLS"})
msp.add_circle((3000, 6500), 200, dxfattribs={"layer": "S-COLS"})
msp.add_lwpolyline([(8850, 2200), (9150, 2200), (9150, 2800), (8850, 2800)], close=True, dxfattribs={"layer": "S-COLS"})

# grids with bubbles
for x, n in [(100, "1"), (6000, "2"), (11900, "3")]:
    msp.add_line((x, -1500), (x, 10500), dxfattribs={"layer": "S-GRID"})
    msp.add_circle((x, 11000), 500, dxfattribs={"layer": "S-GRID"})
    msp.add_text(n, height=400, dxfattribs={"layer": "S-GRID"}).set_placement((x, 11000), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
for y, n in [(100, "A"), (8900, "B")]:
    msp.add_line((-1500, y), (13500, y), dxfattribs={"layer": "S-GRID"})
    msp.add_circle((-2000, y), 500, dxfattribs={"layer": "S-GRID"})
    msp.add_text(n, height=400, dxfattribs={"layer": "S-GRID"}).set_placement((-2000, y), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)

for txt, p in [("صالة\n101", (3000, 4500)), ("Bedroom\n102", (9000, 7000)), ("مطبخ\n103", (9000, 3500))]:
    msp.add_mtext(txt, dxfattribs={"layer": "A-AREA-IDEN", "char_height": 250}).set_location(p)
# noise
msp.add_linear_dim(base=(0, -800), p1=(0, 0), p2=(12000, 0), dxfattribs={"layer": "A-DIMS"}).render()
msp.add_lwpolyline([(1000, 6000), (2500, 6000), (2500, 7000), (1000, 7000)], close=True, dxfattribs={"layer": "A-FURN"})
doc.saveas(sys.argv[1] if len(sys.argv) > 1 else "sample.dxf")
print("saved")
