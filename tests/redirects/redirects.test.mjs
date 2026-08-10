// tests/redirects/redirects.test.mjs
//
// redirectFrom 리다이렉트 파생 계약 테스트.
//
// 대상 API: `scripts/lib/build-expectations.mjs`
//   normalizeRedirectFrom(raw) -> string | undefined   절대 경로 표준화
//   buildRedirectMap(entries, existingRoutes) -> { redirects, errors }
//
// 계약:
//   1. 활성 콘텐츠의 고유 절대 redirectFrom 경로만 리다이렉트가 된다.
//   2. 거부 규칙: 비절대/빈/루트 경로, 자기 자신(from === to),
//      기존 라우트와의 충돌, 서로 다른 대상으로의 중복.
//   3. 같은 from → 같은 to의 중복 선언은 허용(멱등).
//
// 실행: node --test tests/redirects/redirects.test.mjs
//       (npm run test:content 에 포함됨)

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const MODULE_URL = new URL('../../scripts/lib/build-expectations.mjs', import.meta.url);

let exp;

before(async () => {
  exp = await import(MODULE_URL.href);
});

// ── normalizeRedirectFrom ────────────────────────────────────────────────────

test('normalizeRedirectFrom: 절대 경로를 후행 슬래시 표준형으로 만든다', () => {
  assert.equal(exp.normalizeRedirectFrom('/old/path/'), '/old/path/');
  assert.equal(exp.normalizeRedirectFrom('/old/path'), '/old/path/');
  assert.equal(exp.normalizeRedirectFrom('  /old/path/  '), '/old/path/');
  assert.equal(exp.normalizeRedirectFrom('/a//b/'), '/a/b/');
  assert.equal(exp.normalizeRedirectFrom('/a?q=1#x'), '/a/');
});

test('normalizeRedirectFrom: 비절대·빈·루트 경로는 undefined', () => {
  assert.equal(exp.normalizeRedirectFrom(''), undefined);
  assert.equal(exp.normalizeRedirectFrom('   '), undefined);
  assert.equal(exp.normalizeRedirectFrom('old/path'), undefined);
  assert.equal(exp.normalizeRedirectFrom('/'), undefined);
  assert.equal(exp.normalizeRedirectFrom(undefined), undefined);
  assert.equal(exp.normalizeRedirectFrom(null), undefined);
});

// ── buildRedirectMap ────────────────────────────────────────────────────────

const EXISTING = new Set(['/', '/search/', '/glossary/', '/search/seo-basic/']);

function entry(id, redirectFrom, to) {
  return { id, kind: 'doc', to, redirectFrom };
}

test('buildRedirectMap: 활성 콘텐츠의 고유 절대 redirectFrom만 리다이렉트가 된다', () => {
  const { redirects, errors } = exp.buildRedirectMap(
    [
      entry('search/seo-basic', ['/seo-legacy/', '/search/seo-archive/'], '/search/seo-basic/'),
      entry('glossary/seo', ['/glossary/seo-old/'], '/glossary/seo/'),
      // redirectFrom 비어 있음 → 리다이렉트 없음 (가짜 리다이렉트 금지)
      entry('search/index', [], '/search/'),
    ],
    EXISTING
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(redirects, {
    '/seo-legacy/': '/search/seo-basic/',
    '/search/seo-archive/': '/search/seo-basic/',
    '/glossary/seo-old/': '/glossary/seo/',
  });
});

test('buildRedirectMap: 자기 자신(from === to)은 거부한다', () => {
  const { redirects, errors } = exp.buildRedirectMap(
    [entry('search/seo-basic', ['/search/seo-basic/'], '/search/seo-basic/')],
    EXISTING
  );
  assert.deepEqual(redirects, {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /자기 자신/);
});

test('buildRedirectMap: 기존 라우트와 충돌하면 거부한다', () => {
  const { redirects, errors } = exp.buildRedirectMap(
    [entry('search/seo-basic', ['/search/'], '/search/seo-basic/')],
    EXISTING
  );
  assert.deepEqual(redirects, {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /충돌/);
});

test('buildRedirectMap: 서로 다른 대상으로의 중복은 거부한다', () => {
  const { redirects, errors } = exp.buildRedirectMap(
    [
      entry('search/seo-basic', ['/seo-legacy/'], '/search/seo-basic/'),
      entry('search/other', ['/seo-legacy/'], '/search/other/'),
    ],
    EXISTING
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /중복/);
  assert.equal(redirects['/seo-legacy/'], '/search/seo-basic/', '첫 선언은 유지');
});

test('buildRedirectMap: 같은 from → 같은 to 중복 선언은 멱등으로 허용한다', () => {
  const { redirects, errors } = exp.buildRedirectMap(
    [
      entry('search/seo-basic', ['/seo-legacy/'], '/search/seo-basic/'),
      entry('search/seo-basic', ['/seo-legacy/'], '/search/seo-basic/'),
    ],
    EXISTING
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(redirects, { '/seo-legacy/': '/search/seo-basic/' });
});

test('buildRedirectMap: 비절대 경로는 거부한다', () => {
  const { redirects, errors } = exp.buildRedirectMap(
    [entry('search/seo-basic', ['seo-legacy', '/'], '/search/seo-basic/')],
    EXISTING
  );
  assert.deepEqual(redirects, {});
  assert.equal(errors.length, 2);
});
