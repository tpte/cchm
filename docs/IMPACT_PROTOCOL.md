# 影響面宣告協定（跨 repo／多模組）

**每次改動都要先說「會影響哪些部分」，再說要改什麼。** 沒有影響面清單的工單不准派。

## 為什麼

使用者常在多 repo、單 repo 多模組之間工作。漏報影響面 = 改 A 炸 B、審查者不知道要看哪裡、使用者事後才發現。影響面是驗收的一部分，不是附註。

## 改動前（dispatcher）

1. 先定位：`rg` 找符號 → 確認所在 repo／package／模組。
2. 查影響面：
   - YuleCity monorepo：`scripts/agent/nav impact <symbol>`、`nav calls <symbol>`、`nav affected <files...>`
   - 其他 repo：`git grep -n "<symbol>"`、檢查 import／呼叫端、看該 repo 的 `AGENTS.md`／`CLAUDE.md` 邊界
3. 寫進工單的固定欄位：

```
影響面：
- repos: <會動到的 repo；跨 repo 時全部列出>
- modules/files: <路徑>
- 呼叫者: <symbol@file:line，或 none>
- 測試: <受影響測試檔，或 none>
- 未改但受影響: <會被行為改變波及、但本次不動的檔案／repo>
```

4. 跨 repo 排序：**被依賴者先改**（contracts → core → shell、lib → app），前一個驗收過才派下一個。
5. 同一 repo 多模組：一張工單只碰一個模組邊界；共用檔（types、store、契約）一次只有一個持有者。

## 改動中（hacker）

- 動手前先跑一次影響面指令，把結果貼進回報第 1 段。
- 改到共用模組時，必須列出呼叫者與受影響測試，不可只回報「已修改」。
- 跨 repo 改動：兩個 repo 的絕對路徑都要列。
- 發現影響面比工單寫的大：停手回報，不要自己擴張範圍。

## 驗收（verifier）

- 比對「工單影響面」與 `git diff --stat`／`git diff`：
  - diff 有、影響面沒列 → **FAIL（漏報）**
  - 影響面有、diff 沒有 → 要求說明原因，說不出來 FAIL
  - 受影響測試沒跑 → FAIL
- 只看影響面與驗收條件，不評論範圍外改動。

## 回報使用者

每輪回覆都要有一行影響面摘要（repos／模組／測試數），即使結果是「無影響」。不要只說「改好了」。
