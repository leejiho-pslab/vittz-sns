/**
 * 실시간 콘텐츠 관제 대시보드 (HTML 생성)
 *
 * 벤치마킹:
 *  - Planable/Buffer: 채널 탭 + 콘텐츠 캘린더(발행/대기) + 기획안 피드백
 *  - blogdex(블덱스): 네이버 블로그 "지수 등급" + 포스팅 전문성/연관성 점수 + 키워드 분석
 *
 * 클라이언트별 격리 저장소(이력/디자인/플랜)를 모아 자가완결형 HTML 한 장으로
 * 렌더한다. 데이터는 인라인 JSON으로 박고, 채널 탭 전환은 클라이언트 JS로 처리.
 */
import type { ClientConfig, ClientStore } from './client.js';
import type { CycleRecord } from './orchestrator.js';
import type { DesignStore } from './design.js';
import type { PlanStore } from './plan.js';
import type { LearningStore } from './learning.js';
import type { TokenHealthStore } from './token-health.js';
import type { GuidanceStore } from './guidance.js';
import type { WeeklyReportStore } from './weekly.js';
import type { PlatformId } from './types.js';

const REPO = process.env.PSLAB_REPO ?? 'leejiho-pslab/pslab';

const CHANNELS: Array<{ key: PlatformId; label: string; icon: string }> = [
  { key: 'instagram', label: '인스타그램', icon: '📸' },
  { key: 'threads', label: '스레드', icon: '🧵' },
  { key: 'naver-blog', label: '네이버 블로그', icon: '📝' },
  { key: 'blogger', label: '구글 블로그', icon: '🅱️' },
  { key: 'youtube', label: '유튜브', icon: '▶️' },
];

function seed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

interface ChannelPublished {
  topic: string;
  time: string;
  imageUrl?: string;
  caption?: string;
  url?: string;
  views: number;
  likes: number;
  comments: number;
  engagementRate: number;
}

interface PendingCard {
  id: string;
  topic: string;
  format: string;
  channels: PlatformId[];
  scheduledFor: string;
  kicker?: string;
  headline?: string;
  sub?: string;
  dayLabel?: string;
  cardImage?: string;
  captionNote?: string;
  captionBody?: string;
  variant?: string;
  slideImages?: string[];
  status?: string;
  publishedUrl?: string;
  metrics?: { views?: number; likes?: number; comments?: number; engagementRate?: number };
  insightComment?: string;
  publishedAt?: string;
  videoFile?: string;
  reelsScript?: string;
  ytTitle?: string;
  ytDescription?: string;
  ytTags?: string[];
}

function buildChannel(
  client: ClientConfig,
  history: CycleRecord[],
  pendingItems: PendingCard[],
  key: PlatformId,
) {
  const published: ChannelPublished[] = [];
  let series: number[] = [];
  for (const rec of history) {
    const post = (rec.posts ?? []).find((p) => p.platform === key && p.ok);
    if (!post) continue;
    const m = (rec.metrics ?? []).find((x) => x.platform === key);
    published.push({
      topic: rec.topic,
      time: rec.finishedAt,
      imageUrl: rec.imageUrl,
      caption: rec.caption,
      url: post.url,
      views: m?.views ?? 0,
      likes: m?.likes ?? 0,
      comments: m?.comments ?? 0,
      engagementRate: m?.engagementRate ?? rec.avgEngagementRate ?? 0,
    });
    series.push((m?.engagementRate ?? rec.avgEngagementRate ?? 0) * 100);
  }
  published.reverse(); // 최신순
  const er = published.map((p) => p.engagementRate);
  const avgEng = er.length ? er.reduce((a, b) => a + b, 0) / er.length : 0;
  const trend =
    er.length < 2 ? 'n/a' : er[0] >= er[1] ? 'up' : 'down';
  return {
    key,
    active: client.targets.includes(key),
    published,
    pending: pendingItems,
    stats: {
      publishedCount: published.length,
      pendingCount: pendingItems.length,
      avgEngagement: avgEng,
      trend,
      totalViews: published.reduce((a, p) => a + p.views, 0),
      totalLikes: published.reduce((a, p) => a + p.likes, 0),
    },
    series: series.slice(-12),
  };
}

const BLOG_TIERS = [
  '저품질',
  '일반',
  '준최적화 1',
  '준최적화 2',
  '준최적화 3',
  '최적화 1',
  '최적화 2',
  '최적화 3',
];

function buildBlog(
  client: ClientConfig,
  blogPublished: ChannelPublished[],
  kwStats?: import('./guidance.js').KeywordStats,
  catKw?: import('./guidance.js').CategoryKeywordVolumes,
) {
  // 블덱스 스타일: 등급 + 포스팅별 전문성/연관성/품질 + 키워드 분석
  const postCount = blogPublished.length;
  const avgEng =
    postCount > 0
      ? blogPublished.reduce((a, p) => a + p.engagementRate, 0) / postCount
      : 0;
  const rawScore = Math.min(100, postCount * 9 + avgEng * 100 * 4);
  const measured = postCount > 0;
  const tierIdx = Math.min(
    BLOG_TIERS.length - 1,
    Math.floor((rawScore / 100) * BLOG_TIERS.length),
  );
  const posts = blogPublished.map((p) => {
    const r = seed(`blog:${p.topic}`);
    const base = 55 + (r % 35);
    return {
      topic: p.topic,
      time: p.time,
      expertise: Math.min(99, base + ((r >> 3) % 15)),
      relevance: Math.min(99, base + ((r >> 6) % 18)),
      quality: Math.min(99, Math.round((base + p.engagementRate * 100) % 100) || base),
    };
  });
  // 키워드 검색량은 절대 추정/난수로 만들지 않는다 — 네이버 광고주센터 키워드 도구
  // 실측(keyword-stats.json)이 있으면 그 값을, 없으면 null(→ 대시보드 '실측 대기')로.
  const statMap = new Map((kwStats?.items ?? []).map((s) => [s.kw.replace(/\s/g, ''), s]));
  const keywords = client.keywords.map((kw) => {
    const s = statMap.get(kw.replace(/\s/g, ''));
    if (!s) return { kw, pc: null, mobile: null, total: null, competition: null };
    const total = (s.pc ?? 0) + (s.mobile ?? 0);
    return { kw, pc: s.pc, mobile: s.mobile, total: s.pc == null && s.mobile == null ? null : total, competition: s.competition ?? null };
  });
  return {
    measured,
    grade: measured ? BLOG_TIERS[tierIdx] : '측정 전',
    score: Math.round(rawScore),
    posts,
    keywords,
    kwSource: kwStats ? { source: kwStats.source, fetchedAt: kwStats.fetchedAt } : null,
    // 카테고리별 핵심 키워드 주간 실측 — 블로그 탭 상시 패널 (운영자 지시 2026-08-05)
    catKw: catKw
      ? { updatedAt: String(catKw.updatedAt).slice(0, 10), baselineDate: catKw.baselineDate ?? null, categories: catKw.categories }
      : null,
  };
}

function buildClientData(
  client: ClientConfig,
  store: ClientStore<CycleRecord>,
  designStore: DesignStore,
  planStore: PlanStore,
  learnStore?: LearningStore,
  tokenStore?: TokenHealthStore,
  reportStore?: WeeklyReportStore,
  guidanceStore?: GuidanceStore,
) {
  const history = store.read(client.id);
  const design = designStore.load(client.id);
  const plan = planStore.load(client.id);
  const learning = learnStore?.load(client.id);
  const tokenHealth = tokenStore?.load(client.id);
  const weeklyReport = reportStore?.latest(client.id);
  const heldCount = history.filter((h) => !h.published && h.review?.pending).length;

  const toCard = (it: (typeof plan.items)[number]): PendingCard => ({
    id: it.id,
    topic: it.topic,
    format: it.format,
    channels: it.channels,
    scheduledFor: it.scheduledFor,
    kicker: it.kicker,
    headline: it.headline,
    sub: it.sub,
    dayLabel: it.dayLabel,
    cardImage: it.cardImage,
    captionNote: it.captionNote,
    captionBody: it.captionBody,
    variant: it.variant,
    slideImages: it.slideImages,
    status: it.status,
    publishedUrl: it.publishedUrl,
    metrics: it.metrics,
    insightComment: it.insightComment,
    publishedAt: it.publishedAt,
    videoFile: it.videoFile,
    reelsScript: it.reelsScript,
    ytTitle: it.ytTitle,
    ytDescription: it.ytDescription,
    ytTags: it.ytTags,
  });

  const channels = CHANNELS.map((c) => {
    const pending = plan.items.filter((it) => it.channels.includes(c.key)).map(toCard);
    return { ...c, ...buildChannel(client, history, pending, c.key) };
  });

  // 채널 바로가기 링크 (설정 override → 기본 관리콘솔). 핸들 있으면 프로필/표시용.
  const defaultManageUrl = (key: string, handle?: string): string => {
    switch (key) {
      case 'instagram': return handle ? `https://www.instagram.com/${handle}` : 'https://www.instagram.com/';
      case 'threads': return handle ? `https://www.threads.net/@${handle}` : 'https://www.threads.net/';
      case 'naver-blog': return 'https://admin.blog.naver.com/';
      case 'blogger': return 'https://www.blogger.com/';
      case 'youtube': return 'https://studio.youtube.com/';
      default: return '';
    }
  };
  const channelLinks = CHANNELS.map((c) => {
    const handle = client.accounts?.[c.key];
    const url = client.channelLinks?.[c.key] || defaultManageUrl(c.key, handle);
    return { key: c.key, label: c.label, icon: c.icon, url, sub: handle ? `@${handle}` : '관리 열기' };
  }).filter((x) => x.url);

  // 클라이언트 전체 기획안(발행 예정순) — '전체' 탭에서 한눈에
  const planCards = plan.items
    .map(toCard)
    .sort((a, b) => (a.scheduledFor || '').localeCompare(b.scheduledFor || ''));

  const blogChannel = channels.find((c) => c.key === 'naver-blog')!;
  const blog = buildBlog(
    client,
    blogChannel.published as ChannelPublished[],
    guidanceStore?.loadKeywordStats(client.id),
    guidanceStore?.loadCategoryKeywords(client.id),
  );

  return {
    id: client.id,
    name: client.name,
    industry: client.industry,
    themeColor: client.themeColor ?? null,
    brandTone: client.brandTone,
    keywords: client.keywords,
    competitors: client.competitors.map((x) => x.handle),
    bannedWords: client.bannedWords,
    schedule: client.scheduleTimes,
    reviewMode: client.reviewMode,
    designVersion: design.version,
    designStyle: {
      palette: design.palette,
      mood: design.mood,
      composition: design.composition,
      notes: design.notes.slice(-4),
      humanNotes: design.humanNotes ?? [],
    },
    heldCount,
    totalCycles: history.length,
    totalPublished: history.filter((h) => h.published).length,
    planUpdatedAt: plan.updatedAt,
    planCards,
    channels,
    channelLinks,
    blog,
    learning: learning ?? null,
    tokenHealth: tokenHealth ?? null,
    weeklyReport: weeklyReport ?? null,
    brandBrief: guidanceStore?.loadBrief(client.id) ?? {},
    channelGuides: guidanceStore?.loadGuides(client.id) ?? {},
    research: guidanceStore?.loadResearch(client.id) ?? null,
    weekPlan: guidanceStore?.loadWeekPlan(client.id) ?? null,
    referenceLinks: guidanceStore?.loadReferenceLinks(client.id) ?? null,
  };
}

