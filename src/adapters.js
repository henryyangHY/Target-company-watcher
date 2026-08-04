// ---------------------------------------------------------------------------
// 每個 adapter 都回傳統一格式的陣列：
//   { id, title, location, url, posted }
// id 只要在該公司內唯一即可（最後會加上公司名當 prefix 存進 seen.json）。
// posted 是 ISO 字串或 null —— 我們不依賴它做去重，純粹顯示用。
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 帶退避重試。Microsoft 的 endpoint 探測太密會回 429，這裡等一下再試就好。
async function request(url, opts = {}, attempt = 1) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'User-Agent': UA,
      Accept: opts.accept || 'application/json, text/plain, */*',
      ...(opts.headers || {}),
    },
    body: opts.body,
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt <= 3) {
      const wait = attempt * 5000;
      console.log(`   ↻ ${res.status}，${wait / 1000}s 後重試 (${attempt}/3)`);
      await sleep(wait);
      return request(url, opts, attempt + 1);
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return opts.text ? res.text() : res.json();
}

// --- Greenhouse -------------------------------------------------------------
// 用這個的：Anthropic。實測 391 筆。
export async function greenhouse({ token }) {
  const d = await request(
    `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`
  );
  return d.jobs.map((j) => ({
    id: String(j.id),
    title: j.title,
    location: j.location?.name || '',
    url: j.absolute_url,
    posted: j.first_published || j.updated_at || null,
  }));
}

// --- Ashby ------------------------------------------------------------------
// 用這個的：Notion、OpenAI。注意 OpenAI 的 payload 約 12MB（含全文 description），
// 所以一定要在這裡就丟掉 description，不要往下傳。
export async function ashby({ token }) {
  const d = await request(
    `https://api.ashbyhq.com/posting-api/job-board/${token}`
  );
  return d.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      id: String(j.id),
      title: j.title,
      location: [j.location, ...(j.secondaryLocations || []).map((s) => s.location || s)]
        .filter(Boolean)
        .join(' / '),
      url: j.jobUrl,
      posted: j.publishedAt || null,
      // Ashby 有正規化的 employmentType（FullTime / Intern / …），拿來當額外訊號
      employmentType: j.employmentType || '',
    }));
}

