#!/usr/bin/env node
/**
 * 비츠(VITTZ) 전용 카드 렌더러 — 주제별 디자인 폼 시스템 v3
 *
 * 운영자 지시(2026-08-03): 콘텐츠 "주제"에 따라 디자인 폼이 달라진다.
 *  - lifestyle(라이프스타일) : 실사 풀블리드 + 웜 라이트 — 현행 폼을 이 이름으로 고정 기억
 *  - product-pick(제품추천)  : 밝은 패널형 — 라이트 배경 + 제품 실사 패널 + 키 컬러 잉크
 *  - brand-story(브랜드이야기): 타이포형 — 키 컬러(딥 인디고) 풀 배경 + 타이포 중심 미니멀
 *  주제 선택: plan.json items[].designTheme (기본 lifestyle)
 *
 * 키 컬러: #110453 (비츠 로고 딥 인디고) — 모든 콘텐츠 강조색을 이 색으로 통일(운영자 지시, 앰버 폐기).
 *  어두운 사진 위 강조는 로고색 라이트 틴트(#A9A2FF)로 가독 확보.
 *
 * 텍스트 잘림 방지: fit() 오토핏 — 줄 길이에 따라 헤드라인·제목·제품명 크기 자동 축소.
 *
 * 슬라이드 스키마(plan.json items[].slides[]):
 *   { scene: 'cover|point|product|spec|split|cta|brand', label, title, body, big?, en?,
 *     productKey?, bgKey?, imgIndex?, textPos?('top'|'center'|'bottom') }
 *   실사가 없으면(개발 환경) 웜 페이퍼 폴백 — CI에서 자동으로 실사가 채워진다.
 *
 * 색·스크림·타이포·테마 오버라이드는 data/clients/<id>/design-tokens.json 이 단일 출처.
 * 사용: node scripts/render-vittz-cards.mjs --client vittz
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const clientId = arg('client', 'vittz');

function findChromium() {
  if (process.env.PSLAB_CHROMIUM && existsSync(process.env.PSLAB_CHROMIUM)) return process.env.PSLAB_CHROMIUM;
  if (existsSync('/opt/pw-browsers/chromium')) return '/opt/pw-browsers/chromium';
  for (const c of ['chromium', 'chromium-browser', 'google-chrome', 'chrome']) {
    try { return execFileSync('which', [c], { encoding: 'utf8' }).trim(); } catch { /* next */ }
  }
  return null;
}

