#!/usr/bin/env node
/**
 * 네이버 검색광고 "키워드 도구" 월간검색수 수집 → keyword-trends.json (v3)
 *
 * 블로그·콘텐츠 기획을 "실제 검색량"으로 움직이는 데이터 소스.
 * 3시트로 구분 저장(각 검색량 상위 20):
 *   core    = 핵심 키워드 (브랜드 최상위 연관 키워드)
 *   related = 연관 키워드 (핵심에서 파생된 관련 키워드)
 *   timely  = 시의성 키워드 (현재 시즌·이슈 중 브랜드 연결 가능한 키워드)
 * baseDate = 기준일(갱신한 금요일). 매주 금요일 갱신(워크플로에서 요일 게이트).
 *
 * 시크릿: NAVER_AD_API_KEY(액세스라이선스) / NAVER_AD_SECRET(비밀키) / NAVER_AD_CUSTOMER_ID(계정번호)
 * 없으면 조용히 건너뜀(기존 파일 유지). 사용: node scripts/fetch-keywords.mjs --client pslab
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNaverAdCreds } from './naver-ad-creds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const clientId = arg('client', 'pslab');

const { key: API_KEY, secret: SECRET, customerId: CUSTOMER } = loadNaverAdCreds();
if (!API_KEY || !SECRET || !CUSTOMER) {
  console.log('네이버 검색광고 API 자격 증명 없음(환경변수/고정값 파일 모두) — 키워드 수집 건너뜀');
  process.exit(0);
}

// 업체별 기획 시드 — clients/<id>.json 의 keywordPlan { coreSeeds, season, commonTimely, relatedFilter }
// (단일 출처 · 없으면 아래 예시 시드로 폴백)
function loadKeywordPlan() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'clients', `${clientId}.json`), 'utf8'));
    return cfg.keywordPlan || null;
  } catch { return null; }
}
const PLAN = loadKeywordPlan();

const BASE = 'https://api.searchad.naver.com';
const PATH = '/keywordstool';
const TOP = 20; // 시트별 상위 N

// ── 핵심(core) 시드: 브랜드 최상위 연관 키워드 ──
// 예시 시드 — 업체별로 교체
const CORE_SEEDS = [
  '특수인쇄', '금박인쇄', '싸바리박스', '화장품박스', '패키지제작', '단상자', '선물세트박스',
  '쇼핑백제작', '박스제작', '지기구조', '홍삼패키지', '주류패키지', '인쇄후가공', '합지박스',
  '형압', '홀로그램인쇄', '에폭시인쇄', '특수패키지', '화장품패키지', '고급박스', '기프트박스',
  '실크인쇄', '목형', '동판인쇄',
];

// ── 시의성(timely) 시드: 월별 시즌 + 상시 이슈(브랜드 연결 가능) ──
// 예시 시드 — 업체별로 교체
const SEASON = {
  1: ['설선물세트', '설선물', '신년선물', '명절선물세트'],
  2: ['설선물세트', '발렌타인포장', '졸업선물', '입학선물'],
  3: ['화이트데이포장', '졸업선물', '입학선물', '봄시즌패키지'],
  4: ['어버이날선물', '가정의달선물', '스승의날선물'],
  5: ['어버이날선물', '가정의달선물세트', '스승의날선물', '성년의날선물'],
  6: ['여름선물', '기업답례품', '창립기념품'],
  7: ['추석선물세트', '추석선물', '명절선물세트', '홍삼선물세트', '건강기능식품선물'],
  8: ['추석선물세트', '추석선물', '추석답례품', '홍삼선물세트', '명절선물세트'],
  9: ['추석선물세트', '추석답례품', '홍삼선물세트', '기업추석선물'],
  10: ['연말선물', '기업답례품', '창립기념품'],
  11: ['연말선물', '크리스마스선물포장', '연말답례품', '기업선물세트'],
  12: ['크리스마스선물포장', '연말선물', '신년선물', '기업답례품'],
};
// 예시 시드 — 업체별로 교체
const COMMON_TIMELY = ['기업답례품', '웨딩답례품', 'VIP선물', '창립기념품', '판촉물제작', '기념품제작'];
function timelySeeds() {
  const m = new Date().getUTCMonth() + 1;
  const next = (m % 12) + 1;
  const season = (PLAN && PLAN.season) || SEASON;
  const common = (PLAN && Array.isArray(PLAN.commonTimely)) ? PLAN.commonTimely : COMMON_TIMELY;
  return [...new Set([...(season[m] || []), ...(season[next] || []), ...common].map((s) => s.replace(/\s+/g, '')))];
}

// clients/<id>.json 의 keywords도 핵심에 합침
function coreSeeds() {
  let extra = [];
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'clients', `${clientId}.json`), 'utf8'));
    if (Array.isArray(cfg.keywords)) extra = cfg.keywords;
  } catch { /* noop */ }
  return [...new Set([...CORE_SEEDS, ...extra].map((s) => String(s).replace(/\s+/g, '')))];
}

