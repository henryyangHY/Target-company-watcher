# Target Company Watcher

每天固定去指定公司的 careers 官網抓 intern 職缺，有新的就推 Slack。

這是 JSOS Job Scanner 的 **Lane B**。Lane A（Gmail job alert digest）維持在 claude.ai routine 不動，
兩條互補：Lane A 廣度、Lane B 時效。

**執行時零 AI token。** 純 Node.js 打 API、比對 JSON、送 webhook，沒有 LLM 參與。

## 為什麼需要這個

LinkedIn / Simplify / Handshake 的 job alert email 有 12–48 小時延遲而且不完整。
公司官網貼出 → aggregator 索引 → 湊夠量發信，中間會漏。
實測就抓到 Microsoft 的 `Product Manager Internship Opportunities`（7/30 貼出）
從來沒出現在任何一封 alert email 裡。

## 監看名單

| 公司 | 來源 | 備註 |
|---|---|---|
| Microsoft | sitemap + Eightfold PCSX API | 已從舊的 gcsservices 遷移，見下方 |
| Google | careers 結果頁（server-rendered） | 用 `employment_type=INTERN` 在來源端篩 |
| Notion | Ashby posting API | |
| OpenAI | Ashby posting API | payload 約 12MB，adapter 內就丟掉 description |
| Anthropic | Greenhouse board API | |
| Salesforce | Workday CXS API | 用 `workerSubType` facet 篩 intern |

## 安裝

### 1. Slack incoming webhook

1. https://api.slack.com/apps → Create New App → From scratch
2. 選你的 workspace，App 名稱隨意（例：Job Watcher）
3. 左側 **Incoming Webhooks** → 打開 Activate
4. **Add New Webhook to Workspace** → 選 `jsos-job-scanner` 頻道
5. 複製那串 `https://hooks.slack.com/services/...`

### 2. 把 webhook 放進 GitHub secret

Repo → Settings → Secrets and variables → Actions → **New repository secret**

- Name: `SLACK_WEBHOOK_URL`
- Secret: 貼上剛才複製的網址

> 這個值只會存在 GitHub secret 裡，不會進 code、不會進 log。

### 3. 確認排程

`.github/workflows/daily.yml` 預設每天 **早上 8 點和晚上 8 點（America/Chicago）** 各跑一次。

GitHub 的 cron 只吃 UTC 且不認 DST，所以那裡排了四個 UTC 時間點
（13:00 / 14:00 / 01:00 / 02:00），由 `fetch.js` 檢查芝加哥當地時間是不是
`RUN_HOURS` 裡的值，不是就幾秒內結束。**實際每天只有 2 次真的執行。**

改時間就改 workflow 裡的 cron 和 `RUN_HOURS`，兩邊要一起改。

### 4. 先手動跑一次

Repo → Actions → **Daily job watch** → Run workflow →
把 `dry_run` 勾起來，確認 log 正常再取消勾選跑正式的。

## 本機測試

```bash
npm run dry
```

不推 Slack、不寫檔，只印出會推什麼。加新公司後一定要先跑這個。

## 加新公司

### 如果是 Greenhouse / Ashby / Workday（大多數公司）

**第一步：判斷 ATS。** 打開該公司 careers 頁面，點任一職缺，看網址跳去哪：

| 網址長相 | ats | token |
|---|---|---|
| `job-boards.greenhouse.io/XXX/jobs/…` | `greenhouse` | `XXX` |
| `jobs.ashbyhq.com/XXX/…` | `ashby` | `XXX` |
| `XXX.wdN.myworkdayjobs.com/YYY/…` | `workday` | 見下 |

**第二步：實測。** 不要憑猜測就寫進 config：

```bash
node probe.js greenhouse figma
node probe.js ashby databricks
node probe.js workday nvidia.wd5.myworkdayjobs.com nvidia NVIDIAExternalCareerSite
```

> 猜錯是常態。Notion 看起來很像 Greenhouse，實測是 404，
> 真正用的是 Ashby。**先 probe 再寫。**

**第三步：加進 `src/config.js` 的 `COMPANIES`：**

