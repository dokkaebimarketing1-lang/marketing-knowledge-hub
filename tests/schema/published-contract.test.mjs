// tests/schema/published-contract.test.mjs
//
// 게시 지식 계약(Published Knowledge Contract) — strict Zod 스키마 계약 테스트.
//
// 대상 API: `src/schemas/content-contract.ts`의 named export
//   docsKnowledgeContract   docs 지식 메타 필수 계약 (+ superRefine)
//   glossaryContract        glossary 지식 메타 필수 계약 (+ superRefine)
//   SEARCH_INTENTS          ['informational','navigational','transactional','commercial']
//
// 계약 요약:
//   1. docs 필수 필드: contentKind, categoryId, queryClusterId, primaryQuery, searchIntent,
//      primaryQuestion, shortAnswer, primaryEntityId, authorId(nullable), publishedAt(nullable),
//      updatedAt, reviewedAt(nullable), reviewStatus, sourceIds, relatedIds, status, redirectFrom
//      (base: categoryId/primaryEntityId nullable, sourceIds는 빈 배열 허용)
//   2. superRefine:
//        - article/categoryHub → categoryId·primaryEntityId 필수, sourceIds min 1
//        - article             → queryClusterId가 비어 있으면 안 됨 (null 금지)
//        - categoryHub/utility → queryClusterId가 반드시 null
//        - utility             → categoryId/primaryEntityId null·sourceIds 빈 배열 허용
//        - reviewed            → authorId/publishedAt/reviewedAt 필수
//   3. glossary: 신규 지식 필드 전부 필수, sourceIds min 1,
//      reviewStatus=reviewed → reviewedAt 필수
//
// 실행: node --test tests/schema/published-contract.test.mjs
//   (Node 24 네이티브 TypeScript type-stripping으로 .ts 계약 모듈을 직접 import)

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Node 24: .ts 파일은 type-stripping으로 직접 import 가능.
const CONTRACT_URL = new URL('../../src/schemas/content-contract.ts', import.meta.url);

let contract;
test('contract module: src/schemas/content-contract.ts는 zod 스키마를 export해야 한다', async () => {
  contract = await import(CONTRACT_URL.href);
  assert.equal(typeof contract.docsKnowledgeContract?.safeParse, 'function', 'docsKnowledgeContract export');
  assert.equal(typeof contract.glossaryContract?.safeParse, 'function', 'glossaryContract export');
});

// ── helpers ─────────────────────────────────────────────────────────────────

function requireContract() {
  assert.ok(contract, 'contract module must load first');
  return contract;
}

/** 실제 src/content/docs/* 에 존재하는 형태와 동일한 유효한 article fixture. */
function validArticle(overrides = {}) {
  return {
    contentKind: 'article',
    categoryId: 'search',
    queryClusterId: 'seo-foundations',
    primaryQuery: 'SEO 기초',
    searchIntent: 'informational',
    primaryQuestion: 'SEO 기초(온페이지·오프페이지·기술적 SEO)는 무엇인가?',
    shortAnswer: '검색 엔진 상위 노출을 위한 SEO 기본 개념 정리.',
    primaryEntityId: 'seo',
    authorId: null,
    publishedAt: null,
    updatedAt: '2026-08-07',
    reviewedAt: null,
    reviewStatus: 'human-review-needed',
    sourceIds: ['naver-search-advisor-seo-guide', 'google-ai-features-doc'],
    relatedIds: ['search/index', 'search/keyword-ads'],
    status: 'active',
    redirectFrom: [],
    ...overrides,
  };
}

/** 실제 categoryHub(index) 문서 형태. */
function validHub(overrides = {}) {
  return validArticle({
    contentKind: 'categoryHub',
    queryClusterId: null,
    categoryId: 'search',
    primaryQuery: '검색 마케팅 전략',
    ...overrides,
  });
}

