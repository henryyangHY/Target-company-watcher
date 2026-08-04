#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Target Company Watcher — Lane B
//
// 每天固定跑：打 6 家公司的 careers API → 過濾出 intern 職缺 →
// 跟 seen.json 比對找出「新出現的」→ 推 Slack → 把狀態寫回 repo。
//
// 完全不使用 AI / LLM，執行時零 token 成本。
//
// 用法：
//   node fetch.js              正常跑（會推 Slack、會寫檔）
//   node fetch.js --dry-run    只印出結果，不推 Slack、不寫檔
//   node fetch.js --seed       把現有職缺全部標記為已見過，不推任何東西
//   node fetch.js --force      忽略「現在是不是排定時段」的檢查
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from './src/adapters.js';
import {
  COMPANIES,
  TITLE_PATTERNS,
  US_ONLY,
  US_PATTERNS,
  OPAQUE_LOCATION,
  MAX_SLACK_ITEMS,
} from './src/config.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SEEN_PATH = path.join(ROOT, 'seen.json');
const DIGEST_DIR = path.join(ROOT, 'digests');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const SEED = args.has('--seed');
const FORCE = args.has('--force');

const TZ = 'America/Chicago';

// --- 時區閘門 ---------------------------------------------------------------
// GitHub Actions 的 cron 只吃 UTC，不認 DST。所以 workflow 排了「夏令時正確」和
// 「冬令時正確」兩組時間，由這裡判斷芝加哥當地時間是不是真的到了 RUN_HOURS，
// 不是就直接結束。多跑一次空的沒有任何成本。
function localHour() {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hour: 'numeric',
      hour12: false,
    }).format(new Date())
  );
}

function localDateStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function shouldRunNow() {
  if (FORCE || DRY_RUN || SEED) return true;
  const want = (process.env.RUN_HOURS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
  if (want.length === 0) return true; // 沒設就不擋
  return want.includes(localHour());
}

// --- 過濾 -------------------------------------------------------------------
function isIntern(job) {
  // 來源端已經確認是 intern 的（Salesforce workerSubType facet、
  // Google employment_type=INTERN）直接放行，不要再比標題 ——
  // 這些職缺常常整串標題沒有 "intern" 這個字。
  if (job.internConfirmed) return true;
  if (!job.title) return false;
  return TITLE_PATTERNS.some((re) => re.test(job.title));
}

function locationOk(job) {
  if (!US_ONLY) return true;
  const loc = job.location || '';
  // 地點看不出國別時一律放行 —— 放寬策略，寧可多推一筆讓你自己點進去看
  if (OPAQUE_LOCATION.some((re) => re.test(loc))) return true;
  return US_PATTERNS.some((re) => re.test(loc));
}

// --- 主流程 -----------------------------------------------------------------
async function collect() {
  const results = await Promise.allSettled(
    COMPANIES.map(async (c) => {
      const adapter = ADAPTERS[c.ats];
      if (!adapter) throw new Error(`未知的 ats 類型：${c.ats}`);
      const jobs = await adapter(c);
      return { company: c.name, jobs };
    })
  );

  const all = [];
  const errors = [];

  results.forEach((r, i) => {
    const name = COMPANIES[i].name;
    if (r.status === 'rejected') {
      errors.push(`${name}: ${r.reason?.message || r.reason}`);
      console.log(`❌ ${name} — ${r.reason?.message || r.reason}`);
      return;
    }
    const { jobs } = r.value;
    const matched = jobs.filter((j) => isIntern(j) && locationOk(j));
    console.log(
      `✅ ${name.padEnd(11)} 抓到 ${String(jobs.length).padStart(4)} 筆，` +
        `命中 ${matched.length} 筆`
    );
    for (const j of matched) all.push({ ...j, company: name });
  });

  return { all, errors };
}

function loadSeen() {
  if (!fs.existsSync(SEEN_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
  } catch {
    console.log('⚠ seen.json 壞掉，當作空的重來');
    return {};
  }
}

function keyOf(job) {
  return `${job.company}:${job.id}`;
}

// --- Slack ------------------------------------------------------------------
function formatSlack(newJobs, errors) {
  const date = localDateStr();
  const shown = newJobs.slice(0, MAX_SLACK_ITEMS);
  const overflow = newJobs.length - shown.length;

  const lines = [
    `🔴 *官網直擊* — ${date}`,
    `${newJobs.length} 筆新職缺 · 監看 ${COMPANIES.length} 家`,
    '',
  ];

  const byCompany = {};
  for (const j of shown) (byCompany[j.company] ||= []).push(j);

  for (const [company, jobs] of Object.entries(byCompany)) {
    lines.push(`*${company}*`);
    for (const j of jobs) {
      lines.push(`• ${j.title}`);
      const meta = [j.location, j.posted ? fmtPosted(j.posted) : null]
        .filter(Boolean)
        .join(' · ');
      if (meta) lines.push(`   📍 ${meta}`);
      lines.push(`   <${j.url}|→ View job>`);
    }
    lines.push('');
  }

  if (overflow > 0) lines.push(`_…另有 ${overflow} 筆，見 repo 的 digests/${date}.md_`);
  if (errors.length) lines.push(`⚠️ 抓取失敗：${errors.join('; ')}`);

  return lines.join('\n');
}

function fmtPosted(p) {
  if (!p) return '';
  if (!/^\d{4}-\d{2}-\d{2}/.test(p)) return p; // Workday 的 "Posted Today" 直接原樣顯示
  return p.slice(0, 10);
}

async function postToSlack(text) {
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) {
    console.log('⚠ 沒有 SLACK_WEBHOOK_URL，跳過推送');
    return false;
  }
  const res = await fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook 回 ${res.status}: ${await res.text()}`);
  console.log('📮 已推送到 Slack');
  return true;
}

// --- Digest 檔案 ------------------------------------------------------------
function writeDigest(newJobs, errors) {
  const date = localDateStr();
  const lines = [
    `# 官網直擊 — ${date}`,
    '',
    `新職缺 ${newJobs.length} 筆，監看 ${COMPANIES.length} 家。`,
    '',
  ];
  const byCompany = {};
  for (const j of newJobs) (byCompany[j.company] ||= []).push(j);
  for (const [company, jobs] of Object.entries(byCompany)) {
    lines.push(`## ${company} (${jobs.length})`, '');
    for (const j of jobs) {
      lines.push(`- [${j.title}](${j.url})`);
      const meta = [j.location, fmtPosted(j.posted)].filter(Boolean).join(' · ');
      if (meta) lines.push(`  ${meta}`);
    }
    lines.push('');
  }
  if (errors.length) lines.push('## 抓取失敗', '', ...errors.map((e) => `- ${e}`), '');
  fs.mkdirSync(DIGEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(DIGEST_DIR, `${date}.md`), lines.join('\n'));
}

