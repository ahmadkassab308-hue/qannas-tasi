"""
AutoCAD MCP Server
يربط Claude Desktop بأوتوكاد عبر COM (Windows فقط، أوتوكاد كامل وليس LT).
"""
from collections import defaultdict

import pythoncom
import win32com.client
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("autocad")


def _acad():
    pythoncom.CoInitialize()
    try:
        return win32com.client.GetActiveObject("AutoCAD.Application")
    except Exception:
        app = win32com.client.Dispatch("AutoCAD.Application")
        app.Visible = True
        return app


def _doc():
    app = _acad()
    if app.Documents.Count == 0:
        app.Documents.Add()
    return app.ActiveDocument


def _pt(x, y, z=0.0):
    return win32com.client.VARIANT(pythoncom.VT_ARRAY | pythoncom.VT_R8, [float(x), float(y), float(z)])


def _ensure_layer(doc, layer):
    if layer:
        try:
            doc.Layers.Item(layer)
        except Exception:
            doc.Layers.Add(layer)


@mcp.tool()
def drawing_info() -> dict:
    """معلومات الرسم المفتوح: الاسم والمسار وعدد العناصر والطبقات."""
    doc = _doc()
    return {
        "name": doc.Name,
        "path": doc.FullName,
        "entities": doc.ModelSpace.Count,
        "layers": doc.Layers.Count,
    }


@mcp.tool()
def list_layers() -> list:
    """قائمة الطبقات مع اللون وحالة التشغيل."""
    doc = _doc()
    return [
        {"name": l.Name, "color": l.color, "on": bool(l.LayerOn), "frozen": bool(l.Freeze)}
        for l in doc.Layers
    ]


@mcp.tool()
def draw_line(x1: float, y1: float, x2: float, y2: float, layer: str = "") -> str:
    """رسم خط بين نقطتين."""
    doc = _doc()
    _ensure_layer(doc, layer)
    ent = doc.ModelSpace.AddLine(_pt(x1, y1), _pt(x2, y2))
    if layer:
        ent.Layer = layer
    return ent.Handle


@mcp.tool()
def draw_polyline(points: list[list[float]], closed: bool = False, layer: str = "") -> str:
    """رسم بولي لاين من قائمة نقاط [[x,y], ...]."""
    doc = _doc()
    _ensure_layer(doc, layer)
    flat = [float(c) for p in points for c in p[:2]]
    arr = win32com.client.VARIANT(pythoncom.VT_ARRAY | pythoncom.VT_R8, flat)
    ent = doc.ModelSpace.AddLightWeightPolyline(arr)
    ent.Closed = closed
    if layer:
        ent.Layer = layer
    return ent.Handle


@mcp.tool()
def draw_circle(cx: float, cy: float, radius: float, layer: str = "") -> str:
    """رسم دائرة."""
    doc = _doc()
    _ensure_layer(doc, layer)
    ent = doc.ModelSpace.AddCircle(_pt(cx, cy), float(radius))
    if layer:
        ent.Layer = layer
    return ent.Handle


@mcp.tool()
def add_text(text: str, x: float, y: float, height: float = 2.5, layer: str = "") -> str:
    """إضافة نص."""
    doc = _doc()
    _ensure_layer(doc, layer)
    ent = doc.ModelSpace.AddText(text, _pt(x, y), float(height))
    if layer:
        ent.Layer = layer
    return ent.Handle


@mcp.tool()
def quantity_takeoff(layer: str = "") -> dict:
    """حصر كميات: مجموع الأطوال والمساحات وعدد العناصر لكل طبقة.
    الوحدات بحسب وحدات الرسم."""
    doc = _doc()
    out = defaultdict(lambda: {"count": 0, "length": 0.0, "area": 0.0, "blocks": defaultdict(int)})
    for ent in doc.ModelSpace:
        lyr = ent.Layer
        if layer and lyr.lower() != layer.lower():
            continue
        row = out[lyr]
        row["count"] += 1
        name = ent.ObjectName
        try:
            if name in ("AcDbLine", "AcDbArc"):
                row["length"] += ent.Length if name == "AcDbLine" else ent.ArcLength
            elif name in ("AcDbPolyline", "AcDb2dPolyline"):
                row["length"] += ent.Length
                if ent.Closed:
                    row["area"] += ent.Area
            elif name == "AcDbCircle":
                row["length"] += ent.Circumference
                row["area"] += ent.Area
            elif name == "AcDbHatch":
                row["area"] += ent.Area
            elif name == "AcDbBlockReference":
                row["blocks"][ent.EffectiveName] += 1
        except Exception:
            pass
    return {
        k: {"count": v["count"], "length": round(v["length"], 3),
            "area": round(v["area"], 3), "blocks": dict(v["blocks"])}
        for k, v in out.items()
    }


@mcp.tool()
def send_command(command: str) -> str:
    """تنفيذ أمر أوتوكاد مباشرة، مثل: ZOOM E أو _QSAVE. ينتهي الأمر بمسافة تلقائيًا."""
    doc = _doc()
    cmd = command if command.endswith((" ", "\n")) else command + " "
    doc.SendCommand(cmd)
    return "sent"


@mcp.tool()
def save_drawing(path: str = "") -> str:
    """حفظ الرسم، أو حفظه باسم جديد إذا أُعطي مسار."""
    doc = _doc()
    if path:
        doc.SaveAs(path)
    else:
        doc.Save()
    return doc.FullName


if __name__ == "__main__":
    mcp.run()