// --- Workday ----------------------------------------------------------------
// 用這個的：Salesforce。
// 重點：searchText:"intern" 實測「無效」（照樣回 730 筆全部職缺），
// 所以改走 facet。workerSubType 這個 facet 裡有 "Intern (Fixed Term)"。
// facet 的 id 是 tenant 專屬的雜湊值且可能改，所以每次都動態解析，不寫死。
export async function workday({ host, tenant, site }) {
  const endpoint = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
  const post = (body) =>
    request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  // 第一次呼叫：拿 facets，找出 intern 對應的 id
  const probe = await post({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' });
  let internFacet = null;
  for (const f of probe.facets || []) {
    if (f.facetParameter !== 'workerSubType') continue;
    const hit = (f.values || []).find((v) => /intern/i.test(v.descriptor || ''));
    if (hit) internFacet = hit.id;
  }

  const applied = internFacet ? { workerSubType: [internFacet] } : {};
  if (!internFacet) {
    console.log('   ⚠ 找不到 intern facet，改用全量掃描 + 標題過濾');
  }

  const out = [];
  const pageSize = 20;
  // 有 facet 的話通常十幾筆就掃完；沒有的話最多翻 40 頁（800 筆）保護一下
  const maxPages = internFacet ? 10 : 40;

  for (let page = 0; page < maxPages; page++) {
    const d = await post({
      appliedFacets: applied,
      limit: pageSize,
      offset: page * pageSize,
      searchText: '',
    });
    const postings = d.jobPostings || [];
    for (const p of postings) {
      out.push({
        id: (p.bulletFields && p.bulletFields[0]) || p.externalPath,
        title: p.title,
        location: p.locationsText || '',
        url: `https://${host}/${site}${p.externalPath}`,
        // Workday 只給相對字串（"Posted Today" / "Posted 5 Days Ago"），
        // 不可當作可靠時間戳 —— 去重完全靠 seen.json。
        posted: p.postedOn || null,
        // 有 facet 就代表 Workday 自己認定這是 intern 職缺，不用再比標題
        internConfirmed: Boolean(internFacet),
      });
    }
    if (postings.length < pageSize) break;
    if (out.length >= (d.total || 0)) break;
    await sleep(400); // 對 Workday 客氣一點
  }
  return out;
}

// --- Microsoft --------------------------------------------------------------
// Microsoft 已從舊的 gcsservices API 遷移到 Eightfold（apply.careers.microsoft.com）。
// 舊 host 的 TLS 憑證是壞的（給 *.azureedge.net），不要再用。
// robots.txt 明確 Allow /api/pcsx。
//
// 兩個來源合併，用內部 job id 去重：
//
//   1. sitemap  — 一個 request 拿到全部 ~1800 筆職缺，覆蓋完整。
//                 缺點是標題從 URL slug 還原（小寫連字號），且 sitemap
//                 通常一天才重新產生一次，剛貼出來的職缺可能還沒進去。
//   2. PCSX API — sort_by=timestamp 拿最新的 10 筆，補上 sitemap 的時間差。
//                 num 參數實測被鎖死在 10（給 50 或 100 都只回 10 筆），
//                 所以這裡只當「最新補丁」用，不拿它做全量掃描。
//
// 注意：et=Internship 參數無效（實測回傳 count 1812＝全部職缺），別浪費時間。
export async function microsoft() {
  const bySite = await microsoftSitemap();
  const byId = new Map(bySite.map((j) => [j.id, j]));

  try {
    const url =
      'https://apply.careers.microsoft.com/api/pcsx/search' +
      '?domain=microsoft.com&start=0&num=10&sort_by=timestamp&flt=true';
    const d = await request(url, {
      headers: { Referer: 'https://apply.careers.microsoft.com/careers' },
    });
    for (const p of d?.data?.positions || []) {
      // PCSX 的標題和地點比 slug 還原的乾淨，所以讓它覆蓋 sitemap 的版本
      byId.set(String(p.id), {
        id: String(p.id),
        title: p.name,
        location: (p.standardizedLocations || p.locations || []).join(' / '),
        url: `https://apply.careers.microsoft.com/careers/job/${p.id}`,
        posted: p.postedTs ? new Date(p.postedTs * 1000).toISOString() : null,
      });
    }
  } catch (e) {
    // PCSX 會限流，掛掉不要緊，sitemap 已經涵蓋絕大多數
    console.log(`   ⚠ PCSX 補抓失敗（${e.message}），只用 sitemap`);
  }

  return [...byId.values()];
}

// slug 長這樣：senior-manager-data-analytics-united-states-washington-redmond
// 國名之後的都是地點，用這個把標題和地點切開（切不開就整串當標題）。
const COUNTRY_IN_SLUG =
  /-(united-states|united-kingdom|india|china|japan|canada|germany|israel|ireland|netherlands|australia|brazil|mexico|singapore|taiwan|korea|france|italy|spain|poland|czech-republic|romania|denmark|sweden|norway|finland|switzerland|austria|belgium|portugal|greece|turkey|egypt|nigeria|kenya|south-africa|united-arab-emirates|qatar|saudi-arabia|argentina|colombia|chile|peru|new-zealand|philippines|indonesia|malaysia|thailand|vietnam|hong-kong|multiple-locations)-/;

const deslug = (s) =>
  s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

async function microsoftSitemap() {
  const xml = await request(
    'https://apply.careers.microsoft.com/careers/sitemap.xml',
    { text: true, accept: 'application/xml,text/xml,*/*' }
  );
  const out = [];
  const re =
    /<loc>(https:\/\/[^<]*\/careers\/job\/(\d+)-([^?<]+)[^<]*)<\/loc>\s*<priority>[^<]*<\/priority>\s*(?:<lastmod>([^<]*)<\/lastmod>)?/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const slug = m[3];
    const cut = slug.match(COUNTRY_IN_SLUG);
    out.push({
      id: m[2],
      title: deslug(cut ? slug.slice(0, cut.index) : slug),
      // 切不出國名時，把整串 slug 當地點用。看起來冗餘，但這樣美國過濾
      // 才不會誤放行 —— slug 尾端一定帶地名（例：…-kuwait-al-asimah-kuwait），
      // 給 '(見職缺頁)' 的話會被當成「地點不明」而放行。
      location: deslug(cut ? slug.slice(cut.index + 1) : slug),
      url: m[1],
      posted: m[4] || null,
    });
  }
  return out;
}

// --- Google -----------------------------------------------------------------
// Google careers 沒有公開 JSON API（舊的 careers.google.com/api/v3 已 404）。
// 但搜尋結果頁是 server-rendered 的，職缺以 "<19位數字id>","<標題>" 的形式
// 嵌在 HTML 裡，可以直接抽。每頁 10 筆。
//
// 關鍵：用 employment_type=INTERN 讓 Google 自己篩，不要用 q=intern。
// Google 的實習職缺標題常常沒有 "intern" 這個字（實測是 "Student Researcher,
// BS/MS, Fall 2026"、"Project Management Apprenticeship"），
// 所以這裡回傳的一律標 internConfirmed，跳過標題比對。
export async function google({ location } = {}) {
  const out = [];
  const seenIds = new Set();
  const locParam = location ? `&location=${encodeURIComponent(location)}` : '';

  for (let page = 1; page <= 5; page++) {
    const url =
      'https://www.google.com/about/careers/applications/jobs/results' +
      `?employment_type=INTERN&sort_by=date${locParam}&page=${page}`;
    const html = await request(url, {
      text: true,
      accept: 'text/html,application/xhtml+xml',
    });

    const re = /"(\d{15,})","((?:[^"\\]|\\.){5,120})"/g;
    let m;
    let found = 0;
    while ((m = re.exec(html)) !== null) {
      const [, id, rawTitle] = m;
      if (seenIds.has(id)) continue;
      const title = rawTitle.replace(/\\u[\dA-Fa-f]{4}/g, (s) =>
        String.fromCharCode(parseInt(s.slice(2), 16))
      );
      // 頁面裡混了非職缺字串（追蹤 id、內部代碼如 "HiPsbb"）。
      // 真的職缺標題一定有空白，用這個擋掉雜訊。
      if (!/[a-z]/.test(title) || !/\s/.test(title) || title.length < 10) continue;
      seenIds.add(id);
      found++;
      out.push({
        id,
        title,
        location: '(見職缺頁)',
        url: `https://www.google.com/about/careers/applications/jobs/results/${id}`,
        posted: null,
        internConfirmed: true,
      });
    }
    if (found === 0) break;
    await sleep(800);
  }
  return out;
}

export const ADAPTERS = { greenhouse, ashby, workday, microsoft, google };
