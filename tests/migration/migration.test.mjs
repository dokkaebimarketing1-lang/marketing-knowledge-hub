// tests/migration/migration.test.mjs
// Wave 1 contract tests for the deterministic existing-content migration tool.
//
// Future API (not yet implemented — these tests are RED by design):
//   migrateExistingContent({ root, dryRun, mapPath }) -> Promise<{
//     changedFiles: string[],            // POSIX relative paths actually written (always [] in dryRun)
//     diff: Record<string, { before: string, after: string }>,  // per changed path, full file content
//   })
//
// - root:    content root directory (fixture `source/` copied to a temp dir)
// - dryRun:  true  -> plan only, never write (changedFiles MUST be [])
// - mapPath: path to JSON mapping: { "<relative path>": { <auto fields> } }
//
// Contract under test:
//   1. dryRun modifies zero files and reports changedFiles=[]
//   2. real run writes exactly expected/ byte-for-byte (frontmatter contract)
//   3. real run preserves body bytes (SHA-256 of post-frontmatter content)
//   4. re-run is a no-op (changedFiles=[])
//   5. files missing from the mapping are flagged reviewStatus=human-review-needed

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'migration');
const SOURCE = path.join(FIXTURES, 'source');
const EXPECTED = path.join(FIXTURES, 'expected');
const FULL_MAP = path.join(FIXTURES, 'mappings', 'full.map.json');
const PARTIAL_MAP = path.join(FIXTURES, 'mappings', 'partial.map.json');
const MIGRATION_ENTRYPOINT = path.join(PROJECT_ROOT, 'scripts', 'migrate-existing-content.mjs');

const EXPECTED_CHANGED_FILES = [
  'docs/ai-search/geo-basic.mdx',
  'docs/ai-search/index.mdx',
  'glossary/roas.yaml',
].sort();

// --- implementation discovery (must stay undefined until TODO 5 lands) ----------

let migrateExistingContent;

before(async () => {
  try {
    ({ migrateExistingContent } = await import(pathToFileURL(MIGRATION_ENTRYPOINT).href));
  } catch {
    migrateExistingContent = undefined;
  }
});

function requireImpl() {
  assert.ok(
    typeof migrateExistingContent === 'function',
    'contract: migrateExistingContent must be exported from scripts/migrate-existing-content.mjs ' +
      '(RED: implementation intentionally not written yet)',
  );
  return migrateExistingContent;
}

// --- helpers ---------------------------------------------------------------------

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** POSIX relative paths of every file under `dir` (recursive). */
function walkFiles(dir, base = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = base ? path.join(base, entry.name) : entry.name;
    if (entry.isDirectory()) walkFiles(abs, rel, out);
    else out.push(rel.split(path.sep).join('/'));
  }
  return out.sort();
}

/** Content after the closing `---` of the frontmatter block (body bytes). */
function bodyAfterFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** Minimal `key: value` extraction from a YAML/TOML frontmatter block. */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const block = m ? m[1] : text;
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

const createdWorkDirs = [];

/** Copy `source/` into a fresh temp dir and return the temp content root. */
function makeWorkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-contract-'));
  createdWorkDirs.push(dir);
  fs.cpSync(SOURCE, path.join(dir, 'content'), { recursive: true });
  return path.join(dir, 'content');
}

function sourceSnapshot() {
  const files = {};
  for (const rel of walkFiles(SOURCE)) {
    const content = readUtf8(path.join(SOURCE, ...rel.split('/')));
    files[rel] = { content, bodySha: sha256Hex(bodyAfterFrontmatter(content)) };
  }
  return files;
}

