# MeetingFlow 系統開發交接文件

> [!NOTE]
> 這份文件是為了讓後續接手的工程師能快速掌握 MeetingFlow 系統架構與近期開發邏輯而撰寫。專案旨在打造一個透過 Telegram 語音/文字輸入，即可自動分析並排程的 AI 助理系統。

---

## 1. 專案架構概覽 (Architecture Overview)

本專案採用全端 TypeScript 架構，主要分為三大區塊：

1. **前端 (Frontend)**: `React` + `Vite` + `TypeScript`
   - 負責呈現視覺化的控制面板 (Dashboard)、週曆排程 (Calendar)、任務看板 (RoleBoard) 以及草稿審核區 (Review Panel)。
2. **後端 (Backend)**: `Hono` + `Node.js` + `TypeScript`
   - 負責提供 REST API 給前端，同時作為 Telegram Bot 的 Webhook 接收端。
   - 包含多個背景排程機制 (Cron Jobs) 以及呼叫 LLM (Gemini) 進行語意分析與決策。
3. **資料庫 (Database)**: `Supabase (PostgreSQL)`
   - 儲存所有的使用者、任務 (Tasks)、行事曆事件 (Calendar Intents)、記憶 (Memories) 以及系統紀錄。

---

## 2. 目錄與核心檔案對照表 (Directory & File Map)

專案根目錄為 `meeting-flow-backend/`。

### 💻 前端目錄 (`frontend/src/`)
- `App.tsx`: 前端的最核心進入點，負責拉取後端資料，並將 `tasks`, `events`, `weekView` 分發給各大子元件。**（請特別注意此處有實作 `needs_review` 的過濾邏輯）**。
- `api.ts`: 封裝所有打向後端的 API 請求 (Fetch wrappers)。
- `components/ReviewPanel.tsx`: 畫面上方的「待審核區」，專門顯示 `needs_review: true` 的項目。
- `components/DayColumn.tsx`: 週曆的單日欄位，支援拖曳 (Drag and drop) 來安排任務或行程。
- `components/RoleBoard.tsx`: 未排程任務的任務看板，依據「操盤/教育/行政/其他」進行分類。
- `components/WeeklyTasks.tsx`: 左側的週曆輔助面板。

### ⚙️ 後端目錄 (`src/`)
- `index.ts`: 後端主程式，註冊所有的 Hono API Routes，以及所有的 Cron Jobs 端點（如 `/api/cron/morning`）。
- `services/message-handler.service.ts`: **非常核心**。負責接收來自 Telegram 的所有文字/語音訊息，並將其送往 NLP 引擎解析，最後存入資料庫。
- `services/extraction.service.ts`: 負責將使用者的對話轉換成結構化的 JSON (任務、行程、記憶)。
- `services/confirmation.service.ts`: 處理 NLP 語意修改指令（例如使用者說「把開會改到明天」），並執行資料庫的 Update 或 Delete。
- `services/intent-router.service.ts`: 負責判斷使用者的輸入意圖（是閒聊？下達指令？還是交辦任務？）。
- `services/proactive.service.ts`: 主動式 AI 服務，會掃描使用者的歷史記憶，自動生成建議任務。
- `services/command-handlers/`: 存放各種指令（如 `/morning`, `/evening`, `/research`）的具體實作。

### 🗄️ 其他重要檔案 (Root)
- `cron_runs_schema.sql` & `research_documents_schema.sql`: 缺漏資料表的 SQL 建立腳本，須於 Supabase SQL Editor 手動執行。
- `package.json` / `tsconfig.json`: 依賴與編譯設定。

---

## 3. 近期開發重點與商業邏輯

### A. NLP 語意修改引擎 (Natural Language Modification Engine)
- **邏輯**：當使用者在 Telegram 輸入修改指令（如：「刪除剛剛那條」、「時間不是下週是明天」）時，`message-handler.service.ts` 會把當前資料庫裡處於 `needs_review: true` 的草稿 (Candidates) 一併打包送給 LLM。
- **實作**：LLM 判斷後會回傳 `delete_targets` 或是 `update_targets`，然後交由 `confirmation.service.ts` 中的 `handleRejectBatch` 去執行真實的資料庫 Update/Delete。

### B. 草稿隔離機制 (Needs Review Isolation)
- **痛點**：原本 AI 擷取下來的任務會直接出現在週曆上，如果 AI 判斷錯誤會造成使用者的日曆被污染。
- **解法**：新建立的任務預設 `needs_review = true`。
- **前端實作** (`App.tsx`)：
  1. 所有帶有 `needs_review: true` 的項目，**只會**被放進 `ReviewPanel`。
  2. 系統會另外計算 `activeTasks` 和 `activeWeekView`（將 needs_review 濾掉），才傳給 `DayColumn` 和 `RoleBoard`。
  3. 當使用者點擊「確認」按鈕（呼叫 `updateTask(taskId, { needs_review: false })`），項目才會從待審核區消失，並彈出至正式週曆中。

### C. 排程防洗版鎖機制 (Cron Locks)
- **痛點**：若外部觸發器 (如 Make.com 或 GAS) 頻繁呼叫 `/api/cron/*`，會導致系統狂發早報或晚報。
- **解法**：在 `index.ts` 中實作了 `acquireCronLock(jobType: string)`。
  - 它會試圖在 Supabase 的 `cron_runs` Table 中 insert 一筆 `(job_type, run_date)` 的資料。
  - 由於該 Table 設有 `UNIQUE(job_type, run_date)` 限制，一天只能成功 Insert 一次。
  - **重要邊界條件處理**：若資料庫連線失敗或 Table 遺失（拋出非重複鍵值的 Error），程式會直接 return `false` 來阻擋執行，以防無條件放行導致洗版。

---

## 4. 後續接手工程師注意事項 (Important Notes)

> [!WARNING]
> 本專案**沒有**使用 Prisma 或其他自動化 ORM 的 Migration 系統。所有的資料表關聯與更新都是仰賴直連 Supabase 並執行原生的 SQL 腳本。

1. **資料庫更動**：
   - 若未來需要新增欄位或資料表，請務必自己寫 `.sql` 檔，並在 Supabase Dashboard 的 SQL Editor 中手動執行。
   - **請務必確認 `cron_runs` 與 `research_documents` 這兩個 Table 已經在您的 Supabase 環境中建立（對應的 SQL 檔已放在根目錄）。**

2. **前端編譯**：
   - 前端採用 Vite，編譯指令為 `cd frontend && npm run build`。
   - 在部署前，建議先執行 `cd frontend && npx tsc -b` 確認型別沒有錯誤。

3. **AI Prompt 的調整**：
   - 如果發現 AI 分類錯誤、或是擷取的 JSON 格式跑掉，請前往 `src/services/extraction.service.ts` 或 `src/services/intent-router.service.ts` 調整 `systemPrompt`。
   - LLM 目前預設的溫度 (Temperature) 若需微調，請到 `src/services/llm.service.ts` 中修改。

4. **環境變數 (.env)**：
   - `SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY` 必須填寫正確。
   - `TELEGRAM_BOT_TOKEN` 用於 Telegram 發信。
   - `CRON_SECRET` 用於保護 `/api/cron/*` 的端點，請確保您的 Make/GAS trigger 的 Header (`x-cron-token`) 與其一致。
