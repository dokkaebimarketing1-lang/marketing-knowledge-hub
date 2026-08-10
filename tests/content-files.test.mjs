// tests/content-files.test.mjs
//
// Wave2 TODO2.1 — 공유 콘텐츠 파일 parser 계약 (TDD: RED → GREEN)
//
// 대상 API: `scripts/lib/content-files.mjs`의 named export
//   walkFiles(root)                          -> string[]  (POSIX relative, sorted, deterministic)
//   parseContentFile(filePath)               -> { data, body, format }
//       format: 'frontmatter' (md/mdx) | 'yaml' | 'json'
//   parseFrontmatter(text)                   -> { data, body }
//   serializeFrontmatter(data, body, { extension })
//
// 계약:
//   1. UTF-8 읽기, CRLF/LF 라인엔딩 모두 지원
//   2. md/mdx  -> { data, body,  format: 'frontmatter' }
//      yaml    -> { data, body: null, format: 'yaml' }
//      json    -> { data, body: null, format: 'json' }
//   3. 결정적 key 순서 (입력 순서 보존 가능한 한 유지)
//   4. malformed YAML/JSON → 상대 경로를 포함한 Error throw
//   5. serialize는 body 바이트와 끝 newline을 보존
//
// 실행: node --test tests/content-files.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'content-files');
const VALID = path.join(FIXTURES, 'valid');
const MALFORMED = path.join(FIXTURES, 'malformed');
const MODULE_URL = new URL('../scripts/lib/content-files.mjs', import.meta.url);

const VALID_FILES = [
  'docs/crlf.md',
  'docs/sample.mdx',
  'glossary/term.yaml',
  'registries/entity.json',
  'registries/sources.json',
].sort();

let modPromise;

/** 지연 로드 — 모듈이 없으면 ERR_MODULE_NOT_FOUND로 RED. */
function loadModule() {
  if (!modPromise) modPromise = import(MODULE_URL.href);
  return modPromise;
}

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** 독립 구현: 닫는 `---` 뒤 본문(바이트 보존 참조용). */
function bodyAfterFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

// --- walkFiles -----------------------------------------------------------------

test('walkFiles: 모든 파일을 POSIX 상대 경로로 정렬해 반환한다 (결정적)', async () => {
  const { walkFiles } = await loadModule();
  const first = walkFiles(VALID);
  const second = walkFiles(VALID);
  assert.deepEqual(first, VALID_FILES, `기대 목록과 일치해야 한다: ${JSON.stringify(VALID_FILES)}`);
  assert.deepEqual(second, VALID_FILES, '같은 입력 → 같은 출력 (결정적)');
  for (const rel of first) assert.ok(!rel.includes('\\'), `경로는 POSIX(/): ${rel}`);
});

