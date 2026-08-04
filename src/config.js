// ---------------------------------------------------------------------------
// 監看名單。要新增公司就在這裡加一行。
//
// ats 可以是 "greenhouse" | "ashby" | "workday" | "microsoft" | "google"
//
// 怎麼判斷一家公司用哪個 ATS（三步驟）：
//   1. 打開他們的 careers 頁面，點任一個職缺，看網址跳去哪裡
//        job-boards.greenhouse.io/XXX   -> greenhouse，token 就是 XXX
//        jobs.ashbyhq.com/XXX           -> ashby，token 就是 XXX
//        XXX.wdN.myworkdayjobs.com/YYY  -> workday，host/tenant/site 見下方範例
//   2. 用 `npm run probe -- <ats> <token>` 實測一下拿不拿得到資料
//   3. 確認 OK 再加進這個陣列
//
// 自架 careers 系統的公司（像 Microsoft / Google）需要專屬 adapter，
// 加不進來的話請找 Claude 寫一個新的 adapter。
// ---------------------------------------------------------------------------

export const COMPANIES = [
  { name: 'Microsoft', ats: 'microsoft' },
  // Google 的地點過濾在來源端做（它的結果頁不吐地點，事後濾不了）。
  // 想看全世界的就把 location 這行刪掉。
  { name: 'Google', ats: 'google', location: 'United States' },
  { name: 'Notion', ats: 'ashby', token: 'notion' },
  { name: 'OpenAI', ats: 'ashby', token: 'openai' },
  { name: 'Anthropic', ats: 'greenhouse', token: 'anthropic' },
  {
    name: 'Salesforce',
    ats: 'workday',
    host: 'salesforce.wd12.myworkdayjobs.com',
    tenant: 'salesforce',
    site: 'External_Career_Site',
  },
];

// ---------------------------------------------------------------------------
// 過濾規則 — 刻意放寬。寧可多推幾筆讓你自己掃，也不要漏掉。
// ---------------------------------------------------------------------------

// 標題命中任一個就算數。要更寬就往這裡加字。
//
// 注意：不需要另外排除 "International" / "Internal"。\bintern\b 的尾端 \b
// 要求 intern 後面是字界，"international" 後面是 a，所以本來就不會誤中。
// （實測 Anthropic 的 "Head of Deal Desk - International" 不會被抓進來。）
export const TITLE_PATTERNS = [
  /\bintern(ship|s)?\b/i,
  /\bco-?op\b/i,
  /\bMBA\b/i,
  /\bstudent\b/i,
  /\bapprentice(ship)?\b/i,
  /\bsummer\s+20\d\d\b/i,
];

// 有些來源在 API 層就已經篩過 intern（Salesforce 的 workerSubType facet、
// Google 的 employment_type=INTERN）。那些職缺的標題常常整串沒有 "intern"
// 這個字 —— 例如 Salesforce 的 "Summer 2027 Intern - Software Engineer"
// 還好，但 Google 的是 "Student Researcher, BS/MS, Fall 2026"。
// adapter 會在這種職缺上標 internConfirmed: true，fetch.js 就直接放行不再比標題。

// 只留美國 / remote 的職缺。
// 你需要 US work authorization，印度 / 以色列 / 歐洲的 intern 對你是純噪音。
// 想看全部就改成 false。
export const US_ONLY = true;

// 地點字串看不出國別時（Workday 會給 "2 Locations"、Google 完全不給）
// 一律放行。放寬策略：寧可多推一筆讓你自己點進去看。
// 注意這些都要錨定（^…$）。沒錨定的話 "Multiple Locations" 會誤中
// "Israel Multiple Locations Multiple Locations"，把以色列的職缺當成
// 地點不明而放行。
export const OPAQUE_LOCATION = [
  /^\s*$/,
  /^\d+\s+Locations?$/i,
  /^\(見職缺頁\)$/,
  /^(Multiple Locations\s*)+$/i,
];

export const US_PATTERNS = [
  /\bUS\b|\bU\.S\.|United States|USA\b/i,
  /\bremote\b/i,
  /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/,
  /New York|San Francisco|Seattle|Redmond|Mountain View|Sunnyvale|Austin|Chicago|Boston|Atlanta|Denver/i,
];

// 一次跑最多推幾筆到 Slack，避免某天對方大量 repost 把頻道洗版。
// 超過的部分還是會寫進 digest 檔案，只是 Slack 上折疊成一行。
export const MAX_SLACK_ITEMS = 25;
