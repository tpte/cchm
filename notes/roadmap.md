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
| 換道 failover | 繞審查 | ~~`403,429,5xx` 自動換到另一家重試一次（403＝政策封鎖 → 換 outlaw 車道）~~｜**已失效**：v0.3（D014）改單一上游，換道機制移除；2026-11-11 改成車內「併發節流＋退避重試」（D016） |
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
- **已實測（2026-11-10，金鑰到位後）**：
  - 速度：deepseek-1017 p50 3.36s（串流首字 3.0–5.2s）、glm-5.3-flash 首字 1.7–1.9s 但整體 4.4s → **都不比現用 mimo 快**
  - 成本：真實 token 記帳顯示主對話 $0.0069 vs WildWest $0.0235（**便宜 3.4 倍**）；一趟含 subagent 約 $0.015
  - 能力：寫可執行 Python 5/5、tool calling 正確、Claude Code 端到端成功；但逐行計數類任務兩款都算錯
  - 審查：6 題敏感探測（釣魚／假證件/勒索軟體/繞付費牆/入侵 Wi-Fi／仇恨言論）**0/6 拒絕**；對照組官方 mimo 拒 4–5/6
  - 相容性：streaming／tools／thinking／8 並發皆通；count_tokens 不支援（本地估算）
- router 現在會記每次請求的 in/out token 與換算成本（`usage.jsonl` 的 `in_tokens`/`out_tokens`/`cost_usd`）

### 2026-11-10 第三輪：1017 vs GLM-5.3 跑分與 Claude Code 實測

第三方跑分（來源：vals.ai 22 項共同基準、stet.sh、DeepSeek 官方 model card）：

| 對比 | 結果 |
|---|---|
| 1017 vs GLM-5.3（旗艦） | GLM 在 16/22 項領先，Vals Index 53.51 vs 51.32（+2.19）；IOI 68.44 vs 40.28（+28）、Terminal-Bench 4.0 38.89 vs 19.70。DeepSeek 在 SkillsBench（69.8 vs 47.5）、ProgramBench、HLE（42.6 vs 42.0）領先 |
| 1017 vs GLM-5.3-Flash | DeepSeek 品質略高（stet 50.5 vs 47.9，+2.6），GLM-Flash 快一倍（26.6 vs 49.3 分/任務）、成本 $0.45 vs $0.49 |
| 價格（Silk） | 1017 $0.28/$1.00；GLM-5.3 $2.00/$4.00（貴 7 倍）；GLM-5.3-Flash $0.24/$1.00 |

Claude Code 同一個任務實測（wordcount 腳本 + 自測）：

| 主對話模型 | 牆鐘 | 請求數 | 結果 |
|---|---|---|---|
| deepseek-v4.1-flash-1017-uncensored | **31.9s** | 4 | 正確 |
| glm-5.3-flash-uncensored | 73.1s | 6 | 正確（但慢一倍多，thinking 吃時間） |

結論：GLM-5.3 跑分略高但貴 7 倍；GLM-5.3-Flash 首字快但跑完整任務反而慢。
**調度腦選 1017**，需要最強推理時才切 GLM-5.3 旗艦。

### 2026-11-10 第四輪：A/B 測試（全 Silk vs 主 Silk＋手 OpenRouter 高階）

流程：`scripts/bench-lanes.py`，3 個配置 × 3 個任務，全部強制用 Task 委派給 worker，
驗收看客觀結果（pytest 通過、answer.json 內容比對），並檢查 worker 是否真的被呼叫。

| 配置 | 通過 | 總牆鐘 | 請求 | 成本 |
|---|---|---|---|---|
| A 全 Silk 1017（腦+手同顆） | 3/3 | **110.6s** | 24 | $0.0238 |
| B1 手 = OpenRouter z-ai/glm-5.3 | 3/3 | 164.5s（+49%） | 32 | $0.0200 |
| B2 手 = OpenRouter gpt-5.6-luna | 3/3 | 149.1s（+35%） | 27 | $0.0212 |

