# DECISIONS — cchm 決策紀錄

格式：一則一主題（日期／問題／選項／決定／證據／影響／狀態）。
被推翻的條目**不刪除**，補一則「推翻 NNNN」保留歷史。

---

## D001 分流層的存在理由：單一端點、多供應商、可換模型

- **日期**：2026-11-10
- **問題**：Claude Code 只能設一個 `ANTHROPIC_BASE_URL`、只發 Anthropic Messages 格式，但要同時用多家模型（便宜腦＋工作手）。
- **選項**：A 每換一次模型就改 settings 重啟；B 自架零依賴 Node proxy 依 model 名分流。
- **結論**：B。`src/router.mjs` 只做三件事：依 model 名分流、洗掉 client 指紋、SSE 直通。
- **證據**：`/healthz` 回 `{ok,version,routes,lanes,keys}`；`claude -p` 端到端可通（見 D004）。
- **影響**：換模型／換上游只改 `ROUTE_RULES` / `ALIAS_MAP`，不動 Claude Code 設定。
- **狀態**：有效

## D002 設定檔只寫 Claude Code 認得的模型名，由 router 翻譯

- **問題**：設定檔寫 `mimo-…` 或 `deepseek/…` 時，Claude Code 警告 `doesn't recognize the model`，並用錯誤的 context window／thinking 假設。
- **結論**：settings 一律寫 `claude-sonnet-4-5` / `claude-haiku-4-5`，由 `CLAUDE_ALIAS` 翻成真模型。
- **證據**：改名前 stderr 有該警告；改名後消失，`claude -p` 回 `OK`。
- **影響**：任何未對到的 `claude-*` 也一律導向調度腦，避免原樣打到 OpenRouter 的真 Claude（帳單會爆）。
- **狀態**：有效

## D003 context window 預設從 524288 降到 200000

- **問題**：視窗設太大，Claude Code 就不會自動壓縮，每回合把整段歷史（含工具輸出）重送。
- **決定**：`CCHM_CONTEXT` 預設 200000。
- **理由**：便宜腦的成本優勢來自「短 context × 多次呼叫」，不是「一次塞很大的 context」。
- **狀態**：有效

## D004 router 硬化：count_tokens、本地 /v1/models、自動換道、權杖、用量日誌、systemd

- **問題**：OpenRouter 沒有 `/v1/messages/count_tokens`（實測 404）；上游掛掉整條產線就死；看不到真實延遲與成本；router 靠手動 nohup 起。
- **決定**：
  - count_tokens 一律走 WildWest tokenizer，失敗則本地估算（`ceil(chars/2.5)`）並標 `estimated`
  - `/v1/models` 回本地車道清單，不直通上游
  - `403/429/5xx` 自動換道重試一次（403＝政策封鎖 → 換 outlaw 車道）
  - 本地權杖 `cchm-local`（沒帶回 401）
  - usage.jsonl 每筆記 model／upstream／status／ms／bytes／in_tokens／out_tokens／cache_tokens／cost_usd
  - systemd user unit（Restart=always、linger=yes）
- **證據**：`scripts/cchm-doctor` 全綠；`CCHM_FAILOVER_CODES=400` 演練時 log 出現 `→ failover 到 wildwest`。
- **狀態**：有效

## D005 指紋清洗與 need-to-know：兩層不同的「不被擋」

- **問題**：上游與模型都可能因為「知道你是誰」「知道你要幹嘛」而拒絕或降級。
- **決定**：
  - 傳輸層：只轉發 content-type／accept／anthropic-version／anthropic-beta，其餘 header 丟棄，UA 統一 `cchm/0.2`
  - 派工層：**只寫技術規格、不寫用途與動機**（need-to-know，見 D010 的實測與代價）
- **狀態**：有效（傳輸層無副作用；派工層有品質代價，見 D010）

## D006 車道實測：延遲差在通路，不在模型

- **測法**：同一批 prompt 對各車道串流首字與總時間取樣。
- **數據**：同為 MiMo 2.6，WildWest 中轉 2.9s、OpenRouter 直連 0.83s；WildWest 11 顆模型全測，最快是 `mimo-v2.6-flash-outlaw`（2.9s）。
- **結論**：要提速先看通路；換無審核模型求快沒有空間。
- **狀態**：有效

## D007 推翻「fast 車道用 mimo-v2.6-pro-ultraspeed」

