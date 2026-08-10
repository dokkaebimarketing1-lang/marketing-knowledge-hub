// tests/verify/build-expectations.test.mjs
//
// 빌드 기대값 파생 모듈(scripts/lib/build-expectations.mjs) 계약 테스트.
//
// 핵심 계약:
//   1. 모든 개수(Article/DefinedTerm/리프/용어/클러스터/HTML)는 파일시스템에서
//      유도한다 — 고정 상수(134/12/100/29)가 없다.
//   2. 가시성: draft·deprecated 문서와 deprecated 용어는 개수·리다이렉트에서 제외된다.
//   3. 클러스터는 보이는 리프가 하나 이상일 때만 라우트를 가진다.
//   4. 리다이렉트는 활성 콘텐츠의 절대 redirectFrom에서만 생성된다.
//   5. 확장성: 유효한 문서/용어를 하나 추가하면 기대값이 고정 개수 실패 대신
//      함께 증가한다.
//
// 실행: node --test tests/verify/build-expectations.test.mjs
//       (npm run test:content 에 포함됨)

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'expectations', 'workspace');
const MODULE_URL = new URL('../../scripts/lib/build-expectations.mjs', import.meta.url);

let exp;

before(async () => {
  exp = await import(MODULE_URL.href);
});

/** fixture를 임시 디렉토리로 복사하고 선택적으로 추가/덮어쓴다. */
function makeWorkspace(extraFiles = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-expectations-'));
  fs.cpSync(FIXTURE, tmp, { recursive: true });
  for (const [rel, contents] of Object.entries(extraFiles)) {
    const p = path.join(tmp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }
  return tmp;
}

function validExtraDoc({ draft = '', status = 'active' } = {}) {
  return [
    '---',
    'title: 추가 글',
    'description: 확장성 검증용 추가 문서.',
    'contentKind: article',
    'categoryId: search',
    'queryClusterId: seo-foundations',
    'primaryQuery: 추가 글',
    'searchIntent: informational',
    'primaryQuestion: 추가 글은 무엇인가?',
    'shortAnswer: 추가 문서.',
    'primaryEntityId: seo',
    'authorId: null',
    'publishedAt: null',
    'updatedAt: 2026-08-09',
    'reviewedAt: null',
    'reviewStatus: human-review-needed',
    'sourceIds:',
    '  - seo-guide',
    'relatedIds: []',
    `status: ${status}`,
    ...(draft ? [`draft: ${draft}`] : []),
    'redirectFrom: []',
    '---',
    '본문.',
    '',
  ].join('\n');
}

function validExtraTerm({ status = 'active', redirectFrom = [] } = {}) {
  return [
    'term: "추가 용어"',
    'definition: "추가 검증용 용어."',
    'aliases: []',
    'categoryId: glossary-search',
    'sourceIds:',
    '  - seo-guide',
    'relatedIds: []',
    'updatedAt: 2026-08-09',
    'reviewedAt: null',
    'reviewStatus: human-review-needed',
    `status: ${status}`,
    ...(Array.isArray(redirectFrom) && redirectFrom.length > 0
      ? ['redirectFrom:', ...redirectFrom.map((f) => `  - ${f}`)]
      : ['redirectFrom: []']),
  ].join('\n');
}

// ── 1. 가시성 + 파생 개수 (fixture) ─────────────────────────────────────────

test('fixture: draft·deprecated는 개수·라우트·리다이렉트에서 제외된다', () => {
  const tmp = makeWorkspace();
  try {
    const e = exp.deriveExpectations(tmp);

    // 활성 비초안 문서(search, search/seo-basic) + 보이는 리프가 있는 클러스터 1
    assert.equal(e.articleCount, 3, `articleCount: ${JSON.stringify(e)}`);
    // 활성 용어(seo)만 — draft/deprecated term 제외
    assert.equal(e.definedTermCount, 1);
    assert.equal(e.eligiblePages, 4);
    assert.deepEqual(e.clusters.map((c) => c.id), ['seo-foundations']);
    // 클러스터 leafSlugs는 보이는(active non-draft) 리프만 유지
    assert.deepEqual(e.clusters[0].leafSlugs, ['search/seo-basic']);
    assert.deepEqual(e.leaves, ['/search/seo-basic/']);
    assert.deepEqual(e.glossary, ['/glossary/seo/']);
    // draft/deprecated 용어의 redirectFrom은 리다이렉트에 기여하지 않는다
    assert.deepEqual(e.redirects, {
      '/seo-legacy/': '/search/seo-basic/',
      '/search/seo-archive/': '/search/seo-basic/',
      '/glossary/seo-old/': '/glossary/seo/',
    });
    assert.deepEqual(e.redirectErrors, []);
    // 내부 일관성: htmlCount는 파생값들의 합 (고정 상수 아님)
    assert.equal(e.htmlCount, e.eligiblePages + e.tools.length + 3 + Object.keys(e.redirects).length);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fixture: 보이는 리프가 없는 클러스터는 라우트에서 제외된다', () => {
  // 유일한 활성 리프(seo-basic)를 초안으로 바꾸면 클러스터 전체가 사라진다
  const tmp = makeWorkspace({
    'docs/search/seo-basic.md': validExtraDoc({ draft: 'true' }),
  });
  try {
    const e = exp.deriveExpectations(tmp);
    assert.deepEqual(e.clusters, [], '보이는 리프가 없으면 클러스터 라우트가 없어야 한다');
    assert.deepEqual(e.leaves, [], '리프도 없다');
    assert.equal(e.articleCount, 1, '활성 비초안 문서(search)만 남는다');
    // 초안이 된 seo-basic의 redirectFrom은 사라지고, 용어 redirectFrom만 남는다
    assert.deepEqual(e.redirects, { '/glossary/seo-old/': '/glossary/seo/' });
    assert.equal(
      e.htmlCount,
      1 + e.definedTermCount + e.tools.length + 3 + Object.keys(e.redirects).length,
      'htmlCount는 남은 파생값들의 합이다'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 2. 확장성: 임시 추가 레코드가 고정 개수 대신 기대값을 늘린다 ────────────

test('scalability: 유효한 문서·용어를 하나씩 추가하면 파생 기대값이 함께 증가한다', () => {
  const baselineTmp = makeWorkspace();
  let baseline;
  try {
    baseline = exp.deriveExpectations(baselineTmp);
  } finally {
    fs.rmSync(baselineTmp, { recursive: true, force: true });
  }

  // 유효한 새 문서를 만들고 클러스터 leafSlugs에도 등록한다 (정상적인 새 리프)
  const tmp = makeWorkspace({
    'docs/search/extra-article.md': validExtraDoc(),
    'glossary/extra-term.yaml': validExtraTerm(),
    'registries/query-clusters/seo-foundations.json': JSON.stringify(
      {
        id: 'seo-foundations',
        categoryId: 'search',
        title: 'SEO 기초',
        description: 'SEO 기초 클러스터',
        order: 1,
        hubPath: '/search/clusters/seo-foundations/',
        primaryEntityId: 'seo',
        leafSlugs: ['search/seo-basic', 'search/extra-article'],
        status: 'active',
      },
      null,
      2
    ),
  });
  try {
    const e = exp.deriveExpectations(tmp);
    assert.equal(e.articleCount, baseline.articleCount + 1, '문서 추가 → Article +1 (고정 개수 실패 아님)');
    assert.equal(e.definedTermCount, baseline.definedTermCount + 1, '용어 추가 → DefinedTerm +1');
    assert.equal(e.eligiblePages, baseline.eligiblePages + 2);
    assert.equal(e.htmlCount, baseline.htmlCount + 2);
    assert.ok(e.leaves.includes('/search/extra-article/'), '새 리프가 리프 라우트에 포함된다');
    assert.deepEqual(
      e.clusters[0].leafSlugs,
      ['search/seo-basic', 'search/extra-article'],
      '클러스터가 새 활성 리프를 포함한다'
    );
    assert.ok(e.glossary.includes('/glossary/extra-term/'), '추가 용어가 용어 상세 라우트에 포함된다');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scalability: 추가한 문서가 초안/폐기면 기대값이 변하지 않는다 (고정 개수 불변 유지)', () => {
  const baselineTmp = makeWorkspace();
  let baseline;
  try {
    baseline = exp.deriveExpectations(baselineTmp);
  } finally {
    fs.rmSync(baselineTmp, { recursive: true, force: true });
  }

  const tmp = makeWorkspace({
    'docs/search/extra-draft.md': validExtraDoc({ draft: 'true' }),
    'docs/search/extra-deprecated.md': validExtraDoc({ status: 'deprecated', draft: 'true' }),
    'glossary/extra-deprecated-term.yaml': validExtraTerm({ status: 'deprecated' }),
  });
  try {
    const e = exp.deriveExpectations(tmp);
    assert.equal(e.articleCount, baseline.articleCount, '초안/폐기 문서는 개수에 영향 없음');
    assert.equal(e.definedTermCount, baseline.definedTermCount, '폐기 용어는 개수에 영향 없음');
    assert.equal(e.htmlCount, baseline.htmlCount);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
