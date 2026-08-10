// tests/content-audit/audit-guards.test.mjs
//
// Wave2 TODO4c — audit fail-closed·registry·republication guard 실패 계약 (contract-first, RED)
//
// 대상 API: `scripts/content-audit.mjs`의 named export
//   auditWorkspace(root, { kind?: 'docs' | 'glossary' }) -> Promise<{ violations: Array<{ rule, file, message }> }>
//
// 추가 rule ID (기존 7개에 더해 허용 목록 확장):
//   PARSE_ERROR        docs/glossary/registry 파싱 실패 (swallow 금지 — violations로 표면화)
//   INVALID_REGISTRY   validateRegistries가 live per-record registry에서 발견한 오류 매핑
//   INVALID_ARGUMENT   auditWorkspace에 잘못된 kind 전달
//   REPUBLICATION      root/raw 존재 시 20-token 이상 연속 n-gram이 public 문서에 복제
//
// fail-closed 계약:
//   - 존재하지 않는 root / 기본 audit에서 docs·registries 미존재 → auditWorkspace throw
//   - CLI --kind/--format 잘못된 값 → exit 2 + stderr
//   - 현재 프로젝트(src/content/*)는 violations 0 유지
//
// 실행: node --test tests/content-audit/audit-guards.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(HERE, '..', 'fixtures', 'content-audit');
const PROJECT_ROOT = path.join(HERE, '..', '..');
const AUDIT_MODULE_URL = new URL('../../scripts/content-audit.mjs', import.meta.url);
const AUDIT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'content-audit.mjs');

const RULE_IDS = [
  'DUPLICATE_INTENT',
  'BROKEN_REFERENCE',
  'ORPHAN_LEAF',
  'MISSING_SOURCE',
  'CATEGORY_DRIFT',
  'INVALID_RELATED',
  'RAW_LEAKAGE',
  'PARSE_ERROR',
  'INVALID_REGISTRY',
  'INVALID_ARGUMENT',
  'REPUBLICATION',
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

// ── PARSE_ERROR ──────────────────────────────────────────────────────────────

test('malformed doc frontmatter → PARSE_ERROR', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('malformed-doc'));
  assertViolationsShape(violations);
  const hit = violations.find((v) => v.rule === 'PARSE_ERROR');
  assert.ok(hit, `violations에 PARSE_ERROR가 있어야 함: ${JSON.stringify(violations)}`);
  assert.ok(hit.file.startsWith('docs/'), `file은 docs 경로여야 함: ${hit.file}`);
});

test('malformed glossary yaml → PARSE_ERROR', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('malformed-glossary'), { kind: 'glossary' });
  assertViolationsShape(violations);
  const hit = violations.find((v) => v.rule === 'PARSE_ERROR');
  assert.ok(hit, `violations에 PARSE_ERROR가 있어야 함: ${JSON.stringify(violations)}`);
  assert.ok(hit.file.startsWith('glossary/'), `file은 glossary 경로여야 함: ${hit.file}`);
});

test('malformed registry json → PARSE_ERROR', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('malformed-registry'));
  assertViolationsShape(violations);
  const hit = violations.find((v) => v.rule === 'PARSE_ERROR');
  assert.ok(hit, `violations에 PARSE_ERROR가 있어야 함: ${JSON.stringify(violations)}`);
  assert.ok(hit.file.startsWith('registries/'), `file은 registries 경로여야 함: ${hit.file}`);
});

// ── INVALID_REGISTRY (live per-record registry → validateRegistries 매핑) ─────

test('bad registry id/url → INVALID_REGISTRY', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('bad-registry'));
  assertViolationsShape(violations);
  assert.ok(
    violations.some((v) => v.rule === 'INVALID_REGISTRY'),
    `violations에 INVALID_REGISTRY가 있어야 함: ${JSON.stringify(violations)}`,
  );
});

// ── INVALID_ARGUMENT ─────────────────────────────────────────────────────────

test('auditWorkspace에 잘못된 kind → INVALID_ARGUMENT', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('valid'), { kind: 'bogus' });
  assertViolationsShape(violations);
  assert.ok(
    violations.some((v) => v.rule === 'INVALID_ARGUMENT'),
    `violations에 INVALID_ARGUMENT가 있어야 함: ${JSON.stringify(violations)}`,
  );
});

// ── fail-closed: throw ───────────────────────────────────────────────────────

test('존재하지 않는 root → auditWorkspace throw', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  await assert.rejects(
    auditWorkspace(path.join(FIXTURES_ROOT, 'does-not-exist')),
    /존재하지 않/,
  );
});

test('기본 audit에서 docs/registries 미존재 → throw', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  // glossary-only fixture (docs 없음) → 기본 kind audit는 throw
  await assert.rejects(
    auditWorkspace(fixture('glossary-valid')),
    /docs|registries/,
  );
});