const FONT_WEIGHTS = { ExtraBold: 800, Bold: 700, SemiBold: 600, Medium: 500, Regular: 400 };
function fontFaces() {
  const dir = join(ROOT, 'assets/fonts');
  return Object.entries(FONT_WEIGHTS).map(([w, weight]) => {
    const b64 = readFileSync(join(dir, `Pretendard-${w}.otf`)).toString('base64');
    return `@font-face{font-family:'Pretendard';font-weight:${weight};src:url(data:font/otf;base64,${b64}) format('opentype');}`;
  }).join('\n');
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── 디자인 토큰 (단일 출처: design-tokens.json) ─────────────────────
const TOKEN_DEFAULTS = {
  ink: '#FFFFFF', muted: 'rgba(255,255,255,.78)', accent: '#A9A2FF',
  scrimCover: 'linear-gradient(112deg, rgba(20,14,8,.78) 0%, rgba(20,14,8,.42) 46%, rgba(20,14,8,.08) 78%)',
  scrimText: 'linear-gradient(112deg, rgba(18,13,8,.86) 0%, rgba(18,13,8,.55) 55%, rgba(18,13,8,.22) 100%)',
  scrimBottom: 'linear-gradient(180deg, rgba(16,11,6,0) 34%, rgba(16,11,6,.55) 58%, rgba(16,11,6,.92) 100%)',
  chipBg: 'rgba(255,255,255,.14)', chipBorder: 'rgba(255,255,255,.34)',
  labelBg: 'rgba(255,255,255,.92)',
  fallbackBg: 'linear-gradient(160deg,#F6EFE3 0%,#EAD9BC 100%)', fallbackInk: '#2A241B',
  headline: 92, title: 76, body: 40, radius: 28,
};
function loadTokensRaw() {
  try { return JSON.parse(readFileSync(join(ROOT, 'data/clients', clientId, 'design-tokens.json'), 'utf8')); }
  catch { return {}; }
}
const RAW = loadTokensRaw();
const T = { ...TOKEN_DEFAULTS, ...(RAW.card || {}) };
// 브랜드 키 컬러 — vittz.co.kr 로고 딥 인디고. 운영자 지시(2026-08-03):
// 모든 콘텐츠의 키 컬러를 로고 색으로 통일(앰버 폐기). 어두운 사진 위 강조는
// 가독성을 위해 로고색 라이트 틴트(KEY_LIGHT)를 쓴다 — 같은 로고 색 계열.
const KEY = RAW.keyColor || '#110453';
const KEY_LIGHT = RAW.keyColorLight || '#A9A2FF';
// 주제별 폼 정의 — design-tokens.json themes 로 세부 오버라이드 가능
const THEMES = {
  lifestyle: { layout: 'photo' },
  'product-pick': { layout: 'panel', bg: '#F6F5FA', ink: KEY, sub: 'rgba(17,4,83,.60)', line: 'rgba(17,4,83,.16)' },
  'brand-story': { layout: 'typo', bg: KEY, ink: '#FFFFFF', sub: 'rgba(255,255,255,.72)', line: 'rgba(255,255,255,.24)' },
};
// 토큰의 테마 정의는 키별 딥 머지 — 통째 교체하면 잉크/배경 기본값이 날아간다
for (const [k, v] of Object.entries(RAW.themes || {})) THEMES[k] = { ...(THEMES[k] || {}), ...v };
function themeOf(item) {
  const k = item.designTheme || 'lifestyle';
  return { name: k, ...(THEMES[k] || THEMES.lifestyle) };
}

// ── 제품 카탈로그 (지침⑥: 콘텐츠 50% 이상 제품 이미지 → 구매 연결) ──
function loadProducts() {
  try {
    const spec = JSON.parse(readFileSync(join(ROOT, 'data/clients', clientId, 'product-images.json'), 'utf8'));
    const map = {};
    for (const p of spec.products || []) map[p.key] = p;
    return map;
  } catch { return {}; }
}
const PRODUCTS = loadProducts();
const PRODUCT_KEYS = Object.keys(PRODUCTS);
function productPhoto(key, idx = 0) {
  if (!key) return null;
  const f = join(ROOT, 'docs/products', clientId, idx === 0 ? `${key}.jpg` : `${key}-${idx + 1}.jpg`);
  if (!existsSync(f)) return null;
  try { return `data:image/jpeg;base64,${readFileSync(f).toString('base64')}`; } catch { return null; }
}
function cutCount(key) {
  let n = 0;
  while (existsSync(join(ROOT, 'docs/products', clientId, n === 0 ? `${key}.jpg` : `${key}-${n + 1}.jpg`))) n++;
  return n;
}
const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;
const br = (s) => esc(s).replace(/\n/g, '<br>');
const hl = (s) => br(s).replace(/\*([^*]+)\*/g, '<em>$1</em>');

// 텍스트 오토핏 — 가장 긴 줄이 기준 글자수를 넘으면 비례 축소 (운영자 지침: 텍스트 잘림 방지)
function fit(txt, base, perLine) {
  const clean = String(txt || '').replace(/\*/g, '');
  const L = Math.max(1, ...clean.split('\n').map((x) => x.length));
  if (L <= perLine) return base;
  return Math.max(Math.round((base * perLine) / L), Math.round(base * 0.6));
}

// 배경/패널 실사 선택 — 아이템 단위 컷 로테이션 (운영자 지침: 같은 컷 반복 금지)
function makeCutPicker() {
  const used = {};
  return (s) => {
    const key = [s.bgKey, s.productKey, PRODUCT_KEYS[0]].find((k) => k && cutCount(k) > 0);
    if (!key) return null;
    const total = cutCount(key);
    let idx;
    if (Number.isInteger(s.imgIndex)) idx = ((s.imgIndex % total) + total) % total;
    else { idx = (used[key] ?? 0) % total; used[key] = (used[key] ?? 0) + 1; }
    return productPhoto(key, idx);
  };
}

const labelChip = (t) => (t ? `<div class="klabel"><span>${esc(t)}</span></div>` : '');

function productTag(key) {
  const p = PRODUCTS[key];
  if (!p) return '';
  const photo = productPhoto(key);
  const thumb = photo ? `<img class="ptthumb" src="${photo}" alt=""/>` : '';
  return `<div class="ptag">${thumb}<div class="ptxt"><div class="ptname">${esc(p.name)}</div><div class="ptprice">${won(p.price)} · 프로필 링크에서 구매</div></div></div>`;
}

// 브랜드 클로징 카드 — 배경 사진 없이 로고만 (지침③). 로고는 키 컬러(실제 로고 색).
function brandInner(s) {
  return `<div class="mid brand">
    <div class="brandlogo">VITTZ</div>
    <div class="brandline"></div>
    <div class="brandtitle" style="font-size:${fit(s.title, 64, 14)}px">${hl(s.title || '')}</div>
    ${s.body ? `<div class="brandbody">${br(s.body)}</div>` : ''}
    <div class="brandfoot">비츠 딜리버리 · 배달과 설치를 한 번에</div>
  </div>`;
}

// ── 라이프스타일(photo) — 실사 풀블리드 (현행 폼, 이 이름으로 고정) ──
function scenePhoto(item, s, idx) {
  if (s.scene === 'cta' || s.scene === 'brand') return { noPhoto: true, inner: brandInner(s) };
  if (s.scene === 'cover' || idx === 0) {
    const title = s.title || item.headline || item.topic;
    return { scrim: T.scrimCover, inner: `<div class="mid cover">
      <div class="headline" style="font-size:${fit(title, T.headline, 11)}px">${hl(title)}</div>
      <div class="subline"><span class="rule"></span><span class="en">${esc(s.en || 'VITTZ LIGHTING')}</span></div>
      ${s.body ? `<div class="chip">${br(s.body)}</div>` : ''}
    </div>` };
  }
  if (s.scene === 'product') {
    const p = PRODUCTS[s.productKey] || {};
    const name = p.name || s.title || '';
    return { scrim: T.scrimBottom, inner: `<div class="mid pbot">
      ${labelChip(s.label || '비츠 제품')}
      <div class="pname" style="font-size:${fit(name, 56, 17)}px">${esc(name)}${p.price ? `<span class="pprice-s">${won(p.price)}</span>` : ''}</div>
      ${s.body ? `<div class="body pbody">${br(s.body)}</div>` : ''}
      <div class="buyline">프로필 링크에서 실물 보기 →</div>
    </div>` };
  }
  if (s.scene === 'spec') {
    return { scrim: T.scrimText, inner: `<div class="mid">
      ${labelChip(s.label)}
      ${s.big ? `<div class="big">${hl(s.big)}</div>` : ''}
      <div class="title" style="font-size:${fit(s.title, T.title, 13)}px">${hl(s.title || '')}</div>
      ${s.body ? `<div class="body">${br(s.body)}</div>` : ''}
      ${s.productKey ? productTag(s.productKey) : ''}
    </div>` };
  }
  if (s.scene === 'split') {
    return { scrim: T.scrimText, inner: `<div class="mid">
      ${labelChip(s.label)}
      ${s.title ? `<div class="title" style="margin-bottom:44px;font-size:${fit(s.title, T.title, 13)}px">${hl(s.title)}</div>` : ''}
      <div class="split">
        <div class="half"><div class="halfLab">${esc(s.beforeLabel || '지금')}</div><div class="halfTxt">${br(s.before || '')}</div></div>
        <div class="half after"><div class="halfLab">${esc(s.afterLabel || '바꾼 뒤')}</div><div class="halfTxt">${br(s.after || '')}</div></div>
      </div>
      ${s.body ? `<div class="body">${br(s.body)}</div>` : ''}
    </div>` };
  }
  return { scrim: T.scrimText, inner: `<div class="mid">
    ${labelChip(s.label)}
    <div class="title" style="font-size:${fit(s.title, T.title, 13)}px">${hl(s.title || '')}</div>
    ${s.body ? `<div class="body">${br(s.body)}</div>` : ''}
    ${s.productKey ? productTag(s.productKey) : ''}
  </div>` };
}

// ── 제품추천(panel) — 밝은 배경 + 제품 실사 패널 + 키 컬러 잉크 ──
function scenePanel(item, s, idx, pickCut) {
  if (s.scene === 'cta' || s.scene === 'brand') return { noPhoto: true, inner: brandInner(s) };
  const photo = pickCut(s);
  const panel = photo ? `<div class="panelimg"><img src="${photo}" alt=""/></div>` : '';
  if (s.scene === 'cover' || idx === 0) {
    const title = s.title || item.headline || item.topic;
    return { flat: true, inner: `<div class="mid pcov">
      <div class="headline" style="font-size:${fit(title, 84, 11)}px">${hl(title)}</div>
      <div class="subline"><span class="rule"></span><span class="en">${esc(s.en || 'VITTZ PICK')}</span></div>
      ${panel ? panel.replace('panelimg', 'panelimg covpanel') : ''}
      ${s.body ? `<div class="chip">${br(s.body)}</div>` : ''}
    </div>` };
  }
  if (s.scene === 'product') {
    const p = PRODUCTS[s.productKey] || {};
    const name = p.name || s.title || '';
    return { flat: true, inner: `<div class="mid pcov">
      ${s.num ? `<div class="num">${esc(s.num)}</div>` : labelChip(s.label)}
      ${panel}
      <div class="pname" style="margin-top:40px;font-size:${fit(name, 52, 18)}px">${esc(name)}${p.price ? `<span class="pprice-s">${won(p.price)}</span>` : ''}</div>
      ${s.body ? `<div class="body" style="margin-top:22px">${br(s.body)}</div>` : ''}
    </div>` };
  }
  return { flat: true, inner: `<div class="mid pcov">
    ${labelChip(s.label)}
    ${s.big ? `<div class="big">${hl(s.big)}</div>` : ''}
    <div class="title" style="font-size:${fit(s.title, 72, 13)}px">${hl(s.title || '')}</div>
    ${s.body ? `<div class="body">${br(s.body)}</div>` : ''}
  </div>` };
}

// ── 브랜드이야기(typo) — 키 컬러 풀 배경 + 타이포 중심 미니멀 ──
function sceneTypo(item, s, idx, pickCut) {
  if (s.scene === 'cta' || s.scene === 'brand') return { noPhoto: true, inner: brandInner(s) };
  const photo = (s.bgKey || s.productKey) ? pickCut(s) : null;
  const inset = photo ? `<div class="wideimg"><img src="${photo}" alt=""/></div>` : '';
  if (s.scene === 'cover' || idx === 0) {
    const title = s.title || item.headline || item.topic;
    return { flat: true, inner: `<div class="mid tcov">
      <div class="headline" style="font-size:${fit(title, 88, 11)}px">${hl(title)}</div>
      <div class="subline"><span class="rule"></span><span class="en">${esc(s.en || 'VITTZ STORY')}</span></div>
      ${s.body ? `<div class="body" style="margin-top:44px">${br(s.body)}</div>` : ''}
    </div>` };
  }
  return { flat: true, inner: `<div class="mid tcov">
    ${labelChip(s.label)}
    ${s.big ? `<div class="big">${hl(s.big)}</div>` : ''}
    <div class="title" style="font-size:${fit(s.title, 72, 13)}px">${hl(s.title || '')}</div>
    ${s.body ? `<div class="body">${br(s.body)}</div>` : ''}
    ${inset}
  </div>` };
}

// ── 공통 프레임 — 좌상단 워드마크만 (지침⑤) ────────────────────────
function frame(TH, s, out, pickCut, pos) {
  let bgLayer, logoCls = '';
  if (out.noPhoto) {
    bgLayer = `<div class="bg brandbg"></div>`;
  } else if (TH.layout === 'photo') {
    const photo = pickCut(s);
    bgLayer = photo
      ? `<img class="bg" src="${photo}" alt=""/><div class="scrim" style="background:${out.scrim}"></div>`
      : `<div class="bg fb"></div>`;
    if (!photo) logoCls = ' darklogo';
  } else {
    bgLayer = `<div class="bg" style="background:${TH.bg}"></div>`;
    if (TH.layout === 'panel') logoCls = ' darklogo';
  }
  return `<div class="card">
    ${bgLayer}
    <div class="layer">
      ${out.noPhoto ? '' : `<div class="top"><div class="logo${logoCls}">VITTZ</div></div>`}
      <div class="midwrap"${pos ? ` style="justify-content:${pos}"` : ''}>${out.inner}</div>
    </div>
  </div>`;
}

function pageHTML(item, s, idx, faces, pickCut) {
  const TH = themeOf(item);
  const out = TH.layout === 'panel' ? scenePanel(item, s, idx, pickCut)
    : TH.layout === 'typo' ? sceneTypo(item, s, idx, pickCut)
    : scenePhoto(item, s, idx);
  const pos = { top: 'flex-start', center: 'center', bottom: 'flex-end' }[s.textPos] || null;
  // 테마별 전경색 — photo: 화이트/앰버, panel: 키 컬러 잉크, typo: 화이트/앰버
  const ink = TH.ink || T.ink;
  const sub = TH.sub || T.muted;
  const acc = TH.layout === 'panel' ? KEY : T.accent;
  const line = TH.line || 'rgba(255,255,255,.75)';
  const shadow = TH.layout === 'photo' ? 'text-shadow:0 4px 26px rgba(0,0,0,.42)' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${faces}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1350px}
body{font-family:'Pretendard';color:${ink}}
.card{width:1080px;height:1350px;position:relative;overflow:hidden}
.bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.bg.fb{background:${T.fallbackBg}}
.scrim{position:absolute;inset:0}
.layer{position:absolute;inset:0;padding:84px 88px;display:flex;flex-direction:column}
.top{display:flex;justify-content:space-between;align-items:baseline}
.logo{font-weight:800;font-size:33px;letter-spacing:.4em;${TH.layout === 'photo' ? 'text-shadow:0 2px 14px rgba(0,0,0,.35)' : ''}}
.logo.darklogo{color:${KEY};text-shadow:none}
.midwrap{display:contents}
.mid{flex:1;display:flex;flex-direction:column;justify-content:flex-end;padding-bottom:44px;min-width:0}
${pos ? `.mid{justify-content:${pos} !important}` : ''}
.cover{justify-content:center;padding-bottom:0}
.pcov{justify-content:center;padding-bottom:0}
.tcov{justify-content:center;padding-bottom:0}
.headline{font-weight:800;line-height:1.24;letter-spacing:-.028em;text-wrap:balance;overflow-wrap:break-word;${shadow}}
.headline em,.title em,.big em{font-style:normal;color:${TH.layout === 'panel' ? KEY : T.accent}}
.subline{display:flex;align-items:center;gap:26px;margin-top:44px}
.rule{display:block;width:96px;height:2px;background:${line}}
.en{font-weight:600;font-size:27px;letter-spacing:.34em;color:${sub}}
.chip{margin-top:54px;align-self:flex-start;background:${TH.layout === 'photo' ? T.chipBg : 'rgba(17,4,83,.06)'};border:1.5px solid ${TH.layout === 'photo' ? T.chipBorder : 'rgba(17,4,83,.2)'};border-radius:999px;padding:21px 36px;font-size:34px;font-weight:600;line-height:1.45;max-width:100%;backdrop-filter:blur(6px)}
.klabel{margin-bottom:32px}
.klabel span{display:inline-block;background:${TH.layout === 'typo' ? 'rgba(255,255,255,.92)' : T.labelBg};color:${KEY};font-weight:700;font-size:28px;letter-spacing:.14em;padding:14px 26px;border-radius:12px}
.num{font-weight:800;font-size:120px;line-height:1;color:${KEY};opacity:.92;margin-bottom:28px}
.title{font-weight:800;line-height:1.28;letter-spacing:-.024em;text-wrap:balance;overflow-wrap:break-word;${shadow}}
.body{font-weight:500;font-size:${T.body}px;line-height:1.64;color:${sub};margin-top:36px;max-width:96%;overflow-wrap:break-word}
.big{font-weight:800;font-size:150px;letter-spacing:-.03em;color:${TH.layout === 'panel' ? KEY : T.accent};line-height:1;margin-bottom:24px}
.pbot{justify-content:flex-end}
.pname{font-weight:800;letter-spacing:-.02em;overflow-wrap:break-word;${shadow}}
.pprice-s{font-weight:600;font-size:30px;color:${sub};margin-left:22px;letter-spacing:0;white-space:nowrap}
.pbody{margin-top:26px}
.buyline{margin-top:30px;font-size:28px;font-weight:600;color:${sub};letter-spacing:.02em}
.panelimg{margin-top:44px;border-radius:${T.radius}px;overflow:hidden;background:#FFFFFF;box-shadow:0 26px 70px rgba(17,4,83,.14);max-height:640px;width:100%}
.panelimg img{width:100%;height:640px;object-fit:cover;display:block}
.wideimg{margin-top:56px;border-radius:${T.radius}px;overflow:hidden;width:100%;box-shadow:0 26px 70px rgba(0,0,0,.32)}
.wideimg img{width:100%;height:520px;object-fit:cover;display:block}
.covpanel{max-height:540px}.covpanel img{height:540px}
.brandbg{background:#F8F7FC}
.brand{align-items:center;text-align:center;justify-content:center !important;color:#2A241B}
.brandlogo{font-weight:800;font-size:96px;letter-spacing:.42em;color:${KEY};text-indent:.42em}
.brandline{width:120px;height:3px;background:${KEY};margin:44px 0 52px}
.brandtitle{font-weight:800;line-height:1.34;letter-spacing:-.02em;color:#2A241B;text-wrap:balance;overflow-wrap:break-word}
.brandtitle em{font-style:normal;color:${KEY}}
.brandbody{font-weight:500;font-size:36px;line-height:1.66;color:#6E6A85;margin-top:34px;max-width:92%;overflow-wrap:break-word}
.brandfoot{margin-top:64px;font-size:27px;font-weight:600;letter-spacing:.08em;color:#8B87A6}
.ptag{margin-top:48px;display:flex;align-items:center;gap:24px;background:${TH.layout === 'photo' ? 'rgba(0,0,0,.34)' : 'rgba(17,4,83,.06)'};border:1.5px solid ${TH.layout === 'photo' ? T.chipBorder : 'rgba(17,4,83,.2)'};border-radius:22px;padding:20px 26px;backdrop-filter:blur(8px);align-self:flex-start;max-width:100%}
.ptthumb{width:116px;height:116px;border-radius:16px;object-fit:cover;background:#FFF;flex:none}
.ptname{font-weight:700;font-size:30px;line-height:1.35;overflow-wrap:break-word}
.ptprice{font-weight:600;font-size:27px;color:${TH.layout === 'photo' ? T.accent : KEY};margin-top:6px}
.split{display:flex;gap:22px}
.half{flex:1;border-radius:${T.radius}px;padding:50px 42px;min-height:400px;display:flex;flex-direction:column;gap:20px;background:rgba(10,8,5,.55);border:1.5px solid rgba(255,255,255,.18);backdrop-filter:blur(8px)}
.half.after{background:rgba(58,40,16,.62);border-color:${T.chipBorder}}
.halfLab{font-weight:700;font-size:27px;letter-spacing:.2em;color:${sub}}
.halfTxt{font-weight:600;font-size:36px;line-height:1.55;overflow-wrap:break-word}
</style></head><body>${frame(themeOf(item), s, out, pickCut, pos)}</body></html>`;
}

// ── 실행 ───────────────────────────────────────────────────────────
const chromium = findChromium();
if (!chromium) { console.log('Chromium 없음 — 렌더 건너뜀'); process.exit(0); }
const planPath = join(ROOT, 'data/clients', clientId, 'plan.json');
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const outDir = join(ROOT, 'docs/cards', clientId);
mkdirSync(outDir, { recursive: true });
const faces = fontFaces();
const tmp = join(outDir, '_tmp.html');

let n = 0;
for (const item of plan.items) {
  if (!Array.isArray(item.slides) || !item.slides.length) continue;
  const files = [];
  const pickCut = makeCutPicker();
  item.slides.forEach((s, idx) => {
    const file = `${item.id}-${idx + 1}.png`;
    writeFileSync(tmp, pageHTML(item, s, idx, faces, pickCut));
    execFileSync(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--window-size=1080,1350',
      `--screenshot=${join(outDir, file)}`, `file://${tmp}`,
    ], { stdio: 'pipe' });
    files.push(`cards/${clientId}/${file}`);
    n++;
  });
  item.slideImages = files;
  item.cardImage = files[0];
}
try { rmSync(tmp); } catch { /* ignore */ }
writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
console.log(`비츠 주제별 디자인 카드 ${n}장 렌더 완료 → docs/cards/${clientId}/`);