test('walkFiles: 빈 디렉토리는 []를 반환한다', async () => {
  const { walkFiles } = await loadModule();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'content-files-empty-'));
  try {
    assert.deepEqual(walkFiles(empty), []);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// --- parseContentFile -----------------------------------------------------------

test('parseContentFile: mdx → { data, body, format: "frontmatter" }', async () => {
  const { parseContentFile } = await loadModule();
  const file = path.join(VALID, 'docs', 'sample.mdx');
  const { data, body, format } = parseContentFile(file);
  assert.equal(format, 'frontmatter');
  assert.equal(data.title, '샘플 문서');
  assert.equal(data.description, 'frontmatter 파싱 테스트');
  assert.deepEqual(data.tags, ['GEO', 'AI검색']);
  assert.deepEqual(data.nested, { key: 'value', list: ['a', 'b'] });
  assert.equal(body, bodyAfterFrontmatter(readUtf8(file)), '본문 바이트 보존');
});

test('parseContentFile: md with CRLF 라인엔딩 지원 + 본문 CRLF 바이트 보존', async () => {
  const { parseContentFile } = await loadModule();
  const file = path.join(VALID, 'docs', 'crlf.md');
  const raw = readUtf8(file);
  assert.ok(raw.includes('\r\n'), 'fixture는 CRLF여야 한다');
  const { data, body, format } = parseContentFile(file);
  assert.equal(format, 'frontmatter');
  assert.equal(data.title, 'CRLF 문서');
  assert.equal(data.status, 'active');
  assert.equal(body, bodyAfterFrontmatter(raw), 'CRLF 본문 바이트 보존');
  assert.ok(body.includes('\r\n'), '본문의 CRLF가 유지되어야 한다');
});

test('parseContentFile: yaml glossary → { data, body: null, format: "yaml" }', async () => {
  const { parseContentFile } = await loadModule();
  const { data, body, format } = parseContentFile(path.join(VALID, 'glossary', 'term.yaml'));
  assert.equal(format, 'yaml');
  assert.equal(body, null);
  assert.equal(data.term, 'ROAS');
  assert.equal(data.definition, '광고비 대비 발생한 매출의 비율(Return On Ad Spend). ROAS = (광고로 인한 매출 ÷ 광고비) × 100.');
  assert.deepEqual(data.aliases, ['광고 투자 수익률', 'Return On Ad Spend']);
});

test('parseContentFile: json registry → { data, body: null, format: "json" }', async () => {
  const { parseContentFile } = await loadModule();
  const { data, body, format } = parseContentFile(path.join(VALID, 'registries', 'sources.json'));
  assert.equal(format, 'json');
  assert.equal(body, null);
  assert.deepEqual(data.sources.map((s) => s.id), ['src-seo-guide', 'src-ads-guide']);
});

test('parseContentFile: trailing newline이 없는 json도 읽는다', async () => {
  const { parseContentFile } = await loadModule();
  const file = path.join(VALID, 'registries', 'entity.json');
  assert.ok(!readUtf8(file).endsWith('\n'), 'fixture는 trailing newline이 없어야 한다');
  const { data, format } = parseContentFile(file);
  assert.equal(format, 'json');
  assert.deepEqual(data, { id: 'geo', name: 'Generative Engine Optimization', sameAs: [] });
});

test('parseContentFile: malformed YAML → 상대 경로 포함 Error', async () => {
  const { parseContentFile } = await loadModule();
  const file = path.join(MALFORMED, 'bad.yaml');
  assert.throws(() => parseContentFile(file), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /bad\.yaml/, `에러에 파일 경로가 있어야 한다: ${err.message}`);
    assert.match(err.message, /[Yy][Aa][Mm][Ll]/, `에러에 YAML 언급이 있어야 한다: ${err.message}`);
    return true;
  });
});

test('parseContentFile: malformed JSON → 상대 경로 포함 Error', async () => {
  const { parseContentFile } = await loadModule();
  const file = path.join(MALFORMED, 'bad.json');
  assert.throws(() => parseContentFile(file), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /bad\.json/, `에러에 파일 경로가 있어야 한다: ${err.message}`);
    assert.match(err.message, /JSON/, `에러에 JSON 언급이 있어야 한다: ${err.message}`);
    return true;
  });
});

