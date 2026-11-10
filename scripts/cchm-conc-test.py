#!/usr/bin/env python3
"""併發壓測：驗證 cchm router 的排隊與重試是否生效。

用法：
  python3 scripts/cchm-conc-test.py            # 併發 12 打 127.0.0.1:8791
  python3 scripts/cchm-conc-test.py -n 16 -p 8792

判讀：全部 200 就算通過。修 D016 之前，同樣情境會出現大量 429
（Silk 帳號同時上限 8 個請求）。要驗「重試路徑」就起一個
CCHM_MAX_CONCURRENT=20 的實例再打超過 8 併發，看 usage.jsonl 的 op=retry。
"""
import argparse
import collections
import concurrent.futures as cf
import json
import time
import urllib.error
import urllib.request


def one(port, i, token, timeout):
    body = json.dumps({
        "model": "claude-sonnet-4-5",
        "max_tokens": 6,
        "messages": [{"role": "user", "content": "say ok"}],
    }).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/messages", data=body,
        headers={"content-type": "application/json",
                 "authorization": f"Bearer {token}",
                 "anthropic-version": "2023-06-01"})
    t = time.time()
    try:
        urllib.request.urlopen(req, timeout=timeout).read()
        return 200, round(time.time() - t, 1)
    except urllib.error.HTTPError as e:
        e.read()
        return e.code, round(time.time() - t, 1)
    except Exception:
        return -1, round(time.time() - t, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", type=int, default=12, help="併發數")
    ap.add_argument("-p", "--port", type=int, default=8791)
    ap.add_argument("--token", default="cchm-local")
    ap.add_argument("--timeout", type=int, default=180)
    a = ap.parse_args()
    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=a.n) as ex:
        res = list(ex.map(lambda i: one(a.port, i, a.token, a.timeout), range(a.n)))
    codes = dict(collections.Counter(s for s, _ in res))
    print(f"併發 {a.n} → port {a.port}: {codes} 牆鐘 {round(time.time() - t0, 1)}s")
    print("個別延遲:", [d for _, d in res])
    print("PASS" if codes.get(200) == a.n else "FAIL（有非 200）")


if __name__ == "__main__":
    main()
