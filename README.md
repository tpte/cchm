# Claude Code Hacking Mode (cchm)

特殊 Claude Code CLI：**MiMo 2.6 Flash 當調度腦，只拆任務、派工；DeepSeek V4.1 Flash 1017 (nitro) 當工作手，實際寫碼。**

```
claude ──► 本機 router (127.0.0.1:8791) ─┬─ mimo-v2.6-flash-outlaw ─────────► wildwestapi.com
                                         └─ deepseek-v4.1-flash-1017:nitro ─► openrouter.ai/api/v1
```

## 快速開始

```bash
mkdir myproject && cd myproject && cchm
```

- 主對話（MiMo）：收到需求 → 拆解 → 並行派 subagent → 驗收
- Subagent / Task 工具：自動走 DeepSeek nitro
- `bypassPermissions` 已預設開啟

## 安裝

```bash
git clone <repo> && cd cchm
cp bin/cchm ~/.local/bin/cchm   # 或 ln -s
cp agents/hacker.md ~/.claude/agents/cchm-hacker.md
```

金鑰來源（擇一）：
- `WILDWEST_API_KEY` 環境變數，或 `$HOME/.hermes/.secrets/wildwest.env`
- `OPENROUTER_API_KEY` 環境變數，或 `$HOME/.hermes/.env`

## 調整

| 變數 | 預設 | 用途 |
|---|---|---|
| `CCHM_PORT` | `8791` | router 埠 |
| `CCHM_BRAIN_MODEL` | `mimo-v2.6-flash-outlaw` | 調度腦 |
| `CCHM_WORKER_MODEL` | `deepseek/deepseek-v4.1-flash-1017:nitro` | 工作手 |
| `CCHM_CONTEXT` | `524288` | context window tokens |
| `CCHM_MAX_OUTPUT` | `64000` | max output tokens |

路由規則在 `src/router.mjs` 的 `ROUTE_RULES`，前綴比對、好加新模型。

## 架構細節

- Router 是零依賴 Node proxy（只用內建 http/https），SSE 直通不緩衝。
- 調度腦提示在 `agents/dispatcher.md`，啟動器用 `--append-system-prompt` 灌進主對話。
- 工作手 agent 定義在 `agents/hacker.md`，裝到 `~/.claude/agents/cchm-hacker.md`。
- 不影響原 `claude` / `ccun` / `ccds`——環境變數只在這個 process 內生效。
