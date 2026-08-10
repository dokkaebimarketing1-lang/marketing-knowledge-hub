// tests/content-audit/content-audit.test.mjs
//
// Wave1 TODO2 — 콘텐츠 audit CLI 실패 계약 (contract-first, RED)
//
// 대상 API: 미래 `scripts/content-audit.mjs`의 named export
//   auditWorkspace(root, { kind? }) -> Promise<{ violations: Array<{ rule, file, message }> }>
// CLI rule IDs: DUPLICATE_INTENT | BROKEN_REFERENCE | ORPHAN_LEAF |
//               MISSING_SOURCE | CATEGORY_DRIFT | INVALID_RELATED | RAW_LEAKAGE
//
// 지금은 `scripts/content-audit.mjs`가 아직 없으므로 모든 테스트가
// ERR_MODULE_NOT_FOUND로 RED여야 한다. 후속 구현이 이 계약을 충족해야 한다.
//
// 실행: node --test tests/content-audit/content-audit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

/** future module 로드 — 아직 없으면 ERR_MODULE_NOT_FOUND (RED) */
async function loadAuditWorkspace() {
  const mod = await import(AUDIT_MODULE_URL.href);
  assert.equal(typeof mod.auditWorkspace, 'function',
    'scripts/content-audit.mjs는 named export auditWorkspace를 함수로 제공해야 한다');
  return mod.auditWorkspace;
}

/** 모든 violations가 규약에 맞는지 검증 */
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

test('auditWorkspace는 scripts/content-audit.mjs의 named export여야 한다', async () => {
  await loadAuditWorkspace();
});

test('valid workspace → violations가 비어 있어야 한다', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('valid'));
  assertViolationsShape(violations);
  assert.deepEqual(violations, [], `valid fixture에서 violations가 발생하면 안 됨: ${JSON.stringify(violations)}`);
});

// 각 규칙별 fixture → 정확히 해당 rule ID 하나를 포함해야 한다
const RULE_FIXTURE_CASES = [
  ['DUPLICATE_INTENT', 'duplicate-intent'],
  ['BROKEN_REFERENCE', 'broken-ref'],
  ['ORPHAN_LEAF', 'orphan-leaf'],
  ['MISSING_SOURCE', 'missing-source'],
  ['CATEGORY_DRIFT', 'category-drift'],
  ['INVALID_RELATED', 'invalid-related'],
  ['RAW_LEAKAGE', 'raw-leakage'],
];

for (const [rule, fixtureName] of RULE_FIXTURE_CASES) {
  test(`fixture "${fixtureName}" → rule ${rule}`, async () => {
    const auditWorkspace = await loadAuditWorkspace();
    const { violations } = await auditWorkspace(fixture(fixtureName));
    assertViolationsShape(violations);
    assert.ok(
      violations.some((v) => v.rule === rule),
      `violations에 ${rule}가 없어야 함(fixture=${fixtureName}): ${JSON.stringify(violations)}`,
    );
  });
}

// kind 옵션(호출 형태) 계약: kind: 'docs' | 'glossary' | undefined 를 허용해야 한다
test('auditWorkspace는 { kind } 옵션을 받아야 한다 (docs)', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('valid'), { kind: 'docs' });
  assertViolationsShape(violations);
});

test('root /raw/ 디렉터리 존재만으로는 RAW_LEAKAGE가 아니다', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'content-audit-private-raw-'));
  try {
    fs.cpSync(fixture('valid'), workspace, { recursive: true });
    fs.mkdirSync(path.join(workspace, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'raw', 'private-source.html'), '<p>private source</p>\n');
    const { violations } = await auditWorkspace(workspace);
    assert.equal(
      violations.some((violation) => violation.rule === 'RAW_LEAKAGE'),
      false,
      `root /raw/는 비공개 원천 저장소로 허용되어야 함: ${JSON.stringify(violations)}`,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
