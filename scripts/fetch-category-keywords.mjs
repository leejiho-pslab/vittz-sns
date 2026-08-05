#!/usr/bin/env node
/**
 * 제품 카테고리별 핵심 키워드 월간검색수 추적 — 네이버 검색광고 API keywordstool
 *
 * 자사몰 GNB 카테고리(keyword-categories.json)마다 핵심 키워드 3종의 월간검색수를
 * 광고주센터 "키워드 도구"와 동일한 공식 API로 수집해 주간 스냅샷으로 쌓고,
 * 전월(이전 달 마지막 스냅샷) 대비 상승률(%)을 계산해 리서치 탭에 표로 반영한다.
 * (운영자 지시 2026-08-04: 네이버·구글 블로그 기획의 기준 데이터 — 매주 월요일 갱신)
 *
 * 사용:  node scripts/fetch-category-keywords.mjs --client vittz
 * 입력:  data/clients/<id>/keyword-categories.json
 * 출력:  data/clients/<id>/keyword-category-volumes.json  (스냅샷 이력 포함)
 *        data/clients/<id>/research-brief.json             (섹션 upsert — 대시보드 리서치 탭)
 *
 * 필요한 환경변수: NAVER_AD_API_KEY / NAVER_AD_SECRET / NAVER_AD_CUSTOMER_ID
 * 주의: 개발 컨테이너는 외부 API가 막혀 있다 — CI(GitHub Actions)에서 실행할 것.
 */
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? ''] : [])).filter((x) => x.length),
);
const clientId = args.client || 'vittz';
const dataDir = join('data', 'clients', clientId);
const seedPath = join(dataDir, 'keyword-categories.json');
const outPath = join(dataDir, 'keyword-category-volumes.json');
const briefPath = join(dataDir, 'research-brief.json');

const API_KEY = process.env.NAVER_AD_API_KEY || process.env.NAVER_SEARCHAD_API_KEY;
const API_SECRET = process.env.NAVER_AD_SECRET || process.env.NAVER_SEARCHAD_API_SECRET;
const CUSTOMER_ID = process.env.NAVER_AD_CUSTOMER_ID || process.env.NAVER_SEARCHAD_CUSTOMER_ID;
if (!API_KEY || !API_SECRET || !CUSTOMER_ID) {
  console.error('NAVER_AD_API_KEY / NAVER_AD_SECRET / NAVER_AD_CUSTOMER_ID 가 필요합니다.');
  process.exit(1);
}
if (!existsSync(seedPath)) {
  console.error(`카테고리 시드가 없습니다: ${seedPath}`);
  process.exit(1);
}

const BASE = 'https://api.searchad.naver.com';
const PATH = '/keywordstool';
const sign = (ts, method, path) => createHmac('sha256', API_SECRET).update(`${ts}.${method}.${path}`).digest('base64');