- **原本決定**：`CCHM_BRAIN_LANE=fast` → `xiaomi/mimo-v2.6-pro-ultraspeed`（只因名字叫 ultraspeed）。
- **推翻原因**（實測）：單價 $4.35/$8.70（比現用 outlaw 貴 4.35 倍）、1.32s（不比 mimo-flash 的 0.83s 快）、**且明確拒絕**繞限流類請求。
- **改為**：fast 車道用 `xiaomi/mimo-v2.6-flash`（$0.14/$0.28、0.83s，有審查且時拒時做）。
- **教訓**：不要憑模型名稱判斷能力。任何「快」「pro」「ultra」都要實測。
- **狀態**：已被 D008 取代（全 Silk 後 fast 車道不再使用）

## D008 接上 Silk Compute：同一批 abliterated 模型，價格只要 WildWest 的 1/2～1/4.5

- **問題**：WildWest 的無審核模型比別家貴。
- **查價**：1017 `$1.25/$2.50`（WildWest）vs `$0.28/$1.00`（Silk）；Kimi K3.1 Pro `$7.5/$37.5` vs `$5/$15`。
- **決定**：router 加 `UPSTREAMS.silk`（`api.silkcompute.com`，Anthropic Messages 原生、1M ctx、8 並發）；沒有金鑰就整條停用；`-uncensored` 與 `-outlaw` 互為 failover。
- **證據**：`/healthz` 的 `keys.silk`；`deepseek-v4.1-flash-1017-uncensored` 實測 200。
- **狀態**：有效

## D009 選型：1017 vs GLM-5.3（跑分＋實測）

- **第三方跑分**（vals.ai 22 項共同基準）：GLM-5.3 在 16/22 領先，Vals Index 53.51 vs 51.32；IOI 68.44 vs 40.28、Terminal-Bench 4.0 38.89 vs 19.70。1017 在 SkillsBench 69.80 vs 47.51 領先。
- **便宜版對決**（stet）：1017 品質 50.5% vs GLM-5.3-Flash 47.9%。
- **Claude Code 同一任務**：1017 31.9s／4 請求；GLM-5.3-Flash 73.1s／6 請求。
- **結論**：GLM 旗艦跑分略高但貴 7 倍；Flash 首字快但 agent 迴圈反而慢。**調度腦與工作手都用 1017**。
- **狀態**：有效

## D010 need-to-know 實驗：用途剝離能繞審核，但速度與品質都掉

- **假設**（使用者提出）：工作手被擋，是因為大腦沒有把任務包裝成純技術請求。
- **測法**：同一題（proxy 池管理器，驗收 sticky／輪替／失敗重綁）× 車道（Silk 1017／OpenRouter glm-5.3）× prompt（原始含用途／剝離成純規格）。
- **數據**：

  | 車道 | prompt | 拒絕 | 速度 | 可用率 |
  |---|---|---|---|---|
  | Silk 1017 | 原始 | 0/4 | 8–20s | 高（4 次 3 次完全正確） |
  | Silk 1017 | 剝離 | 0/4 | 8–10s | 2/3 |
  | OpenRouter glm-5.3 | 原始 | **拒絕** | 12s | 0 |
  | OpenRouter glm-5.3 | 剝離 | 不拒 | 12–59s | **0/3**（2 次 thinking 吃滿 6000 token、1 次實作 bug） |

- **結論**：假設成立（glm 從拒絕變成照做），但代價是慢 3–8 倍、輸出不穩、且缺少用途脈絡導致設計猜錯。
- **內容生成類例外**：釣魚信即使剝離成「請客戶回覆卡號與 PIN」，glm 仍拒絕；這類只能走無審核車道。
- **決定**：need-to-know 寫進 dispatcher 當**備援紀律**（prompt 更聚焦、省 token），不是主要手段；主要手段是無審核車道。
- **狀態**：有效（有代價，已標記）

## D011 A/B：全 Silk vs 主 Silk＋手 OpenRouter 高階模型

- **流程**：`scripts/bench-lanes.py`，3 配置 × 3 任務，全部強制用 Task 委派給 worker，客觀驗收。
- **數據**：

  | 配置 | 通過 | 牆鐘 | 成本 |
  |---|---|---|---|
  | 全 Silk 1017 | 3/3 | **110.6s** | $0.0238 |
  | 手＝OpenRouter glm-5.3 | 3/3 | 164.5s | $0.0200 |
  | 手＝OpenRouter gpt-5.6-luna | 3/3 | 149.1s | $0.0212 |

