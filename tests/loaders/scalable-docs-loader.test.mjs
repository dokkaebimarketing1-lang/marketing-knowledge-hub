// tests/loaders/scalable-docs-loader.test.mjs
//
// Staged scalable docs loader 계약 (TDD: RED → GREEN)
//
// 대상 API: `src/loaders/scalableDocsLoader.ts`의 named export
//   scalableDocsLoader() -> Loader (Astro `glob` 기반)
//
// 계약 (content.config에는 아직 연결하지 않는다 — 스테이징):
//   1. base = `./src/content/docs` (프로젝트 루트 기준)
//   2. md + mdx 포함, 그 외 확장자는 제외
//   3. 밑줄(`_`)로 시작하는 디렉토리/파일은 어느 깊이든 제외
//   4. retainBody: false  → store entry의 body는 undefined
//   5. deferRender: true  → store entry의 deferredRender는 true
//   6. 커스텀 generateId 없음 → 기본 파일 파생 slug ID 보존
//      (확장자 제거, `/index` slug 제거)
//   7. 확장 가능성: 기대 ID 집합은 파일시스템에서 독립 도출한다(고정 목록 금지).
//      레거시 18개 ID는 반드시 그 부분집합으로 유지된다.
//
// 실행: node --test tests/loaders/scalable-docs-loader.test.mjs
//       (npm run test:content 에 포함됨)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const DOCS_DIR = path.join(PROJECT_ROOT, 'src', 'content', 'docs');
const LOADER_URL = new URL('../../src/loaders/scalableDocsLoader.ts', import.meta.url);
const PARSER_URL = new URL('../../scripts/lib/content-files.mjs', import.meta.url);

// 현재 소스 docs의 레거시 slug ID 목록 (18개).
// 새 문서 추가 시 이 목록을 갱신할 필요가 없다 — 단, 이 ID들은
// 앞으로도 반드시 로더가 도출하는 ID 집합의 부분집합으로 유지되어야 한다.
const LEGACY_18_IDS = [
  'ai-search',
  'ai-search/aeo-basic',
  'ai-search/geo-basic',
  'analytics',
  'analytics/data-analysis',
  'analytics/ga4-basic',
  'content',
  'content/content-strategy',
  'content/email-marketing',
  'performance',
  'performance/retention',
  'performance/roas-metrics',
  'search',
  'search/keyword-ads',
  'search/seo-basic',
  'sns',
  'sns/instagram',
  'sns/youtube',
];

let loaderModPromise;
let parserModPromise;

/** 지연 로드 — 모듈이 없으면 ERR_MODULE_NOT_FOUND로 RED. */
function loadLoader() {
  if (!loaderModPromise) loaderModPromise = import(LOADER_URL.href);
  return loaderModPromise;
}

function loadParser() {
  if (!parserModPromise) parserModPromise = import(PARSER_URL.href);
  return parserModPromise;
}

// --- 독립 구현 ----------------------------------------------------------------

