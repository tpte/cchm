# AGENTS.md — 給接手 agent 的說明

這個 repo 是「Claude Code 外殼」：把 Claude Code 的模型呼叫接到本機 router，讓便宜的模型分工做事。
先讀 `notes/roadmap.md`（做到哪、還差什麼），再讀 `docs/DEV_ENV.md`（環境與指令）。

## 一句話架構

```
claude（Claude Code CLI）
  └─ ANTHROPIC_BASE_URL → http://127.0.0.1:8791  (src/router.mjs, systemd user unit cchm-router)
       ├─ model 含 mimo / claude-sonnet / claude-opus → wildwestapi.com   （調度腦）
       ├─ model 含 deepseek / claude-haiku            → openrouter.ai     （工作手）
       └─ model 以 hh- 開頭                            → wildwest outlaw  （重車道）
```

## 怎麼跑

```bash
cchm                       # 進一個專案目錄後執行；會自動確認 router 在跑，再 exec claude
scripts/cchm-doctor        # 一鍵自檢：router、權杖、三車道延遲、count_tokens、用量統計
scripts/bench-lanes.py     # A/B 比較「主對話固定 + 工作手換模型」的通過率、牆鐘、成本
                           #   --only A,B1  --tasks T1,T3；結果寫 .exp/logs/bench-*.json
```

## 怎麼改

- **加一個模型或換上游**：改 `src/router.mjs` 的 `CLAUDE_ALIAS`／`ALIAS_MAP`／`routeFor`。
  不要在 `settings/claude-settings.json` 硬寫真模型名——Claude Code 只認自家名字，寫別名它會警告不認得。
- **改完要重啟 router 才生效**：`systemctl --user restart cchm-router.service`。
  （只改檔不重啟 = 沒生效。曾因此讓 `claude-sonnet-4-5` 原樣打到 OpenRouter 的真 Claude，白付一次錢。）
- **改完跑 `scripts/cchm-doctor`**，全綠才算完成。

## 驗收條件（不能只看「檔案改了」）

1. `scripts/cchm-doctor` 全部 ✅
2. `claude -p "Reply with exactly: OK" --model claude-sonnet-4-5 --settings settings/claude-settings.json` 回 `OK`，且 stderr 沒有 "doesn't recognize the model"
3. 端到端一次 Task 子代理：`claude -p "Use the Task tool ... reply SUBOK"` 能拿到回覆，且 `router.log` 出現 `model=deepseek/...:nitro → openrouter`

## 地雷（踩過）

- **改了 router 沒重啟**：症狀是新邏輯完全沒生效，但 `node --check` 綠、檔案也對。永遠 restart 後再驗。
- **未知 model 名會直通上游**：OpenRouter 上有 `claude-*` 真模型，一個名字漏了就會真的打到 Anthropic 帳單。`normalizeModel` 有一道保險把任何 `claude-*` 導回 mimo，別拿掉。
- **`tr -d '\r'` 在 bash 單引號裡是刪掉「反斜線和字母 r」**，不是 CR；要寫 `tr -d '\015'`。這個 bug 會默默把金鑰裡的 `r` 去掉。
- **context window 設太大**：`CCHM_CONTEXT` 超過 200k，Claude Code 就不自動壓縮，每回合重送肥 context，便宜腦的好處直接被吃掉。
- **`~/.local/bin/cchm` 是實體檔不是 symlink**：改完 `bin/cchm` 要 `cp bin/cchm ~/.local/bin/cchm`，否則跑的是舊版。
- **`.exp/logs/` 與 `.exp/` 不進版控**（`.gitignore`），但那是 router 的 log 與用量紀錄所在，debug 先看那裡。

## 檔案位置

| 檔案 | 作用 |
|---|---|
| `src/router.mjs` | 分流代理（零依賴，SSE 直通，含換道與用量日誌） |
| `bin/cchm` | 啟動器；灌 dispatcher 系統提示、設視窗大小、確認 router |
| `bin/cchm-exp` | 自我改造沙箱（改 router 前先在那裡試） |
| `settings/claude-settings.json` | Claude Code 設定（模型別名、權限、deny 清單） |
| `agents/*.md` | dispatcher（系統提示）、cchm-hacker、cchm-verifier、cchm-heavy |
| `scripts/cchm-doctor` | 自檢腳本 |
| `deploy/cchm-router.service` | systemd user unit 樣板 |
| `~/.claude/agents/cchm-*.md` | agent 定義的安裝位置（從 `agents/` 複製） |
