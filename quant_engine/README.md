# quant_engine — 多市场本地 DuckDB 历史仓与原创事件驱动回测内核

本目录为 `三库工作台` 的独立 Python 量化回测子项目（100% 原创实现，全部采用 MIT / BSD / Apache 2.0 商业友好依赖）。

## 独立隔离环境安装（不污染全局 Python）

```powershell
cd quant_engine
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
```

## 常用 CLI 命令

```powershell
# 环境诊断
.\.venv\Scripts\python.exe -m quant_engine doctor --data-dir ..\quant_data

# 同步多市场日 K 数据（支持增量补缺，自动防重复）
.\.venv\Scripts\python.exe -m quant_engine sync --data-dir ..\quant_data --symbols 000300.SH,300308.SZ,002384.SZ --market CN --start 2024-01-01
.\.venv\Scripts\python.exe -m quant_engine sync --data-dir ..\quant_data --symbols SPY.US,NVDA.US --market US --start 2024-01-01
.\.venv\Scripts\python.exe -m quant_engine sync --data-dir ..\quant_data --symbols 00700.HK,02800.HK --market HK --start 2024-01-01

# 查看数据仓统计
.\.venv\Scripts\python.exe -m quant_engine summary --data-dir ..\quant_data

# 运行回测
.\.venv\Scripts\python.exe -m quant_engine backtest --spec path\to\spec.json --out path\to\run_dir

# 运行单元测试
.\.venv\Scripts\pytest.exe -v
```
