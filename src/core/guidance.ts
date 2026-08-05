/**
 * 운영자 지침(브랜드 노트 + 채널별 콘텐츠 가이드) — AI가 "상시 학습"하는 입력 창구
 *
 * 대시보드 '지침' 탭에서 작성 → 깃허브 이슈(제목 규약) → guidance-sync 워크플로가
 * 이 저장소 파일에 반영 → 다음 생성 사이클부터 프롬프트·소재 선정에 자동 적용.
 *
 *   [브랜드노트·분석]   → brand-brief.json analysis
 *   [브랜드노트·방향성] → brand-brief.json direction
 *   [브랜드노트·감도]   → brand-brief.json sensibility
 *   [가이드·<채널key>]  → channel-guides.json (본문 "주제:" 줄은 소재 풀, 나머지는 가이드)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PlatformId } from './types.js';

/** 브랜드 노트 — 운영자가 수시로 갱신하는 브랜드 이해 */
export interface BrandBrief {
  /** 브랜드 분석 (우리가 어떤 브랜드인지) */
  analysis?: string;
  /** 방향성 의견 (어디로 가야 하는지) */
  direction?: string;
  /** 콘텐츠 감도 (톤·비주얼·무드 기준) */
  sensibility?: string;
  updatedAt?: string;
  /** 최근 갱신 이력 (최대 20) */
  log?: Array<{ at: string; field: string; excerpt: string }>;
}

/** 채널별 콘텐츠 가이드 */
export interface ChannelGuide {
  /** 우선 소재 풀 — 기획 소재 선정에서 가장 먼저 고려 */
  topics: string[];
  /** 핵심 가이드 본문 — 글 생성 프롬프트에 그대로 주입 */
  guide: string;
  updatedAt?: string;
}
export type ChannelGuides = Partial<Record<PlatformId, ChannelGuide>>;

/** 리서치 브리프 — 온보딩 조사 결과를 대시보드 '리서치' 탭에 시각화하기 위한 구조 */
export interface ResearchSection {
  icon?: string;
  title: string;
  desc?: string;
  /** KPI 숫자 카드 */
  stats?: Array<{ v: string; l: string; accent?: boolean }>;
  /** 가로 막대 차트 (value는 0~max 상대값) */
  bars?: { title?: string; unit?: string; max?: number; items: Array<{ label: string; value: number; note?: string; color?: string }> };
  /** 표 */
  table?: { head: string[]; rows: string[][] };
  /** 태그 뭉치 */
  tags?: string[];
  /** 불릿 리스트 (제목+설명) */
  list?: Array<{ t: string; d?: string }>;
  /** 타임라인 */
  timeline?: Array<{ date: string; text: string; url?: string }>;
  /** 확인용 외부 링크 */
  links?: Array<{ label: string; url: string; note?: string }>;
}
export interface ResearchBrief {
  title?: string;
  updatedAt?: string;
  note?: string;
  sections: ResearchSection[];
}

/**
 * 네이버 광고주센터 키워드 도구 실측 데이터 — keyword-stats.json
 * 반드시 실제 조회값만 넣는다 (허수 금지). scripts/import-keyword-stats.mjs로
 * 키워드 도구 '전체 다운로드' CSV를 변환해 생성.
 */
export interface KeywordStat {
  kw: string;
  /** 월간검색수(PC) — 키워드 도구 '< 10'은 null로 */
  pc: number | null;
  /** 월간검색수(모바일) */
  mobile: number | null;
  /** 경쟁정도 (낮음/보통/높음) */
  competition?: string;
  /** 월평균노출광고수 */
  adCount?: number | null;
  /** 월평균클릭수 (PC+모바일 합) */
  clicks?: number | null;
}
export interface KeywordStats {
  source: string;
  /** 조회(다운로드) 기준일 */
  fetchedAt: string;
  items: KeywordStat[];
}

/**
 * 제품 카테고리별 핵심 키워드 주간 실측 — keyword-category-volumes.json
 * scripts/fetch-category-keywords.mjs가 매주 월요일 수집(스냅샷)하고 전월 대비 상승률을 계산한다.
 * 블로그(네이버·구글) 탭의 상시 키워드 패널이 이 데이터를 그대로 표시한다.
 */
