# Claude Code Hacking Mode (cchm)

特殊 Claude Code CLI：**MiMo 2.6 Flash 當調度腦，只拆任務、派工；DeepSeek V4.1 Flash 1017 (nitro) 當工作手，實際寫碼。**

```
claude ──► 本機 router (127.0.0.1:8791) ─┬─ mimo-v2.6-flash-outlaw ─────────► wildwestapi.com   （調度腦）
                                         ├─ deepseek-v4.1-flash-1017:nitro ─► openrouter.ai/api/v1（工作手）
                                         └─ hh-*（outlaw 版）───────────────► wildwestapi.com   （重車道）
```

## 快速開始

```bash
mkdir myproject && cd myproject && cchm
```

- 主對話（MiMo）：收到需求 → 拆解 → 並行派 subagent → 驗收
- Subagent / Task 工具：自動走 DeepSeek nitro
- `bypassPermissions` 已預設開啟（另附 deny 清單擋 force push／`rm -rf /`／讀 `.env`）
- 模型名用 Claude Code 認得的 `claude-sonnet-4-5`／`claude-haiku-4-5`，router 再翻成真模型，所以不會出現「不認得這個模型」的降級

## 安裝

```bash
git clone <repo> && cd cchm
cp bin/cchm ~/.local/bin/cchm                    # 注意是複製，不是 symlink
mkdir -p ~/.claude/agents
cp agents/hacker.md agents/verifier.md agents/heavy.md ~/.claude/agents/   # 檔名已是 cchm-*.md 則直接覆蓋
# router 常駐（掛掉自動重啟、開機自動起）
mkdir -p ~/.config/systemd/user ~/cchm/.exp/logs
cp deploy/cchm-router.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now cchm-router.service
```

金鑰來源（擇一）：
- `WILDWEST_API_KEY` 環境變數，或 `$HOME/.hermes/.secrets/wildwest.env`
- `OPENROUTER_API_KEY` 環境變數，或 `$HOME/.hermes/.env`

## 自檢

```bash
scripts/cchm-doctor      # router／權杖／三車道延遲／count_tokens／近 100 筆成功率
```

## 調整

| 變數 | 預設 | 用途 |
|---|---|---|
| `CCHM_PORT` | `8791` | router 埠 |
| `CCHM_BRAIN_MODEL` | `claude-sonnet-4-5` | 調度腦（router 翻成 mimo） |
| `CCHM_WORKER_MODEL` | `claude-haiku-4-5` | 工作手（router 翻成 1017 nitro） |
| `CCHM_CONTEXT` | `200000` | context window tokens（**別調高**，會讓 Claude Code 不自動壓縮） |
| `CCHM_MAX_OUTPUT` | `64000` | max output tokens |
| `CCHM_FAILOVER_CODES` | `403,429,500,502,503,504,529` | 這些狀態碼自動換道重試 |
| `CCHM_REQUIRE_TOKEN` | `cchm-local` | 本地權杖（空字串＝關閉檢查） |
| `CCHM_BRAIN_LANE` | `outlaw` | `fast` = 調度腦改走 openrouter 的 mimo-v2.6-flash（0.83s、$0.14/M，快又便宜，但有審查） |

路由與別名在 `src/router.mjs` 的 `CLAUDE_ALIAS` / `ALIAS_MAP` / `routeFor`，加新模型只改那裡。

## 架構細節

- Router 是零依賴 Node proxy（只用內建 http/https），SSE 直通不緩衝，keep-alive 連線池。
- **本地端點**：`/healthz`、`/v1/models`（自家的車道清單，不直通上游）、`/v1/messages/count_tokens`（OpenRouter 沒有這端點，一律走 wildwest tokenizer）。
- **自動換道**：上游回 403／429／5xx 時，工作手會自動改用 wildwest 的 outlaw 版重試一次（403 = 政策封鎖時這條等於繞審查的備援）。
- **指紋清洗**：只轉發 content-type／accept／anthropic-version／anthropic-beta，其餘 client header 一律不送，UA 統一 `cchm/0.2`。
- **用量日誌**：`~/cchm/.exp/logs/usage.jsonl`，每筆一行（model／upstream／status／ms／bytes／retry）。
- 調度腦提示在 `agents/dispatcher.md`，啟動器用 `--append-system-prompt` 灌進主對話。
- 工作手與審查者 agent 定義在 `agents/`，裝到 `~/.claude/agents/cchm-*.md`。
- 不影響原 `claude` / `ccun` / `ccds`——環境變數只在這個 process 內生效。

## 成本與審查（2026-11-10 實測，每 1M token）