// --- 進入點 -----------------------------------------------------------------
async function main() {
  if (!shouldRunNow()) {
    console.log(
      `⏭  現在芝加哥時間 ${localHour()} 點，不在 RUN_HOURS=${process.env.RUN_HOURS} 內，跳過。`
    );
    return;
  }

  console.log(`🔍 開始掃描 — ${localDateStr()} ${localHour()}:00 ${TZ}\n`);
  const { all, errors } = await collect();

  const seen = loadSeen();
  const firstRun = Object.keys(seen).length === 0;

  const newJobs = all.filter((j) => !seen[keyOf(j)]);
  const nowIso = new Date().toISOString();
  for (const j of all) {
    if (!seen[keyOf(j)]) {
      seen[keyOf(j)] = { title: j.title, url: j.url, first_seen: nowIso };
    }
  }

  console.log(`\n📊 命中 ${all.length} 筆，其中 ${newJobs.length} 筆是新的`);

  if (SEED || firstRun) {
    console.log(
      firstRun
        ? '\n🌱 這是第一次跑（seen.json 是空的）。把現有職缺全部標記為已見過，' +
            '不推送任何東西 —— 否則你會一次收到上百則通知。\n' +
            '   從下一次開始，只有真正新增的才會推給你。'
        : '\n🌱 --seed 模式：只寫入狀態，不推送。'
    );
  } else if (newJobs.length === 0) {
    console.log('\n😴 沒有新職缺，不推送。');
  } else {
    for (const j of newJobs) {
      console.log(`   🆕 [${j.company}] ${j.title} — ${j.location}`);
    }
    if (!DRY_RUN) {
      await postToSlack(formatSlack(newJobs, errors));
      writeDigest(newJobs, errors);
    } else {
      console.log('\n--- Slack 訊息預覽 ---\n');
      console.log(formatSlack(newJobs, errors));
    }
  }

  if (!DRY_RUN) {
    fs.writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2) + '\n');
    console.log(`\n💾 seen.json 已更新（共 ${Object.keys(seen).length} 筆記錄）`);
  }

  // 全部公司都失敗才讓 workflow 紅燈；部分失敗只留 log，不要因為
  // 單一家 API 改版就讓整個排程停擺。
  if (errors.length === COMPANIES.length) {
    console.error('\n💥 所有公司都抓取失敗');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('💥', e);
  process.exit(1);
});