export interface CategoryKeywordVolume {
  keyword: string;
  pc: number | null;
  mobile: number | null;
  total: number | null;
  comp?: string | null;
  /** 전월 대비 상승률(%) — 이전 달 스냅샷이 없으면 null(축적 중) */
  momPct: number | null;
}
export interface CategoryKeywordVolumes {
  updatedAt: string;
  source?: string;
  baselineDate?: string | null;
  categories: { name: string; keywords: CategoryKeywordVolume[] }[];
}

/**
 * 레퍼런스 링크 인박스 — reference-links.json
 * 운영자가 대시보드에서 채널별 벤치마크 링크를 등록(`[레퍼런스·<채널>]` 이슈)하면
 * pending으로 적재되고, Claude 세션이 기획·제작 게이트에서 직접 열람·학습한 뒤
 * learned로 바꾸며 학습 요약을 남긴다. CI는 링크를 열람하지 않는다(적재만).
 */
export interface ReferenceLink {
  url: string;
  channel: string;
  /** 운영자가 링크와 함께 남긴 메모(벤치마크 의도) */
  note?: string;
  status: 'pending' | 'learned' | 'failed';
  addedAt: string;
  learnedAt?: string;
  /** 학습 요약 — 무엇을 배웠고 어디에 반영했는지 (Claude 세션이 기록) */
  summary?: string;
}
export interface ReferenceLinks {
  updatedAt?: string;
  links: ReferenceLink[];
}

export const BRAND_FIELDS: Record<string, keyof BrandBrief> = {
  분석: 'analysis',
  방향성: 'direction',
  감도: 'sensibility',
};

/** 이슈 본문 → 채널 가이드 파싱. "주제:" 로 시작하는 줄은 소재 풀(쉼표 구분). */
export function parseGuideBody(body: string): { topics: string[]; guide: string } {
  const topics: string[] = [];
  const rest: string[] = [];
  for (const line of String(body || '').split('\n')) {
    const m = line.trim().match(/^(?:주제|토픽|topics?)\s*[:：]\s*(.+)$/i);
    if (m) {
      topics.push(...m[1].split(/[,，·]/).map((s) => s.trim()).filter(Boolean));
    } else {
      rest.push(line);
    }
  }
  return { topics, guide: rest.join('\n').trim() };
}

