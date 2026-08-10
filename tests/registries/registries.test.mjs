// tests/registries/registries.test.mjs
// Wave1 TODO4 — registry 스키마 validator 계약 (contract-first, RED)
//
// Future API (아직 미구현 — 현재는 RED):
//   scripts/lib/registry-validation.mjs
//     export function validateRegistries(root) -> Promise<{ errors: Array<{ code, file, message }> }>
//
// Registry layout contract (데이터가 반드시 지켜야 할 스키마):
//   <root>/registries/{taxonomy,query-clusters,entities,people,sources}/<id>.json
//   - 각 파일은 단일 레코드 객체 하나이며, 레코드 `id`는 반드시 파일 stem과 같다
//     (IDs are file stems 계약: `id` == 파일명에서 `.json`을 뗀 이름)
//   - error code 목록:
//       DUPLICATE_ID                레코드 id가 2개 이상 파일에서 중복(또는 id != file stem)
//       INVALID_PATH                registries/{5개 kind}/ 밖에 위치한 .json 파일
//       INVALID_URL                 source `url`이 절대 http(s) URL이 아님(또는 누락)
//       INVALID_STATUS              레코드 `status`가 { active, deprecated } 밖의 값
//       CLUSTER_CATEGORY_MISMATCH   query-cluster의 `categoryId`가 taxonomy id로 해소 불가
//   - cross-registry 관계: cluster.categoryId -> taxonomy.id,
//                          cluster.entityId   -> entities.id
//
// 콘텐츠 audit(scripts/content-audit.mjs)이 이 validator를 재사용한다.
//
// 실행: node --test tests/registries/registries.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(HERE, '..', 'fixtures', 'registries');
const VALIDATOR_MODULE_URL = new URL('../../scripts/lib/registry-validation.mjs', import.meta.url);

const ERROR_CODES = [
  'DUPLICATE_ID',
  'INVALID_PATH',
  'INVALID_URL',
  'INVALID_STATUS',
  'CLUSTER_CATEGORY_MISMATCH',
];

const KINDS = ['taxonomy', 'query-clusters', 'entities', 'people', 'sources'];

function fixture(name) {
  return path.join(FIXTURES_ROOT, name);
}

// --- implementation discovery (scripts/lib/registry-validation.mjs는 아직 없음 → RED) ---

let validateRegistries;

before(async () => {
  try {
    ({ validateRegistries } = await import(VALIDATOR_MODULE_URL.href));
  } catch {
    validateRegistries = undefined;
  }
});

function requireImpl() {
  assert.ok(
    typeof validateRegistries === 'function',
    'contract: validateRegistries는 scripts/lib/registry-validation.mjs의 named export여야 한다 ' +
      '(RED: implementation intentionally not written yet)',
  );
  return validateRegistries;
}

// --- helpers -------------------------------------------------------------------------

function assertErrorsShape(errors) {
  assert.ok(Array.isArray(errors), 'validateRegistries는 { errors: [] }를 반환해야 한다');
  for (const e of errors) {
    assert.equal(typeof e.code, 'string', 'error.code는 문자열이어야 한다');
    assert.equal(typeof e.file, 'string', 'error.file은 문자열이어야 한다');
    assert.equal(typeof e.message, 'string', 'error.message는 문자열이어야 한다');
    assert.ok(
      ERROR_CODES.includes(e.code),
      `알 수 없는 error code "${e.code}" — 허용 목록: ${ERROR_CODES.join(', ')}`,
    );
  }
}

/** 주어진 fixture의 registries 아래 모든 .json 레코드를 { kind, stem, data } 목록으로 로드 */
function loadRecords(root) {
  const out = [];
  for (const kind of KINDS) {
    const dir = path.join(root, 'registries', kind);
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const data = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
      out.push({ kind, stem: path.basename(entry, '.json'), data });
    }
  }
  return out;
}

// --- fixture contract (자기 완결 문서화 테스트: 계약 그 자체를 고정한다) ---------------------

test('fixture contract (valid/): record id === file stem, cross-registry 참조 해소', () => {
  const records = loadRecords(fixture('valid'));
  assert.equal(
    records.length,
    9,
    'valid fixture는 taxonomy 2 + query-clusters 2 + entities 2 + people 1 + sources 2 = 9 레코드',
  );

  const taxonomyIds = new Set(records.filter((r) => r.kind === 'taxonomy').map((r) => r.stem));
  const entityIds = new Set(records.filter((r) => r.kind === 'entities').map((r) => r.stem));

  // IDs are file stems: 레코드 id는 파일 stem과 같아야 한다
  for (const { kind, stem, data } of records) {
    assert.equal(data.id, stem, `${kind}/${stem}.json의 id는 파일 stem과 일치해야 한다`);
  }
  // query-cluster → taxonomy(categoryId), query-cluster → entities(entityId) 참조 해소
  for (const { data } of records.filter((r) => r.kind === 'query-clusters')) {
    assert.ok(
      taxonomyIds.has(data.categoryId),
      `cluster ${data.id}의 categoryId "${data.categoryId}"는 taxonomy id로 해소되어야 한다`,
    );
    assert.ok(
      entityIds.has(data.entityId),
      `cluster ${data.id}의 entityId "${data.entityId}"는 entity id로 해소되어야 한다`,
    );
  }
  // source는 절대 http(s) URL을 가져야 한다
  for (const { data } of records.filter((r) => r.kind === 'sources')) {
    assert.match(data.url, /^https?:\/\/\S+$/, `source ${data.id}의 url은 절대 http(s) URL이어야 한다`);
  }
});

