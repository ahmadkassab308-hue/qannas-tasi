# ربط أوتوكاد مع Claude عبر MCP

يعمل على Windows مع أوتوكاد الكامل أو Civil 3D. نسخة LT لا تدعم الربط لأنها بلا COM.

## التثبيت
1. ثبّت Python 3.10 أو أحدث، وفعّل خيار Add to PATH.
2. انسخ هذا المجلد إلى `C:\autocad-mcp`.
3. من موجه الأوامر:
   ```
   cd C:\autocad-mcp
   pip install -r requirements.txt
   ```
4. افتح ملف الإعدادات `%APPDATA%\Claude\claude_desktop_config.json`
   والصق محتوى `claude_desktop_config.example.json`.
5. افتح أوتوكاد، ثم أعد تشغيل Claude Desktop بالكامل.

## الأدوات
drawing_info، list_layers، draw_line، draw_polyline، draw_circle، add_text،
quantity_takeoff لحصر الأطوال والمساحات والبلوكات لكل طبقة، send_command، save_drawing.
