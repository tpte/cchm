# Roadmap / 現況

最後更新：2026-11-10

## 這個專案要什麼

四條軸，依重要性：

1. **繞過審查**（核心需求）：模型不會因為內容主題而停手；上游擋了有替代路徑。
2. **質量**：產出要能被驗收，不能靠模型自述「我做完了」。
3. **效率**：便宜模型做便宜的事，昂貴的 context 不要浪費。
4. **架構**：單一端點、可換模型、掛掉會自己回來、可被下一個 agent 接手。

## 已完成

### 2026-11-10 第一輪硬化（router v0.2.0）

| 項目 | 軸 | 內容 |
|---|---|---|
| 車道別名 | 架構 | `claude-sonnet/opus-*` → mimo（腦）、`claude-haiku-*` → 1017 nitro（手）、`hh-*` → outlaw。設定檔用官方名，Claude Code 不再警告「不認得模型」 |
| 未知 claude 名的保險 | 繞審查＋帳單 | 任何沒對到的 `claude-*` 一律導回 mimo，避免原樣打到 OpenRouter 的真 Claude |
| count_tokens 修正 | 架構 | OpenRouter 沒這端點（實測 404）→ 一律走 wildwest tokenizer，失敗則本地估算 |
| `/v1/models` 本地化 | 架構 | 回自家三條車道，不直通上游 |
| 換道 failover | 繞審查 | `403,429,5xx` 自動換到另一家重試一次（403＝政策封鎖 → 換 outlaw 車道）。已用 `CCHM_FAILOVER_CODES=400` 演練驗證 |
| 指紋清洗 | 繞審查 | 只放行 content-type/accept/anthropic-version/anthropic-beta，其餘 header（user-agent、x-stainless-*、x-app…）一律不轉發，UA 統一 `cchm/0.2` |
| 本地權杖 | 架構 | 沒帶 token 回 401，避免本機任何程式白嫖金鑰 |
| keep-alive 連線池 | 效率 | 省 TLS 握手 |
| 用量日誌 | 效率 | `usage.jsonl` 每筆一行：model/upstream/status/ms/bytes/retry/failover |
| context 視窗 | 效率 | 524288 → **200000**；設太大會讓 Claude Code 不自動壓縮，每回合重送肥 context |
| systemd user unit | 架構 | `cchm-router.service`（Restart=always、linger=yes），掛掉 2 秒後自己回來，開機自動起 |
| 自檢腳本 | 質量 | `scripts/cchm-doctor`：router／權杖／三車道延遲／count_tokens／近 100 筆成功率 |
| verifier 角色 | 質量 | `agents/verifier.md`：只讀審查者，逐條對驗收條件、回缺陷清單、不改檔 |
| 派工與驗收紀律 | 質量 | dispatcher：每張工單必寫可驗條件、回來逐條對、外部效果另驗；hacker：不准捏造（沒跑過不能說通過） |
| 防自傷 deny | 架構 | settings 加 deny：force push、`reset --hard`、`rm -rf /`、讀 `.env`／`~/.ssh/id_*` |

### 實測數據（2026-11-10，本機，串流首字）

| 車道 | 模型 | 首字延遲 |
|---|---|---|
| brain | mimo-v2.6-flash-outlaw（wildwest） | 2.0–5.3s（波動大，同一請求重測可差 2.5 倍） |
| worker | deepseek-v4.1-flash-1017:nitro（openrouter） | **0.5–1.0s** |
| heavy | deepseek-v4.1-flash-1017-outlaw（wildwest） | 2.6–3.3s |

**結論**：outlaw 重車道不是「快車道」，比工作手慢約 5 倍。舊 README 寫「快一倍」不成立，已修正。
端到端實測：`claude -p` 走 sonnet 名 → router → mimo，10 秒內完成；Task 子代理 → nitro 594ms。

## 待辦（依價值排序）

1. **拒絕自動換道（串流版）**：目前只在 HTTP 錯誤層換道。SSE 已吐出的內容無法回捲，所以「內容級」refusal 偵測**刻意沒做**——做了只會讓使用者看到重複內容。真正可行的是「派出前升級」：偵測 prompt 含高風險主題時自動改走 outlaw 車道（`CCHM_AUTO_ESCALATE`）。要做的話先設計誤判成本。
2. **用量成本換算**：`usage.jsonl` 目前只有 bytes 與延遲，沒有 token 數與金額。下一步在 router 解析 SSE 最後的 `message_delta.usage`，累計每日成本。
3. **第二家無審核上游**：現在 wildwest 是唯一 outlaw 來源，它掛了就只剩 openrouter。要找第二家並在 `UPSTREAMS` 加一條（也需要模型名對照）。
4. **prompt cache**：Anthropic 格式的 `cache_control` 目前原樣直通，但沒驗證上游是否真的吃到。值得實測一次（同一段長 system prompt 連送兩次，看延遲與計費差異）。
5. **`bin/cchm-exp` 沙箱化**：目前只是另一支啟動器，沒有真的隔離。理想的自我改造流程是「改 router → 沙箱跑 doctor → 通過才 promote」，promote 那步已經有自動 push，但缺沙箱驗證。

## 已決定不做（避免重複討論）

- **SSE 串流中途的 refusal 偵測與重發**：做不到不影響使用者體驗，理由見待辦 1。
- **把 `ROUTE_RULES` 改成資料驅動的表**：目前 `routeFor` 已經足夠，多一層抽象沒有換到什麼。

## 文件索引

- `AGENTS.md`：接手者要看的地雷與驗收條件
- `docs/DEV_ENV.md`：環境、端點、環境變數
- `README.md`：使用者面向的安裝與用法