export function renderDashboard(
  clients: ClientConfig[],
  store: ClientStore<CycleRecord>,
  designStore: DesignStore,
  planStore: PlanStore,
  learnStore?: LearningStore,
  tokenStore?: TokenHealthStore,
  reportStore?: WeeklyReportStore,
  guidanceStore?: GuidanceStore,
): string {
  // 설정 현황 — 환경변수 "존재 여부"만 본다(값은 절대 노출하지 않음).
  const env = process.env;
  const has = (...keys: string[]) => keys.every((k) => Boolean(env[k]));
  const setup = {
    realPublish: env.PSLAB_DRY_RUN === 'false',
    telegram: has('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'),
    anthropic: has('ANTHROPIC_API_KEY'),
    instagram: has('PSLAB_INSTAGRAM_ACCESS_TOKEN', 'PSLAB_INSTAGRAM_IG_USER_ID'),
    threads: has('PSLAB_THREADS_ACCESS_TOKEN', 'PSLAB_THREADS_THREADS_USER_ID'),
    blogger: has('PSLAB_BLOGGER_REFRESH_TOKEN', 'PSLAB_BLOGGER_BLOG_ID'),
  };
  const data = {
    generatedAt: new Date().toISOString(),
    repo: REPO,
    channels: CHANNELS,
    setup,
    clients: clients.map((c) =>
      buildClientData(c, store, designStore, planStore, learnStore, tokenStore, reportStore, guidanceStore),
    ),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  // 업체 감도 팔레트(clients/<id>.json theme) — 있으면 기본 라이트 테마 위에 오버라이드
  const th = clients.find((c) => c.theme)?.theme;
  const themeCss = th
    ? `
/* ── 업체 브랜드 테마 오버라이드 ── */
:root{--brand:${th.accent ?? '#2b6fff'}}
body{background:${th.bg ?? '#ffffff'}}
header,.tabs{background:${th.bg ?? '#ffffff'};border-color:${th.border ?? '#e4e8f0'}}
.panel,.card,.kpi{background:${th.panel ?? '#ffffff'};border-color:${th.border ?? '#e4e8f0'}}
a{color:${th.accentInk ?? '#1d6ae5'}}
.tab.on{border-bottom-color:${th.accent ?? '#2b6fff'}}
.cbtn.on{background:${th.accent ?? '#2b6fff'};border-color:${th.accent ?? '#2b6fff'}}
.kpi .v.accent{color:${th.accentInk ?? '#d97706'}}
.btn.fb{background:${th.panel ?? '#f6effc'};border-color:${th.accent ?? '#d9c2ee'};color:${th.accentInk ?? '#7a35b8'}}
`
    : '';

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="refresh" content="300"/>
<title>ALWAYS ON 콘텐츠 관제실</title>
<style>
:root{color-scheme:light;--brand:#2b6fff}*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"Segoe UI",Roboto,"Noto Sans KR",sans-serif;background:#ffffff;color:#14171d}
a{color:#1d6ae5}
header{padding:16px 22px;border-bottom:1px solid #e4e8f0;background:#ffffff;position:sticky;top:0;z-index:5}
.brand{font-size:18px;font-weight:700;display:flex;align-items:center;gap:8px}
.sub{color:#6a7284;font-size:12px;margin-top:3px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.clients{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.cbtn{background:#f2f4f8;border:1px solid #dfe4ec;color:#3a4254;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px}
.cbtn.on{background:var(--brand);border-color:var(--brand);color:#fff}
.tabs{display:flex;gap:4px;flex-wrap:wrap;padding:12px 22px 0;border-bottom:1px solid #e4e8f0;background:#ffffff;position:sticky;top:58px;z-index:4}
.tab{background:transparent;border:none;border-bottom:2px solid transparent;color:#6a7284;padding:8px 12px;cursor:pointer;font-size:14px}
.tab.on{color:#14171d;border-bottom-color:var(--brand);font-weight:600}
.tab .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-left:5px;vertical-align:middle}
.dot.live{background:#22c55e}.dot.off{background:#c6ccd8}
.treq{font-size:10px;border-radius:10px;padding:1px 6px;margin-left:4px;vertical-align:middle;font-weight:700}
.treq.open{background:#fdf3e0;color:#b45309}
.treq.done{background:#e4f7ea;color:#15803d}
main{padding:18px 22px;max-width:1180px;margin:0 auto}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:18px}
.kpi{background:#f7f9fc;border:1px solid #e4e8f0;border-radius:12px;padding:12px 14px}
.kpi .v{font-size:22px;font-weight:700}.kpi .l{color:#6a7284;font-size:12px;margin-top:2px}
.kpi .v.accent{color:#d97706}
.panel{background:#ffffff;border:1px solid #e4e8f0;border-radius:12px;padding:14px 16px;margin-bottom:16px;box-shadow:0 1px 2px rgba(20,24,40,.04)}
.panel h3{margin:0 0 10px;font-size:15px}
.sect-h{display:flex;justify-content:space-between;align-items:center;margin:18px 0 10px}
.sect-h h2{font-size:16px;margin:0}
.btn{background:#f2f4f8;border:1px solid #dfe4ec;color:#3a4254;padding:6px 11px;border-radius:8px;font-size:12px;text-decoration:none;cursor:pointer}
.btn.fb{background:#f6effc;border-color:#d9c2ee;color:#7a35b8}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.card{background:#ffffff;border:1px solid #e4e8f0;border-radius:12px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 1px 2px rgba(20,24,40,.04)}
.thumb{width:100%;aspect-ratio:1/1;object-fit:cover;background:#eef1f6;display:block}
.thumb.noimg{display:flex;align-items:center;justify-content:center;color:#9aa2b2;font-size:13px}
.cbody{padding:10px 12px;flex:1;display:flex;flex-direction:column;gap:6px}
.ctop{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.ctop strong{font-size:13px}
.muted{color:#6a7284;font-size:11px}
.cap{color:#4a5264;font-size:12px;line-height:1.4;max-height:3.6em;overflow:hidden}
.met{display:flex;gap:10px;font-size:11px;color:#5a6274;margin-top:auto}
.badge{font-size:10px;padding:2px 7px;border-radius:20px;white-space:nowrap}
.b-ok{background:#e4f7ea;color:#15803d}.b-wait{background:#fdf3e0;color:#b45309}.b-plan{background:#e7effc;color:#2b5fd0}.b-hold{background:#fdeaea;color:#dc2626}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e9edf3}
th{color:#6a7284;font-weight:600;font-size:12px}
.grade{display:inline-flex;align-items:center;justify-content:center;min-width:108px;padding:10px 16px;border-radius:12px;font-weight:800;font-size:18px}
.bar{height:7px;border-radius:4px;background:#e9edf3;overflow:hidden}.bar>i{display:block;height:100%;background:#2b6fff}
.plan-pill{font-size:11px;color:#5a6274}
.spark{display:block}
.empty{color:#8a92a4;padding:18px;text-align:center;font-size:13px}
.tag{display:inline-block;background:#f2f4f8;border:1px solid #e0e5ee;border-radius:6px;padding:2px 7px;font-size:11px;color:#5a6274;margin:2px 2px 0 0}
.rbarrow{display:flex;align-items:center;gap:8px;margin:5px 0}
.rbarrow .rl{width:150px;font-size:12px;color:#3a4254;flex:none;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rbarrow .rtrack{flex:1;background:#eef1f6;border-radius:6px;height:18px;overflow:hidden}
.rbarrow .rfill{height:100%;border-radius:6px;background:#2b6fff;min-width:2px}
.rbarrow .rv{font-size:11.5px;color:#6a7284;width:120px;flex:none}
.rtl{border-left:2px solid #dfe5ef;margin:6px 0 4px 6px;padding-left:14px}
.rtl .ri{position:relative;margin-bottom:10px;font-size:13px;line-height:1.55}
.rtl .ri:before{content:'';position:absolute;left:-19.5px;top:4px;width:9px;height:9px;border-radius:50%;background:#2b6fff}
.rtl .rd{color:#6a7284;font-size:11.5px}
.rlink{display:inline-block;background:#f2f6ff;border:1px solid #c9d8f0;border-radius:8px;padding:6px 10px;margin:3px 4px 3px 0;font-size:12.5px;text-decoration:none;color:#1c4fd6}
.rlink:hover{background:#e6eeff}
footer{text-align:center;color:#9aa2b2;font-size:11px;padding:22px}
.card.clk{cursor:pointer;transition:transform .12s,border-color .12s,box-shadow .12s}
.card.clk:hover{transform:translateY(-3px);border-color:#b9c4d8;box-shadow:0 6px 16px rgba(20,24,40,.10)}
.b-var{font-weight:600}.v-A{background:#fdf0e4;color:#c2570f}.v-B{background:#e2f6f4;color:#0f766e}.v-C{background:#fdf6e0;color:#a16207}
.modal{position:fixed;inset:0;background:rgba(20,24,32,.55);display:none;align-items:flex-start;justify-content:center;z-index:50;padding:32px 16px;overflow:auto}
.modal.on{display:flex}
.mwrap{position:relative;background:#ffffff;border:1px solid #e4e8f0;border-radius:16px;max-width:920px;width:100%;padding:22px}
.mx{position:absolute;top:14px;right:14px;background:#f2f4f8;border:1px solid #dfe4ec;color:#3a4254;width:34px;height:34px;border-radius:9px;cursor:pointer;font-size:15px}
#mbody h2{font-size:23px}
#mbody .kick{color:#c2570f;font-weight:600;font-size:12px;letter-spacing:.12em;text-transform:uppercase}
.carou{display:flex;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;padding:4px 2px 12px;-webkit-overflow-scrolling:touch}
.carou .slide{position:relative;flex:0 0 auto;scroll-snap-align:center}
.carou .slide img{height:520px;width:auto;border-radius:14px;display:block;background:#eef1f6;border:1px solid #e4e8f0}
.carou .snum{position:absolute;top:10px;right:10px;background:rgba(8,10,14,.7);color:#fff;font-size:11px;padding:3px 8px;border-radius:20px}
.carou::-webkit-scrollbar{height:8px}.carou::-webkit-scrollbar-thumb{background:#cdd4e0;border-radius:8px}
.capbox{background:#f7f9fc;border:1px solid #e4e8f0;border-radius:12px;padding:14px 16px}
.caphd{color:#6a7284;font-size:12px;font-weight:600;margin-bottom:8px}
.mcap{white-space:normal;line-height:1.75;font-size:15px;color:#2a3040}
.chgrp{margin:10px 0 18px}
.chgrp-h{font-size:14px;font-weight:700;margin:14px 0 8px;padding-bottom:6px;border-bottom:1px solid #e9edf3}
.md-h1{font-size:19px;margin:10px 0 8px;font-weight:800}.md-h{font-size:15px;color:#b45309;margin:14px 0 4px;font-weight:700}
.md-tag{color:#1d6ae5;font-weight:600;font-size:13px;margin:10px 0 2px}.md-sp{height:10px}
.md-quote{background:#fdf6ec;border-left:3px solid #d97706;padding:8px 12px;color:#14171d;font-size:14px}
.md-quote+.md-quote{padding-top:0}
.md-tags{color:#1d6ae5;font-size:13px;margin-top:12px}
.md-img{display:block;width:100%;border-radius:10px;margin:12px 0;border:1px solid #e4e8f0}
.mcap b{color:#000}
.thumbwrap{position:relative}
.b-car{position:absolute;top:8px;right:8px;background:rgba(8,10,14,.74);color:#fff;border:1px solid rgba(255,255,255,.25)}
.pbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pbar-t{font-weight:700;font-size:13px;margin-right:4px}
.pbtn{background:#f2f4f8;border:1px solid #dfe4ec;color:#3a4254;padding:5px 11px;border-radius:20px;cursor:pointer;font-size:12px}
.pbtn.on{background:#14171d;border-color:#14171d;color:#fff}
.pbar-c{font-size:12px;color:#6a7284;display:inline-flex;align-items:center;gap:5px;margin-left:6px}
.pbar input[type=date]{border:1px solid #dfe4ec;border-radius:7px;padding:4px 6px;font-size:12px;color:#3a4254;background:#fff}
.reqta{width:100%;border:1px solid #dfe4ec;border-radius:10px;padding:10px 12px;font-size:13px;font-family:inherit;color:#14171d;background:#fff;resize:vertical}
.reqta:focus{outline:2px solid #2b6fff33;border-color:#2b6fff}
@media(max-width:720px){.carou .slide img{height:60vh}}
${themeCss}</style>
</head>
<body>
<header>
  <div class="brand">🛰️ <span id="dashtitle">ALWAYS ON 콘텐츠 관제실</span></div>
  <div class="sub" id="dashsub">채널별 현황 · 발행/대기 · 반응도 · 기획안 피드백 · 5분 자동 새로고침</div>
  <div class="clients" id="clients"></div>
</header>
<div class="tabs" id="tabs"></div>
<main id="view"></main>
<footer>pslab autopilot · 자동 생성 · <span id="gen"></span></footer>
<div id="modal" class="modal" onclick="if(event.target===this)closeModal()">
  <div class="mwrap"><button class="mx" onclick="closeModal()">✕</button><div id="mbody"></div></div>
</div>
<script>
/* 안전장치: 아래 메인 스크립트가 (구형 브라우저 파싱오류 등으로) 깨져도
   빈 화면 대신 오류 내용과 새로고침 버튼을 보여준다. */
window.onerror = function (m) {
  try {
    var v = document.getElementById('view');
    if (v && !(v.innerHTML && v.innerHTML.replace(/\\s/g, ''))) {
      v.innerHTML = '<div style="padding:24px;line-height:1.7;color:#b91c1c">'
        + '화면을 그리는 중 문제가 생겼어요.<br>'
        + '<span style="color:#6a7284;font-size:13px">' + String(m) + '</span><br><br>'
        + '<button onclick="location.reload(true)" style="padding:10px 16px;border-radius:8px;border:0;background:#2b6fff;color:#fff;font-size:15px">새로고침</button>'
        + '</div>';
    }
  } catch (e) {}
  return false;
};
</script>
<script>
const DATA = ${json};
const REPO = DATA.repo;
let ci = 0, ch = 'all';
// ── 운영 기간 선택 (전역 상태) ──
let period = { key:'all', from:null, to:null };
function periodRange(){
  if(period.key==='all') return null;
  const now=new Date(); let from,to;
  if(period.key==='7d'){ to=now; from=new Date(now.getTime()-6*864e5); }
  else if(period.key==='14d'){ to=now; from=new Date(now.getTime()-13*864e5); }
  else if(period.key==='30d'){ to=now; from=new Date(now.getTime()-29*864e5); }
  else if(period.key==='month'){ from=new Date(now.getFullYear(),now.getMonth(),1); to=now; }
  else if(period.key==='prev'){ from=new Date(now.getFullYear(),now.getMonth()-1,1); to=new Date(now.getFullYear(),now.getMonth(),0); }
  else if(period.key==='custom'){
    if(!period.from&&!period.to) return null;
    from=period.from?new Date(period.from):new Date(0);
    to=period.to?new Date(period.to):now;
  } else return null;
  const f=new Date(from); f.setHours(0,0,0,0);
  const t=new Date(to); t.setHours(23,59,59,999);
  return [f.getTime(), t.getTime()];
}
function inPeriod(s){ const r=periodRange(); if(!r) return true; if(!s) return false; const t=new Date(s).getTime(); return t>=r[0]&&t<=r[1]; }
function periodLabel(){
  const names={all:'전체 기간','7d':'최근 7일','14d':'최근 14일','30d':'최근 30일',month:'이번 달',prev:'지난 달',custom:'직접 선택'};
  const r=periodRange();
  const d=x=>new Date(x).toISOString().slice(0,10);
  return names[period.key]+(r?' ('+d(r[0])+' ~ '+d(r[1])+')':'');
}
function periodBar(){
  const b=(k,l)=>'<button class="pbtn'+(period.key===k?' on':'')+'" onclick="setPeriod(\\''+k+'\\')">'+l+'</button>';
  return '<div class="panel pbar"><span class="pbar-t">📆 운영 기간</span>'+
    b('all','전체')+b('7d','최근 7일')+b('14d','최근 14일')+b('30d','최근 30일')+b('month','이번 달')+b('prev','지난 달')+
    '<span class="pbar-c">직접 선택 <input type="date" id="pfrom" value="'+(period.from||'')+'" onchange="setCustom()"/> ~ <input type="date" id="pto" value="'+(period.to||'')+'" onchange="setCustom()"/></span>'+
    '<span class="muted" style="margin-left:auto">'+periodLabel()+'</span></div>';
}
function setPeriod(k){ period.key=k; renderView(); }
function setCustom(){
  period.key='custom';
  period.from=(document.getElementById('pfrom')||{}).value||null;
  period.to=(document.getElementById('pto')||{}).value||null;
  renderView();
}
// ── 수정요청 (깃허브 이슈 연동: [수정요청·채널키] 제목 규약) ──
let ISSUES=null; // null=로딩중, []=없음/실패
let REF_ISSUES=[]; // [레퍼런스·채널] 이슈에서 즉시 파싱한 링크 (커밋 전에도 대시보드에 바로 표시)
let G_ISSUES=[]; // 지침 이슈(브랜드노트·디자인피드백·가이드) — 지침 탭 실시간 '접수됨' 표시용
const REQ_RE=/^\\[수정요청·([a-z-]+)\\]\\s*(.*)$/;
const REF_RE=/^\\[레퍼런스·([a-z-]+)\\]/;
const GUID_RE=/^\\[(브랜드노트·(분석|방향성|감도)|디자인피드백|가이드·([a-z-]+))\\]/;
// 아직 데이터에 반영 안 됐을 수 있는 지침 이슈: 열려 있거나, 이 대시보드 생성 이후 등록된 것
function guidPending(kind, id){
  return G_ISSUES.filter(g=>g.kind===kind&&(kind!=='brand'||g.field===id)&&(kind!=='guide'||g.chKey===id)&&
    (g.state!=='closed'||String(g.created_at||'')>String(DATA.generatedAt||'')));
}
function pendBox(list){
  return list.map(p=>'<div class="capbox" style="border:1px solid #f0d9a8;background:#fffaf0;margin-bottom:8px;border-radius:10px;padding:10px 12px">'+
    '<div class="muted" style="font-size:11.5px;margin-bottom:4px">🕓 '+(p.state==='closed'?'반영 완료 — 잠시 후 본문에 표시됩니다':'접수됨 — 시스템 반영 처리중')+' · <a href="'+esc(p.html_url)+'" target="_blank">이슈↗</a></div>'+
    '<div class="mcap" style="font-size:13px;white-space:pre-wrap">'+esc(p.body.slice(0,400))+(p.body.length>400?'…':'')+'</div></div>').join('');
}
function myIssue(x){ return !x.clientId||x.clientId===DATA.clients[ci].id; } // 업체 스코프 (없으면 전 업체)
function channelIssues(key){ return (ISSUES||[]).filter(x=>x.chKey===key&&myIssue(x)); }
// 발행 게이트 — 이 콘텐츠에 걸린 미처리(열림) 수정요청. 특정 id 지정 요청은 그 콘텐츠만,
// '채널 공통' 요청은 그 채널의 발행 전 콘텐츠 전체를 보류시킨다 (publish-plan --due와 동일 규칙).
function openHolds(it){
  return (ISSUES||[]).filter(x=>x.state!=='closed'&&myIssue(x)&&(x.planId?x.planId===it.id:(it.channels||[]).includes(x.chKey)));
}
function loadIssues(){
  fetch('https://api.github.com/repos/'+REPO+'/issues?state=all&per_page=100&sort=created&direction=desc')
    .then(r=>r.ok?r.json():[])
    .then(arr=>{
      const list=(Array.isArray(arr)?arr:[]).filter(x=>!x.pull_request);
      ISSUES=list.map(x=>{
        const m=REQ_RE.exec(x.title||''); if(!m) return null;
        // 본문 '대상 콘텐츠: … (id: xxx)' → 특정 콘텐츠 수정요청. id 없으면 채널 공통.
        // '업체: xxx' → 여러 업체가 한 저장소를 쓸 때의 업체 스코프 (없으면 전 업체 적용 — 과거 이슈 호환)
        const idm=/\\(id:\\s*([\\w.-]+)\\)/.exec(String(x.body||''));
        const cm=/업체:\\s*([\\w-]+)/.exec(String(x.body||''));
        return { chKey:m[1], planId:idm?idm[1]:null, clientId:cm?cm[1]:null, titleClean:m[2]||x.title, state:x.state, html_url:x.html_url, created_at:x.created_at, closed_at:x.closed_at };
      }).filter(Boolean);
      // 레퍼런스 이슈 본문에서 링크를 즉시 수집 — 시스템 반영(커밋·배포) 전에도 '접수됨'으로 표시
      REF_ISSUES=[];
      for(const x of list){
        const m=REF_RE.exec(x.title||''); if(!m) continue;
        for(const line of String(x.body||'').split('\\n')){
          const t=line.replace(/^[-*·•\\s]+/,'').trim();
          const um=t.match(/^(https?:\\/\\/\\S+)\\s*(?:[—–-]\\s*)?(.*)$/);
          if(um) REF_ISSUES.push({channel:m[1], url:um[1], note:(um[2]||'').trim(), issueUrl:x.html_url, at:x.created_at});
        }
      }
      // 지침 이슈(브랜드노트·디자인피드백·가이드)도 즉시 수집 — 지침 탭에 실시간 표시
      G_ISSUES=[];
      for(const x of list){
        const g=GUID_RE.exec(x.title||''); if(!g) continue;
        G_ISSUES.push({kind:g[1].indexOf('브랜드노트')===0?'brand':(g[1]==='디자인피드백'?'design':'guide'),
          field:g[2]||null, chKey:g[3]||null, body:String(x.body||''), state:x.state,
          html_url:x.html_url, created_at:x.created_at});
      }
      renderTabs(); renderView();
    })
    .catch(()=>{ ISSUES=[]; });
}
// 커밋된 링크 + 아직 반영 전인 이슈 링크(접수됨)를 채널 기준으로 병합
function refLinksFor(client, key){
  const saved=(((client.referenceLinks||{}).links)||[]).filter(l=>!key||l.channel===key);
  const have=new Set(saved.map(l=>l.channel+'|'+l.url.replace(/\\/+$/,'')));
  const incoming=REF_ISSUES.filter(r=>(!key||r.channel===key)&&!have.has(r.channel+'|'+r.url.replace(/\\/+$/,'')))
    .map(r=>({url:r.url, channel:r.channel, note:r.note||undefined, status:'received', addedAt:r.at, issueUrl:r.issueUrl}));
  return saved.concat(incoming);
}
function reqStatus(x){ return x.state==='closed' ? '<span class="badge b-ok">✅ 처리완료</span>' : '<span class="badge b-wait">🛠 처리중</span>'; }
// 수정요청의 대상 표시 — 특정 콘텐츠(id)면 그 헤드라인, 아니면 채널 공통
function reqTarget(client,x){
  if(!x.planId) return '채널 공통';
  const p=(client.planCards||[]).find(t=>t.id===x.planId);
  return esc(p?plainHead(p).slice(0,22):x.planId);
}
// 수정 항목 분류 — 이슈 제목 [항목] 태그 + 본문 '수정 항목:' 줄로 들어간다
const REQ_TYPES=['텍스트(문구·카피)','이미지(사진·카드)','영상(릴스·쇼츠)','디자인(색·레이아웃)','해시태그·키워드','발행 일정','기타'];
function requestsPanel(client, key, chLabel){
  const list=channelIssues(key);
  const open=list.filter(x=>x.state!=='closed').length;
  let h='<div class="panel" style="border-color:#d9c2ee;background:#fcfaff"><div class="sect-h" style="margin:0 0 10px"><h3>✏️ 수정요청 게시판 · '+esc(chLabel)+'</h3><span class="muted">'+(ISSUES===null?'불러오는 중…':('🛠 처리중 '+open+'건 · 총 '+list.length+'건'))+'</span></div>'+
    '<div class="muted" style="margin:0 0 10px">🚦 <b>발행 전 검수 게이트</b> — 접수된 수정요청이 <b>처리완료</b>되기 전에는 대상 콘텐츠의 자동 발행이 보류됩니다. 수정사항이 반영되고 요청이 처리완료로 바뀌면 다음 사이클에 자동 발행됩니다. (대상을 지정하지 않은 "채널 공통" 요청은 이 채널의 발행 대기 콘텐츠 전체를 보류)</div>';
  if(list.length){
    h+='<table><tr><th style="width:92px">상태</th><th style="width:150px">대상</th><th>요청 내용</th><th style="width:100px">등록일</th><th style="width:52px"></th></tr>'+
      list.map(x=>'<tr><td>'+reqStatus(x)+'</td><td class="muted" style="font-size:12px">'+reqTarget(client,x)+'</td><td>'+esc(x.titleClean)+'</td><td class="muted">'+String(x.created_at||'').slice(0,10)+'</td><td><a href="'+esc(x.html_url)+'" target="_blank">보기↗</a></td></tr>').join('')+'</table>';
  } else if(ISSUES!==null){
    h+='<div class="empty" style="padding:8px">아직 등록된 수정요청이 없습니다. 아래에 바로 작성해 보세요.</div>';
  }
  // 대상 콘텐츠 선택 — 이 채널의 기획 콘텐츠(발행일순). 어떤 날짜 콘텐츠의 수정인지 특정한다
  const plans=(client.planCards||[]).filter(p=>(p.channels||[]).includes(key));
  const planOpt=plans.map(p=>{
    const d=String(p.scheduledFor||'').slice(5,10).replace('-','/');
    const st=p.status==='published'?' · 발행됨':'';
    return '<option value="'+esc(p.id)+'">'+esc((d?d+' · ':'')+plainHead(p).slice(0,34)+st)+'</option>';
  }).join('');
  h+='<div style="margin-top:12px">'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">'+
    '<label class="muted" style="display:flex;align-items:center;gap:6px;font-size:12.5px">📅 대상 콘텐츠 '+
    '<select id="reqplan-'+esc(key)+'" class="reqta" style="width:auto;padding:6px 8px;font-size:12.5px"><option value="">채널 공통 (특정 콘텐츠 아님)</option>'+planOpt+'</select></label>'+
    '<label class="muted" style="display:flex;align-items:center;gap:6px;font-size:12.5px">🏷 수정 항목 '+
    '<select id="reqtype-'+esc(key)+'" class="reqta" style="width:auto;padding:6px 8px;font-size:12.5px">'+REQ_TYPES.map(t=>'<option>'+esc(t)+'</option>').join('')+'</select></label></div>'+
    '<textarea id="reqtext-'+esc(key)+'" class="reqta" rows="3" placeholder="수정하고 싶은 내용을 적어주세요. 예) 3번 카드 문구를 더 짧게 / 커버 이미지 톤을 밝게 / 해시태그에 #청담맛집 추가"></textarea>'+
    '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap"><button class="btn fb" onclick="submitReq(\\''+esc(key)+'\\',\\''+esc(chLabel)+'\\')">✏️ 수정요청 등록</button>'+
    '<span class="muted">등록을 누르면 깃허브 창이 열립니다 — 초록색 “Submit new issue” 버튼만 누르면 접수 완료. 처리 상태는 이 게시판에 자동 표시됩니다.</span></div></div></div>';
  return h;
}
// ── 지침(브랜드 노트 + 채널 가이드) — AI 상시 학습 입력 창구 ──
const BRAND_FIELDS=[
  {k:'분석', f:'analysis', label:'🔍 브랜드 분석', ph:'우리 브랜드는 어떤 브랜드인지, 강점·차별점·고객이 우리를 찾는 이유를 적어주세요.'},
  {k:'방향성', f:'direction', label:'🧭 방향성 의견', ph:'앞으로 콘텐츠가 가야 할 방향, 밀고 싶은 메시지, 하지 말아야 할 것을 적어주세요.'},
  {k:'감도', f:'sensibility', label:'🎨 콘텐츠 감도', ph:'원하는 톤·비주얼 무드를 적어주세요. 예) 과장 없이 차분하게, 사진은 웜톤, 이모지 최소화'}
];
function guideNote(){
  return '<div class="muted" style="margin:2px 0 14px">여기 적은 내용은 자동으로 반영됩니다 — 등록 → 깃허브 창에서 제출 → 몇 분 내 시스템에 저장되어 <b>다음 콘텐츠 생성부터 프롬프트·소재 선정에 적용</b>됩니다. (이슈가 자동으로 닫히면 반영 완료)</div>';
}
function submitGuidance(title, bodyPrefix, taId){
  const ta=document.getElementById(taId);
  const txt=(ta&&ta.value.trim())||'';
  if(!txt){ alert('내용을 먼저 적어주세요.'); return; }
  window.open(issue(title, bodyPrefix+txt), '_blank');
  if(ta) ta.value='';
}
function guideView(client){
  let h='<div class="sect-h"><h2>🧭 지침 — AI가 상시 학습하는 브랜드 노트·채널 가이드</h2></div>'+guideNote();
  // 브랜드 노트 3종
  h+='<div class="panel" style="border-color:#c9d8f0;background:#f8fbff"><h3>🏷 브랜드 노트</h3>';
  const bb=client.brandBrief||{};
  for(const bf of BRAND_FIELDS){
    const cur=bb[bf.f];
    h+='<div style="margin:14px 0 4px;font-weight:700;font-size:13.5px">'+bf.label+'</div>'+
       pendBox(guidPending('brand',bf.k))+
       (cur?'<div class="capbox" style="margin-bottom:8px"><div class="mcap" style="font-size:13.5px;white-space:pre-wrap">'+esc(cur)+'</div></div>'
           :'<div class="muted" style="margin-bottom:8px">아직 등록된 내용이 없습니다.</div>')+
       '<textarea id="bb-'+bf.f+'" class="reqta" rows="3" placeholder="'+esc(bf.ph)+'"></textarea>'+
       '<div style="margin-top:6px"><button class="btn fb" onclick="submitGuidance(\\'[브랜드노트·'+bf.k+'] '+esc(client.name)+'\\',\\'\\',\\'bb-'+bf.f+'\\')">✏️ '+bf.k+' 업데이트</button></div>';
  }
  if(bb.updatedAt){ h+='<div class="muted" style="margin-top:10px">마지막 갱신: '+ftime(bb.updatedAt)+'</div>'; }
  if(bb.log&&bb.log.length){
    h+='<div class="muted" style="margin-top:8px">최근 이력</div><table style="margin-top:4px"><tr><th style="width:130px">일시</th><th style="width:70px">항목</th><th>내용</th></tr>'+
      bb.log.slice(0,5).map(l=>'<tr><td class="muted">'+ftime(l.at)+'</td><td>'+esc(l.field)+'</td><td class="muted">'+esc(l.excerpt)+'…</td></tr>').join('')+'</table>';
  }
  h+='</div>';
  // 디자인 피드백 — 사람 지시는 AI 학습 메모와 분리 보관되며 항상 최우선 반영
  const hn=(client.designStyle||{}).humanNotes||[];
  h+='<div class="panel" style="border-color:#e3cdf0;background:#fdfaff"><h3>🎨 디자인 피드백</h3>'+
     '<div class="muted" style="margin:4px 0 10px">카드·릴스의 색감, 레이아웃, 톤에 대한 지시를 적어주세요. 여기 등록된 지시는 AI가 스스로 쌓는 학습 메모보다 <b>항상 우선</b> 반영되고, AI가 지우거나 덮어쓰지 못합니다. 한 줄에 하나씩 적으면 각각 별도 지시로 저장됩니다.</div>';
  h+=pendBox(guidPending('design'));
  if(hn.length){
    h+='<div class="capbox" style="margin-bottom:8px"><div class="caphd">현재 등록된 지시 ('+hn.length+')</div><div class="mcap" style="font-size:13.5px;white-space:pre-wrap">'+hn.map(n=>'· '+esc(n)).join('\\n')+'</div></div>';
  } else {
    h+='<div class="muted" style="margin-bottom:8px">아직 등록된 디자인 지시가 없습니다.</div>';
  }
  h+='<textarea id="design-fb" class="reqta" rows="3" placeholder="예) 오렌지 액센트를 더 절제되게 / 첫 장 헤드라인을 더 크게 / 배경 사진은 인물보다 공간 위주로"></textarea>'+
     '<div style="margin-top:6px"><button class="btn fb" onclick="submitGuidance(\\'[디자인피드백] '+esc(client.name)+'\\',\\'\\',\\'design-fb\\')">🎨 디자인 지시 등록</button></div></div>';
  // 🔗 레퍼런스 링크 학습 현황 — 전 채널 요약 (등록은 각 채널 탭에서)
  const rls=refLinksFor(client, null);
  h+='<div class="panel" style="border-color:#f0e2c8;background:#fffdf7"><div class="sect-h" style="margin:0 0 8px"><h3>🔗 레퍼런스 링크 학습 현황</h3><span class="muted">'+
     (rls.length?('등록 '+rls.length+'건 · 학습대기 '+rls.filter(l=>l.status==='pending').length+'건'):'각 채널 탭에서 벤치마크 링크를 등록하세요')+'</span></div>'+
     '<div class="muted" style="margin:0 0 8px">채널 탭의 <b>🔗 레퍼런스 링크</b> 패널에서 링크를 등록하면, 다음 기획 전에 AI가 직접 열람·학습해 디자인·기획에 반영하고 이곳에 결과를 남깁니다.</div>';
  if(rls.length){
    h+='<table><tr><th style="width:110px">채널</th><th>링크 / 메모</th><th style="width:86px">상태</th><th>학습 요약</th></tr>'+
      rls.slice(-15).reverse().map(l=>{const cd=DATA.channels.find(x=>x.key===l.channel)||{label:l.channel,icon:''};
        return '<tr><td>'+cd.icon+' '+esc(cd.label)+'</td><td><a href="'+esc(l.url)+'" target="_blank" rel="noopener">'+refShort(l.url)+'↗</a>'+(l.note?'<div class="muted" style="font-size:11.5px">'+esc(l.note)+'</div>':'')+'</td>'+
          '<td>'+refBadge(l.status)+'</td><td class="muted" style="font-size:12px">'+esc(l.summary||'')+'</td></tr>';}).join('')+'</table>';
  }
  h+='</div>';
  // 채널별 가이드
  h+='<div class="sect-h"><h2>📚 채널별 콘텐츠 주제·핵심 가이드</h2></div>'+guideNote();
  const guides=client.channelGuides||{};
  for(const chDef of DATA.channels){
    const g=guides[chDef.key];
    h+='<div class="panel"><div class="sect-h" style="margin:0 0 8px"><h3>'+chDef.icon+' '+esc(chDef.label)+'</h3>'+(g&&g.updatedAt?'<span class="muted">갱신 '+ftime(g.updatedAt)+'</span>':'<span class="muted">미설정</span>')+'</div>';
    h+=pendBox(guidPending('guide',chDef.key));
    if(g&&(g.topics||[]).length){ h+='<div style="margin-bottom:6px">'+(g.topics||[]).map(t=>'<span class="tag" style="background:#e7effc;border-color:#c4d6f4;color:#2b5fd0">#'+esc(t)+'</span>').join('')+'</div>'; }
    if(g&&g.guide){ h+='<div class="capbox" style="margin-bottom:8px"><div class="caphd">핵심 가이드</div><div class="mcap" style="font-size:13.5px;white-space:pre-wrap">'+esc(g.guide)+'</div></div>'; }
    h+='<textarea id="cg-'+chDef.key+'" class="reqta" rows="4" placeholder="첫 줄에 \\'주제: 소재1, 소재2, 소재3\\' 형식으로 우선 소재를, 그 아래에 이 채널의 규칙·톤·금지사항 등 핵심 가이드를 적어주세요."></textarea>'+
       '<div style="margin-top:6px"><button class="btn fb" onclick="submitGuidance(\\'[가이드·'+chDef.key+'] '+esc(client.name)+'\\',\\'\\',\\'cg-'+chDef.key+'\\')">✏️ '+esc(chDef.label)+' 가이드 업데이트</button></div></div>';
  }
  return h;
}
// 📊 콘텐츠 리포트 — 채널 발행 콘텐츠의 KPI·추세 + 콘텐츠별 실측 성과 표 (기간 반영)
function contentReportPanel(client, c, chLabel){
  const pubF=c.published.filter(p=>inPeriod(p.time));
  const planPubF=c.pending.filter(it=>it.status==='published'&&inPeriod(it.publishedAt||it.scheduledFor));
  const waiting=c.pending.filter(it=>it.status!=='published');
  const mAll=pubF.map(p=>({t:p.time,v:p.views,l:p.likes,e:p.engagementRate}))
    .concat(planPubF.map(it=>{const m=it.metrics||{};return {t:it.publishedAt||it.scheduledFor,v:m.views||0,l:m.likes||0,e:m.engagementRate||0};}));
  const avgF=mAll.length?mAll.reduce((a,x)=>a+x.e,0)/mAll.length:0;
  let h='<div class="panel" style="border-color:#c8e0d0;background:#f8fcf9"><div class="sect-h" style="margin:0 0 10px"><h3>📊 콘텐츠 리포트 · '+esc(chLabel)+'</h3><span class="muted">'+periodLabel()+' · 실측 집계</span></div>';
  h+='<div class="kpis">'+
    kpi(mAll.length,'발행됨'+(period.key!=='all'?' (기간)':''))+
    kpi(waiting.length,'발행 대기')+
    kpi(pct(avgF)+' '+tIcon(c.stats.trend),'평균 참여율',true)+
    kpi(mAll.reduce((a,x)=>a+x.v,0),'누적 조회')+
    kpi(mAll.reduce((a,x)=>a+x.l,0),'누적 좋아요')+'</div>';
  const seriesF=mAll.slice().sort((a,b)=>String(a.t||'').localeCompare(String(b.t||''))).map(x=>x.e*100);
  if(seriesF.length>1){h+='<div style="margin-top:10px"><div class="muted" style="font-size:12px;margin-bottom:4px">반응도 추세 (참여율 %)</div>'+sparkline(seriesF.slice(-12))+'</div>';}
  // 콘텐츠별 성과 — 기획 발행분(성과+인사이트) + 사이클 발행분
  const rows=planPubF.slice().sort((a,b)=>String(b.publishedAt||'').localeCompare(String(a.publishedAt||''))).map(it=>{const m=it.metrics||{};
    return '<tr><td><b>'+esc(plainHead(it))+'</b><div class="muted">'+ftime(it.publishedAt||it.scheduledFor)+(it.variant?' · '+esc(it.variant)+'안':'')+'</div>'+
      (it.insightComment?'<div style="color:#15803d;font-size:12px;margin-top:4px">💬 '+esc(it.insightComment)+'</div>':'')+'</td>'+
      '<td>'+(m.views||0)+'</td><td>'+(m.likes||0)+'</td><td>'+(m.comments||0)+'</td><td>'+pct(m.engagementRate||0)+'</td>'+
      '<td>'+(it.publishedUrl?'<a href="'+esc(it.publishedUrl)+'" target="_blank">열기↗</a>':'')+'</td></tr>';
  }).concat(pubF.map(p=>'<tr><td><b>'+esc(p.topic)+'</b><div class="muted">'+ftime(p.time)+'</div></td>'+
    '<td>'+(p.views||0)+'</td><td>'+(p.likes||0)+'</td><td><span class="muted">—</span></td><td>'+pct(p.engagementRate||0)+'</td><td></td></tr>'));
  h+= rows.length
    ? '<table style="margin-top:10px"><tr><th>콘텐츠 / 인사이트</th><th>조회</th><th>좋아요</th><th>댓글</th><th>참여율</th><th></th></tr>'+rows.join('')+'</table>'
    : '<div class="empty" style="padding:10px;margin-top:8px">아직 발행된 콘텐츠가 없습니다 — 첫 발행부터 콘텐츠별 조회·좋아요·댓글·참여율이 여기에 쌓입니다. (성과는 실측만 표시)</div>';
  h+='</div>';
  return h;
}
// 🔗 레퍼런스 링크 — 채널별 벤치마크 링크 등록(인박스). 등록=적재, 학습은 다음 기획 세션에서.
function refBadge(st){
  return st==='learned'?'<span class="badge b-ok">학습완료</span>'
       : st==='failed'?'<span class="badge b-hold">열람실패</span>'
       : st==='received'?'<span class="badge b-plan">접수됨</span>'
       : '<span class="badge b-wait">학습대기</span>';
}
function refShort(u){ return esc(String(u).replace(/^https?:\\/\\/(www\\.)?/,'').slice(0,52)); }
function referencePanel(client, key){
  const all=refLinksFor(client, key);
  const pend=all.filter(l=>l.status==='pending'||l.status==='received').length;
  let h='<div class="panel" style="border-color:#f0e2c8;background:#fffdf7"><div class="sect-h" style="margin:0 0 8px"><h3>🔗 레퍼런스 링크</h3><span class="muted">'+
    (all.length?('등록 '+all.length+'건 · 학습대기 '+pend+'건'):'벤치마크할 게시물 링크를 등록하세요')+'</span></div>'+
    '<div class="muted" style="margin:0 0 8px">한 줄에 링크 1개. 링크 뒤에 한 칸 띄고 메모를 붙이면 그 의도까지 학습에 반영됩니다. 등록된 링크는 <b>다음 기획 전에 AI가 직접 열람·학습</b>해 디자인·기획에 반영하고, 학습 결과가 여기에 표시됩니다.</div>';
  if(all.length){
    h+='<table style="margin-bottom:8px"><tr><th>링크 / 메모</th><th style="width:86px">상태</th><th>학습 요약</th></tr>'+
      all.slice(-8).reverse().map(l=>'<tr><td><a href="'+esc(l.url)+'" target="_blank" rel="noopener">'+refShort(l.url)+'↗</a>'+(l.note?'<div class="muted" style="font-size:11.5px">'+esc(l.note)+'</div>':'')+'</td>'+
        '<td>'+refBadge(l.status)+'</td><td class="muted" style="font-size:12px">'+esc(l.summary||'')+'</td></tr>').join('')+'</table>';
  }
  h+='<textarea id="rl-'+key+'" class="reqta" rows="2" placeholder="https://... (한 줄에 하나씩)"></textarea>'+
     '<div style="margin-top:6px"><button class="btn fb" onclick="submitGuidance(\\'[레퍼런스·'+key+'] '+esc(client.name)+'\\',\\'\\',\\'rl-'+key+'\\')">🔗 레퍼런스 등록</button></div></div>';
  return h;
}
function submitReq(key, chLabel){
  const ta=document.getElementById('reqtext-'+key);
  const txt=(ta&&ta.value.trim())||'';
  if(!txt){ alert('요청 내용을 먼저 적어주세요.'); return; }
  const planSel=document.getElementById('reqplan-'+key);
  const typeSel=document.getElementById('reqtype-'+key);
  const planId=planSel?planSel.value:'';
  const planLabel=planSel&&planSel.selectedIndex>=0?planSel.options[planSel.selectedIndex].text:'';
  const rtype=typeSel?typeSel.value:'기타';
  const first=txt.split('\\n')[0].slice(0,42);
  const title='[수정요청·'+key+'] ['+rtype.split('(')[0]+'] '+first;
  const body='업체: '+DATA.clients[ci].id+
    '\\n채널: '+chLabel+
    '\\n대상 콘텐츠: '+(planId?planLabel+' (id: '+planId+')':'채널 공통')+
    '\\n수정 항목: '+rtype+
    '\\n\\n[요청 내용]\\n'+txt+'\\n\\n— 대시보드 수정요청 게시판에서 작성됨';
  window.open(issue(title,body),'_blank');
  if(ta) ta.value='';
}
// 카드 이미지 캐시버스팅 — 기획안 갱신 시에만 새로 받게 버전 쿼리 부여
const VER = (((DATA.clients[0]||{}).planUpdatedAt)||DATA.generatedAt||'').replace(/\\D/g,'').slice(0,14);
const imgv = s => !s ? s : (s + (s.indexOf('?')<0?'?':'&') + 'v=' + VER);
const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const ftime = s => !s?'-':String(s).replace('T',' ').slice(0,16);
const pct = v => (v*100).toFixed(1)+'%';
const tIcon = t => ({up:'📈',down:'📉','n/a':'·'}[t]||'·');
function issue(title, body){
  return 'https://github.com/'+REPO+'/issues/new?labels=feedback&title='+encodeURIComponent(title)+'&body='+encodeURIComponent(body);
}
function sparkline(arr){
  if(!arr||arr.length<2) return '';
  const w=160,h=34,mx=Math.max(...arr,1),mn=Math.min(...arr,0);
  const dx=w/(arr.length-1);
  const pts=arr.map((v,i)=>[i*dx,h-((v-mn)/(mx-mn||1))*(h-6)-3]);
  const d=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  return '<svg class="spark" width="'+w+'" height="'+h+'"><path d="'+d+'" fill="none" stroke="#2b6fff" stroke-width="2"/></svg>';
}
function publishedCard(p, badge){
  const img=p.imageUrl?'<img class="thumb" src="'+esc(p.imageUrl)+'" loading="lazy" alt=""/>':'<div class="thumb noimg">이미지 없음</div>';
  const link=p.url?'<a href="'+esc(p.url)+'" target="_blank">열기 ↗</a>':'';
  return '<div class="card">'+img+'<div class="cbody"><div class="ctop"><strong>'+esc(p.topic)+'</strong>'+badge+'</div>'+
    '<div class="muted">'+ftime(p.time)+'</div>'+
    '<div class="cap">'+esc(p.caption||'')+'</div>'+
    '<div class="met"><span>👁 '+p.views+'</span><span>❤ '+p.likes+'</span><span>💬 '+p.comments+'</span><span>'+pct(p.engagementRate)+'</span></div>'+
    '<div>'+link+'</div></div></div>';
}
function plainHead(it){ return it.headline?it.headline.replace(/<br>/g,' ').replace(/\\*/g,''):it.topic; }
function vBadge(v){ return v?'<span class="badge b-var v-'+esc(v)+'">디자인 '+esc(v)+'</span>':''; }
function slideCount(it){ return (it.slideImages&&it.slideImages.length)||1; }
function planCard(client, chLabel, it){
  const img=it.cardImage?'<img class="thumb" src="'+esc(imgv(it.cardImage))+'" loading="lazy" alt=""/>':'<div class="thumb noimg">카드 준비중</div>';
  const head=esc(plainHead(it));
  const n=slideCount(it);
  const carBadge=n>1?'<span class="badge b-car">📑 '+n+'장</span>':'';
  const pub=it.status==='published';
  const manual=it.status==='manual';
  // 발행 게이트 — 미처리 수정요청이 걸려 있으면 자동 발행이 보류됨을 카드에 표시
  const held=!pub&&openHolds(it).length>0;
  const stBadge=pub?'<span class="badge b-ok">발행됨</span>'
    :held?'<span class="badge b-hold">⛔ 발행 보류 · 수정 반영 대기</span>'
    :manual?'<span class="badge b-wait">수동발행</span>':'<span class="badge b-plan">예정</span>';
  const right=pub&&it.publishedUrl?'<a href="'+esc(it.publishedUrl)+'" target="_blank" onclick="event.stopPropagation()">열기 ↗</a>':'<span class="muted">클릭하면 전체보기 →</span>';
  const m=it.metrics;
  const metLine=(pub&&m)?'<div class="met" style="margin-top:0"><span>👁 '+(m.views||0)+'</span><span>❤ '+(m.likes||0)+'</span><span>💬 '+(m.comments||0)+'</span><span>'+pct(m.engagementRate||0)+'</span></div>':'';
  return '<div class="card clk" onclick="openDetail(\\''+esc(it.id)+'\\')">'+
    '<div class="thumbwrap">'+img+carBadge+'</div>'+
    '<div class="cbody"><div class="ctop"><strong>'+head+'</strong>'+stBadge+'</div>'+
    '<div class="muted">🗓 '+ftime(it.scheduledFor)+(it.dayLabel?' · '+esc(it.dayLabel):'')+'</div>'+
    (it.captionNote?'<div class="cap">'+esc(it.captionNote)+'</div>':'')+
    metLine+
    '<div class="met" style="justify-content:space-between;align-items:center">'+vBadge(it.variant)+right+'</div></div></div>';
}
function openDetail(id){
  const c=DATA.clients[ci];
  const it=(c.planCards||[]).find(x=>x.id===id); if(!it) return;
  // 게이트 규약으로 등록 — [수정요청·채널] 제목 + 본문 (id: …) → 처리완료 전까지 이 콘텐츠 발행 보류
  const dKey=(it.channels||[])[0]||'instagram';
  const t='[수정요청·'+dKey+'] [콘텐츠] '+plainHead(it).slice(0,42);
  const b='업체: '+c.id+
    '\\n채널: '+dKey+
    '\\n대상 콘텐츠: '+plainHead(it)+' (id: '+it.id+')'+
    '\\n수정 항목: 콘텐츠 상세'+
    '\\n예정: '+ftime(it.scheduledFor)+' · 디자인: '+(it.variant||'')+
    '\\n\\n[요청 내용]\\n\\n— 대시보드 콘텐츠 상세에서 작성됨';
  const imgs=(it.slideImages&&it.slideImages.length)?it.slideImages:(it.cardImage?[it.cardImage]:[]);
  const chDef=DATA.channels.find(x=>x.key===((it.channels||[])[0]))||{icon:'📸',label:'인스타그램',key:'instagram'};
  const isCarousel=imgs.length>1;
  const capLabel=chDef.key==='naver-blog'?'📝 블로그 본문':chDef.key==='youtube'?'🎬 쇼츠 대본':chDef.key==='threads'?'🧵 스레드 타래':'📝 발행 캡션';
  const slides=imgs.map((s,i)=>'<div class="slide"><img src="'+esc(imgv(s))+'" alt=""/><span class="snum">'+(i+1)+' / '+imgs.length+'</span></div>').join('');
  const cap=fmtCaption(it.captionBody||it.captionNote||'');
  const isReels=chDef.key==='instagram'&&it.reelsScript;
  const reelsVideo=(chDef.key==='instagram'&&it.videoFile)?'<div style="margin:6px 0 14px"><video src="'+esc(it.videoFile)+'" controls playsinline style="max-height:430px;max-width:100%;border-radius:14px;border:1px solid #e4e8f0;background:#000"></video><div style="margin-top:8px"><a class="btn fb" href="'+esc(it.videoFile)+'" download="'+esc(it.id+'.mp4')+'" style="background:#fbeaf6;border-color:#e0b0d0;color:#a83a8a">🎬 릴스 영상 다운로드</a></div></div>':'';
  const reelsBox=isReels?'<div class="capbox" style="margin-top:12px"><div class="caphd">🎬 릴스 대본 (영상 자막 구성)</div><div class="mcap">'+fmtCaption(it.reelsScript)+'</div></div>':'';
  const m=it.metrics;
  const perf=(it.status==='published'&&m)?'<div class="capbox" style="margin-bottom:12px;border-color:#c9d8f0"><div class="caphd">📊 성과 데이터</div>'+
    '<div class="met" style="font-size:13px"><span>👁 '+(m.views||0)+'</span><span>❤ '+(m.likes||0)+'</span><span>💬 '+(m.comments||0)+'</span><span>참여율 '+pct(m.engagementRate||0)+'</span></div>'+
    (it.insightComment?'<div style="color:#15803d;font-size:14px;margin-top:8px;line-height:1.6">💬 '+esc(it.insightComment)+'</div>':'')+'</div>':'';
  document.getElementById('mbody').innerHTML=
    '<div class="kick">'+esc(it.kicker||'')+' · 디자인 '+esc(it.variant||'')+(isCarousel?' · 📑 캐러셀 '+imgs.length+'장':'')+(isReels?' · 🎬 릴스':'')+'</div>'+
    '<h2 style="margin:2px 0 4px">'+esc(plainHead(it))+'</h2>'+
    '<div class="muted" style="margin-bottom:14px">🗓 '+ftime(it.scheduledFor)+(it.dayLabel?' · '+esc(it.dayLabel):'')+' · '+chDef.icon+' '+esc(chDef.label)+' · <span class="badge b-plan">발행 대기</span></div>'+
    '<div class="carou">'+slides+'</div>'+
    (isCarousel?'<div class="muted" style="margin:6px 0 14px">← 좌우로 넘겨 보세요 ('+imgs.length+'장)</div>':'<div style="height:8px"></div>')+
    reelsVideo+
    perf+
    '<div class="capbox"><div class="caphd">'+capLabel+'</div><div class="mcap">'+cap+'</div></div>'+
    reelsBox+
    manualHelper(it,chDef)+
    '<div style="margin-top:16px;display:flex;gap:8px"><a class="btn fb" href="'+issue(t,b)+'" target="_blank">✏️ 수정요청</a><button class="btn" onclick="closeModal()">닫기</button></div>';
  document.getElementById('modal').classList.add('on');
  const car=document.querySelector('.carou'); if(car) car.scrollLeft=0;
}
function closeModal(){ document.getElementById('modal').classList.remove('on'); }
// 수동 채널(네이버 블로그·유튜브) 발행 도우미 — 본문 복사 + 이미지 다운로드
function manualHelper(it, chDef){
  if(chDef.key!=='naver-blog' && chDef.key!=='youtube') return '';
  const isNaver=chDef.key==='naver-blog';
  // 네이버: 본문에 실제로 들어가는 이미지(마커 [📷 이미지N]과 1:1)를 받게 한다. 유튜브: 커버 썸네일.
  const bodyImgs=String(it.captionBody||'').split('\\n').map(function(l){var m=l.trim().match(/^!\\[[^\\]]*\\]\\(([^)]+)\\)$/);return m?m[1]:null;}).filter(Boolean);
  const coverImgs=(it.slideImages&&it.slideImages.length)?it.slideImages:(it.cardImage?[it.cardImage]:[]);
  const figImgs=(isNaver&&bodyImgs.length)?bodyImgs:coverImgs;
  const dls=figImgs.map((s,i)=>'<a class="btn" href="'+esc(imgv(s))+'" download="'+esc(it.id+'-img'+(i+1)+'.png')+'">⬇ 이미지'+(i+1)+'</a>').join('')
    +(isNaver?'<a class="btn" href="'+esc(imgv('blog/'+it.id+'/cover.png'))+'" download="'+esc(it.id+'-대표이미지.png')+'" style="background:#e7effc;border-color:#b4cdf0;color:#2b5aa0">⬇ 대표이미지(가로)</a>':'');
  const isYt=chDef.key==='youtube';
  const hasVideo=isYt&&it.videoFile;
  const guide=isYt
    ? '쇼츠 영상을 다운로드해 업로드하고, 아래 SEO 제목·설명·태그를 그대로 복사해 넣으세요. (음악은 업로드 시 유튜브 무료 음악으로 추가)'
    : '① “본문 전체 복사” → 네이버 글쓰기에 붙여넣기. ② 본문 속 [📷 이미지N] 자리마다 “이미지N”을 받아 그 위치에 삽입. ③ “대표이미지(가로)”를 받아 네이버 대표사진으로 지정(가로 16:9라 잘림·글자겹침 없음). ※ 네이버는 외부 이미지가 붙여넣기로 안 따라와 직접 삽입해야 합니다.';
  const videoBtn=hasVideo?'<a class="btn fb" href="'+esc(it.videoFile)+'" download="'+esc(it.id+'.mp4')+'" style="background:#fbeaf6;border-color:#e0b0d0;color:#a83a8a">🎬 쇼츠 영상 다운로드</a>':'';
  // 유튜브: SEO 업로드 패키지 (제목/설명/태그) 미리보기 + 개별 복사
  const ytPack=isYt&&(it.ytTitle||it.ytDescription)?(
    '<div style="margin-top:10px;border-top:1px solid #e4e8f0;padding-top:10px">'+
    (it.ytTitle?'<div class="muted" style="font-size:11px">제목</div><div class="mcap" style="font-size:13px;margin-bottom:8px">'+esc(it.ytTitle)+'</div>':'')+
    (it.ytDescription?'<div class="muted" style="font-size:11px">설명(멘션)</div><div class="mcap" style="font-size:12px;white-space:pre-wrap;max-height:9em;overflow:auto;background:#f7f9fc;border:1px solid #e4e8f0;border-radius:8px;padding:8px;margin-bottom:8px">'+esc(it.ytDescription)+'</div>':'')+
    (it.ytTags&&it.ytTags.length?'<div class="muted" style="font-size:11px">태그</div><div style="margin-bottom:4px">'+it.ytTags.map(function(t){return '<span class="tag">'+esc(t)+'</span>';}).join('')+'</div>':'')+
    '</div>'):'';
  const ytBtns=isYt?(
    (it.ytTitle?'<button class="btn" id="yttitle-'+esc(it.id)+'" onclick="copyField(\\''+esc(it.id)+'\\',\\'ytTitle\\',this.id)">🏷 제목 복사</button>':'')+
    (it.ytDescription?'<button class="btn fb" id="ytdesc-'+esc(it.id)+'" onclick="copyField(\\''+esc(it.id)+'\\',\\'ytDescription\\',this.id)">📝 설명(멘션) 복사</button>':'')+
    (it.ytTags&&it.ytTags.length?'<button class="btn" id="yttags-'+esc(it.id)+'" onclick="copyTags(\\''+esc(it.id)+'\\',this.id)"># 태그 복사</button>':'')
  ):'';
  return '<div class="capbox" style="margin-top:12px;border-color:#d8e4bc;background:#f8fbee">'+
    '<div class="caphd">📋 수동 발행 도우미 ('+esc(chDef.label)+')</div>'+
    '<div class="muted" style="margin-bottom:10px">'+guide+'</div>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap">'+
    videoBtn+ytBtns+
    (isYt?'<button class="btn" id="copybtn-'+esc(it.id)+'" onclick="copyPost(\\''+esc(it.id)+'\\')">🎬 대본 복사</button>':'<button class="btn fb" id="copybtn-'+esc(it.id)+'" onclick="copyPost(\\''+esc(it.id)+'\\')">📋 본문 전체 복사</button>')+
    (chDef.key==='naver-blog'?'<button class="btn" id="titlebtn-'+esc(it.id)+'" onclick="copyTitle(\\''+esc(it.id)+'\\')">🏷 제목만 복사</button>':'')+
    dls+'</div>'+ytPack+'</div>';
}
// 네이버 붙여넣기용 평문(마크다운 기호 제거, 이미지 위치는 마커로)
function plainPostText(it){
  let n=0;
  return String(it.captionBody||'').split('\\n').map(line=>{
    const t=line.trim();
    const img=t.match(/^!\\[([^\\]]*)\\]\\(([^)]+)\\)$/);
    if(img){ n++; return '\\n[📷 이미지'+n+' 삽입]\\n'; }
    if(t.startsWith('## ')) return '\\n■ '+t.slice(3);
    if(t.startsWith('# ')) return t.slice(2);
    if(t==='>'||t.startsWith('> ')) return t.replace(/^>\\s?/,'');
    return line.replace(/\\*\\*([^*]+)\\*\\*/g,'$1');
  }).join('\\n').replace(/\\n{3,}/g,'\\n\\n').trim();
}
function flash(id,msg){ const b=document.getElementById(id); if(b){const o=b.textContent;b.textContent=msg;setTimeout(()=>b.textContent=o,1500);} }
function copyPost(id){
  const it=(DATA.clients[ci].planCards||[]).find(x=>x.id===id); if(!it) return;
  navigator.clipboard.writeText(plainPostText(it)).then(()=>flash('copybtn-'+id,'✅ 복사됨!')).catch(()=>alert('복사 실패 — 본문을 길게 눌러 직접 복사하세요.'));
}
function copyTitle(id){
  const it=(DATA.clients[ci].planCards||[]).find(x=>x.id===id); if(!it) return;
  navigator.clipboard.writeText(plainHead(it)).then(()=>flash('titlebtn-'+id,'✅ 복사됨!')).catch(()=>{});
}
function copyField(id,field,btnId){
  const it=(DATA.clients[ci].planCards||[]).find(x=>x.id===id); if(!it||!it[field]) return;
  navigator.clipboard.writeText(it[field]).then(()=>flash(btnId,'✅ 복사됨!')).catch(()=>alert('복사 실패 — 직접 복사하세요.'));
}
function copyTags(id,btnId){
  const it=(DATA.clients[ci].planCards||[]).find(x=>x.id===id); if(!it||!it.ytTags) return;
  navigator.clipboard.writeText(it.ytTags.join(', ')).then(()=>flash(btnId,'✅ 복사됨!')).catch(()=>{});
}
// 블로그/대본 등 본문의 가벼운 마크다운(## 소제목, [HOOK] 등)을 보기 좋게
function mdInline(x){ return esc(x).replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>'); }
function fmtCaption(s){
  return String(s||'').split('\\n').map(line=>{
    const t=line.trim();
    const img=t.match(/^!\\[([^\\]]*)\\]\\(([^)]+)\\)$/);
    if(img) return '<img class="md-img" src="'+esc(img[2])+'" alt="'+esc(img[1])+'" loading="lazy"/>';
    if(t.startsWith('## ')) return '<h4 class="md-h">'+mdInline(t.slice(3))+'</h4>';
    if(t.startsWith('# ')) return '<h3 class="md-h1">'+mdInline(t.slice(2))+'</h3>';
    if(t==='>'||t.startsWith('> ')) return '<div class="md-quote">'+mdInline(t.replace(/^>\\s?/,''))+'</div>';
    if(t.indexOf('🔖')===0) return '<div class="md-tags">'+esc(t)+'</div>';
    if(/^\\[.+\\]$/.test(t)) return '<div class="md-tag">'+esc(t)+'</div>';
    if(t==='---'||t==='') return '<div class="md-sp"></div>';
    return '<div>'+mdInline(line)+'</div>';
  }).join('');
}
function channelDetail(client, c){
  const chLabel=(DATA.channels.find(x=>x.key===c.key)||{}).label||c.key;
  let h='';
  // ① 수정요청 게시판 — 채널 최상단 (작성 + 처리 현황)
  h+=requestsPanel(client, c.key, chLabel);
  // ② 운영 기간 선택 — 아래 데이터/히스토리에 모두 적용
  h+=periodBar();
  // ③ 콘텐츠 리포트 — 발행 콘텐츠 실측 데이터 (가이드는 지침 탭 전용으로 이동)
  h+=contentReportPanel(client, c, chLabel);
  // 기획안 패널
  const planTitle='['+client.name+'/'+chLabel+'] 기획안 피드백';
  const planBody='이 채널 기획안에 대한 피드백/수정사항을 적어주세요.\\n\\n[현재 기획안]\\n- 키워드: '+client.keywords.join(', ')+'\\n- 브랜드 말투: '+client.brandTone+'\\n- 발행시간: '+client.schedule.join(', ')+'\\n- 디자인 스타일: '+client.designStyle.mood+' / '+client.designStyle.palette+'\\n\\n[수정 요청]\\n';
  h+='<div class="panel"><div class="sect-h" style="margin:0 0 8px"><h3>📋 기획안</h3><a class="btn fb" href="'+issue(planTitle,planBody)+'" target="_blank">✏️ 기획안 피드백</a></div>'+
     '<div>'+client.keywords.map(k=>'<span class="tag">#'+esc(k)+'</span>').join('')+'</div>'+
     '<div class="muted" style="margin-top:8px">말투: '+esc(client.brandTone)+' · 발행 '+client.schedule.join(', ')+' · 검수 '+esc(client.reviewMode)+' · 디자인 v'+client.designVersion+'</div>'+
     '<div class="muted">디자인 스타일: '+esc(client.designStyle.mood)+' / '+esc(client.designStyle.palette)+' / '+esc(client.designStyle.composition)+'</div></div>';
  if(!c.active){
    h+='<div class="panel"><div class="empty">이 채널은 아직 <b>연결되지 않았습니다</b>. 설정표(targets)에 '+chLabel+'을 추가하고 키를 연결하면 자동 발행이 시작됩니다.</div></div>';
  }
  // 선택 기간으로 필터한 히스토리 (KPI·성과표는 ③ 콘텐츠 리포트 패널이 단일 출처)
  const pubF=c.published.filter(p=>inPeriod(p.time));
  const planPubF=c.pending.filter(it=>it.status==='published'&&inPeriod(it.publishedAt||it.scheduledFor));
  const waiting=c.pending.filter(it=>it.status!=='published');
  // 블로그(네이버·구글) → blogdex 스타일 + 카테고리 키워드 상시 패널
  if(c.key==='naver-blog'||c.key==='blogger'){ h+=blogSection(client); }
  // 발행 대기 (발행 전 콘텐츠만)
  const heldN=waiting.filter(it=>openHolds(it).length>0).length;
  h+='<div class="sect-h"><h2>🕓 발행 대기 콘텐츠 ('+waiting.length+(heldN?' · ⛔ 보류 '+heldN:'')+')</h2></div>';
  h+= waiting.length? '<div class="cards">'+waiting.map(it=>planCard(client,chLabel,it)).join('')+'</div>' : '<div class="empty">예정된 콘텐츠가 없습니다. 다음 사이클에 자동 생성됩니다.</div>';
  // 발행됨 — 기간 반영 히스토리 (기획 발행분 + 사이클 발행분)
  h+='<div class="sect-h"><h2>✅ 발행된 콘텐츠 · '+periodLabel()+' ('+(planPubF.length+pubF.length)+')</h2></div>';
  const pubCards=planPubF.map(it=>planCard(client,chLabel,it)).concat(pubF.map(p=>publishedCard(p,'<span class="badge b-ok">발행</span>')));
  h+= pubCards.length? '<div class="cards">'+pubCards.join('')+'</div>' : '<div class="empty">이 기간에 발행된 콘텐츠가 없습니다.</div>';
  // ④ 레퍼런스 링크 인박스 — 채널 탭 최하단 (등록하면 다음 기획 세션에서 AI가 열람·학습)
  h+=referencePanel(client, c.key);
  return h;
}
function blogSection(client){
  const b=client.blog;
  const color = b.score>=70?'#e4f7ea':b.score>=40?'#fdf3e0':'#eef1f6';
  const fg = b.score>=70?'#15803d':b.score>=40?'#b45309':'#5a6274';
  let h='<div class="panel"><div class="sect-h" style="margin:0 0 10px"><h3>📊 블로그 지수 (blogdex 스타일)</h3><span class="muted">내부 추정 · 네이버 연동 시 실측 교체</span></div>';
  h+='<div class="row"><div class="grade" style="background:'+color+';color:'+fg+'">'+esc(b.grade)+'</div>'+
     '<div style="flex:1;min-width:160px"><div class="muted">종합 점수 '+b.score+'/100</div><div class="bar"><i style="width:'+b.score+'%"></i></div></div></div>';
  // 포스팅 분석
  if(b.posts.length){
    h+='<table style="margin-top:12px"><tr><th>포스팅</th><th>전문성</th><th>연관성</th><th>품질</th></tr>'+
      b.posts.slice(0,8).map(p=>'<tr><td>'+esc(p.topic)+'</td><td>'+p.expertise+'</td><td>'+p.relevance+'</td><td>'+p.quality+'</td></tr>').join('')+'</table>';
  }
  // 키워드 분석 — 네이버 광고주센터 키워드 도구 실측값만 표시 (허수 금지)
  const src=b.kwSource;
  h+='<div class="sect-h" style="margin:14px 0 6px"><h3 style="margin:0;font-size:14px">🔑 키워드 월간 검색수</h3><span class="muted">'+
     (src?esc(src.source)+' 실측 · 기준 '+String(src.fetchedAt).slice(0,10):'광고주센터 키워드 도구 실측 데이터 연결 전 — 수치는 표시하지 않습니다')+'</span></div>';
  h+='<table><tr><th>키워드</th><th>PC</th><th>모바일</th><th>합계</th><th>경쟁정도</th></tr>'+
    b.keywords.map(k=>{
      const n=v=>v==null?'<span class="muted">—</span>':Number(v).toLocaleString();
      const wait=k.total==null&&!src;
      return '<tr><td>#'+esc(k.kw)+'</td>'+
        (wait?'<td colspan="4"><span class="badge b-wait">실측 대기</span> <span class="muted" style="font-size:11px">키워드 도구 CSV 임포트 후 표시</span></td>'
             :'<td>'+n(k.pc)+'</td><td>'+n(k.mobile)+'</td><td><b>'+n(k.total)+'</b></td><td>'+(k.competition?esc(k.competition):'<span class="muted">—</span>')+'</td>')+'</tr>';
    }).join('')+'</table>';
  // 카테고리별 핵심 키워드 — 주간 실측·전월 대비 상시 패널 (운영자 지시 2026-08-05)
  const ck=b.catKw;
  if(ck){
    const cell=k=>{
      if(k.total==null) return esc(k.keyword)+' <span class="muted">—</span>';
      const mom=k.momPct==null?'<span class="muted" style="font-size:11px">축적 중</span>'
        :(k.momPct>0?'<span style="color:#15803d;font-weight:700">▲'+k.momPct+'%</span>'
          :k.momPct<0?'<span style="color:#b91c1c;font-weight:700">▼'+Math.abs(k.momPct)+'%</span>'
          :'<span class="muted">0%</span>');
      return esc(k.keyword)+' <b>'+Number(k.total).toLocaleString()+'</b> '+mom;
    };
    h+='<div class="sect-h" style="margin:16px 0 6px"><h3 style="margin:0;font-size:14px">🗂 카테고리별 핵심 키워드 (주간 갱신·전월 대비)</h3><span class="muted">매주 월요일 09:00 자동 · 기준 '+esc(ck.updatedAt)+(ck.baselineDate?' · 전월比 '+esc(ck.baselineDate)+' 기준':' · 전월比는 다음 달부터')+'</span></div>';
    h+='<div style="overflow-x:auto"><table><tr><th>카테고리</th><th>키워드 ①</th><th>키워드 ②</th><th>키워드 ③</th></tr>'+
      ck.categories.map(c=>'<tr><td><b>'+esc(c.name)+'</b></td>'+c.keywords.map(k=>'<td>'+cell(k)+'</td>').join('')+'</tr>').join('')+'</table></div>';
  }
  h+='</div>';
  return h;
}
function tokenBanner(client){
  const th=client.tokenHealth; if(!th||!th.tokens||!th.tokens.length) return '';
  const bad=th.tokens.filter(t=>t.warn||!t.ok);
  if(!bad.length) return '';
  return '<div class="panel" style="border-color:#f0cfae;background:#fdf6ec">'+
    '<h3>🔑 토큰 점검 경고</h3>'+
    bad.map(t=>'<div class="muted" style="color:#b45309;font-size:13px;margin:2px 0">'+(t.ok?'🟡':'🔴')+' '+esc(t.label)+': '+esc(t.detail||'확인 필요')+'</div>').join('')+
    '<div class="muted" style="margin-top:6px">토큰을 새로 발급해 GitHub 시크릿(PSLAB_*_ACCESS_TOKEN)을 갱신하세요. 마지막 점검: '+ftime(th.checkedAt)+'</div></div>';
}
function learningPanel(client){
  const L=client.learning; if(!L) return '';
  const gs=g=>'<tr><td>'+esc(g.key)+'</td><td>'+g.posts+'</td><td>'+pct(g.avgEngagement)+'</td><td>'+Math.round(g.avgLikes)+'</td></tr>';
  let h='<div class="panel"><div class="sect-h" style="margin:0 0 10px"><h3>🧠 성과 인사이트 · 자체 학습</h3><span class="muted">표본 '+L.sampleSize+'건 · '+ftime(L.generatedAt)+'</span></div>';
  if(L.sampleSize<1){
    h+='<div class="empty">발행물 성과가 쌓이면 어떤 디자인·시간대·소재가 잘 먹히는지 여기서 자동 분석됩니다.</div></div>';
    return h;
  }
  if(L.hints&&L.hints.length){
    h+='<div style="margin-bottom:10px">'+L.hints.map(x=>'<div class="muted" style="color:#15803d;font-size:13px;margin:3px 0">💡 '+esc(x)+'</div>').join('')+'</div>';
  }
  if(L.variants&&L.variants.length){
    h+='<div class="muted" style="margin:8px 0 4px">디자인 변형별 성과'+(L.bestVariant?' · 우세: <b style="color:#b45309">'+esc(L.bestVariant)+'안</b>':'')+'</div>'+
      '<table><tr><th>디자인</th><th>발행</th><th>평균 참여율</th><th>평균 좋아요</th></tr>'+L.variants.map(gs).join('')+'</table>';
  }
  if(L.hours&&L.hours.length>1){
    h+='<div class="muted" style="margin:12px 0 4px">시간대별 성과</div><table><tr><th>발행시각</th><th>발행</th><th>평균 참여율</th><th>평균 좋아요</th></tr>'+L.hours.map(gs).join('')+'</table>';
  }
  h+='<div class="muted" style="margin-top:10px">이 학습은 다음 기획 생성 때 디자인 선택·소재 방향에 자동 반영됩니다(자체 디벨롭).</div></div>';
  return h;
}
function weeklyPanel(client){
  const w=client.weeklyReport; if(!w) return '';
  const chRows=(w.channels||[]).map(c=>'<tr><td>'+esc(c.label)+'</td><td>'+c.posts+'</td><td>'+pct(c.avgEngagement)+'</td><td>'+c.totalViews+'</td><td>'+c.totalLikes+'</td></tr>').join('');
  const recs=(w.recommendations||[]).map(r=>'<li>'+esc(r)+'</li>').join('');
  const top=w.top?'<div class="muted" style="margin:6px 0">🏆 최고 성과: <b>['+esc(w.top.label)+'] '+esc(w.top.title)+'</b> ('+pct(w.top.engagementRate)+')</div>':'';
  return '<div class="panel" style="border-color:#c9d8f0;background:#f2f6fd">'+
    '<div class="sect-h" style="margin:0 0 10px"><h3>📅 주간 종합 리포트</h3><span class="muted">'+esc(w.weekOf)+' 주 · 발행 '+w.postsCount+'건 · '+ftime(w.generatedAt)+'</span></div>'+
    '<div class="mcap" style="font-size:14px;margin-bottom:8px">'+esc(w.summary)+'</div>'+top+
    (chRows?'<table style="margin:8px 0"><tr><th>채널</th><th>발행</th><th>평균 참여율</th><th>조회</th><th>좋아요</th></tr>'+chRows+'</table>':'')+
    (recs?'<div class="muted" style="margin:8px 0 4px">다음 주 방향</div><ul style="margin:0;padding-left:18px;color:#15803d;font-size:13px">'+recs+'</ul>':'')+
    '</div>';
}
function setupPanel(){
  const s=DATA.setup||{};
  const settingsUrl='https://github.com/'+REPO+'/settings/secrets/actions';
  const varsUrl='https://github.com/'+REPO+'/settings/variables/actions';
  const row=(ok,name,todo,url)=>'<tr><td style="width:34px;font-size:16px">'+(ok?'✅':'⬜')+'</td><td><b>'+esc(name)+'</b>'+(ok?'':'<div class="muted" style="margin-top:2px">'+todo+(url?' · <a href="'+url+'" target="_blank">설정 열기 ↗</a>':'')+'</div>')+'</td></tr>';
  const done=[s.instagram,s.threads,s.telegram,s.anthropic,s.realPublish].filter(Boolean).length;
  return '<div class="panel" style="border-color:#2b6fff">'+
    '<div class="sect-h" style="margin:0 0 8px"><h3>🚀 오픈 준비 체크리스트</h3><span class="muted">'+done+'/5 완료</span></div>'+
    '<table>'+
    row(s.instagram,'인스타그램 연결','발행 토큰 미설정 — PSLAB_INSTAGRAM_ACCESS_TOKEN 시크릿',settingsUrl)+
    row(s.threads,'스레드 연결','발행 토큰 미설정 — PSLAB_THREADS_ACCESS_TOKEN 시크릿',settingsUrl)+
    row(s.telegram,'텔레그램 푸시','@BotFather로 봇 생성 → TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID 시크릿',settingsUrl)+
    row(s.blogger,'구글 블로그 자동발행','선택 — Blogger OAuth(클라이언트/리프레시 토큰/블로그ID) 시크릿',settingsUrl)+
    row(s.anthropic,'AI 글·코멘트','ANTHROPIC_API_KEY 시크릿 (없으면 규칙기반으로 동작)',settingsUrl)+
    row(s.realPublish,'실제 자동발행 ON','예약 발행을 켜려면 Variables에 PSLAB_DRY_RUN=false (지금은 안전 시뮬레이션)',varsUrl)+
    '</table>'+
    '<div class="muted" style="margin-top:8px"><b>구글 블로그</b>는 API로 자동발행됩니다. <b>네이버 블로그·유튜브</b>는 공식 자동발행 API가 없어 <b>수동(복붙)</b> 채널입니다.</div>'+
    '</div>';
}
// 채널 바로가기 — 채널별 그라데이션 카드(클릭 시 관리로 이동)
function chGrad(key){
  return ({youtube:'linear-gradient(135deg,#fdecec,#fbdcdc)',instagram:'linear-gradient(135deg,#fceaf5,#f6d8ec)',threads:'linear-gradient(135deg,#ecf5f5,#dcecec)','naver-blog':'linear-gradient(135deg,#eafaf0,#d8f0e2)',blogger:'linear-gradient(135deg,#fdf3e6,#f8e6cc)'})[key]||'linear-gradient(135deg,#f4f6fa,#e9edf5)';
}
function chBorder(key){ return ({youtube:'#f0b8b8',instagram:'#eab8d8',threads:'#b8d8d8','naver-blog':'#a8dcbe',blogger:'#ecca9e'})[key]||'#dfe4ec'; }
function channelLinksPanel(client){
  const links=client.channelLinks||[];
  if(!links.length) return '';
  const cards=links.map(l=>
    '<a href="'+esc(l.url)+'" target="_blank" rel="noopener" style="flex:1 1 200px;min-width:180px;text-decoration:none;border-radius:14px;padding:16px 18px;border:1px solid '+chBorder(l.key)+';background:'+chGrad(l.key)+';display:block">'+
    '<div style="font-weight:800;font-size:18px;color:#14171d;margin-bottom:4px">'+l.icon+' '+esc(l.label)+'</div>'+
    '<div style="font-size:13px;color:#4a5264;opacity:.9">'+esc(l.sub)+'</div></a>').join('');
  return '<div class="panel"><div class="sect-h" style="margin:0 0 10px"><h3>🔗 채널 바로가기</h3><span class="muted">클릭하면 각 채널 관리로 이동</span></div>'+
    '<div style="display:flex;gap:12px;flex-wrap:wrap">'+cards+'</div></div>';
}
// 📅 차주 콘텐츠 기획 (ADR-0006: 금 키워드 수집 → 토 기획 → week-plan.json, plan.json과 분리)
function weekPlanPanel(client){
  const wp=client.weekPlan;
  let h='<div class="panel"><div class="sect-h" style="margin:0 0 8px"><h3>📅 차주 콘텐츠 기획</h3><span class="muted">'+
    (wp&&wp.baseDate?'기준일 '+esc(String(wp.baseDate).slice(0,10)):'키워드 실측 연동 후 매주 토요일 자동 생성')+'</span></div>';
  if(!wp){
    h+='<div class="empty" style="padding:10px">아직 차주 기획이 없습니다 — 네이버 검색광고 키워드 수집(금) → 차주 기획(토) 파이프라인은 계정 연결 단계에서 켜집니다.</div>';
  } else {
    h+='<table><tr><th style="width:90px">날짜</th><th style="width:130px">채널</th><th>제안 제목</th><th style="width:80px">시트</th></tr>'+
      wp.items.map(it=>{
        const cd=DATA.channels.find(x=>x.key===it.channel)||{icon:'',label:it.channel||''};
        return '<tr><td class="muted">'+esc(it.date||'')+'</td><td>'+cd.icon+' '+esc(cd.label)+'</td><td>'+esc(it.title||'')+'</td><td><span class="tag">'+esc(it.sheet||'')+'</span></td></tr>';
      }).join('')+'</table>'+
      '<div class="muted" style="margin-top:8px">이 기획안은 감도·가짜글자 검수를 거친 뒤에만 실제 제작으로 넘어갑니다 (자동발행 큐와 분리).</div>';
  }
  return h+'</div>';
}
// 🔌 채널 연결 상황 — 압축 칩 (개요 최하단, docs/06-대시보드 레이아웃 원칙)
function connChips(client){
  const st=DATA.setup||{};
  const on={'instagram':st.instagram,'threads':st.threads,'blogger':st.blogger,'youtube':st.youtube};
  const chips=client.channels.map(c=>{
    const lab=DATA.channels.find(x=>x.key===c.key)||{icon:'',label:c.key};
    const mark=c.key==='naver-blog'?'✍️ 수동':(on[c.key]?'✅':'⬜');
    return '<span class="tag" style="font-size:12px;padding:5px 10px">'+lab.icon+' '+esc(lab.label)+' '+mark+'</span>';
  }).join(' ');
  return '<div class="panel"><div class="sect-h" style="margin:0 0 8px"><h3>🔌 채널 연결 상황</h3><span class="muted">계정 연결은 온보딩 마지막 단계 — 상세 절차는 아래 체크리스트</span></div><div>'+chips+'</div></div>';
}
function overview(client){
  let h=tokenBanner(client);
  h+=channelLinksPanel(client);
  h+=weekPlanPanel(client);
  h+=weeklyPanel(client);
  h+=periodBar();
  h+='<div class="kpis">'+
    kpi(client.totalCycles,'총 사이클')+
    kpi(client.totalPublished,'총 발행')+
    kpi(client.heldCount,'승인 대기',client.heldCount>0)+
    kpi('v'+client.designVersion,'디자인 진화')+'</div>';
  h+=learningPanel(client);
  h+='<div class="panel"><h3>채널별 요약</h3><table><tr><th>채널</th><th>상태</th><th>발행</th><th>대기</th><th>평균 참여율</th><th>수정요청</th></tr>'+
    client.channels.map(c=>{const lab=(DATA.channels.find(x=>x.key===c.key)||{});
      const iss=channelIssues(c.key); const openN=iss.filter(x=>x.state!=='closed').length;
      const reqCell=iss.length?(openN?'<span class="badge b-wait">🛠 처리중 '+openN+'</span>':'<span class="badge b-ok">✅ 완료 '+iss.length+'</span>'):'<span class="muted">-</span>';
      return '<tr><td>'+lab.icon+' '+lab.label+'</td><td>'+(c.active?'<span class="badge b-ok">연결</span>':'<span class="badge b-hold">미연결</span>')+'</td><td>'+c.stats.publishedCount+'</td><td>'+c.stats.pendingCount+'</td><td>'+pct(c.stats.avgEngagement)+' '+tIcon(c.stats.trend)+'</td><td>'+reqCell+'</td></tr>';}).join('')+'</table></div>';
  // 발행 전 콘텐츠 기획안 — 메인에는 발행 전(예정·수동대기)만 보여준다
  const plan=client.planCards||[];
  const pre=plan.filter(p=>p.status!=='published');
  const fbTitle='['+client.name+'] 기획안 전체 피드백';
  const fbBody='이번 달 기획안에 대한 의견/수정사항을 적어주세요.\\n\\n';
  const mon=new Date(DATA.generatedAt).getMonth()+1;
  h+='<div class="sect-h"><h2>🕓 '+mon+'월 발행 전 콘텐츠 ('+pre.length+')</h2><a class="btn fb" href="'+issue(fbTitle,fbBody)+'" target="_blank">✏️ 기획안 피드백</a></div>';
  if(!pre.length){ h+='<div class="empty">발행 전 콘텐츠가 없습니다. 다음 사이클에 자동 생성됩니다.</div>'; }
  else {
    for(const chDef of DATA.channels){
      const items=pre.filter(p=>(p.channels||[]).includes(chDef.key));
      if(!items.length) continue;
      const lab=chDef.icon+' '+chDef.label;
      h+='<div class="chgrp"><div class="chgrp-h">'+lab+' <span class="muted">'+items.length+'건 · '+esc((items[0].format)||'')+'</span></div>'+
         '<div class="cards">'+items.map(p=>planCard(client,chDef.label,p)).join('')+'</div></div>';
    }
  }
  // 선택한 기간의 발행 게시물 (기획 발행분 + 사이클 발행분)
  const planPub=plan.filter(p=>p.status==='published'&&inPeriod(p.publishedAt||p.scheduledFor))
    .sort((a,b)=>String(b.publishedAt||'').localeCompare(String(a.publishedAt||'')));
  const recent=[].concat(...client.channels.map(c=>c.published)).filter(p=>inPeriod(p.time))
    .sort((a,b)=>(b.time||'').localeCompare(a.time||'')).slice(0,12);
  h+='<div class="sect-h"><h2>✅ 발행된 게시물 · '+periodLabel()+' ('+(planPub.length+recent.length)+')</h2></div>';
  const pubCards=planPub.map(p=>{
    const chDef=DATA.channels.find(x=>x.key===((p.channels||[])[0]))||{label:''};
    return planCard(client,chDef.label,p);
  }).concat(recent.map(p=>publishedCard(p,'<span class="badge b-ok">발행</span>')));
  h+= pubCards.length?'<div class="cards">'+pubCards.join('')+'</div>':'<div class="empty">이 기간에 발행된 게시물이 없습니다.</div>';
  // 경쟁사
  h+='<div class="panel" style="margin-top:16px"><h3>벤치마킹 경쟁사</h3><div>'+(client.competitors.length?client.competitors.map(x=>'<span class="tag">@'+esc(x)+'</span>').join(''):'<span class="muted">미설정</span>')+'</div></div>';
  // 저중요 패널은 최하단 — 연결 상황 압축 칩 + 오픈 준비 체크리스트 (docs/06-대시보드 레이아웃 원칙)
  h+=connChips(client);
  h+=setupPanel();
  return h;
}
function kpi(v,l,accent){return '<div class="kpi"><div class="v'+(accent?' accent':'')+'">'+v+'</div><div class="l">'+l+'</div></div>';}
// ── 리서치 탭 — research-brief.json이 있으면 항목별 시각화(통계·막대·표·타임라인·링크) ──
function researchView(client){
  const r=client.research;
  if(!r||!r.sections||!r.sections.length) return '<div class="empty">리서치 데이터가 없습니다.</div>';
  let h='<div class="sect-h"><h2>📊 '+esc(r.title||'브랜드 리서치')+'</h2><span class="muted">'+(r.updatedAt?('업데이트 '+String(r.updatedAt).slice(0,10)):'')+'</span></div>';
  if(r.note) h+='<div class="muted" style="margin:0 0 14px;line-height:1.6">'+esc(r.note)+'</div>';
  for(const s of r.sections){
    h+='<div class="panel"><h3>'+esc((s.icon?s.icon+' ':'')+s.title)+'</h3>';
    if(s.desc) h+='<div class="muted" style="margin:-4px 0 10px;font-size:12.5px;line-height:1.65">'+esc(s.desc)+'</div>';
    if(s.stats&&s.stats.length) h+='<div class="kpis">'+s.stats.map(x=>kpi(esc(x.v),esc(x.l),x.accent)).join('')+'</div>';
    if(s.bars&&s.bars.items&&s.bars.items.length){
      const mx=s.bars.max||Math.max.apply(null,s.bars.items.map(x=>x.value))||1;
      if(s.bars.title) h+='<div style="font-weight:700;font-size:12.5px;margin:4px 0 6px">'+esc(s.bars.title)+'</div>';
      h+=s.bars.items.map(x=>'<div class="rbarrow"><div class="rl" title="'+esc(x.label)+'">'+esc(x.label)+'</div><div class="rtrack"><div class="rfill" style="width:'+Math.max(2,Math.round(x.value/mx*100))+'%'+(x.color?';background:'+esc(x.color):'')+'"></div></div><div class="rv">'+esc(String(x.value))+(s.bars.unit?esc(s.bars.unit):'')+(x.note?' · '+esc(x.note):'')+'</div></div>').join('');
    }
    if(s.table&&s.table.head) h+='<div style="overflow-x:auto;margin-top:8px"><table><tr>'+s.table.head.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr>'+(s.table.rows||[]).map(row=>'<tr>'+row.map(cd=>'<td>'+esc(cd)+'</td>').join('')+'</tr>').join('')+'</table></div>';
    if(s.list&&s.list.length) h+='<ul style="margin:8px 0 2px;padding-left:18px;font-size:13px;line-height:1.75">'+s.list.map(x=>'<li><b>'+esc(x.t)+'</b>'+(x.d?' — <span style="color:#4a5266">'+esc(x.d)+'</span>':'')+'</li>').join('')+'</ul>';
    if(s.timeline&&s.timeline.length) h+='<div class="rtl" style="margin-top:10px">'+s.timeline.map(x=>'<div class="ri"><span class="rd">'+esc(x.date)+'</span> · '+esc(x.text)+(x.url?' <a href="'+esc(x.url)+'" target="_blank">확인↗</a>':'')+'</div>').join('')+'</div>';
    if(s.tags&&s.tags.length) h+='<div style="margin-top:8px">'+s.tags.map(x=>'<span class="tag">'+esc(x)+'</span>').join('')+'</div>';
    if(s.links&&s.links.length) h+='<div style="margin-top:10px">'+s.links.map(x=>'<a class="rlink" href="'+esc(x.url)+'" target="_blank">🔗 '+esc(x.label)+' ↗</a>'+(x.note?'<span class="muted" style="font-size:11.5px;margin-right:8px">'+esc(x.note)+'</span>':'')).join('')+'</div>';
    h+='</div>';
  }
  return h;
}
function renderClients(){
  // 헤더 로고는 제품명 "ALWAYS ON 콘텐츠 관제실" 고정 — 업체 식별은 클라이언트 칩으로 (docs/06-대시보드)
  document.getElementById('clients').innerHTML = DATA.clients.map((c,i)=>'<button class="cbtn'+(i===ci?' on':'')+'" onclick="setClient('+i+')">'+esc(c.name)+'</button>').join('');
  const c=DATA.clients[ci];
  if(c){
    document.getElementById('dashsub').textContent=(c.industry?c.industry+' · ':'')+'채널별 현황 · 발행/대기 · 반응도 · 기획안 피드백 · 5분 자동 새로고침';
    document.documentElement.style.setProperty('--brand', c.themeColor||'#2b6fff');
  }
}
function renderTabs(){
  const c=DATA.clients[ci];
  const tabs=[{key:'all',label:'전체',icon:'🏠',active:true}]
    .concat(DATA.channels.map(ch=>{const cc=c.channels.find(x=>x.key===ch.key);return {key:ch.key,label:ch.label,icon:ch.icon,active:cc&&cc.active};}))
    .concat(c.research?[{key:'research',label:'리서치',icon:'📊',active:true,noDot:true}]:[])
    .concat([{key:'guide',label:'지침',icon:'🧭',active:true,noDot:true}]);
  document.getElementById('tabs').innerHTML = tabs.map(t=>{
    // 수정요청 진행상황 아이콘 — 🛠 처리중 n건 / ✅ 전부 처리완료
    let req='';
    if(t.key!=='all'){
      const iss=channelIssues(t.key);
      const openN=iss.filter(x=>x.state!=='closed').length;
      req = openN ? '<span class="treq open" title="수정요청 처리중 '+openN+'건">🛠'+openN+'</span>'
          : (iss.length ? '<span class="treq done" title="수정요청 전부 처리완료">✅</span>' : '');
    }
    return '<button class="tab'+(t.key===ch?' on':'')+'" onclick="setCh(\\''+t.key+'\\')">'+t.icon+' '+t.label+(t.key!=='all'&&!t.noDot?'<span class="dot '+(t.active?'live':'off')+'"></span>':'')+req+'</button>';
  }).join('');
}
function renderView(){
  const c=DATA.clients[ci];
  document.getElementById('view').innerHTML = ch==='all'?overview(c):(ch==='guide'?guideView(c):(ch==='research'?researchView(c):channelDetail(c,c.channels.find(x=>x.key===ch))));
  document.getElementById('gen').textContent = ftime(DATA.generatedAt)+' (UTC)';
}
function setClient(i){ci=i;ch='all';renderClients();renderTabs();renderView();window.scrollTo(0,0);}
function setCh(k){ch=k;renderTabs();renderView();window.scrollTo(0,0);}
try {
  renderClients(); renderTabs(); renderView(); loadIssues();
} catch (e) {
  var v = document.getElementById('view');
  if (v) v.innerHTML = '<div style="padding:24px;line-height:1.7;color:#b91c1c">표시 중 오류: '
    + ((e && e.message) || e)
    + '<br><br><button onclick="location.reload(true)" style="padding:10px 16px;border-radius:8px;border:0;background:#2b6fff;color:#fff;font-size:15px">새로고침</button></div>';
}
</script>
</body>
</html>`;
}