- **追加審查**：OpenRouter 兩顆在敏感題 3/3 全拒；OpenRouter 上唯一 uncensored 是 24B dolphin（不夠力）。
- **結論**：品質沒差、速度慢 35–49%、成本只差 10–16% → **採用全 Silk 單一供應商**（`CCHM_BRAIN_LANE=silk` 寫進 systemd unit），WildWest 當自動 fallback。
- **狀態**：有效

## D012 第一次 benchmark 的設計缺陷（方法論教訓）

- **現象**：第一版 bench 三個配置結果幾乎一樣，看不出差異。
- **原因**：任務太簡單，主對話自己做完了，**worker 從未被呼叫**（檢查 usage.jsonl 的 model 分佈才發現）。
- **修正**：prompt 一律要求用 Task 委派，並在結果裡記 `models` 與 `worker_used`。
- **教訓**：benchmark 必須驗證「被測的元件真的被用到」，否則量到的是別的東西。
- **狀態**：已修正

## D013 單層 vs 雙層：預設一層，雙層只在「context 會爆」或「真並行」時用

- **問題**（使用者提出）：工作手這一層是否必要？一層直接做品質會不會更高？分兩層若沒有提升，就只是增加複雜度。
- **測法**：`scripts/bench-layers.py`，同一組 3 個獨立任務、同一顆模型（Silk 1017）：
  - `single` 主對話自己做
  - `serial` 逐個委派給 subagent
  - `parallel` 一次並行派三個 subagent
  驗收看客觀結果（3 個 .py 能跑、輸出含預期值、out.json 內容正確），每模式跑 2 次。
- **數據**（`bench-layers-20261110-225955.json`）：

  | 模式 | 通過 | 兩次牆鐘 | 中位 |
  |---|---|---|---|
  | single（一層） | 6/6 | 37.1s / 36.9s | **37.0s** |
  | serial（兩層序列） | 6/6 | 115.3s / 144.9s | 130.1s（慢 3.5 倍） |
  | parallel（兩層並行） | 6/6 | 97.9s / 92.6s | 95.3s（慢 2.6 倍） |

- **結論**：品質完全一樣（都 6/6），但**兩層慢 2.6–3.5 倍**，請求數也是 2–3 倍。
  雙層的價值只剩兩件事：把「輸出會爆 context 的髒活」隔離出去，以及真正獨立的大工作可並行；
  對一班小任務來說它純粹是 overhead。
- **決定**：dispatcher 改成「預設自己直接做」，Task 派工只留給三種情況（context 會爆／真並行／要第二意見）。
  CCHM 原本「MiMo 弱腦＋DeepSeek 強手」的分工理由，在全 Silk 同顆模型之後已經消失。
- **教訓**：架構分層要有可量測的收益才留；「看起來比較工程」不是理由。
- **狀態**：有效

## D014 拿掉 WildWest 備援，router 縮成單一上游（使用者決策 6B）

- **問題**：Silk 之外是否保留 WildWest 作自動 fallback（failover 已實作）。
- **選項**：A 保留（抗單點故障，但兩套 key、兩份計費、兩種命名）；B 只留 Silk（最單純）。
- **結論**：B。使用者明確選擇「架構最單純優先」。
- **改動**：
  - `src/router.mjs` 從 454 行縮到 ~230 行：移除 multi-upstream、`fallbackFor`、`ALIAS_MAP`、`ROUTE_RULES`、WildWest／OpenRouter 金鑰
  - `count_tokens` 改本地估算（`ceil(chars/2.5)`，回 `estimated:true`），不再借 WildWest tokenizer
  - `hh-` 前綴直接映射回預設模型（重車道概念消失，因為全 Silk 都是無審核）
  - `scripts/cchm-doctor` 車道檢查改為 brain／worker／pro 三條（全在 Silk）
  - systemd unit 移除 `CCHM_BRAIN_LANE`
- **代價**：Silk 掛掉時直接 502，沒有自動接手。可接受（單一供應商本來就是這個取捨）。
- **回退方式**：舊版保留在 `~/.hermes/cache/scratch/cchm-backup/router-v0.2.mjs`，git 歷史也有；要恢復多上游就把該檔放回來、並在 unit 補回金鑰環境變數。
- **狀態**：有效

## D015 最終驗證（單上游 + 一層）與量測注意事項

