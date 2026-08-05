#!/usr/bin/env node
/**
 * 네이버 키워드 도구 실측 월간검색수 수집 — 검색광고 API keywordstool
 *
 * 광고주센터 "키워드 도구" 화면과 동일한 데이터(월간검색수 PC/모바일, 경쟁정도,
 * 월평균클릭수, 월평균노출 광고수)를 공식 API로 받아 저장한다.
 *
 * 사용:  node scripts/fetch-keyword-volumes.mjs --client vittz
 * 입력:  data/clients/<id>/keyword-batches.json  (배치당 최대 5개 키워드)
 * 출력:  data/clients/<id>/keyword-volumes.json  (대시보드 리서치 탭이 자동 표시)
 *
 * 필요한 환경변수(GitHub Secrets):
 *   NAVER_AD_API_KEY      광고주센터 → 도구 → API 사용 관리 → 액세스라이선스
 *   NAVER_AD_SECRET       같은 화면의 비밀키
 *   NAVER_AD_CUSTOMER_ID  광고주 ID (광고주센터 URL의 ad-accounts/<숫자>)
 *   (구명 NAVER_SEARCHAD_* 도 폴백 지원)
 *
 * 주의: 개발 컨테이너는 외부 API 접근이 막혀 있을 수 있다 — CI(GitHub Actions)에서 실행할 것.
 */
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadNaverAdCreds } from './naver-ad-creds.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? ''] : [])).filter((x) => x.length),
);
const clientId = args.client || 'vittz';
const dataDir = join('data', 'clients', clientId);
const batchesPath = join(dataDir, 'keyword-batches.json');
const outPath = join(dataDir, 'keyword-volumes.json');

const { key: API_KEY, secret: API_SECRET, customerId: CUSTOMER_ID } = loadNaverAdCreds();
if (!API_KEY || !API_SECRET || !CUSTOMER_ID) {
  console.error('네이버 광고 API 자격 증명이 없습니다 — 환경변수(NAVER_AD_*) 또는 data/naver-ad-credentials.json(고정값)이 필요합니다.');
  process.exit(1);
}
if (!existsSync(batchesPath)) {
  console.error(`배치 파일이 없습니다: ${batchesPath}`);
  process.exit(1);
}

const BASE = 'https://api.searchad.naver.com';
const PATH = '/keywordstool';

function sign(timestamp, method, path) {
  return createHmac('sha256', API_SECRET).update(`${timestamp}.${method}.${path}`).digest('base64');
}

/** "< 10" 같은 문자열 검색수를 숫자로 정규화 */
function num(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (s.startsWith('<')) return 5;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function fetchBatch(keywords) {
  // 키워드 도구 입력 규칙과 동일: 공백 제거, 한 번에 최대 5개
  const hint = keywords.map((k) => k.replace(/\s+/g, '')).join(',');
  const ts = String(Date.now());
  const url = `${BASE}${PATH}?hintKeywords=${encodeURIComponent(hint)}&showDetail=1`;
  const res = await fetch(url, {
    headers: {
      'X-Timestamp': ts,
      'X-API-KEY': API_KEY,
      'X-Customer': String(CUSTOMER_ID),
      'X-Signature': sign(ts, 'GET', PATH),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`keywordstool ${res.status} — ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return Array.isArray(json.keywordList) ? json.keywordList : [];
}

function toVolume(row) {
  const pc = num(row.monthlyPcQcCnt);
  const mobile = num(row.monthlyMobileQcCnt);
  return {
    keyword: row.relKeyword,
    pc,
    mobile,
    total: pc + mobile,
    compIdx: row.compIdx || undefined,
    avgPcClicks: num(row.monthlyAvePcClkCnt) || undefined,
    avgMobileClicks: num(row.monthlyAveMobileClkCnt) || undefined,
    plAvgDepth: num(row.plAvgDepth) || undefined,
  };
}

const batches = JSON.parse(readFileSync(batchesPath, 'utf8'));
const requestedSet = new Set(
  batches.flatMap((b) => b.keywords).map((k) => k.replace(/\s+/g, '')),
);
const requested = new Map();
const related = new Map();

for (const [i, batch] of batches.entries()) {
  process.stdout.write(`배치 ${i + 1}/${batches.length} (${batch.name || ''}): ${batch.keywords.join(', ')} … `);
  try {
    const rows = await fetchBatch(batch.keywords);
    for (const row of rows) {
      const key = String(row.relKeyword || '').replace(/\s+/g, '');
      const vol = toVolume(row);
      if (requestedSet.has(key)) {
        if (!requested.has(key)) requested.set(key, vol);
      } else if (!related.has(key)) {
        related.set(key, vol);
      }
    }
    console.log(`ok (${rows.length}행)`);
  } catch (err) {
    console.log(`실패 — ${err.message}`);
  }
  // 호출 간 간격 (검색광고 API 속도 제한 보호)
  await new Promise((r) => setTimeout(r, 1200));
}

if (requested.size === 0) {
  console.error('실측값을 하나도 받지 못했습니다 — API 키/권한/네트워크를 확인하세요.');
  process.exit(1);
}

const doc = {
  updatedAt: new Date().toISOString(),
  source: '네이버 검색광고 API keywordstool (광고주센터 키워드 도구와 동일 데이터)',
  requested: [...requested.values()].sort((a, b) => b.total - a.total),
  related: [...related.values()].sort((a, b) => b.total - a.total).slice(0, 100),
};
writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf8');
console.log(`\n저장: ${outPath} — 요청 키워드 ${doc.requested.length}개 실측, 연관키워드 상위 ${doc.related.length}개`);

// 대시보드 계약(keyword-stats.json) — 엔진(guidance.ts KeywordStats)이 읽는 단일 출처.
// '< 10'(비공개 소량)은 toVolume에서 5로 정규화되지만, 계약상 null 허용 — 실측값만 기록.
const stats = {
  source: doc.source,
  fetchedAt: doc.updatedAt.slice(0, 10),
  items: [...requested.values(), ...related.values()].map((v) => ({
    kw: v.keyword,
    pc: v.pc,
    mobile: v.mobile,
    competition: v.compIdx ?? undefined,
    clicks: (v.avgPcClicks ?? 0) + (v.avgMobileClicks ?? 0) || undefined,
    adCount: v.plAvgDepth ?? undefined,
  })),
};
const statsPath = join(dataDir, 'keyword-stats.json');
writeFileSync(statsPath, JSON.stringify(stats, null, 2), 'utf8');
console.log(`저장: ${statsPath} — 대시보드 '키워드 월간 검색수' 실측 연결 (${stats.items.length}행)`);