test('parseContentFile: 지원하지 않는 확장자는 Error', async () => {
  const { parseContentFile } = await loadModule();
  const file = path.join(MALFORMED, 'unknown.txt');
  fs.writeFileSync(file, 'plain text');
  try {
    assert.throws(() => parseContentFile(file), (err) => {
      assert.match(err.message, /unknown\.txt/);
      return true;
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// --- parseFrontmatter -----------------------------------------------------------

test('parseFrontmatter: data/body 추출 + key 순서 유지 (입력 순서)', async () => {
  const { parseFrontmatter } = await loadModule();
  const text = '---\nzebra: 1\nalpha: 2\nmiddle:\n  - x\n---\n\n본문.\n';
  const { data, body } = parseFrontmatter(text);
  assert.deepEqual(data, { zebra: 1, alpha: 2, middle: ['x'] });
  assert.deepEqual(Object.keys(data), ['zebra', 'alpha', 'middle'], '입력 순서의 key 순서 보존');
  assert.equal(body, '\n본문.\n');
});

test('parseFrontmatter: frontmatter가 없으면 { data: {}, body: 전체 텍스트 }', async () => {
  const { parseFrontmatter } = await loadModule();
  const text = '# 그냥 마크다운\n\n내용.\n';
  assert.deepEqual(parseFrontmatter(text), { data: {}, body: text });
});

test('parseFrontmatter: CRLF 텍스트 지원', async () => {
  const { parseFrontmatter } = await loadModule();
  const text = '---\r\ntitle: A\r\n---\r\n\r\n본문\r\n';
  const { data, body } = parseFrontmatter(text);
  assert.deepEqual(data, { title: 'A' });
  assert.equal(body, '\r\n본문\r\n');
});

// --- serializeFrontmatter -------------------------------------------------------

test('serializeFrontmatter: mdx/md는 frontmatter + body를 만들고 round-trip 보존', async () => {
  const { serializeFrontmatter, parseFrontmatter } = await loadModule();
  const data = { title: 'A 문서', tags: ['x', 'y'], count: 3 };
  const body = '\n# 본문\n\n끝.\n';
  for (const ext of ['md', 'mdx']) {
    const out = serializeFrontmatter(data, body, { extension: ext });
    assert.ok(out.startsWith('---\n'), 'frontmatter 시작 ---');
    assert.ok(out.endsWith(body), `body 바이트를 그대로 보존 (ext=${ext})`);
    assert.ok(out.endsWith('\n'), '끝 newline 보존');
    const parsed = parseFrontmatter(out);
    assert.deepEqual(parsed.data, data, `round-trip data (ext=${ext})`);
    assert.equal(parsed.body, body, `round-trip body (ext=${ext})`);
    // YAML 블록 내 key 순서 = 입력 순서
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(out)[1];
    assert.ok(block.indexOf('title:') < block.indexOf('tags:') && block.indexOf('tags:') < block.indexOf('count:'),
      `key 순서 보존: ${block}`);
  }
});

test('serializeFrontmatter: trailing newline 없는 body도 그대로 보존', async () => {
  const { serializeFrontmatter } = await loadModule();
  const out = serializeFrontmatter({ a: 1 }, 'body-no-newline', { extension: 'md' });
  assert.ok(out.endsWith('body-no-newline'), `body 끝이 유지되어야 한다: ${JSON.stringify(out.slice(-30))}`);
});

test('serializeFrontmatter: yaml → YAML 텍스트 (끝 newline), 재파싱 가능', async () => {
  const { serializeFrontmatter } = await loadModule();
  const YAML = (await import('yaml')).default;
  const data = { term: 'ROAS', aliases: ['a', 'b'] };
  const out = serializeFrontmatter(data, null, { extension: 'yaml' });
  assert.ok(out.endsWith('\n'), '끝 newline');
  assert.deepEqual(YAML.parse(out), data, '직렬화 결과를 다시 YAML로 파싱하면 동일');
});

test('serializeFrontmatter: json → JSON 텍스트 (끝 newline), 재파싱 가능', async () => {
  const { serializeFrontmatter } = await loadModule();
  const data = { id: 'geo', name: 'Generative Engine Optimization', sameAs: [] };
  const out = serializeFrontmatter(data, null, { extension: 'json' });
  assert.ok(out.endsWith('\n'), '끝 newline');
  assert.deepEqual(JSON.parse(out), data, '직렬화 결과를 다시 JSON으로 파싱하면 동일');
  assert.equal(Object.keys(JSON.parse(out)).join(','), Object.keys(data).join(','), 'key 순서 보존');
});

// --- 전체 유효성: walkFiles → parseContentFile 전 파일 스캔 ----------------------

test('통합: valid fixture 전체를 walk+parse해도 오류 없이 결정적이다', async () => {
  const { walkFiles, parseContentFile } = await loadModule();
  const results = walkFiles(VALID).map((rel) => {
    const parsed = parseContentFile(path.join(VALID, ...rel.split('/')));
    return { rel, format: parsed.format, dataSha: sha256(JSON.stringify(parsed.data)), bodySha: parsed.body === null ? null : sha256(parsed.body) };
  });
  assert.equal(results.length, VALID_FILES.length);
  // 두 번째 실행도 동일 (결정적)
  const again = walkFiles(VALID).map((rel) => {
    const parsed = parseContentFile(path.join(VALID, ...rel.split('/')));
    return { rel, format: parsed.format, dataSha: sha256(JSON.stringify(parsed.data)), bodySha: parsed.body === null ? null : sha256(parsed.body) };
  });
  assert.deepEqual(again, results);
});
