#!/usr/bin/env python3
"""bench-lanes.py — 比較「主對話 Silk + 工作手不同模型」的流程順暢度、品質與成本。

用法：
  python3 scripts/bench-lanes.py                       # 跑預設 3 個配置 × 3 個任務
  python3 scripts/bench-lanes.py --only A,B1           # 只跑指定配置
  python3 scripts/bench-lanes.py --tasks T1            # 只跑指定任務

每個配置跑同一組任務，任務都有客觀驗收（跑 pytest / 比對 JSON），不看模型自述。
結果寫到 .exp/logs/bench-<時間>.json，並印成表格。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRATCH = Path.home() / ".hermes/cache/scratch/bench"
PORT_BASE = 8795
CLAUDE = str(Path.home() / ".local/share/mise/shims/claude")

# 配置：主對話固定 Silk 1017；工作手換模型
CONFIGS = {
    # A = 單一供應商（全部 Silk 1017）
    "A": {"label": "全 Silk 1017", "worker": "deepseek-v4.1-flash-1017-uncensored"},
    # B = 主 Silk 1017 + 工作手 OpenRouter 高階便宜模型
    "B1": {"label": "手=OpenRouter glm-5.3", "worker": "z-ai/glm-5.3"},
    "B2": {"label": "手=OpenRouter gpt-5.6-luna", "worker": "openai/gpt-5.6-luna"},
}

# ── 任務 fixtures ────────────────────────────────────────────────
BROKEN_PY = '''\
def average(nums):
    total = 0
    for n in nums:
        total += n
    return total / len(nums)


def parse_price(s):
    return float(s)


def clamp(x, lo, hi):
    if x < lo:
        return lo
    if x > hi:
        return hi
'''

BROKEN_TEST = '''\
import pytest
from broken import average, parse_price, clamp

def test_parse_price_with_symbols():
    assert parse_price("$1,234.50") == 1234.5
    assert parse_price("12") == 12.0

def test_clamp_returns_input_when_inside():
    assert clamp(2, 1, 3) == 2

def test_clamp_bounds():
    assert clamp(5, 1, 3) == 3
    assert clamp(0, 1, 3) == 1

def test_average_empty_is_zero():
    assert average([]) == 0.0
'''

CSV = """category,amount
food,12
rent,900
food,8
travel,120
food,5
tools,40
travel,30
"""

def _setup_T1(d: Path):
    (d / "broken.py").write_text(BROKEN_PY, encoding="utf-8")
    (d / "test_broken.py").write_text(BROKEN_TEST, encoding="utf-8")

def _setup_T2(d: Path):
    (d / "README.txt").write_text("Empty project. Create the files yourself.\n", encoding="utf-8")

def _setup_T3(d: Path):
    (d / "data.csv").write_text(CSV, encoding="utf-8")

PYTEST = None

def pytest_cmd():
    """找出可用的 pytest：優先用 uv run --with pytest（本機 venv 沒有 pytest）。"""
    global PYTEST
    if PYTEST:
        return PYTEST
    uv = shutil.which("uv")
    PYTEST = ([uv, "run", "--quiet", "--with", "pytest", "python", "-m", "pytest"]
              if uv else [sys.executable, "-m", "pytest"])
    return PYTEST


def run_pytest(d: Path, name: str):
    r = subprocess.run(pytest_cmd() + [str(d / name), "-q"],
                       capture_output=True, text=True, timeout=180, cwd=str(d))
    ok = r.returncode == 0
    return {"pass": ok, "detail": (r.stdout or r.stderr).strip().splitlines()[-1][:120] if (r.stdout or r.stderr) else ""}

def verify_T2(d: Path):
    r = subprocess.run(pytest_cmd() + ["test_stats.py", "-q"],
                       capture_output=True, text=True, timeout=180, cwd=str(d))
    return {"pass": r.returncode == 0, "detail": (r.stdout or r.stderr).strip().splitlines()[-1][:120] if (r.stdout or r.stderr) else ""}

def verify_T3(d: Path):
    f = d / "answer.json"
    if not f.exists():
        return {"pass": False, "detail": "answer.json 不存在"}
    try:
        got = json.loads(f.read_text(encoding="utf-8"))
    except Exception as e:
        return {"pass": False, "detail": f"JSON 解析失敗 {e}"}
    exp = {"food": 25, "rent": 900, "travel": 150, "tools": 40}
    # 允許 {category: total} 或 {"food": {"total": 25}} 形式
    norm = {}
    for k, v in (got.items() if isinstance(got, dict) else []):
        norm[k] = v if isinstance(v, (int, float)) else (v.get("total") if isinstance(v, dict) else v)
    ok = all(abs(float(norm.get(k, -1)) - v) < 1e-6 for k, v in exp.items()) and len(norm) == len(exp)
    return {"pass": ok, "detail": f"got={norm}"}

TASKS = {
    "T1": {
        "title": "修 bug 到測試通過",
        "setup": _setup_T1,
        "prompt": (
            "In the current directory there is broken.py with several bugs, and test_broken.py holding the "
            "acceptance tests. Fix broken.py so `uv run --with pytest python -m pytest test_broken.py -q` passes. "
            "You must NOT modify test_broken.py. Run the tests yourself and report the exact pytest summary line."
        ),
        "verify": lambda d: run_pytest(d, "test_broken.py"),
    },
    "T2": {
        "title": "從零建多檔＋邊界",
        "setup": _setup_T2,
        "prompt": (
            "Create stats.py in the current directory with a function `median(nums)` (empty list returns None, "
            "even length averages the two middle values, input must not be mutated) and a function "
            "`top_n(counts, n)` returning the n highest keys by value as a list of (key, value) tuples, ties "
            "broken alphabetically. Then create test_stats.py with at least 6 tests covering those edge cases "
            "and make `uv run --with pytest python -m pytest test_stats.py -q` pass. Report the pytest summary line."
        ),
        "verify": verify_T2,
    },
    "T3": {
        "title": "算 CSV 寫 JSON",
        "setup": _setup_T3,
        "prompt": (
            "There is data.csv with columns category,amount. Write summarise.py that reads it and writes "
            "answer.json containing total amount per category as a flat object {category: total}. "
            "Run it, then report the resulting JSON on one line."
        ),
        "verify": verify_T3,
    },
}


DELEGATE_PREFIX = (
    "This task MUST be delegated: use the Task tool to spawn a subagent that does the actual work "
    "(editing files and running commands). You only coordinate and verify \u2014 do not edit files yourself. "
    "After the subagent returns, verify the acceptance criteria yourself and report the result.\n\n"
)


def make_settings(d: Path, port: int, worker: str) -> Path:
    base = json.loads((REPO / "settings/claude-settings.json").read_text(encoding="utf-8"))
    base["env"]["ANTHROPIC_BASE_URL"] = f"http://127.0.0.1:{port}"
    base["env"]["CLAUDE_CODE_SUBAGENT_MODEL"] = worker
    p = d / "settings.json"
    p.write_text(json.dumps(base, ensure_ascii=False, indent=2), encoding="utf-8")
    return p


def run_one(cfg_key: str, task_key: str, port: int):
    cfg = CONFIGS[cfg_key]
    task = TASKS[task_key]
    d = SCRATCH / f"{cfg_key}-{task_key}"
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    task["setup"](d)
    settings = make_settings(d, port, cfg["worker"])

    env = dict(os.environ, CCHM_PORT=str(port), CCHM_BRAIN_LANE="silk", CCHM_LOG_DIR=str(d / "logs"))
    router = subprocess.Popen(["node", str(REPO / "src/router.mjs")], env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(1.3)
    t0 = time.time()
    try:
        p = subprocess.run([CLAUDE, "-p", DELEGATE_PREFIX + task["prompt"], "--model", "claude-sonnet-4-5",
                            "--settings", str(settings), "--output-format", "text"],
                           capture_output=True, text=True, timeout=420, cwd=str(d),
                           env={k: v for k, v in os.environ.items() if not k.startswith("ANTHROPIC")})
        secs = round(time.time() - t0, 1)
        out = (p.stdout or "").strip()
        rc = p.returncode
    except subprocess.TimeoutExpired:
        secs, out, rc = 420.0, "(timeout)", -9
    finally:
        router.send_signal(2)
        log = router.communicate(timeout=15)[0]

    reqs, cost, tin, tout = 0, 0.0, 0, 0
    models = {}
    for line in log.splitlines():
        if "in=" not in line:
            continue
        reqs += 1
        mm = re.search(r"model=(\S+)\s+→", line)
        if mm:
            models[mm.group(1)] = models.get(mm.group(1), 0) + 1
        try:
            tin += int(line.split("in=")[1].split()[0])
            tout += int(line.split("out=")[1].split()[0])
            if "$" in line:
                cost += float(line.rsplit("$", 1)[1].split()[0])
        except Exception:
            pass

    verdict = task["verify"](d)
    return {
        "config": cfg_key, "config_label": cfg["label"], "worker": cfg["worker"], "task": task_key,
        "task_title": task["title"], "exit": rc, "secs": secs, "requests": reqs,
        "in_tokens": tin, "out_tokens": tout, "cost_usd": round(cost, 6),
        "pass": verdict["pass"], "detail": verdict["detail"], "answer": out[:200],
        "models": models, "worker_used": any(m != "deepseek-v4.1-flash-1017-uncensored" for m in models),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=",".join(CONFIGS))
    ap.add_argument("--tasks", default=",".join(TASKS))
    args = ap.parse_args()
    cfgs = [c.strip() for c in args.only.split(",") if c.strip()]
    tasks = [t.strip() for t in args.tasks.split(",") if t.strip()]
    SCRATCH.mkdir(parents=True, exist_ok=True)
    results = []
    port = PORT_BASE
    for c in cfgs:
        for t in tasks:
            port += 1
            print(f"▶ {c} / {t} …", flush=True)
            r = run_one(c, t, port)
            results.append(r)
            print(f"  {'PASS' if r['pass'] else 'FAIL'}{'' if r['worker_used'] else '[no-worker]'} {r['secs']}s {r['requests']}req "
                  f"in={r['in_tokens']} out={r['out_tokens']} ${r['cost_usd']} :: {r['detail'][:70]}", flush=True)

    out_dir = REPO / ".exp/logs"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    fp = out_dir / f"bench-{stamp}.json"
    fp.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n寫入 {fp}\n")

    # 匯總
    print(f"{'cfg':4} {'worker':34} {'pass':>7} {'secs':>6} {'req':>4} {'cost':>9}")
    for c in cfgs:
        rs = [r for r in results if r["config"] == c]
        print(f"{c:4} {rs[0]['worker'][:34]:34} {sum(1 for r in rs if r['pass'])}/{len(rs):<5} "
              f"{sum(r['secs'] for r in rs):>6.1f} {sum(r['requests'] for r in rs):>4} "
              f"{sum(r['cost_usd'] for r in rs):>9.4f}")


if __name__ == "__main__":
    main()