/** 유효한 glossary fixture. */
function validGlossary(overrides = {}) {
  return {
    term: 'ROAS',
    definition: '광고비 대비 발생한 매출의 비율(Return On Ad Spend).',
    aliases: ['광고 투자 수익률'],
    categoryId: 'glossary-ad-performance',
    sourceIds: ['google-ads-optimization-guide'],
    relatedIds: ['roi', 'mer'],
    updatedAt: '2026-08-08',
    reviewedAt: null,
    reviewStatus: 'human-review-needed',
    status: 'active',
    redirectFrom: [],
    ...overrides,
  };
}

function issuePaths(result) {
  return (result.error?.issues ?? []).map((i) => (i.path ?? []).join('.'));
}

// ── docs: 유효 케이스 ────────────────────────────────────────────────────────

test('docs: 유효한 article이 통과한다', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(validArticle());
  assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
});

test('docs: 유효한 categoryHub(queryClusterId null)가 통과한다', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(validHub());
  assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
});

test('docs: 유효한 utility가 통과한다 (categoryId/entity null, sources 빈 배열 허용)', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(
    validArticle({
      contentKind: 'utility',
      queryClusterId: null,
      categoryId: null,
      primaryEntityId: null,
      sourceIds: [],
    }),
  );
  assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
});

test('docs: searchIntent의 4개 enum 값이 모두 허용된다', () => {
  const { docsKnowledgeContract, SEARCH_INTENTS } = requireContract();
  assert.deepEqual(SEARCH_INTENTS, ['informational', 'navigational', 'transactional', 'commercial']);
  for (const intent of SEARCH_INTENTS) {
    const result = docsKnowledgeContract.safeParse(validArticle({ searchIntent: intent }));
    assert.equal(result.success, true, `searchIntent "${intent}"는 허용되어야 한다: ${JSON.stringify(result.error?.issues)}`);
  }
});

test('docs: reviewed 상태에는 authorId/publishedAt/reviewedAt가 모두 필수다', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(
    validArticle({
      reviewStatus: 'reviewed',
      authorId: 'author-kim',
      publishedAt: '2026-08-01',
      reviewedAt: '2026-08-05',
    }),
  );
  assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
});

// ── docs: malformed 케이스 ───────────────────────────────────────────────────

test('docs: sourceIds가 비어 있으면 실패한다 (missing-source)', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(validArticle({ sourceIds: [] }));
  assert.equal(result.success, false, 'article sourceIds min 1');
  assert.ok(issuePaths(result).includes('sourceIds'), `sourceIds 경로 지목: ${issuePaths(result)}`);
});

test('docs: article이 categoryId null이면 실패한다', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(validArticle({ categoryId: null }));
  assert.equal(result.success, false, 'article은 categoryId가 비어 있으면 안 됨');
  assert.ok(issuePaths(result).includes('categoryId'), `categoryId 경로 지목: ${issuePaths(result)}`);
});

test('docs: article이 primaryEntityId null이면 실패한다', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(validArticle({ primaryEntityId: null }));
  assert.equal(result.success, false, 'article은 primaryEntityId가 비어 있으면 안 됨');
  assert.ok(issuePaths(result).includes('primaryEntityId'), `primaryEntityId 경로 지목: ${issuePaths(result)}`);
});

test('docs: searchIntent가 없으면 실패한다 (missing-intent)', () => {
  const { docsKnowledgeContract } = requireContract();
  const data = validArticle();
  delete data.searchIntent;
  const result = docsKnowledgeContract.safeParse(data);
  assert.equal(result.success, false, 'searchIntent 필수');
  assert.ok(issuePaths(result).includes('searchIntent'), `searchIntent 경로 지목: ${issuePaths(result)}`);
});

test('docs: article이 queryClusterId null이면 실패한다 (article-null-cluster)', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(validArticle({ queryClusterId: null }));
  assert.equal(result.success, false, 'article은 queryClusterId가 비어 있으면 안 됨');
  assert.ok(issuePaths(result).includes('queryClusterId'), `queryClusterId 경로 지목: ${issuePaths(result)}`);
});