// ── CLI fail-closed ──────────────────────────────────────────────────────────

test('CLI 잘못된 --kind → exit 2 + stderr', () => {
  const res = spawnSync(process.execPath, [AUDIT_SCRIPT, '--kind', 'bogus'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 2, `status=2이어야 함 (got ${res.status})`);
  assert.ok(res.stderr.length > 0, 'stderr에 오류 메시지가 있어야 함');
});

test('CLI 잘못된 --format → exit 2 + stderr', () => {
  const res = spawnSync(process.execPath, [AUDIT_SCRIPT, '--format', 'xml'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 2, `status=2이어야 함 (got ${res.status})`);
  assert.ok(res.stderr.length > 0, 'stderr에 오류 메시지가 있어야 함');
});

// ── 추가 레퍼런스 검증 (source status, draft related) ─────────────────────────

test('inactive source 참조 → MISSING_SOURCE', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('inactive-source'));
  assertViolationsShape(violations);
  assert.ok(
    violations.some((v) => v.rule === 'MISSING_SOURCE'),
    `violations에 MISSING_SOURCE가 있어야 함: ${JSON.stringify(violations)}`,
  );
});

test('native draft:true 대상 관련 참조 → INVALID_RELATED', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('draft-related'));
  assertViolationsShape(violations);
  assert.ok(
    violations.some((v) => v.rule === 'INVALID_RELATED'),
    `violations에 INVALID_RELATED가 있어야 함: ${JSON.stringify(violations)}`,
  );
});

// ── REPUBLICATION (n-gram guard) ─────────────────────────────────────────────

test('20-token 이상 연속 복제 → REPUBLICATION', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('republication'));
  assertViolationsShape(violations);
  const hit = violations.find((v) => v.rule === 'REPUBLICATION');
  assert.ok(hit, `violations에 REPUBLICATION이 있어야 함: ${JSON.stringify(violations)}`);
  assert.ok(hit.file.startsWith('docs/'), `file은 docs 경로여야 함: ${hit.file}`);
});

test('20-token 미만 복제 + raw 존재만으로는 위반 없음', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const { violations } = await auditWorkspace(fixture('republication-below'));
  assertViolationsShape(violations);
  assert.deepEqual(
    violations.filter((v) => v.rule === 'REPUBLICATION'),
    [],
    `REPUBLICATION은 없어야 함: ${JSON.stringify(violations)}`,
  );
  assert.deepEqual(
    violations.filter((v) => v.rule === 'RAW_LEAKAGE'),
    [],
    `raw 존재만으로 RAW_LEAKAGE는 없어야 함: ${JSON.stringify(violations)}`,
  );
});

test('공개 frontmatter의 20-token 이상 연속 복제도 REPUBLICATION', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-frontmatter-republication-'));
  try {
    fs.cpSync(fixture('republication'), workspace, { recursive: true });
    const docPath = path.join(workspace, 'docs', 'search', 'repro.md');
    const copied = '이 원문 단락은 검증용으로 25개 이상의 연속 토큰을 포함하며 공개 문서에 그대로 복제되어서는 안 되는 내용입니다. 복제 감지 규칙은 정확히 20개 이상의 연속 토큰이 일치하는 경우에만 위반으로 판정합니다. 이 문장은 의도적으로 길게 작성되었습니다.';
    const text = fs.readFileSync(docPath, 'utf8')
      .replace(copied, '독립적으로 다시 작성한 짧은 본문입니다.')
      .replace('status: active', `shortAnswer: "${copied}"\nstatus: active`);
    fs.writeFileSync(docPath, text);
    const { violations } = await auditWorkspace(workspace);
    assert.ok(
      violations.some((violation) => violation.rule === 'REPUBLICATION'),
      JSON.stringify(violations),
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('query-cluster primaryEntityId는 active entity로 해소되어야 한다', async () => {
  const auditWorkspace = await loadAuditWorkspace();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cluster-entity-'));
  try {
    fs.cpSync(fixture('valid'), workspace, { recursive: true });
    const registryRoot = path.join(workspace, 'registries');
    fs.writeFileSync(
      path.join(registryRoot, 'entities.json'),
      JSON.stringify({ entities: [{ id: 'entity-x', status: 'deprecated' }] }, null, 2),
    );
    const clusterPath = path.join(registryRoot, 'query-clusters.json');
    const clusters = JSON.parse(fs.readFileSync(clusterPath, 'utf8'));
    clusters.clusters[0].primaryEntityId = 'entity-x';
    fs.writeFileSync(clusterPath, JSON.stringify(clusters, null, 2));

    const { violations } = await auditWorkspace(workspace);
    assert.ok(
      violations.some(
        (violation) =>
          violation.rule === 'BROKEN_REFERENCE' && violation.message.includes('primaryEntityId'),
      ),
      JSON.stringify(violations),
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
