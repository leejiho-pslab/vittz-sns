/**
 * 네이버 검색광고 API 자격 증명 로더 — 표준 고정값 배선 (운영자 지시 2026-08-05)
 * 우선순위: 환경변수(NAVER_AD_* / 구명 NAVER_SEARCHAD_*) → data/naver-ad-credentials.json(고정값).
 * 모든 키워드 도구 스크립트가 이 로더를 쓴다 — 광고주센터 키를 재발급하면 JSON 한 파일만 갱신.
 */
import { readFileSync, existsSync } from 'node:fs';

export function loadNaverAdCreds() {
  let key = process.env.NAVER_AD_API_KEY || process.env.NAVER_SEARCHAD_API_KEY;
  let secret = process.env.NAVER_AD_SECRET || process.env.NAVER_SEARCHAD_API_SECRET;
  let customerId = process.env.NAVER_AD_CUSTOMER_ID || process.env.NAVER_SEARCHAD_CUSTOMER_ID;
  if (!key || !secret || !customerId) {
    const p = 'data/naver-ad-credentials.json';
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        key = key || j.apiKey;
        secret = secret || j.secret;
        customerId = customerId || String(j.customerId ?? '');
      } catch {
        /* JSON 오류면 호출부의 자격 증명 검증 단계에서 잡힌다 */
      }
    }
  }
  return { key, secret, customerId };
}
