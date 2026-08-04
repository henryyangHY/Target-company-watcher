#!/usr/bin/env node
// 加新公司前先用這個實測。例：
//   node probe.js greenhouse figma
//   node probe.js ashby databricks
//   node probe.js workday nvidia.wd5.myworkdayjobs.com nvidia NVIDIAExternalCareerSite
import { ADAPTERS } from './src/adapters.js';
import { TITLE_PATTERNS, TITLE_EXCLUDE } from './src/config.js';

const [ats, a, b, c] = process.argv.slice(2);
if (!ats || !ADAPTERS[ats]) {
  console.log('用法: node probe.js <greenhouse|ashby|workday|microsoft|google> [token | host tenant site]');
  process.exit(1);
}

const cfg =
  ats === 'workday' ? { host: a, tenant: b, site: c } : { token: a };

const jobs = await ADAPTERS[ats](cfg);
const hits = jobs.filter(
  (j) =>
    !TITLE_EXCLUDE.some((re) => re.test(j.title)) &&
    TITLE_PATTERNS.some((re) => re.test(j.title))
);

console.log(`總共 ${jobs.length} 筆，命中 ${hits.length} 筆\n`);
for (const j of hits.slice(0, 20)) {
  console.log(`• ${j.title}\n  ${j.location} — ${j.url}`);
}
