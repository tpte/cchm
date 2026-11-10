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
| 調度腦雙車道 | 效率＋繞審查 | 預設 outlaw（wildwest，p50 2.9s、無審核）；`CCHM_BRAIN_LANE=fast` 改走 openrouter `mimo-v2.6-flash`（0.83s、$0.14/M，但有審查且時拒時做）；wildwest 失敗自動 fallback 到同一顆 |
| 車道實測與成本表 | 效率 | wildwest 11 顆全測：現用 mimo-outlaw 最快（2.9s）。同顆 mimo 走 openrouter 0.83s → **延遲差在通路不在模型**。ultraspeed（$4.35/$8.7）會明確拒絕繞限流請求且沒更快，已從 fast 車道移除 |
| outlaw 真名路由修正 | 架構 | 直接指定 `deepseek-v4.1-flash-1017-outlaw` 原本會被誤送 openrouter（實測失敗），已改成含 outlaw 一律走 wildwest |
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

### 2026-11-10 第二輪：接 Silk Compute（待實測延遲）

- router 加 `UPSTREAMS.silk`（`api.silkcompute.com`，Anthropic Messages 原生），沒有金鑰就自動停用
- `CCHM_BRAIN_LANE=silk` → 調度腦走 `deepseek-v4.1-flash-1017-uncensored`
- Silk ⇄ WildWest 互為備援：`-uncensored` ⇄ `-outlaw` 自動改名；無 Silk 金鑰時也自動降級
- 查價結論：同一批 abliterated 模型，Silk 比 WildWest 便宜 2～4.5 倍（1017：$0.28/$1.00 vs $1.25/$2.50）；
  Kimi K3.1 Pro 輸出 $15 vs $37.5。Silk 沒有 MiMo。
- **未驗**：Silk 的實際首字延遲與拒絕率（需要 API key，$5 起預付）

## 待辦（依價值排序）

0. **Silk 實測**（阻塞中：需要 key）：拿到 `SILK_API_KEY` 後跑 `scripts/cchm-doctor` 加 silk 段，
   量 p50 與拒絕率，若 <2s 就把預設調度腦切到 silk（目前 wildwest 2.9s、貴 4.5 倍）
1. **拒絕自動換道（串流版）**：目前只在 HTTP 錯誤層換道。SSE 已吐出的內容無法回捲，所以「內容級」refusal 偵測**刻意沒做**——做了只會讓使用者看到重複內容。真正可行的是「派出前升級」：偵測 prompt 含高風險主題時自動改走 outlaw 車道（`CCHM_AUTO_ESCALATE`）。要做的話先設計誤判成本。
2. **用量成本換算**：`usage.jsonl` 目前只有 bytes 與延遲，沒有 token 數與金額。下一步在 router 解析 SSE 最後的 `message_delta.usage`，累計每日成本。
3. **第二家無審核上游**：現在 wildwest 是唯一 outlaw 來源。已補「腦的備援」（wildwest 掛 → openrouter 的 `xiaomi/mimo-v2.6-flash`），但那是審核版，不算第二家無審核供應商。要找第二家並在 `UPSTREAMS` 加一條（需要模型名對照）。
4. **prompt cache**：Anthropic 格式的 `cache_control` 目前原樣直通，但沒驗證上游是否真的吃到。值得實測一次（同一段長 system prompt 連送兩次，看延遲與計費差異）。
5. **`bin/cchm-exp` 沙箱化**：目前只是另一支啟動器，沒有真的隔離。理想的自我改造流程是「改 router → 沙箱跑 doctor → 通過才 promote」，promote 那步已經有自動 push，但缺沙箱驗證。

## 已決定不做（避免重複討論）

- **SSE 串流中途的 refusal 偵測與重發**：做不到不影響使用者體驗，理由見待辦 1。
- **把 `ROUTE_RULES` 改成資料驅動的表**：目前 `routeFor` 已經足夠，多一層抽象沒有換到什麼。

## 文件索引

- `AGENTS.md`：接手者要看的地雷與驗收條件
- `docs/DEV_ENV.md`：環境、端點、環境變數
- `README.md`：使用者面向的安裝與用法
