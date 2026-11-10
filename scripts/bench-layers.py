#!/usr/bin/env python3
"""bench-layers.py — 單層（主對話自己做）vs 雙層（派給 subagent）的品質／速度／成本比較。

三種模式：
  single   主對話自己做完全部工作（一層）
  serial   主對話逐一把每個任務委派給 subagent（兩層、序列）
  parallel 主對話一次並行派三個 subagent（兩層、並行）

同一組任務、同一顆模型（Silk 1017），驗收看客觀結果（檔案內容與執行輸出），不看模型自述。
用法：python3 scripts/bench-layers.py [--runs 2] [--only single,parallel]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import subprocess
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRATCH = Path.home() / ".hermes/cache/scratch/bench-layers"
CLAUDE = str(Path.home() / ".local/share/mise/shims/claude")
PORT_BASE = 8830

TASKS = [
    ("fizzbuzz.py", "Write fizzbuzz.py that prints FizzBuzz for 1..15 (Fizz for multiples of 3, Buzz for 5, "
                    "FizzBuzz for both, else the number). Run it and report the output.",
     "fizzbuzz.py", ["1", "2", "Fizz", "4", "Buzz", "FizzBuzz"]),
    ("sortstats.py", "Write sortstats.py with a function stats(nums) returning dict(mean, median, min, max) "
                     "and a __main__ that prints stats for [3,1,4,1,5,9,2,6]. Run it and report the output.",
     "sortstats.py", ["3.875"]),
    ("csv2json.py", "Write csv2json.py that reads data.csv (columns: name,score) and writes out.json as a list "
                    "of {name, score:int} objects. Create data.csv with 3 rows yourself, run it, report out.json.",
     "out.json", ["score"]),
]

MODES = {
    "single": ("一層：主對話自己做完", ""),
    "serial": ("兩層：逐個委派", "For EACH task below, use the Task tool to spawn a subagent that does the work. "
                                 "Wait for each one to finish before starting the next. Do not write the files yourself.\n\n"),
    "parallel": ("兩層：一次並行派三個", "Use the Task tool to spawn THREE subagents in parallel (three Task calls in "
                                        "ONE message), one per task below. Do not write the files yourself; after they "
                                        "return, verify each output yourself.\n\n"),
}

VERIFY_PY = r'''
import json, subprocess, sys, pathlib
def check(files, expect):
    d = pathlib.Path(".")
    out = {}
    for f in files:
        out[f] = (d / f).exists()
    return out
'''


def run_mode(mode: str, run_idx: int) -> dict:
    label, prefix = MODES[mode]
    d = SCRATCH / f"{mode}-{run_idx}"
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)

    listing = "\n".join(f"{i+1}. {t[1]}" for i, t in enumerate(TASKS))
    prompt = (prefix + "Complete all of these tasks in the current directory:\n\n" + listing +
              "\n\nReport the exact program outputs at the end.")

    base = json.loads((REPO / "settings/claude-settings.json").read_text(encoding="utf-8"))
    base["env"]["ANTHROPIC_BASE_URL"] = "http://127.0.0.1:8791"   # 用系統 router（全 Silk）
    sp = d / "settings.json"
    sp.write_text(json.dumps(base, ensure_ascii=False, indent=2), encoding="utf-8")

    t0 = time.time()
    try:
        p = subprocess.run([CLAUDE, "-p", prompt, "--model", "claude-sonnet-4-5",
                            "--settings", str(sp), "--output-format", "text"],
                           capture_output=True, text=True, timeout=600, cwd=str(d),
                           env={k: v for k, v in os.environ.items() if not k.startswith("ANTHROPIC")})
        rc, out = p.returncode, (p.stdout or "")
    except subprocess.TimeoutExpired:
        rc, out = -9, "(timeout)"
    secs = round(time.time() - t0, 1)

    # ── 客觀驗收 ──
    results = {}
    for _, _, fname, expect in TASKS:
        f = d / fname
        if not f.exists():
            results[fname] = "MISSING"
            continue
        if fname.endswith(".py"):
            r = subprocess.run([sys.executable, str(f)], capture_output=True, text=True, timeout=60, cwd=str(d))
            text = (r.stdout or "") + (r.stderr or "")
            ok = r.returncode == 0 and all(e in text for e in expect)
            results[fname] = "PASS" if ok else f"FAIL(rc={r.returncode})"
        else:
            text = f.read_text(encoding="utf-8")
            results[fname] = "PASS" if all(e in text for e in expect) else "FAIL"

    passed = sum(1 for v in results.values() if v == "PASS")
    return {"mode": mode, "label": label, "run": run_idx, "secs": secs, "exit": rc,
            "passed": passed, "total": len(TASKS), "results": results, "answer": out.strip()[:200]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--jobs", type=int, default=3, help="並行跑幾個 (mode,run) 組合，預設 3")
    ap.add_argument("--only", default=",".join(MODES))
    args = ap.parse_args()
    modes = [m.strip() for m in args.only.split(",") if m.strip()]
    SCRATCH.mkdir(parents=True, exist_ok=True)

    jobs = [(m, i + 1) for m in modes for i in range(args.runs)]
    rows = []
    from concurrent.futures import ThreadPoolExecutor, as_completed
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futs = {pool.submit(run_mode, m, i): (m, i) for m, i in jobs}
        for f in as_completed(futs):
            r = f.result()
            rows.append(r)
            print(f"  ✔ {r['mode']} run{r['run']}: {r['passed']}/{r['total']} {r['secs']}s {r['results']}", flush=True)
    rows.sort(key=lambda r: (r["mode"], r["run"]))

    out_dir = REPO / ".exp/logs"
    out_dir.mkdir(parents=True, exist_ok=True)
    fp = out_dir / f"bench-layers-{time.strftime('%Y%m%d-%H%M%S')}.json"
    fp.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n寫入 {fp}\n")
    print(f"{'mode':9} {'pass':>6} {'median s':>9} {'runs':>5}")
    for mode in modes:
        rs = [r for r in rows if r["mode"] == mode]
        secs = sorted(r["secs"] for r in rs)
        med = secs[len(secs) // 2]
        print(f"{mode:9} {sum(r['passed'] for r in rs)}/{sum(r['total'] for r in rs):<4} {med:>9.1f} {len(rs):>5}")


if __name__ == "__main__":
    main()