```js
{ name: 'Figma', ats: 'greenhouse', token: 'figma' },
{ name: 'Databricks', ats: 'ashby', token: 'databricks' },
{ name: 'Nvidia', ats: 'workday',
  host: 'nvidia.wd5.myworkdayjobs.com',
  tenant: 'nvidia', site: 'NVIDIAExternalCareerSite' },
```

然後 `npm run dry` 確認有抓到東西，再 commit。

### 如果是自架 careers 系統（像 Microsoft / Google）

要寫專屬 adapter，丟給 Claude 處理。給它公司的 careers 網址，
請它照 `src/adapters.js` 既有的格式加一個新 adapter。

## 調整過濾

全部在 `src/config.js`：

- `TITLE_PATTERNS` — 標題命中任一個就算。要更寬就加字。
- `US_ONLY` — 預設 `true`。你需要 US work authorization，非美國職缺是純噪音。想看全部改成 `false`（Google 要另外把 config 裡的 `location: 'United States'` 刪掉，它是來源端篩的）。
- `MAX_SLACK_ITEMS` — 單次推送上限，預設 25，避免對方大量 repost 洗版。超出的仍會寫進 `digests/`。

過濾刻意放寬：**寧可多推幾筆讓你自己掃，也不要漏。**

有些來源在 API 層就篩過 intern（Salesforce 的 facet、Google 的 `employment_type`），
那些職缺 adapter 會標 `internConfirmed: true`，直接跳過標題比對 ——
因為它們的標題常常整串沒有 "intern" 這個字（例：`Student Researcher, BS/MS, Fall 2026`）。

## 去重怎麼運作

`seen.json` 記錄每筆看過的職缺（key 是 `公司名:職缺id`）。
**不依賴任何網站的時間戳** —— 因為各家給的東西不一致：

- Microsoft `postedTs` 是乾淨的 unix timestamp ✅
- Greenhouse / Ashby 給 ISO 時間，但 repost 會刷新
- **Workday 只給相對字串**（`"Posted Today"` / `"Posted 5 Days Ago"`）❌
- Google 完全不給 ❌

所以一律用 `seen.json` 做差集。每次跑完 Actions 會把它 commit 回 repo。

第一次跑（`seen.json` 是空的）會自動進入 seed 模式：把現有職缺全部標記為已見過、
不推任何東西，避免一次收到上百則通知。

## 排錯

**Slack 沒收到通知**
先看 Actions log。`⚠ 沒有 SLACK_WEBHOOK_URL` 代表 secret 沒設或名字打錯。
`😴 沒有新職缺` 代表正常運作，只是真的沒有新的。

**某家公司顯示 ❌**
單一公司失敗不會讓整個 workflow 紅燈（只有全部失敗才會），設計如此 ——
不要因為一家 API 改版就讓整個排程停擺。
連續幾天失敗就是對方改了 API，把 log 貼給 Claude 修 adapter。

**排程自己停了**
GitHub 對長期沒有活動的 public repo 會自動停用 scheduled workflow。
理論上每天 commit `seen.json` 就算活動，但有回報說機器人自己的 commit 不算數。
真的停了就去 Actions 頁面手動 re-enable，或隨便推一個 commit。

**Microsoft 抓不到**
舊的 `gcsservices.careers.microsoft.com` 已停用，而且它的 TLS 憑證是壞的
（給 `*.azureedge.net`，任何 client 都驗證失敗）。**不要回頭用那個 host。**
現在走 `apply.careers.microsoft.com`（Eightfold），robots.txt 明確 Allow `/api/pcsx`。
PCSX 的 `num` 參數被鎖死在 10（給 50 或 100 都只回 10 筆），
所以完整覆蓋靠 sitemap，PCSX 只用來補最新的 10 筆。

**跑起來很慢**
正常約 30–60 秒。Workday 分頁之間有 400ms 間隔、Google 有 800ms，
是刻意對對方客氣，不要拿掉。

## 禮貌與合規

每天 2 次、每次 10 個上下的 request，量極小。
用的都是各家公開的 job board API（Greenhouse / Ashby 的 posting API 本來就是給外部讀的），
Microsoft 走 robots.txt 明確允許的路徑。沒有繞過任何驗證、沒有登入、沒有 CAPTCHA。
