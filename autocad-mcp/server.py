"""
AutoCAD MCP server (Windows only).
Connects Claude to the running AutoCAD instance through COM.
"""
import math
from collections import defaultdict

import pythoncom
import win32com.client
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("autocad")


def _acad():
    pythoncom.CoInitialize()
    try:
        app = win32com.client.GetActiveObject("AutoCAD.Application")
    except Exception:
        raise RuntimeError("AutoCAD is not running. Open AutoCAD and a drawing first.")
    doc = app.ActiveDocument
    return app, doc, doc.ModelSpace


def _pt(x, y, z=0.0):
    return win32com.client.VARIANT(pythoncom.VT_ARRAY | pythoncom.VT_R8, [float(x), float(y), float(z)])


def _set_layer(ent, layer):
    if layer:
        _, doc, _ = _acad()
        doc.Layers.Add(layer)
        ent.Layer = layer


@mcp.tool()
def drawing_info() -> dict:
    """Return the active drawing name, path, layer list and entity count."""
    _, doc, ms = _acad()
    return {
        "name": doc.Name,
        "path": doc.FullName,
        "layers": [doc.Layers.Item(i).Name for i in range(doc.Layers.Count)],
        "entities_in_modelspace": ms.Count,
    }


@mcp.tool()
def create_layer(name: str, color: int = 7) -> str:
    """Create a layer (or update its color). color is an AutoCAD Color Index 1-255."""
    _, doc, _ = _acad()
    layer = doc.Layers.Add(name)
    layer.color = color
    return f"Layer '{name}' ready (color {color})."


@mcp.tool()
def draw_line(x1: float, y1: float, x2: float, y2: float, layer: str = "") -> str:
    """Draw a line between two points."""
    _, _, ms = _acad()
    ent = ms.AddLine(_pt(x1, y1), _pt(x2, y2))
    _set_layer(ent, layer)
    return f"Line drawn, length {ent.Length:.3f}."


@mcp.tool()
def draw_polyline(points: list[list[float]], closed: bool = False, layer: str = "") -> str:
    """Draw a 2D polyline. points = [[x, y], [x, y], ...]."""
    _, _, ms = _acad()
    flat = [float(c) for p in points for c in p[:2]]
    ent = ms.AddLightWeightPolyline(win32com.client.VARIANT(pythoncom.VT_ARRAY | pythoncom.VT_R8, flat))
    ent.Closed = closed
    _set_layer(ent, layer)
    msg = f"Polyline drawn, length {ent.Length:.3f}"
    if closed:
        msg += f", area {ent.Area:.3f}"
    return msg + "."


@mcp.tool()
def draw_rectangle(x: float, y: float, width: float, height: float, layer: str = "") -> str:
    """Draw a closed rectangle from its lower-left corner."""
    return draw_polyline([[x, y], [x + width, y], [x + width, y + height], [x, y + height]], True, layer)


@mcp.tool()
def draw_circle(cx: float, cy: float, radius: float, layer: str = "") -> str:
    """Draw a circle."""
    _, _, ms = _acad()
    ent = ms.AddCircle(_pt(cx, cy), radius)
    _set_layer(ent, layer)
    return f"Circle drawn, area {math.pi * radius ** 2:.3f}."


@mcp.tool()
def add_text(text: str, x: float, y: float, height: float = 2.5, layer: str = "") -> str:
    """Add single-line text."""
    _, _, ms = _acad()
    ent = ms.AddText(text, _pt(x, y), height)
    _set_layer(ent, layer)
    return "Text added."


@mcp.tool()
def quantity_takeoff(layer: str = "") -> dict:
    """Summarise quantities by layer: count, total length and total closed area.
    Pass a layer name to limit the result to that layer."""
    _, _, ms = _acad()
    out = defaultdict(lambda: {"count": 0, "length": 0.0, "area": 0.0, "types": defaultdict(int)})
    for i in range(ms.Count):
        e = ms.Item(i)
        if layer and e.Layer != layer:
            continue
        row = out[e.Layer]
        kind = e.ObjectName
        row["count"] += 1
        row["types"][kind] += 1
        try:
            if kind in ("AcDbLine", "AcDbPolyline", "AcDb2dPolyline", "AcDbArc"):
                row["length"] += e.Length if kind != "AcDbArc" else e.ArcLength
            if kind == "AcDbCircle":
                row["length"] += e.Circumference
                row["area"] += e.Area
            elif kind in ("AcDbPolyline", "AcDbHatch") and (kind == "AcDbHatch" or e.Closed):
                row["area"] += e.Area
        except Exception:
            pass
    return {
        k: {"count": v["count"], "length": round(v["length"], 3), "area": round(v["area"], 3), "types": dict(v["types"])}
        for k, v in out.items()
    }


@mcp.tool()
def run_command(command: str) -> str:
    """Send a raw command to the AutoCAD command line, e.g. 'ZOOM E ' or '(load "x.lsp") '.
    End the string with a space or newline so AutoCAD executes it."""
    _, doc, _ = _acad()
    doc.SendCommand(command if command.endswith((" ", "\n")) else command + " ")
    return "Command sent."


@mcp.tool()
def save_drawing() -> str:
    """Save the active drawing."""
    _, doc, _ = _acad()
    doc.Save()
    return f"Saved {doc.FullName}."


if __name__ == "__main__":
    mcp.run()