/** docs 디렉토리를 재귀적으로 걸어 POSIX 상대 경로 목록을 만든다 (결정적 정렬). */
function walkTree(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkTree(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** github-slugger 근사: 소문자화 + 비알파벳/숫자 연속 제거. (현 소스는 ASCII-hyphen이라 동일) */
function slugSegment(segment) {
  return segment.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

/** 소스 docs에서 로더 계약대로 slug ID 집합을 독립 도출한다. */
function deriveSlugIds(docsDir) {
  const files = walkTree(docsDir).filter((rel) => {
    const parts = rel.split('/');
    if (parts.some((p) => p.startsWith('_'))) return false; // 밑줄 디렉토리/파일 제외
    return /\.(md|mdx)$/.test(rel); // md + mdx만
  });
  return files
    .map((rel) => {
      const withoutExt = rel.replace(/\.(md|mdx)$/, '');
      return withoutExt
        .split('/')
        .map(slugSegment)
        .join('/')
        .replace(/\/index$/, ''); // index → 디렉토리 slug
    })
    .sort();
}

/** route-id 형식 규칙: 로더가 생성하는 모든 ID가 지켜야 하는 불변조건. */
function assertRouteIdRules(ids) {
  for (const id of ids) {
    assert.ok(typeof id === 'string' && id.length > 0, `route-id는 비어 있으면 안 됨: ${JSON.stringify(id)}`);
    assert.ok(!id.startsWith('/') && !id.endsWith('/'), `route-id는 슬래시로 시작/끝나면 안 됨: ${id}`);
    assert.ok(!/\/index$/.test(id), `route-id는 /index로 끝나면 안 됨: ${id}`);
    assert.ok(!id.split('/').some((seg) => seg.startsWith('_')), `route-id에 밑줄 세그먼트 금지: ${id}`);
    assert.ok(
      id.split('/').every((seg) => /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(seg)),
      `route-id 세그먼트는 slug 형식이어야 함: ${id}`,
    );
    assert.ok(id === id.toLowerCase(), `route-id는 소문자여야 함: ${id}`);
  }
}

// --- 로더 실행 컨텍스트 (Astro LoaderContext의 Node 호환 최소 구현) -----------

/** .md/.mdx entryTypes — 검증된 content-files parser를 재사용해 frontmatter를 파싱. */
function makeEntryTypes(parser) {
  const types = new Map();
  for (const ext of ['.md', '.mdx']) {
    types.set(ext, {
      getEntryInfo: async ({ fileUrl }) => {
        const parsed = parser.parseContentFile(fileURLToPath(fileUrl));
        return { body: parsed.body, data: parsed.data };
      },
      // 실제 Astro markdown entry type은 렌더링 함수를 제공하므로,
      // deferRender:true 경로(store.deferredRender)를 타게 한다.
      // deferRender가 켜져 있어 이 함수는 호출되지 않는다.
      getRenderFunction: async () => async () => undefined,
    });
  }
  return types;
}

/** DataStore 계약의 인메모리 구현. */
function makeStore() {
  const map = new Map();
  return {
    map,
    get: (key) => map.get(key),
    keys: () => [...map.keys()],
    set: (entry) => {
      map.set(entry.id, entry);
      return true;
    },
    delete: (key) => {
      map.delete(key);
    },
    has: (key) => map.has(key),
    entries: () => [...map.entries()],
    values: () => [...map.values()],
    clear: () => map.clear(),
    addModuleImport: () => {},
    addAssetImports: () => {},
  };
}

function makeContext(rootUrl, parser) {
  return {
    collection: 'docs',
    store: makeStore(),
    meta: { get: () => undefined, set: () => {}, has: () => false, delete: () => {} },
    logger: {
      warn: () => {},
      error: () => {},
      info: () => {},
    },
    config: {
      root: rootUrl,
      srcDir: new URL('src/', rootUrl),
    },
    parseData: async ({ data }) => data, // 스키마 검증은 이 계약 테스트 범위 밖
    generateDigest: (contents) => JSON.stringify(contents),
    entryTypes: makeEntryTypes(parser),
    watcher: undefined,
  };
}

/** 임시 루트에 docs 트리를 복사하고 선택적으로 추가 파일을 쓴다. */
function makeTempDocsTree(extraFiles = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scalable-docs-loader-'));
  const docsDest = path.join(tmp, 'src', 'content', 'docs');
  fs.cpSync(DOCS_DIR, docsDest, { recursive: true });
  for (const [rel, contents] of Object.entries(extraFiles)) {
    const p = path.join(docsDest, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }
  return tmp;
}

// --- 테스트 -------------------------------------------------------------------

test('scalableDocsLoader(): Loader 계약 객체(name + load)를 반환한다', async () => {
  const { scalableDocsLoader } = await loadLoader();
  const loader = scalableDocsLoader();
  assert.equal(typeof loader, 'object');
  assert.equal(typeof loader.name, 'string');
  assert.ok(loader.name.length > 0, 'name이 비어 있으면 안 된다');
  assert.equal(typeof loader.load, 'function');
});

test('실제 docs: 파일시스템에서 독립 도출한 ID 집합과 로더 결과가 일치한다 (고정 개수 금지)', async () => {
  const { scalableDocsLoader } = await loadLoader();
  const parser = await loadParser();
  const loader = scalableDocsLoader();

  const ctx = makeContext(pathToFileURL(PROJECT_ROOT + path.sep), parser);
  await loader.load(ctx);

  const ids = ctx.store.keys().sort();

  // 기대값은 파일시스템에서 독립 도출한다 — 고정 개수/목록으로 단정하지 않는다.
  const derived = deriveSlugIds(DOCS_DIR);
  assert.ok(derived.length > 0, '소스 docs에서 파일을 찾아야 한다');
  assert.deepEqual(ids, derived, 'loader 결과 === 독립 도출 ID (확장 가능)');

  // route-id 형식 규칙: 모든 도출 ID가 slug/라우트 규칙을 지켜야 한다.
  assertRouteIdRules(derived);

  // 레거시 18개 ID는 반드시 도출 집합의 부분집합이다.
  for (const legacy of LEGACY_18_IDS) {
    assert.ok(derived.includes(legacy), `레거시 route-id "${legacy}"가 도출 집합에 포함되어야 함`);
  }
  assert.equal(
    new Set(LEGACY_18_IDS).size,
    LEGACY_18_IDS.length,
    '레거시 18개 목록 자체에 중복이 있으면 안 된다',
  );

  // retainBody: false → body 없음, deferRender: true → deferredRender 플래그
  const values = ctx.store.values();
  assert.equal(values.length, derived.length);
  for (const entry of values) {
    assert.equal(entry.body, undefined, `retainBody:false — body는 undefined여야 한다: ${entry.id}`);
    assert.equal(entry.deferredRender, true, `deferRender:true — deferredRender 플래그: ${entry.id}`);
  }
});

test('scalability: 유효한 문서를 하나 추가하면 도출 기대값이 고정 개수 대신 함께 증가한다', async () => {
  const { scalableDocsLoader } = await loadLoader();
  const parser = await loadParser();

  const baselineDerived = deriveSlugIds(DOCS_DIR);

  const tmp = makeTempDocsTree({
    'search/extra-seo-article.md': [
      '---',
      'title: 추가 글',
      'description: 확장성 검증용 추가 문서.',
      '---',
      '본문.',
      '',
    ].join('\n'),
  });
  try {
    const expectedWithExtra = deriveSlugIds(path.join(tmp, 'src', 'content', 'docs'));
    assert.equal(
      expectedWithExtra.length,
      baselineDerived.length + 1,
      '파일을 하나 추가하면 독립 도출 ID도 정확히 하나 늘어야 한다 (고정 18 실패 대신 유도 기대값 증가)',
    );
    assert.ok(
      expectedWithExtra.includes('search/extra-seo-article'),
      '추가 문서의 route-id가 도출 집합에 포함되어야 한다',
    );
    // 레거시 18개는 여전히 부분집합 (기존 라우트 보존)
    for (const legacy of LEGACY_18_IDS) {
      assert.ok(expectedWithExtra.includes(legacy), `레거시 route-id "${legacy}" 보존`);
    }

    // 로더도 동일하게 늘어난 집합을 도출한다.
    const loader = scalableDocsLoader();
    const ctx = makeContext(pathToFileURL(tmp + path.sep), parser);
    await loader.load(ctx);
    assert.deepEqual(ctx.store.keys().sort(), expectedWithExtra, '로더 결과 === 독립 도출 ID(확장 시)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fixture: underscore 제외 + md/mdx 포함 + base 해석 (실제 로더 실행)', async () => {
  const { scalableDocsLoader } = await loadLoader();
  const parser = await loadParser();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scalable-docs-loader-'));
  try {
    const files = {
      'src/content/docs/normal.md': '---\ntitle: N\n---\n본문.\n',
      'src/content/docs/sub/visible.mdx': '---\ntitle: V\n---\n본문.\n',
      'src/content/docs/_hidden.md': '---\ntitle: H\n---\n',
      'src/content/docs/_drafts/secret.md': '---\ntitle: S\n---\n',
      'src/content/docs/sub/_private/x.mdx': '---\ntitle: X\n---\n',
      'src/content/docs/sub/_private/deep/y.md': '---\ntitle: Y\n---\n',
      'src/content/docs/data.json': '{"a":1}',
      'src/content/docs/sub/notes.yaml': 'a: 1',
    };
    for (const [rel, contents] of Object.entries(files)) {
      const p = path.join(tmp, ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, contents);
    }

    const loader = scalableDocsLoader();
    const ctx = makeContext(pathToFileURL(tmp + path.sep), parser);
    await loader.load(ctx);

    const ids = ctx.store.keys().sort();
    assert.deepEqual(ids, ['normal', 'sub/visible'], `밑줄 파일/디렉토리와 비-md/mdx 확장자는 제외: ${JSON.stringify(ids)}`);
    for (const entry of ctx.store.values()) {
      assert.equal(entry.body, undefined, `fixture에서도 body 제거: ${entry.id}`);
      assert.equal(entry.deferredRender, true, `fixture에서도 지연 렌더링: ${entry.id}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