test('docs: categoryHub가 queryClusterId 문자열이면 실패한다 (hub-string-cluster)', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(validHub({ queryClusterId: 'seo-foundations' }));
  assert.equal(result.success, false, 'categoryHub는 queryClusterId가 null이어야 함');
  assert.ok(issuePaths(result).includes('queryClusterId'), `queryClusterId 경로 지목: ${issuePaths(result)}`);
});

test('docs: utility가 queryClusterId 문자열이면 실패한다 (invalid utility-cluster)', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(
    validArticle({
      contentKind: 'utility',
      queryClusterId: 'seo-foundations',
      categoryId: null,
      primaryEntityId: null,
      sourceIds: [],
    }),
  );
  assert.equal(result.success, false, 'utility는 queryClusterId가 null이어야 함');
  assert.ok(issuePaths(result).includes('queryClusterId'), `queryClusterId 경로 지목: ${issuePaths(result)}`);
});

test('docs: reviewStatus=reviewed인데 authorId가 null이면 실패한다 (reviewed-null-author)', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(
    validArticle({ reviewStatus: 'reviewed', authorId: null, publishedAt: null, reviewedAt: null }),
  );
  assert.equal(result.success, false, 'reviewed는 authorId/publishedAt/reviewedAt 필요');
  const paths = issuePaths(result);
  for (const p of ['authorId', 'publishedAt', 'reviewedAt']) {
    assert.ok(paths.includes(p), `${p} 경로 지목: ${paths}`);
  }
});

// ── content.config 연동: extend로 추가 필드를 붙여도 refine이 유지된다 ──────

test('docs: extend({ tags, audience }) 후에도 superRefine이 동작한다', async () => {
  const { docsKnowledgeContract } = requireContract();
  const { z } = await import('zod');
  const extended = docsKnowledgeContract.extend({
    tags: z.array(z.string()).default([]),
    audience: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
  });
  // extend된 계약은 유효한 article + tags/audience를 받는다
  const ok = extended.safeParse(validArticle({ tags: ['SEO'], audience: 'beginner' }));
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues, null, 2));
  // extend 후에도 refine이 살아 있어야 한다 (article-null-cluster)
  const bad = extended.safeParse(validArticle({ queryClusterId: null }));
  assert.equal(bad.success, false, 'extend 후에도 refine 유지');
  assert.ok(issuePaths(bad).includes('queryClusterId'));
  // extend 후에도 article/categoryHub 강화 규칙이 유지되어야 한다 (null categoryId)
  const badCategory = extended.safeParse(validArticle({ categoryId: null }));
  assert.equal(badCategory.success, false, 'extend 후에도 categoryId 강화 규칙 유지');
  assert.ok(issuePaths(badCategory).includes('categoryId'));
});

// ── glossary ─────────────────────────────────────────────────────────────────

test('glossary: 유효한 항목이 통과한다', () => {
  const { glossaryContract } = requireContract();
  const result = glossaryContract.safeParse(validGlossary());
  assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
});

test('glossary: sourceIds min 1 — 비어 있으면 실패한다', () => {
  const { glossaryContract } = requireContract();
  const result = glossaryContract.safeParse(validGlossary({ sourceIds: [] }));
  assert.equal(result.success, false, 'glossary sourceIds min 1');
  assert.ok(issuePaths(result).includes('sourceIds'), `sourceIds 경로 지목: ${issuePaths(result)}`);
});

test('glossary: categoryId가 없으면 실패한다', () => {
  const { glossaryContract } = requireContract();
  const data = validGlossary();
  delete data.categoryId;
  const result = glossaryContract.safeParse(data);
  assert.equal(result.success, false, 'glossary categoryId 필수');
  assert.ok(issuePaths(result).includes('categoryId'), `categoryId 경로 지목: ${issuePaths(result)}`);
});

test('glossary: reviewStatus=reviewed인데 reviewedAt이 null이면 실패한다', () => {
  const { glossaryContract } = requireContract();
  const result = glossaryContract.safeParse(
    validGlossary({ reviewStatus: 'reviewed', reviewedAt: null }),
  );
  assert.equal(result.success, false, 'glossary reviewed는 reviewedAt 필요');
  assert.ok(issuePaths(result).includes('reviewedAt'), `reviewedAt 경로 지목: ${issuePaths(result)}`);
});