after(() => {
  for (const dir of createdWorkDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// --- contract tests ---------------------------------------------------------------

test('contract: dryRun writes zero files and reports changedFiles=[]', async () => {
  const impl = requireImpl();
  const root = makeWorkDir();

  const result = await impl({ root, dryRun: true, mapPath: FULL_MAP });

  assert.deepEqual(result.changedFiles, [], 'dryRun must not report any changed file');
  // No byte may change anywhere under root.
  for (const rel of walkFiles(root)) {
    assert.equal(
      readUtf8(path.join(root, ...rel.split('/'))),
      readUtf8(path.join(SOURCE, ...rel.split('/'))),
      `dryRun must not modify ${rel}`,
    );
  }
  // dryRun still previews the plan for every pending migration.
  assert.deepEqual(
    Object.keys(result.diff ?? {}).sort(),
    EXPECTED_CHANGED_FILES,
    'dryRun diff must preview all pending migrations',
  );
});

test('contract: real run byte-matches expected/ (frontmatter) and preserves body SHA-256', async () => {
  const impl = requireImpl();
  const root = makeWorkDir();
  const snapshot = sourceSnapshot();

  const result = await impl({ root, dryRun: false, mapPath: FULL_MAP });

  assert.deepEqual(
    result.changedFiles.sort(),
    EXPECTED_CHANGED_FILES,
    'real run must touch exactly the 3 mapped files',
  );

  for (const rel of EXPECTED_CHANGED_FILES) {
    const actual = readUtf8(path.join(root, ...rel.split('/')));
    const expected = readUtf8(path.join(EXPECTED, ...rel.split('/')));

    // Frontmatter contract: migrated file is byte-identical to the expected fixture.
    assert.equal(actual, expected, `migrated ${rel} must byte-match expected/${rel}`);

    // Markdown/MDX body byte preservation: migration may only rewrite frontmatter.
    // Standalone YAML entries have no frontmatter/body boundary; their full output
    // is already verified byte-for-byte against the expected fixture above.
    if (/\.mdx?$/.test(rel)) {
      assert.equal(
        sha256Hex(bodyAfterFrontmatter(actual)),
        snapshot[rel].bodySha,
        `body of ${rel} must be byte-preserved (SHA-256 identical)`,
      );
    }

    // diff contract: before = original content, after = migrated content.
    assert.equal(result.diff[rel]?.after, expected, `diff[${rel}].after must equal migrated content`);
    assert.equal(result.diff[rel]?.before, snapshot[rel].content, `diff[${rel}].before must equal original content`);
  }
});

test('contract: re-running the migration is a no-op (changedFiles=[])', async () => {
  const impl = requireImpl();
  const root = makeWorkDir();

  await impl({ root, dryRun: false, mapPath: FULL_MAP });

  const second = await impl({ root, dryRun: false, mapPath: FULL_MAP });
  assert.deepEqual(second.changedFiles, [], 'second real run must not change anything');
  assert.deepEqual(Object.keys(second.diff ?? {}), [], 'second real run must report no pending diff');

  const dry = await impl({ root, dryRun: true, mapPath: FULL_MAP });
  assert.deepEqual(dry.changedFiles, [], 'dryRun after migration must report no changes');
  assert.deepEqual(Object.keys(dry.diff ?? {}), [], 'dryRun after migration must report no pending diff');
});

test('contract: file missing from mapping is flagged reviewStatus=human-review-needed', async () => {
  const impl = requireImpl();
  const root = makeWorkDir();

  const result = await impl({ root, dryRun: false, mapPath: PARTIAL_MAP });

  // Unmapped file must be reported and touched so humans can find it.
  assert.ok(
    result.changedFiles.includes('glossary/roas.yaml'),
    `unmapped glossary/roas.yaml must appear in changedFiles, got: ${JSON.stringify(result.changedFiles)}`,
  );
  // Mapped files still migrate normally.
  assert.deepEqual(
    result.changedFiles.sort(),
    ['docs/ai-search/geo-basic.mdx', 'docs/ai-search/index.mdx', 'glossary/roas.yaml'].sort(),
    'partial map: mapped docs plus the unmapped glossary must all be reported',
  );

  const migrated = readUtf8(path.join(root, 'glossary', 'roas.yaml'));
  const fm = parseFrontmatter(migrated);
  assert.equal(fm.reviewStatus, 'human-review-needed', 'unmapped file must carry reviewStatus=human-review-needed');
  // Existing content untouched (term/definition preserved verbatim).
  assert.match(migrated, /^term: "ROAS"$/m);
  assert.match(migrated, /^definition: "광고비 대비 발생한 매출의 비율\(Return On Ad Spend\)\. ROAS = \(광고로 인한 매출 ÷ 광고비\) × 100\."$/m);
});

test('contract: removeFields strips legacy top-level fields before canonical merge and is never serialized', async () => {
  const impl = requireImpl();
  const root = makeWorkDir();

  const result = await impl({ root, dryRun: false, mapPath: FULL_MAP });
  assert.deepEqual(result.changedFiles.sort(), EXPECTED_CHANGED_FILES);

  // Per-file contract: removed = fields explicitly listed (plus unknown/missing keys
  // which must be a safe no-op); kept = fields not listed; canonical = merged set.
  const cases = [
    {
      rel: 'docs/ai-search/geo-basic.mdx',
      removed: ['category', 'summary', 'related', 'isTool', 'toolType'],
      kept: ['title', 'description', 'tags', 'audience'],
      canonical: ['contentKind', 'categoryId', 'primaryQuery', 'reviewStatus', 'status'],
    },
    {
      rel: 'docs/ai-search/index.mdx',
      removed: ['category', 'summary', 'related', 'isTool', 'toolType', 'noSuchLegacyField'],
      kept: ['title', 'description', 'tags', 'audience'],
      canonical: ['contentKind', 'categoryId', 'primaryQuery', 'reviewStatus', 'status'],
    },
    {
      rel: 'glossary/roas.yaml',
      removed: ['category', 'related', 'unknownLegacyKey'],
      kept: ['term', 'definition', 'aliases'],
      canonical: ['categoryId', 'reviewStatus', 'status'],
    },
  ];

  for (const c of cases) {
    const text = readUtf8(path.join(root, ...c.rel.split('/')));
    const fm = parseFrontmatter(text);
    for (const field of c.removed) {
      assert.equal(fm[field], undefined, `${c.rel}: legacy field "${field}" must be removed`);
    }
    for (const field of c.kept) {
      assert.ok(fm[field] !== undefined, `${c.rel}: non-listed field "${field}" must be preserved`);
    }
    for (const field of c.canonical) {
      assert.ok(fm[field] !== undefined, `${c.rel}: canonical field "${field}" must be present`);
    }
    assert.equal(fm.removeFields, undefined, `${c.rel}: removeFields must never be serialized`);
  }
});