const sign = (ts, method, path) => createHmac('sha256', SECRET).update(`${ts}.${method}.${path}`).digest('base64');
const toNum = (v) => { const n = parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : 0; };

async function keywordstool(hints) {
  const ts = Date.now();
  const qs = `hintKeywords=${encodeURIComponent(hints.join(','))}&showDetail=1`;
  const res = await fetch(`${BASE}${PATH}?${qs}`, {
    method: 'GET',
    headers: { 'X-Timestamp': String(ts), 'X-API-KEY': API_KEY, 'X-Customer': String(CUSTOMER), 'X-Signature': sign(ts, 'GET', PATH) },
  });
  if (!res.ok) { console.log(`  API ${res.status} — ${(await res.text()).slice(0, 120)}`); return []; }
  const j = await res.json();
  return Array.isArray(j.keywordList) ? j.keywordList : [];
}

const core = PLAN && Array.isArray(PLAN.coreSeeds) && PLAN.coreSeeds.length ? [...new Set([...PLAN.coreSeeds, ...coreSeeds()])] : coreSeeds();
const timely = timelySeeds();
const allSeeds = [...new Set([...core, ...timely])];

const rows = new Map(); // relKeyword → row
for (let i = 0; i < allSeeds.length; i += 5) {
  const batch = allSeeds.slice(i, i + 5);
  try {
    const list = await keywordstool(batch);
    for (const r of list) if (r && r.relKeyword) rows.set(r.relKeyword.replace(/\s+/g, ''), r);
  } catch (e) { console.log(`  배치 실패 ${batch.join(',')}: ${e.message}`); }
  await new Promise((r) => setTimeout(r, 350));
}
if (!rows.size) { console.log('API 응답 없음 — 기존 파일 유지'); process.exit(0); }

const mapRow = (r) => { const pc = toNum(r.monthlyPcQcCnt), mo = toNum(r.monthlyMobileQcCnt); return { kw: r.relKeyword.replace(/\s+/g, ''), pc, mobile: mo, total: pc + mo, comp: r.compIdx || '' }; };
const bySeed = (seeds) => seeds.map((s) => rows.get(s)).filter(Boolean).map(mapRow).sort((a, b) => b.total - a.total).slice(0, TOP);

const coreSheet = bySeed(core);
const timelySheet = bySeed(timely);

// 연관: 시드에 없던 패키지/인쇄 관련 연관키워드 상위 20
const seedSet = new Set(allSeeds);
const PKG_RE = (PLAN && PLAN.relatedFilter)
  ? new RegExp(PLAN.relatedFilter)
  : /(박스|상자|패키지|패키징|쇼핑백|지함|카톤|포장|인쇄|후가공|금박|은박|형압|에폭시|홀로그램|단상자|합지|굿즈|케이스|리플렛|명함|스티커|라벨|지기|틴|제작소|인쇄소|답례품|선물세트)/;
const relatedSheet = [...rows.values()].map(mapRow)
  .filter((r) => !seedSet.has(r.kw) && r.total > 0 && PKG_RE.test(r.kw))
  .sort((a, b) => b.total - a.total).slice(0, TOP);

// 기준일 = 이번 주 금요일(이 스크립트는 금요일에 실행됨). 실행일 기준으로 계산.
const now = new Date();
const day = now.getUTCDay(); // 0=일 … 5=금
const fri = new Date(now); fri.setUTCDate(now.getUTCDate() + ((5 - day + 7) % 7 === 0 ? 0 : (5 - day + 7) % 7 - 7));
// 실행일이 금요일이면 오늘, 아니면 가장 최근 금요일
const base = day === 5 ? now : (() => { const d = new Date(now); d.setUTCDate(now.getUTCDate() - ((day - 5 + 7) % 7)); return d; })();
const baseDate = base.toISOString().slice(0, 10);

const out = {
  source: '네이버 검색광고 키워드도구 · 월간검색수(PC+모바일)',
  baseDate,
  updatedAt: now.toISOString(),
  updateCycle: '매주 금요일',
  core: coreSheet,
  related: relatedSheet,
  timely: timelySheet,
  keywords: coreSheet, // 하위호환(v2 dashboard가 keywords 참조 시 핵심시트로 폴백)
};
const file = join(ROOT, 'data/clients', clientId, 'keyword-trends.json');
if (!existsSync(dirname(file))) { console.log('데이터 폴더 없음 — 건너뜀'); process.exit(0); }
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`키워드 수집 완료(기준일 ${baseDate}) · 핵심 ${coreSheet.length} · 연관 ${relatedSheet.length} · 시의성 ${timelySheet.length}`);
console.log('핵심 상위:', coreSheet.slice(0, 5).map((k) => `${k.kw}=${k.total}`).join(' '));
console.log('시의성 상위:', timelySheet.slice(0, 4).map((k) => `${k.kw}=${k.total}`).join(' '));
