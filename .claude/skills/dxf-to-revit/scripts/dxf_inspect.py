#!/usr/bin/env python3
"""
dxf_inspect.py  -  Step 1 of the DXF -> Revit pipeline.

Reads a DXF, reports units / extents / layers / blocks, and writes a
pre-filled project config (JSON) with a best-guess layer mapping that the
user (or Claude) reviews before running dxf_to_model.py.

Usage:
    python dxf_inspect.py plan.dxf [-o project.json] [--level "Ground Floor"]
"""
import argparse
import fnmatch
import json
import os
import sys
from collections import Counter, defaultdict

try:
    import ezdxf
    from ezdxf import bbox
except ImportError:  # pragma: no cover
    sys.exit("ezdxf is required:  pip install ezdxf shapely")

INSUNITS = {0: "unitless", 1: "in", 2: "ft", 4: "mm", 5: "cm", 6: "m"}

# keyword -> category. Matched case-insensitively against layer names.
LAYER_KEYWORDS = {
    "walls": ["wall", "a-wall", "wand", "mur", "جدار", "جدران", "حائط", "حوائط", "بلوك", "block-wall"],
    "columns": ["column", "col", "s-cols", "colm", "عمود", "اعمدة", "أعمدة", "stuetze", "poteau"],
    "doors": ["door", "a-door", "dr", "باب", "ابواب", "أبواب", "tuer", "porte"],
    "windows": ["window", "win", "glaz", "wind", "شباك", "شبابيك", "نافذة", "نوافذ", "fenster", "fenetre"],
    "grids": ["grid", "axis", "axes", "s-grid", "محور", "محاور", "achse"],
    "rooms": ["room", "space", "area-iden", "a-area", "name", "غرف", "فراغ", "اسماء", "أسماء", "raum"],
    "slabs": ["slab", "floor-outline", "s-slab", "بلاطة", "بلاطات", "سقف", "decke"],
}
# layers that look like a category but are not geometry we want
LAYER_EXCLUDE = ["dim", "hatch", "patt", "text-dim", "furn", "انشاء", "ابعاد", "أبعاد", "تهشير"]

BLOCK_PATTERNS = {
    "doors": ["*door*", "*dr*", "*باب*", "*tuer*", "*porte*", "d[0-9]*"],
    "windows": ["*window*", "*win*", "*شباك*", "*نافذ*", "*fenster*", "w[0-9]*"],
    "columns": ["*column*", "*col*", "*عمود*"],
}


def guess_category(layer):
    low = layer.lower()
    if any(x in low for x in LAYER_EXCLUDE):
        return None
    best = None
    for cat, keys in LAYER_KEYWORDS.items():
        for k in keys:
            if k in low:
                # prefer the longest keyword hit (e.g. "a-door" over "dr")
                if best is None or len(k) > best[1]:
                    best = (cat, len(k))
    return best[0] if best else None


def default_config(dxf_path, level_name):
    return {
        "project": {"name": os.path.splitext(os.path.basename(dxf_path))[0], "units": "auto"},
        "levels": [
            {"name": level_name, "elevation": 0.0, "height": 3.2, "dxf": os.path.abspath(dxf_path)},
            {"name": "Roof", "elevation": 3.2, "height": 0.0, "roof_slab_from": level_name},
        ],
        "layers": {k: [] for k in LAYER_KEYWORDS},
        "wall_centerline_layers": [],
        "blocks": {k: list(v) for k, v in BLOCK_PATTERNS.items()},
        "defaults": {
            "wall_min_thickness": 0.05,
            "wall_max_thickness": 0.60,
            "wall_min_length": 0.15,
            "centerline_wall_thickness": 0.20,
            "max_opening_width": 3.5,
            "door_height": 2.10,
            "window_height": 1.50,
            "window_sill": 0.90,
            "slab_thickness": 0.20,
            "auto_slab": True,
            "column_min_size": 0.15,
            "column_max_size": 2.00,
            "grid_min_length": 2.0,
        },
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dxf")
    ap.add_argument("-o", "--out", help="write pre-filled project config here")
    ap.add_argument("--level", default="Ground Floor", help="level name for this drawing")
    args = ap.parse_args()

    doc = ezdxf.readfile(args.dxf)
    msp = doc.modelspace()
    units_code = doc.header.get("$INSUNITS", 0)

    per_layer = defaultdict(Counter)
    block_use = Counter()
    block_layer = defaultdict(Counter)
    for e in msp:
        per_layer[e.dxf.layer][e.dxftype()] += 1
        if e.dxftype() == "INSERT":
            block_use[e.dxf.name] += 1
            block_layer[e.dxf.name][e.dxf.layer] += 1

    ext = bbox.extents(msp, fast=True)
    print("=" * 70)
    print("DXF:", args.dxf)
    print("DXF version:", doc.dxfversion, "| $INSUNITS =", units_code, "(%s)" % INSUNITS.get(units_code, "?"))
    if ext.has_data:
        sx, sy = ext.size.x, ext.size.y
        print("Extents: %.2f x %.2f drawing units" % (sx, sy))
        if units_code == 0:
            guess = "mm" if max(sx, sy) > 500 else "m"
            print("  -> units not set; size suggests '%s'" % guess)
    print("-" * 70)
    print("%-38s %-9s %s" % ("LAYER", "GUESS", "ENTITIES"))
    cfg = default_config(args.dxf, args.level)
    for layer in sorted(per_layer):
        cat = guess_category(layer)
        if cat:
            cfg["layers"][cat].append(layer)
        ents = ", ".join("%s:%d" % kv for kv in per_layer[layer].most_common())
        print("%-38s %-9s %s" % (layer[:38], cat or "-", ents))
    print("-" * 70)
    print("BLOCKS (inserted in model space):")
    for name, n in block_use.most_common(40):
        cats = [c for c, pats in BLOCK_PATTERNS.items() if any(fnmatch.fnmatch(name.lower(), p) for p in pats)]
        print("  %-36s x%-4d layer=%s  guess=%s" % (name[:36], n, block_layer[name].most_common(1)[0][0], cats[0] if cats else "-"))

    if units_code in INSUNITS and units_code != 0:
        cfg["project"]["units"] = INSUNITS[units_code]
    elif ext.has_data:
        cfg["project"]["units"] = "mm" if max(ext.size.x, ext.size.y) > 500 else "m"

    empty = [k for k, v in cfg["layers"].items() if not v and k in ("walls", "doors", "windows")]
    if empty:
        print("\n!! No layer guessed for: %s  -> edit the config manually." % ", ".join(empty))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        print("\nConfig written:", args.out)


if __name__ == "__main__":
    main()