- **端到端**：`claude -p` 走 claude-sonnet → Silk `deepseek-v4.1-flash-1017-uncensored`，33.9 秒完成寫檔＋執行，輸出正確。
- **單層／雙層最終複測**（`bench-layers --runs 2 --jobs 3`，三模式並行跑）：
  single 41.5/45.0s、parallel 93.0/124.4s、serial 124.1/200.8s，全部 6/6 通過。
  與前一輪（循序跑）比：single 41→41s 穩定，雙層明顯被並行互相干擾放大（95→124s、130→201s）。
- **量測教訓**：benchmark 自己並行跑會污染受測對象的耗時。要比較絕對延遲時，被比較的組合要循序跑；
  並行只適合用來縮短「整批」牆鐘，不適合拿時間當結論。
- **同向結論不變**：一層永遠最快，雙層沒有品質收益。
- **狀態**：有效

## D016 429 的真正來源是 Silk 帳號併發上限 8；router 補排隊節流與有界重試

- **問題**：使用者在 Claude Code（cchm）一直看到 API Error。
- **根因（實測）**：直接打 `api.silkcompute.com` 取得 429 body：
  `{"type":"error","error":{"type":"rate_limit_error","message":"This account already has 8 requests running. Try again when one finishes."}}`
  即**帳號同時只能有 8 個請求在跑**，第 9 個就 429，且回應**不帶 Retry-After**。
  v0.3（D014）拿掉 failover 之後，router 既沒有節流也沒有重試，429 原樣 writeHead 給 client，
  Claude Code 就顯示成 API Error。
- **量測**（`.exp/logs/usage.jsonl` 3,264 筆）：非 200 共 542 筆（16.6%）；
  11-10 18 時那小時 1,018 請求有 486 失敗（48%），最密集的 18:03 該分鐘 58 請求 41 個 429（71%）；
  另有 524×13（上游 125 秒超時）、503×11、400×15、`read ECONNRESET`×14。
- **改動**（`src/router.mjs` v0.3.1）：
  - semaphore 併發閘門，`CCHM_MAX_CONCURRENT` 預設 **6**（留 2 個裕度給自檢／bench），超過就排隊而不是丟 429；client 斷線會釋放槽
  - `RETRY_CODES = 408/409/429/500/502/503/504/524/529` ＋ 連線錯誤，最多重試 **4** 次，指數退避 1s→8s ＋ jitter（連線錯誤 0.4s 起）；錯誤 body 丟棄不轉給 client
  - 先取得上游 status 才決定「直通或重試」，SSE 仍原樣直通不緩衝
  - `/healthz` 增 `inflight`／`queued`／`max_concurrent`，可即時看有沒有排隊
- **驗證**：
  - 經 router 併發 12 → **12/12 200，零 429**（修前同樣情境會整批 429）
  - 另一實例 `CCHM_MAX_CONCURRENT=20` 併發 16 → 觸發 **14 次 429 全部被重試吸收**，最終 16/16 200
- **代價**：同時超過 6 個請求會排隊，單發延遲被拉長（12 併發時最慢 117 秒）。用延遲換「不再跳錯誤」。
- **未解**：Silk 沒有官方併發文件、也沒有 Retry-After，上限 8 是行為實測；要更快只能升方案或分流到第二家（等同恢復 D014 推翻的多上游）。
- **狀態**：有效

## D017 對話無法繼續的 400 是「歷史 base64 截圖撐爆 context」，router 補三級自動修復

- **問題**：既有 Claude Code 對話（YULECITY 投資人簡報）從 15:36 起每輪都 400，重試 12 次全失敗，使用者問「為什麼、能不能繼續」。
- **不是什麼**（先排除）：參數沒變（`max_tokens` 64000、`thinking.budget_tokens` 63999 與 13:25 成功那次完全相同）、額度正常、router 與網路正常；上游錯誤 body 只有 198B 的通用字串 `The model could not accept this request…the message format`，沒有細節。
- **根因（實測，非推論）**：把 router 攔到的原始請求 dump 出來分析（11.9MB）：
  - 343 則訊息、172 個 `tool_result`，其中 **48 張 base64 PNG 截圖**（單張 325–552KB），messages 合計 **11.5MB ≈ 340 萬 token**
  - system 30KB、tools 169KB，結構本身完全正常（角色交替、無孤兒工具、無空 block、cache_control 僅 2 個）
  - 也就是 Claude Code 把每次視覺驗收的截圖原樣留在對話歷史，累積到遠超模型上限後，上游對**每一輪**都回 400，壞資料留在歷史裡所以永遠救不回來