/** "< 10" 같은 문자열 검색수를 숫자로 정규화 */
function num(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (s.startsWith('<')) return 5;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function fetchBatch(keywords) {
  const hint = keywords.map((k) => k.replace(/\s+/g, '')).join(',');
  const ts = String(Date.now());
  const res = await fetch(`${BASE}${PATH}?hintKeywords=${encodeURIComponent(hint)}&showDetail=1`, {
    headers: { 'X-Timestamp': ts, 'X-API-KEY': API_KEY, 'X-Customer': String(CUSTOMER_ID), 'X-Signature': sign(ts, 'GET', PATH) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`keywordstool ${res.status} — ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = await res.json();
  return Array.isArray(json.keywordList) ? json.keywordList : [];
}

// ── 수집 ──
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
const allKeywords = seed.categories.flatMap((c) => c.keywords);
const wanted = new Set(allKeywords.map((k) => k.replace(/\s+/g, '')));
const measured = new Map();

for (let i = 0; i < allKeywords.length; i += 5) {
  const chunk = allKeywords.slice(i, i + 5);
  process.stdout.write(`배치 ${Math.floor(i / 5) + 1}/${Math.ceil(allKeywords.length / 5)}: ${chunk.join(', ')} … `);
  try {
    const rows = await fetchBatch(chunk);
    for (const row of rows) {
      const key = String(row.relKeyword || '').replace(/\s+/g, '');
      if (!wanted.has(key) || measured.has(key)) continue;
      const pc = num(row.monthlyPcQcCnt);
      const mobile = num(row.monthlyMobileQcCnt);
      measured.set(key, { pc, mobile, total: pc + mobile, comp: row.compIdx || undefined });
    }
    console.log('ok');
  } catch (err) {
    console.log(`실패 — ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 300)); // API 예의상 간격
}
if (!measured.size) {
  console.error('실측값을 하나도 받지 못했습니다 — 자격 증명/네트워크 확인.');
  process.exit(1);
}

// ── 스냅샷 이력 갱신 (주간) ──
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST
const store = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { snapshots: {} };
store.snapshots[today] = Object.fromEntries([...measured].map(([k, v]) => [k, { pc: v.pc, mobile: v.mobile, total: v.total, comp: v.comp }]));
// 최근 60개 스냅샷만 유지 (약 1년+)
const dates = Object.keys(store.snapshots).sort();
for (const d of dates.slice(0, Math.max(0, dates.length - 60))) delete store.snapshots[d];

/** 전월 대비 기준값: 이전 달(캘린더 기준)의 마지막 스냅샷 */
const curMonth = today.slice(0, 7);
const prevDates = Object.keys(store.snapshots).filter((d) => d.slice(0, 7) < curMonth).sort();
const baseDate = prevDates.length ? prevDates[prevDates.length - 1] : null;
const baseline = baseDate ? store.snapshots[baseDate] : null;

function mom(kwKey) {
  const cur = measured.get(kwKey)?.total;
  const base = baseline?.[kwKey]?.total;
  if (cur == null || base == null || base <= 0) return null;
  return Math.round(((cur - base) / base) * 1000) / 10;
}

store.updatedAt = new Date().toISOString();
store.source = '네이버 광고주센터 키워드 도구 (검색광고 API keywordstool)';
store.baselineDate = baseDate;
store.categories = seed.categories.map((c) => ({
  name: c.name,
  keywords: c.keywords.map((kw) => {
    const key = kw.replace(/\s+/g, '');
    const v = measured.get(key);
    return { keyword: kw, pc: v?.pc ?? null, mobile: v?.mobile ?? null, total: v?.total ?? null, comp: v?.comp ?? null, momPct: mom(key) };
  }),
}));
writeFileSync(outPath, JSON.stringify(store, null, 2), 'utf8');
console.log(`저장: ${outPath} (스냅샷 ${Object.keys(store.snapshots).length}개 · 전월 기준 ${baseDate ?? '축적 중'})`);

// ── 리서치 탭 섹션 upsert ──
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
const arrow = (p) => (p == null ? '전월 데이터 축적 중' : `${p > 0 ? '▲' : p < 0 ? '▼' : '—'}${Math.abs(p)}%`);
const cell = (k) => (k.total == null ? `${k.keyword} · 실측 없음` : `${k.keyword} ${fmt(k.total)} (${arrow(k.momPct)})`);

const risers = store.categories
  .flatMap((c) => c.keywords)
  .filter((k) => k.momPct != null)
  .sort((a, b) => b.momPct - a.momPct);
const section = {
  id: 'category-keywords',
  icon: '🗂',
  title: '카테고리별 핵심 키워드 검색량 — 블로그 기획 기준 데이터',
  desc:
    `자사몰 제품 카테고리별 핵심 키워드 3종의 네이버 월간검색수(PC+모바일 합계). 광고주센터 키워드 도구 실측 · 매주 월요일 자동 갱신. ` +
    `기준일 ${today}` +
    (baseDate ? ` · 전월 대비는 ${baseDate} 스냅샷 기준` : ` · 전월 대비 %는 다음 달부터 표시(스냅샷 축적 중)`),
  stats: [
    { v: fmt(store.categories.flatMap((c) => c.keywords).reduce((s, k) => s + (k.total ?? 0), 0)), l: '42개 키워드 월간검색수 합계' },
    risers.length
      ? { v: `${risers[0].keyword} ▲${risers[0].momPct}%`, l: '전월 대비 최고 상승', accent: true }
      : { v: '축적 중', l: '전월 대비 상승률(다음 달부터)' },
    risers.length ? { v: `${risers[risers.length - 1].keyword} ${arrow(risers[risers.length - 1].momPct)}`, l: '전월 대비 최저' } : { v: '월요일 09:00', l: '주간 자동 갱신' },
  ],
  table: {
    head: ['카테고리', '핵심 키워드 ① (월간·전월比)', '핵심 키워드 ②', '핵심 키워드 ③'],
    rows: store.categories.map((c) => [c.name, ...c.keywords.map(cell)]),
  },
};

if (existsSync(briefPath)) {
  const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
  const idx = (brief.sections ?? []).findIndex((s) => s.id === 'category-keywords');
  if (idx >= 0) brief.sections[idx] = section;
  else {
    const kwIdx = (brief.sections ?? []).findIndex((s) => s.id === 'keywords' || /키워드 전략/.test(s.title ?? ''));
    if (kwIdx >= 0) brief.sections.splice(kwIdx + 1, 0, section);
    else brief.sections.push(section);
  }
  brief.updatedAt = today;
  writeFileSync(briefPath, JSON.stringify(brief, null, 2), 'utf8');
  console.log(`리서치 탭 반영: ${briefPath} (#category-keywords)`);
}
