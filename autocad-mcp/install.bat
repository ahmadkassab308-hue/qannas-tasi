@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/3] Installing Python requirements...
python -m pip install -r requirements.txt || (echo Python not found. Install Python 3.10+ with "Add to PATH". & pause & exit /b 1)

echo [2/3] Registering with Claude Code (if installed)...
where claude >nul 2>&1 && claude mcp add autocad -- python "%~dp0server.py"

echo [3/3] Registering with Claude Desktop...
python -c "import json,os,sys;p=os.path.join(os.environ['APPDATA'],'Claude','claude_desktop_config.json');os.makedirs(os.path.dirname(p),exist_ok=True);c=json.load(open(p,encoding='utf-8')) if os.path.exists(p) else {};c.setdefault('mcpServers',{})['autocad']={'command':sys.executable,'args':[os.path.abspath('server.py')]};json.dump(c,open(p,'w',encoding='utf-8'),indent=2);print('Updated',p)"

echo.
echo Done. Open AutoCAD, then fully restart Claude Desktop.
pause