| 車道 | 模型 | 輸入 | 輸出 | 首字 | 審查 |
|---|---|---|---|---|---|
| 調度腦（預設） | wildwest `mimo-v2.6-flash-outlaw` | $1.00 | $2.00 | 2.9s | 無審核，實測直接給腳本 |
| 調度腦 `fast` | openrouter `xiaomi/mimo-v2.6-flash` | **$0.14** | **$0.28** | **0.83s** | 有審查，實測時拒時做（不穩） |
| 工作手 | openrouter `deepseek-v4.1-flash-1017:nitro` | $0.006 | $0.50 | 0.5s | 有審查 |
| ~~fast（已棄用）~~ | openrouter `xiaomi/mimo-v2.6-pro-ultraspeed` | $4.35 | $8.70 | 1.32s | 有審查，實測明確拒絕 |

## Silk Compute 實測（2026-11-10，便宜兩款）

| 項目 | deepseek-v4.1-flash-1017-uncensored | glm-5.3-flash-uncensored | 現用 mimo-2.6-outlaw |
|---|---|---|---|
| 單價 in/out（每 1M） | $0.28 / $1.00 | $0.24 / $1.00 | $1.00 / $2.00 |
| 簡單請求 p50 | 3.36s（波動 2.0–5.2s） | 4.38s | 2.9s |
| 串流首字 | 3.0–5.2s | **1.7–1.9s** | 約 2.0s |
| 寫可執行 Python | 5/5 測試通過 | 5/5 | — |
| tool calling（Anthropic 格式） | ✅ 正確回 tool_use | ✅ | ✅ |
| 逐行計數類任務 | ❌ 算錯（答 36，正解 24） | ❌ 算錯（答 21） | — |
| 6 題敏感探測拒絕數 | **0 / 6** | **0 / 6** | **0 / 6** |
| Claude Code 端到端 | ✅ 建檔＋執行＋回報正確 | 未測 | ✅ |

對照組（OpenRouter 官方 `xiaomi/mimo-v2.6-flash`，有審核）同樣 6 題拒絕 **4–5 題**，證明探測本身能偵測到拒絕。

**成本實測**（Claude Code 一次含 subagent 的任務，router 記到的真實 token）：
主對話 22,051 in / 714 out = **$0.0069**；同等量走 WildWest mimo 是 $0.0235（貴 3.4 倍）；
subagent 走 OpenRouter nitro 是 $0.0040。整趟約 **$0.015**。

Agent 相容性：Anthropic Messages 原生、streaming、tool calling、thinking blocks、8 並發都通；
`count_tokens` 不支援（走本地估算）、沒有 web search 這類內建工具。

## 無審核供應商比較（每 1M token，2026-11-10 查價）

| 供應商 | 代表模型 | 輸入 | 輸出 | 格式 | 備註 |
|---|---|---|---|---|---|
| **Silk Compute** | `deepseek-v4.1-flash-1017-uncensored` | **$0.28** | **$1.00** | Anthropic ＋ OpenAI 原生 | 1M ctx、8 並發、1M 可快取、無留存；**無 MiMo** |
| WildWest（現用） | `mimo-v2.6-flash-outlaw` | $1.00 | $2.00 | Anthropic | 有 MiMo，通路較慢 |
| WildWest | `glm-5.3-flash-outlaw` | $0.30 | $1.00 | Anthropic | 便宜但實測 4.4s |
| Venice | `deepseek-v4-1-flash-1017-uncensored` | $0.33 | $1.32 | OpenAI 相容 | 有 E2EE 版、隱私分級 |
| ArliAI | 月費制 | $15/月起 | 無限 | OpenAI 相容 | context 上限 32K（$15）～512K（$160） |
| Featherless | 4 萬+ 開源模型 | $25/月（限人工聊天）／$50/月起按量 | — | OpenAI 相容 | 大量自動化要用 $50 開發方案 |
| Chutes | Qwen3.8-27B 等 | 約 $0.12 | 約 $0.37 | OpenAI 相容 | 最便宜，但模型較小 |

Silk 已接進 router（`UPSTREAMS.silk`）：有 `SILK_API_KEY` 就自動啟用，
`CCHM_BRAIN_LANE=silk` 可把調度腦切過去；沒有金鑰時 `-uncensored` 名會自動對到 WildWest 的 `-outlaw`。

延遲差異主要來自**通路**不是模型：同一顆 mimo，wildwest 中轉 2.9s、openrouter 直連 0.83s。
wildwest 11 顆模型實測，最快的仍是現用的 mimo-outlaw（2.9s），換無審核模型求快沒有空間。

## 實測（2026-11-10，本機串流首字）

| 車道 | 首字延遲 |
|---|---|
| 調度腦 mimo（wildwest） | 2.0–5.3s（波動大） |
| 工作手 1017 nitro（openrouter） | **0.5–1.0s** |
| 重車道 outlaw（wildwest） | 2.6–3.3s |

重車道**不是快車道**，它慢約 5 倍，價值在「無審核」與輸出精簡。

## 給接手的 agent

先讀 `AGENTS.md`（地雷、驗收條件）與 `notes/roadmap.md`（做到哪、還差什麼）。