// --- validator contract ---------------------------------------------------------------

test('validateRegistries는 scripts/lib/registry-validation.mjs의 named export여야 한다', async () => {
  requireImpl();
});

test('valid registry → errors=[]', async () => {
  const impl = requireImpl();
  const { errors } = await impl(fixture('valid'));
  assertErrorsShape(errors);
  assert.deepEqual(errors, [], `valid fixture에서 오류가 발생하면 안 됨: ${JSON.stringify(errors)}`);
});

// 각 오류 코드별 fixture → 해당 code를 포함해야 한다
const CODE_FIXTURE_CASES = [
  ['DUPLICATE_ID', 'duplicate-id'],
  ['INVALID_PATH', 'invalid-path'],
  ['INVALID_URL', 'invalid-url'],
  ['INVALID_STATUS', 'invalid-status'],
  ['CLUSTER_CATEGORY_MISMATCH', 'cluster-category-mismatch'],
  ['CLUSTER_CATEGORY_MISMATCH', 'invalid-primary-entity'],
];

for (const [code, fixtureName] of CODE_FIXTURE_CASES) {
  test(`fixture "${fixtureName}" → code ${code}`, async () => {
    const impl = requireImpl();
    const { errors } = await impl(fixture(fixtureName));
    assertErrorsShape(errors);
    assert.ok(
      errors.some((e) => e.code === code),
      `errors에 ${code}가 있어야 함(fixture=${fixtureName}): ${JSON.stringify(errors)}`,
    );
  });
}

test('DUPLICATE_ID 오류 메시지는 중복된 id를 지목해야 한다', async () => {
  const impl = requireImpl();
  const { errors } = await impl(fixture('duplicate-id'));
  const dup = errors.find((e) => e.code === 'DUPLICATE_ID');
  assert.ok(dup, `DUPLICATE_ID가 있어야 함: ${JSON.stringify(errors)}`);
  assert.ok(dup.message.includes('entity-shared'), `메시지가 중복 id를 지목해야 함: ${dup.message}`);
});

test('INVALID_PATH 오류는 잘못 위치한 파일을 지목해야 한다', async () => {
  const impl = requireImpl();
  const { errors } = await impl(fixture('invalid-path'));
  const bad = errors.find((e) => e.code === 'INVALID_PATH');
  assert.ok(bad, `INVALID_PATH가 있어야 함: ${JSON.stringify(errors)}`);
  assert.equal(
    bad.file.split(path.sep).join('/'),
    'registries/misc/rogue.json',
    'INVALID_PATH는 registries/misc/rogue.json을 지목해야 한다',
  );
});

test('서로 다른 registry kind는 같은 id를 사용할 수 있다', async () => {
  const impl = requireImpl();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-kind-namespace-'));
  try {
    fs.cpSync(fixture('valid'), workspace, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'registries', 'taxonomy', 'shared.json'),
      JSON.stringify({ id: 'shared', status: 'active' }, null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(workspace, 'registries', 'entities', 'shared.json'),
      JSON.stringify({ id: 'shared', status: 'active' }, null, 2) + '\n',
    );
    const { errors } = await impl(workspace);
    assert.equal(
      errors.some((error) => error.code === 'DUPLICATE_ID' && error.message.includes('shared')),
      false,
      `registry kind별 namespace가 분리되어야 함: ${JSON.stringify(errors)}`,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('CLUSTER_CATEGORY_MISMATCH 오류 메시지는 해소 불가한 primaryEntityId를 지목해야 한다', async () => {
  const impl = requireImpl();
  const { errors } = await impl(fixture('invalid-primary-entity'));
  const mismatch = errors.find((e) => e.code === 'CLUSTER_CATEGORY_MISMATCH');
  assert.ok(mismatch, `CLUSTER_CATEGORY_MISMATCH가 있어야 함: ${JSON.stringify(errors)}`);
  assert.ok(
    mismatch.message.includes('nonexistent-entity'),
    `메시지가 해소 불가한 primaryEntityId를 지목해야 함: ${mismatch.message}`,
  );
});

test('entities/people 외부 URL은 절대 http(s)만 허용한다', async () => {
  const impl = requireImpl();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-external-url-'));
  try {
    fs.cpSync(fixture('valid'), workspace, { recursive: true });
    const entityPath = path.join(workspace, 'registries', 'entities', 'geo.json');
    const personPath = path.join(workspace, 'registries', 'people', 'author-kim.json');
    const entity = JSON.parse(fs.readFileSync(entityPath, 'utf8'));
    const person = JSON.parse(fs.readFileSync(personPath, 'utf8'));
    entity.sameAs = ['ftp://example.com/entity'];
    person.url = 'mailto:author@example.com';
    person.sameAs = ['/relative-profile'];
    fs.writeFileSync(entityPath, JSON.stringify(entity, null, 2) + '\n');
    fs.writeFileSync(personPath, JSON.stringify(person, null, 2) + '\n');

    const { errors } = await impl(workspace);
    const invalidUrls = errors.filter((error) => error.code === 'INVALID_URL');
    assert.equal(invalidUrls.length, 3, JSON.stringify(errors));
    assert.ok(invalidUrls.some((error) => error.file.endsWith('entities/geo.json')));
    assert.ok(invalidUrls.filter((error) => error.file.endsWith('people/author-kim.json')).length >= 2);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
