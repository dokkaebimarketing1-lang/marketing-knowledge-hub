// tests/content-audit/glossary-audit.test.mjs
//
// Wave2 TODO4b — glossary audit 실패 계약 (contract-first, RED)
//
// 대상 API: `scripts/content-audit.mjs`의 named export
//   auditWorkspace(root, { kind?: 'docs' | 'glossary' }) -> Promise<{ violations: Array<{ rule, file, message }> }>
//
// glossary 규칙 (kind: 'glossary' | undefined):
//   MISSING_SOURCE     active 용어: sourceIds 최소 1개, 모든 source가 sources 레지스트리에 존재 + active
//   CATEGORY_DRIFT     categoryId가 taxonomy 레지스트리에서 kind=glossary + active로 해소되어야 함
//   BROKEN_REFERENCE   relatedIds가 존재하는 glossary 용어로 해소되어야 함
//   INVALID_RELATED    relatedIds에 자기 자신 / 중복 / deprecated 대상 금지
//   RAW_LEAKAGE        definition·aliases에 /raw/ 링크·raw import 금지
//
// kind 분리 계약:
//   { kind: 'docs' }     → docs 규칙만
//   { kind: 'glossary' } → glossary 규칙만
//   undefined            → docs + glossary 결합
//
// 실행: node --test tests/content-audit/glossary-audit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(HERE, '..', 'fixtures', 'content-audit');
const AUDIT_MODULE_URL = new URL('../../scripts/content-audit.mjs', import.meta.url);

const RULE_IDS = [
  'DUPLICATE_INTENT',
  'BROKEN_REFERENCE',
  'ORPHAN_LEAF',
  'MISSING_SOURCE',
  'CATEGORY_DRIFT',
  'INVALID_RELATED',
  'RAW_LEAKAGE',
];

function fixture(name) {
  return path.join(FIXTURES_ROOT, name);
}

async function loadAuditWorkspace() {
  const mod = await import(AUDIT_MODULE_URL.href);
  assert.equal(typeof mod.auditWorkspace, 'function',
    'scripts/content-audit.mjs는 named export auditWorkspace를 함수로 제공해야 한다');
  return mod.auditWorkspace;
}

function assertViolationsShape(violations) {
  assert.ok(Array.isArray(violations), 'auditWorkspace는 { violations: [] }를 반환해야 한다');
  for (const v of violations) {
    assert.equal(typeof v.rule, 'string', 'violation.rule은 문자열이어야 한다');
    assert.equal(typeof v.file, 'string', 'violation.file은 문자열이어야 한다');
    assert.equal(typeof v.message, 'string', 'violation.message는 문자열이어야 한다');
    assert.ok(RULE_IDS.includes(v.rule),
      `알 수 없는 rule ID "${v.rule}" — 허용 목록: ${RULE_IDS.join(', ')}`);
  }
}

test('glossary valid workspace → violations가 비어 있어야 한다', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('glossary-valid'), { kind: 'glossary' });
  assertViolationsShape(violations);
  assert.deepEqual(violations, [], `glossary-valid에서 violations가 발생하면 안 됨: ${JSON.stringify(violations)}`);
});

// glossary 규칙별 fixture → 정확히 해당 rule ID 하나를 포함해야 한다
const GLOSSARY_RULE_FIXTURE_CASES = [
  ['MISSING_SOURCE', 'glossary-missing-source'],
  ['CATEGORY_DRIFT', 'glossary-category-drift'],
  ['BROKEN_REFERENCE', 'glossary-broken-ref'],
  ['INVALID_RELATED', 'glossary-invalid-related'],
  ['RAW_LEAKAGE', 'glossary-raw-leakage'],
];

for (const [rule, fixtureName] of GLOSSARY_RULE_FIXTURE_CASES) {
  test(`glossary fixture "${fixtureName}" → rule ${rule}`, async () => {
    const auditWorkspace = await loadAuditWorkspace();
    const { violations } = await auditWorkspace(fixture(fixtureName), { kind: 'glossary' });
    assertViolationsShape(violations);
    assert.ok(
      violations.some((v) => v.rule === rule),
      `violations에 ${rule}가 있어야 함(fixture=${fixtureName}): ${JSON.stringify(violations)}`,
    );
  });
}

// kind 분리 계약: docs와 glossary가 모두 violations를 가진 결합 fixture에서
// kind: 'docs'는 glossary 규칙을, kind: 'glossary'는 docs 규칙을 보고하지 않아야 한다.
test("kind: 'docs'는 glossary 규칙을 실행하지 않아야 한다", async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('combined'), { kind: 'docs' });
  assertViolationsShape(violations);
  assert.ok(
    violations.some((v) => v.rule === 'MISSING_SOURCE'),
    `combined(fixture=docs)에서 docs의 MISSING_SOURCE가 보고되어야 함: ${JSON.stringify(violations)}`,
  );
  assert.ok(
    !violations.some((v) => v.rule === 'BROKEN_REFERENCE'),
    `combined(fixture=docs)에서 glossary의 BROKEN_REFERENCE가 보고되면 안 됨: ${JSON.stringify(violations)}`,
  );
});

test("kind: 'glossary'는 docs 규칙을 실행하지 않아야 한다", async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('combined'), { kind: 'glossary' });
  assertViolationsShape(violations);
  assert.ok(
    violations.some((v) => v.rule === 'BROKEN_REFERENCE'),
    `combined(fixture=glossary)에서 glossary의 BROKEN_REFERENCE가 보고되어야 함: ${JSON.stringify(violations)}`,
  );
  assert.ok(
    !violations.some((v) => v.rule === 'MISSING_SOURCE'),
    `combined(fixture=glossary)에서 docs의 MISSING_SOURCE가 보고되면 안 됨: ${JSON.stringify(violations)}`,
  );
});

test('kind 미지정 → docs + glossary 규칙을 함께 실행한다', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('combined'));
  assertViolationsShape(violations);
  assert.ok(
    violations.some((v) => v.rule === 'MISSING_SOURCE') &&
      violations.some((v) => v.rule === 'BROKEN_REFERENCE'),
    `combined(undefined)에서 docs·glossary 두 규칙이 모두 보고되어야 함: ${JSON.stringify(violations)}`,
  );
});
