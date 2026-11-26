# AutoCAD MCP

خادم يربط Claude ببرنامج AutoCAD المفتوح على جهازك عبر COM. يعمل على Windows فقط.

## التثبيت

1. ثبّت Python 3.10 أو أحدث، وفعّل خيار Add to PATH أثناء التثبيت.
2. انسخ هذا المجلد إلى `C:\autocad-mcp`.
3. افتح موجه الأوامر واكتب:

```
cd C:\autocad-mcp
pip install -r requirements.txt
```

## الربط مع Claude Desktop

افتح Settings ثم Developer ثم Edit Config، وأضف:

```json
{
  "mcpServers": {
    "autocad": {
      "command": "python",
      "args": ["C:\\autocad-mcp\\server.py"]
    }
  }
}
```

أغلق Claude Desktop تمامًا ثم افتحه من جديد.

## الربط مع Claude Code

```
claude mcp add autocad -- python C:\autocad-mcp\server.py
```

## الأدوات المتاحة

| الأداة | الوظيفة |
|---|---|
| drawing_info | اسم الرسم والطبقات وعدد العناصر |
| create_layer | إنشاء طبقة بلون محدد |
| draw_line / draw_polyline / draw_rectangle / draw_circle | الرسم |
| add_text | إضافة نص |
| quantity_takeoff | حصر العدد والأطوال والمساحات لكل طبقة |
| run_command | إرسال أي أمر إلى سطر أوامر AutoCAD |
| save_drawing | حفظ الرسم |

افتح AutoCAD وملف الرسم قبل أن تطلب من Claude أي شيء.
