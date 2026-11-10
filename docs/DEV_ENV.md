# DEV_ENV — 本機環境與指令

## 主機

- Linux 桌機 `omarchy-msi`，使用者 `alan`（sudo 免密）
- repo：`/home/alan/cchm`（GitHub `tpte/cchm`，public）
- node：`~/.local/share/mise/shims/node`（v26.12.1，mise 管理）
- claude：`~/.local/share/mise/shims/claude`（v2.1.322）

## 常駐服務

| 東西 | 位置 | 管理方式 |
|---|---|---|
| router | `127.0.0.1:8791` | systemd user unit `cchm-router.service`（Restart=always，linger=yes 所以開機就會起） |
| router log | `~/cchm/.exp/logs/router.log` | 單位檔的 StandardOutput |
| 用量紀錄 | `~/cchm/.exp/logs/usage.jsonl` | 每筆請求一行 JSON（model／upstream／status／ms／bytes／retry） |

```bash
systemctl --user status cchm-router.service
systemctl --user restart cchm-router.service
journalctl --user -u cchm-router.service -n 50
```

## 金鑰

| 變數 | 來源 | 用途 |
|---|---|---|
| `WILDWEST_API_KEY` | `~/.hermes/.secrets/wildwest.env` 或 `~/.hermes/.env` | 調度腦（mimo）、重車道（outlaw） |
| `OPENROUTER_API_KEY` | `~/.hermes/.env` | 工作手（1017 nitro）、`/v1/models` 來源 |

`bin/cchm` 會自己讀檔並 export；router 自己也讀同一組檔。**不要**把金鑰寫進 repo 或 log。

## 端點（router 提供）

| 端點 | 說明 |
|---|---|
| `POST /v1/messages` | 主通道，依 model 名分流、SSE 直通 |
| `POST /v1/messages/count_tokens` | 一律送 wildwest tokenizer（OpenRouter 回 404），失敗則本地估算並標 `estimated:true` |
| `GET /v1/models` | **本地**車道清單（不直通上游，避免看到別家目錄） |
| `GET /healthz` | `{ok, version, uptime_s, routes, lanes, auth, keys}` |

所有端點都要帶 `x-api-key: cchm-local`（或 `Authorization: Bearer cchm-local`），否則 401。
設 `CCHM_REQUIRE_TOKEN=""` 可關閉檢查。

## 常用環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `CCHM_PORT` | `8791` | router 埠 |
| `CCHM_CONTEXT` | `200000` | 上下文視窗。**不要**調到 200k 以上，會讓 Claude Code 不自動壓縮 |
| `CCHM_MAX_OUTPUT` | `64000` | 最大輸出 token |
| `CCHM_FAILOVER_CODES` | `403,429,500,502,503,504,529` | 這些狀態碼觸發換道（403 = 政策封鎖，換 outlaw） |
| `CCHM_REQUIRE_TOKEN` | `cchm-local` | 本地權杖 |
| `CCHM_TOKENIZER_MODEL` | `mimo-v2.6-flash-outlaw` | count_tokens 用的 tokenizer |
| `CCHM_LOG_DIR` | `~/cchm/.exp/logs` | 用量日誌目錄 |
| `CCHM_BRAIN_MODEL` | `claude-sonnet-4-5` | 主對話模型名（可改真模型名） |
| `CCHM_BRAIN_LANE` | `outlaw` | `fast` = 調度腦改走 openrouter 的 `xiaomi/mimo-v2.6-flash`（0.83s、$0.14/M，快又便宜，**但有審查、實測會拒繞限流類請求**） |
| `CCHM_BRAIN_FAST_MODEL` | `xiaomi/mimo-v2.6-flash` | fast 車道的腦模型（ultraspeed 實測貴 4 倍又會拒，已棄用） |
| `CCHM_BRAIN_FALLBACK` | `xiaomi/mimo-v2.6-flash` | wildwest 掛掉／擋住時的腦備援（openrouter） |
| `CCHM_DEFAULT_ROUTE` | `openrouter` | 認不出的 model 走哪家 |
| `CCHM_HEAVY_ROUTE` | `wildwest` | `hh-` 前綴走哪家 |

## 快速驗證

```bash
scripts/cchm-doctor
curl -s http://127.0.0.1:8791/healthz -H 'x-api-key: cchm-local' | jq .
claude -p "Reply with exactly: OK" --model claude-sonnet-4-5 \
  --settings /home/alan/cchm/settings/claude-settings.json --output-format text
```