test('glossary: reviewStatus=reviewed + reviewedAt 지정이면 통과한다', () => {
  const { glossaryContract } = requireContract();
  const result = glossaryContract.safeParse(
    validGlossary({ reviewStatus: 'reviewed', reviewedAt: '2026-08-05' }),
  );
  assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
});

// ── 레거시 필드 제거 계약 ────────────────────────────────────────────────────

test('계약: 레거시 필드(category/summary/related/isTool/toolType)는 정의되어서는 안 된다', () => {
  const { docsKnowledgeContract, glossaryContract } = requireContract();
  const shape = (s) => Object.keys(s.shape ?? {});
  for (const legacy of ['category', 'summary', 'related', 'isTool', 'toolType']) {
    assert.ok(!shape(docsKnowledgeContract).includes(legacy), `docs에서 legacy "${legacy}" 제거`);
    assert.ok(!shape(glossaryContract).includes(legacy), `glossary에서 legacy "${legacy}" 제거`);
  }
});

// ── strict: 미선언 필드 거부 ─────────────────────────────────────────────────

function unknownKeys(result) {
  return (result.error?.issues ?? [])
    .filter((i) => i.code === 'unrecognized_keys')
    .flatMap((i) => i.keys ?? []);
}

test('docs: 미선언 커스텀 필드(legacyField)는 strict로 거부된다', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(validArticle({ legacyField: 'x' }));
  assert.equal(result.success, false, '미선언 필드는 거부되어야 함');
  assert.ok(unknownKeys(result).includes('legacyField'), `legacyField 지목: ${JSON.stringify(result.error?.issues)}`);
});

test('docs: strict여도 유효한 article 필드는 전부 통과한다', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(validArticle());
  assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
});

test('glossary: 미선언 커스텀 필드(legacyField)는 strict로 거부된다', () => {
  const { glossaryContract } = requireContract();
  const result = glossaryContract.safeParse(validGlossary({ legacyField: 'x' }));
  assert.equal(result.success, false, '미선언 필드는 거부되어야 함');
  assert.ok(unknownKeys(result).includes('legacyField'), `legacyField 지목: ${JSON.stringify(result.error?.issues)}`);
});

// ── 외부 URL: 절대 http(s)만 허용 ────────────────────────────────────────────

test('URL: 절대 https/http는 통과한다', () => {
  const { externalUrlSchema } = requireContract();
  for (const url of ['https://example.com/a?b=1', 'https://searchadvisor.naver.com/guide', 'http://example.com']) {
    assert.equal(externalUrlSchema.safeParse(url).success, true, `${url}는 허용되어야 함`);
  }
});

test('URL: ftp/mailto/상대경로는 거부된다', () => {
  const { externalUrlSchema } = requireContract();
  for (const url of ['ftp://example.com/file', 'mailto:foo@example.com', 'not-a-url', '/relative/path']) {
    const result = externalUrlSchema.safeParse(url);
    assert.equal(result.success, false, `${url}는 거부되어야 함`);
  }
});

// ── status=deprecated → draft=true ───────────────────────────────────────────

test('docs: status=deprecated인데 draft=true가 아니면 실패한다', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(validArticle({ status: 'deprecated' }));
  assert.equal(result.success, false, 'deprecated는 draft=true 필요');
  assert.ok(issuePaths(result).includes('draft'), `draft 경로 지목: ${issuePaths(result)}`);
});

test('docs: status=deprecated + draft=true는 통과한다', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(
    validArticle({ status: 'deprecated', draft: true }),
  );
  assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
});

test('docs: status=active는 draft 기본값 false로 통과한다 (현행 문서 보존)', () => {
  const { docsKnowledgeContract } = requireContract();
  const result = docsKnowledgeContract.safeParse(validArticle());
  assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
  assert.equal(result.data.draft, false, 'draft 기본값 false');
});