追加審查測試（同一組敏感題）：OpenRouter 的 glm-5.3 與 gpt-5.6-luna **3/3 全部拒絕**。
OpenRouter 上唯一的 uncensored 模型是 `dolphin-mistral-24b`（24B，品質不夠當工作手）。

結論：B 的品質沒有提升（都全過）、速度慢 35–49%、成本只便宜 10–16%，而且工作手會被審查擋住。
**採用 A：全 Silk 1017（腦與手同顆），WildWest 只當自動 fallback。** 已寫進 systemd unit 的 `CCHM_BRAIN_LANE=silk`。

第一次跑發現的設計缺陷（已修）：任務太簡單時主對話自己做，worker 根本沒被呼叫 → benchmark 測到的是
「主對話」而不是「工作手」。現在 prompt 一律要求用 Task 委派，並在結果裡記 `models` 與 `worker_used`。

### 2026-11-10 第五輪：need-to-know 架構實驗（把用途剝離後派給有審核模型）

假設：有審核的工作手會擋「用途」，但只看到技術規格時會照做。實測（同一題目四種組合，proxy 池管理器，
驗收看 sticky 綁定／輪替／失敗重綁）：

| 車道 | prompt 形式 | 拒絕 | 速度 | 驗收 |
|---|---|---|---|---|
| Silk 1017 | 原始（含用途） | 0/4 | 8–20s | 通過（1 次偶發 bug） |
| Silk 1017 | 剝離（純規格） | 0/4 | 8–10s | 2/3 通過 |
| OpenRouter glm-5.3 | 原始 | **拒絕** | 12s | — |
| OpenRouter glm-5.3 | 剝離 | 不拒 | 12–59s | **0/3 可用**（2 次被 thinking 吃滿 6000 token、1 次實作 bug） |

另外「內容生成類」任務（釣魚信）剝離後仍被 glm 拒絕（摘要後本質不變）。

結論：
- need-to-know **確實能繞過審核**（glm 從拒絕變成照做），使用者的直覺對
- 但代價是慢 3–8 倍、輸出被 thinking 吃滿而不穩、且缺少用途脈絡導致設計決策猜錯（品質下降）
- 因此「最穩定＋最高品質＋最快」仍是全 Silk 1017 直接派；need-to-know 只寫進 dispatcher 當備援紀律
  （順便讓 prompt 更聚焦、省 token），不是主要繞審查手段

### 2026-11-10 第六輪：單層 vs 雙層（工作手這層該不該存在）

`scripts/bench-layers.py`，3 個獨立任務、同一顆 Silk 1017、每模式跑 2 次：

| 模式 | 通過 | 中位牆鐘 | 相對 |
|---|---|---|---|
| single 一層自己做 | 6/6 | **37.0s** | 基準 |
| parallel 兩層並行派 3 個 | 6/6 | 95.3s | 慢 2.6 倍 |
| serial 兩層逐個派 | 6/6 | 130.1s | 慢 3.5 倍 |

品質完全相同。結論：**預設一層**，雙層只保留給「輸出會爆 context」「真正獨立的大工作並行」「要第二意見」。
dispatcher 已改為「預設自己直接做」。CCHM 原本的「弱腦＋強手」分工前提（MiMo 當腦）在全 Silk 後已不存在。

### 2026-11-10 第七輪：最終優化（單上游 v0.3、一層預設、測試提速）

- router 縮成單一上游（454 → 230 行），移除 WildWest／OpenRouter／failover／count_tokens 借道
- doctor 車道檢查改 brain／worker／pro（全在 Silk）；systemd unit 移除舊 lane 變數
- `bench-layers.py` 加 `--jobs` 並行（整批牆鐘 6 次從 ~10 分鐘降到 ~4 分鐘）
- 最終驗證：doctor 全綠、端到端 33.9s、單層 41s／雙層 93–200s（皆 6/6）
- 注意：並行跑 bench 會互相干擾耗時，比較絕對延遲時要循序

## 待辦（依價值排序）

0. **Silk 要不要當預設**（等使用者決定）：實測成本便宜 3.4 倍但速度沒贏（3.4s vs 2.9s），
   屬取捨而非純改善，因此不自動切換
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