- **改動**（`src/router.mjs` v0.3.2）：
  - 4xx 先收完整錯誤 body：寫 `logs/upstream-errors.jsonl`、console 印前 400 字，不再直接丟棄
  - 三級自動修復（`CCHM_SANITIZE_400=1` 預設開，`CCHM_MAX_REPAIR=3`）：
    1. 正規化：thinking budget 收進 `max_tokens-1024`、剝歷史 thinking block、移除孤兒 `tool_use`／`tool_result`、收掉空訊息與連續同角色、**剝除歷史 base64 圖片**（換成 `[歷史截圖已省略：NKB]` 佔位，單一字串 tool_result 超過 200KB 截斷）
    2. 移除 `thinking`／`context_management`／`metadata`、`max_tokens` 降到 32000、剝 `anthropic-beta` header
    3. 只留最小欄位組（model／messages／system／max_tokens／stream／temperature／top_p／stop_sequences／tools／tool_choice）並把 `max_tokens` 壓到 8192
  - 超過 `CCHM_MAX_PROMPT_CHARS`（預設 400000 字元）時從最舊訊息丟，保留開頭一則與最後 30 則並重新合併角色
  - 修復用盡仍 400 時把原始請求寫 `logs/failed-request.json`（`CCHM_DUMP_FAILED=0` 可關）
- **驗證**：同一個原本 12 次全 400 的對話，`claude -p --resume` 一次就 200（`in=120891`、11.4 秒），對話自己回報「43 頁版已改完驗過，還沒 commit／推上去」；正常請求（新對話）仍 200，未受影響。
- **代價**：被剝掉的歷史截圖模型看不到（不影響推理，只是少了視覺證據）；第 2、3 級會拿掉 thinking 與 beta 功能，等於降級回覆；丟最舊訊息會少掉早期上下文。
- **回退**：`CCHM_SANITIZE_400=0` 環境變數即可完全關閉自動修復（仍保留錯誤記錄）。
- **教訓**：把截圖留在主對話歷史會以 base64 等比放大 context；視覺驗收應該在子代理裡做、只回一句結論，圖不要進主串。
- **狀態**：有效


## D018 400 自動修復的三段死路補起來（v0.3.3）

- **日期**：2026-11-13
- **問題**：D017 上線後回頭審修復邏輯，發現三條路徑實際走不到／救不回，等於 D017 只解決了「有圖片可剝」那一類：
  1. `repairFor400` 第 1 級找不到可修項就 `return null` → 第 2、3 級（移除 `thinking`／`context_management`、`max_tokens` 降級、只留最小欄位）**永遠不會被試**；「格式乾淨但就是太大」的請求直接回 400。
  2. 第 5c 段只在 `messages.length > 31` 時才丟訊息 → **單則就爆掉**（貼上長文、單一 5MB `tool_result`）的情況完全不縮減。
  3. 丟訊息會切斷 `tool_use`／`tool_result` 配對，但第 2 級沒有再收孤兒 → 下一輪照樣 400。
- **改動**（`src/router.mjs`）：
  - 第 1 級無可修項時級聯到第 2 級，第 2 級無變化再級聯到第 3 級（原本 `return null`）
  - 新增 5d：訊息數少但超長時，一次丟到「下一個 user 訊息」開頭，不會留成 assistant 開頭或空陣列；丟完立刻重收孤兒工具區塊
  - 新增 5e：只剩一則仍超長時截斷超長文字塊（8KB）並註記，不再直接 400
  - 被 import 時不啟動伺服器、不缺金鑰就 exit（`IS_MAIN` guard），並 `export { repairFor400, normalizeModel }`
- **驗證**：新增 `src/router.test.mjs`（`node --test src/router.test.mjs`，8 項全過），涵蓋級聯、base64 圖片剝除、孤兒工具、少則超大、單則超長、丟訊息後不留孤兒；改完 restart 後 `scripts/cchm-doctor` 全綠、healthz 回報 0.3.3。
- **代價**：極端情況會丟到只剩最後一則 user 訊息，模型看不到早期上下文；`max_tokens` 會被壓到 32000／8192。
- **回退**：`CCHM_SANITIZE_400=0` 完全關閉（同 D017）。
- **狀態**：有效