/** 프롬프트 주입용 — 브랜드 노트를 한 덩어리 텍스트로 */
export function brandNotesText(b: BrandBrief | undefined): string | undefined {
  if (!b) return undefined;
  const parts = [
    b.analysis ? `- 브랜드 분석: ${b.analysis}` : '',
    b.direction ? `- 방향성: ${b.direction}` : '',
    b.sensibility ? `- 콘텐츠 감도(톤·무드): ${b.sensibility}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
}

/** data/<clientId>/brand-brief.json + channel-guides.json 저장소 */
export class GuidanceStore {
  constructor(private readonly baseDir: string) {}

  private file(clientId: string, name: string): string {
    return join(this.baseDir, clientId, name);
  }

  private read<T>(path: string): T | undefined {
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  private write(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  }

  loadBrief(clientId: string): BrandBrief {
    return this.read<BrandBrief>(this.file(clientId, 'brand-brief.json')) ?? {};
  }

  saveBrief(clientId: string, brief: BrandBrief): void {
    this.write(this.file(clientId, 'brand-brief.json'), brief);
  }

  /** 브랜드 노트 한 필드를 갱신하고 이력을 남긴다. */
  updateBriefField(clientId: string, field: keyof BrandBrief, text: string): BrandBrief {
    const b = this.loadBrief(clientId);
    (b as Record<string, unknown>)[field] = text;
    b.updatedAt = new Date().toISOString();
    b.log = [
      { at: b.updatedAt, field: String(field), excerpt: text.slice(0, 80) },
      ...(b.log ?? []),
    ].slice(0, 20);
    this.saveBrief(clientId, b);
    return b;
  }

  /** week-plan.json — 차주 콘텐츠 기획 (ADR-0006: 토요일 생성, plan.json과 분리) */
  loadWeekPlan(clientId: string): { baseDate?: string; items: Array<{ date?: string; channel?: string; title?: string; sheet?: string }> } | undefined {
    const raw = this.read<unknown>(this.file(clientId, 'week-plan.json'));
    if (!raw) return undefined;
    const items = Array.isArray(raw) ? raw : (raw as { items?: unknown }).items;
    if (!Array.isArray(items) || !items.length) return undefined;
    return { baseDate: (raw as { baseDate?: string }).baseDate, items: items as Array<{ date?: string; channel?: string; title?: string; sheet?: string }> };
  }

  /** keyword-stats.json — 키워드 도구 실측 데이터 (없으면 undefined = '실측 대기' 표시) */
  loadKeywordStats(clientId: string): KeywordStats | undefined {
    const s = this.read<KeywordStats>(this.file(clientId, 'keyword-stats.json'));
    return s && Array.isArray(s.items) && s.items.length ? s : undefined;
  }

  /** keyword-category-volumes.json — 제품 카테고리별 핵심 키워드 주간 실측 (전월 대비 포함) */
  loadCategoryKeywords(clientId: string): CategoryKeywordVolumes | undefined {
    const s = this.read<CategoryKeywordVolumes>(this.file(clientId, 'keyword-category-volumes.json'));
    return s && Array.isArray(s.categories) && s.categories.length ? s : undefined;
  }

  /** reference-links.json — 레퍼런스 링크 인박스 (대시보드 등록 → 세션 학습) */
  loadReferenceLinks(clientId: string): ReferenceLinks | undefined {
    const r = this.read<ReferenceLinks>(this.file(clientId, 'reference-links.json'));
    return r && Array.isArray(r.links) && r.links.length ? r : undefined;
  }

  /** 레퍼런스 링크 등록 — 채널+URL 기준 중복 제거(같은 링크를 다른 채널 레퍼런스로 재등록 가능) */
  addReferenceLinks(
    clientId: string,
    channel: string,
    entries: Array<{ url: string; note?: string }>,
  ): { added: number; total: number } {
    const doc = this.read<ReferenceLinks>(this.file(clientId, 'reference-links.json')) ?? { links: [] };
    const seen = new Set(doc.links.map((l) => `${l.channel}|${l.url}`));
    let added = 0;
    for (const e of entries) {
      if (!e.url || seen.has(`${channel}|${e.url}`)) continue;
      seen.add(`${channel}|${e.url}`);
      doc.links.push({
        url: e.url,
        channel,
        note: e.note || undefined,
        status: 'pending',
        addedAt: new Date().toISOString(),
      });
      added++;
    }
    doc.updatedAt = new Date().toISOString();
    this.write(this.file(clientId, 'reference-links.json'), doc);
    return { added, total: doc.links.length };
  }

  /** research-brief.json — 있으면 대시보드에 '리서치' 탭이 생긴다 */
  loadResearch(clientId: string): ResearchBrief | undefined {
    const r = this.read<ResearchBrief>(this.file(clientId, 'research-brief.json'));
    return r && Array.isArray(r.sections) && r.sections.length ? r : undefined;
  }

  loadGuides(clientId: string): ChannelGuides {
    return this.read<ChannelGuides>(this.file(clientId, 'channel-guides.json')) ?? {};
  }

  saveGuides(clientId: string, guides: ChannelGuides): void {
    this.write(this.file(clientId, 'channel-guides.json'), guides);
  }

  updateGuide(clientId: string, channel: PlatformId, patch: { topics: string[]; guide: string }): ChannelGuides {
    const g = this.loadGuides(clientId);
    g[channel] = {
      topics: patch.topics.length ? patch.topics : (g[channel]?.topics ?? []),
      guide: patch.guide || (g[channel]?.guide ?? ''),
      updatedAt: new Date().toISOString(),
    };
    this.saveGuides(clientId, g);
    return g;
  }
}
