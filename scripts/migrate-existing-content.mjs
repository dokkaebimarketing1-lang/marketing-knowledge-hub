// scripts/migrate-existing-content.mjs
//
// Wave1 TODO5 — 기존 콘텐츠 결정적 이관 도구 (RED 계약 → GREEN).
//
// 계약 (tests/migration/migration.test.mjs 참조):
//   migrateExistingContent({ root, dryRun, mapPath }) -> Promise<{
//     changedFiles: string[],                       // 실제로 쓴 파일 (POSIX 상대 경로, 정렬)
//     diff: Record<string, { before, after }>,      // 변경 대상별 전체 파일 내용
//   }>
//
// 정책:
//   - dryRun: 아무 파일도 쓰지 않고 changedFiles=[] 로 반환하되, diff 로 계획을 미리 보여준다.
//   - 매핑 파일(map)에 있는 파일: canonical 필드를 결정적 순서로 병합한다.
//   - 매핑에 없는 파일: reviewStatus=human-review-needed 만 플래그로 추가한다 (값 추측 금지).
//   - 본문(body) 바이트는 그대로 보존한다 (SHA-256 동일).
//   - 원본 YAML 노드 스타일(flow/block/quoting)은 보존하고, 새 배열 필드는 flow 스타일로 쓴다.
//   - 재실행은 no-op 이다 (이미 이관된 파일은 다시 쓰지 않는다).
//   - 쓰기는 임시 파일 + rename 으로 원자적으로 수행한다.
//
// CLI:
//   node scripts/migrate-existing-content.mjs --root <content-dir> --map <map.json> [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { walkFiles } from './lib/content-files.mjs';

// --- canonical 필드 순서 (plan: scalable-knowledge-architecture.md) -----------------

// 지식 문서(md/mdx/markdown) 계약 필드 순서.
const DOC_ORDER = [
  'contentKind',
  'categoryId',
  'queryClusterId',
  'primaryQuery',
  'searchIntent',
  'primaryQuestion',
  'shortAnswer',
  'primaryEntityId',
  'authorId',
  'publishedAt',
  'updatedAt',
  'reviewedAt',
  'reviewStatus',
  'sourceIds',
  'relatedIds',
  'status',
  'redirectFrom',
];

// 용어사전(yaml) 계약 필드 순서.
const GLOSSARY_ORDER = [
  'categoryId',
  'sourceIds',
  'relatedIds',
  'updatedAt',
  'reviewedAt',
  'reviewStatus',
  'status',
  'redirectFrom',
];

const FRONTMATTER_EXTS = new Set(['md', 'mdx', 'markdown']);
const YAML_EXTS = new Set(['yaml', 'yml']);
const PROCESSED_EXTS = new Set([...FRONTMATTER_EXTS, ...YAML_EXTS]);

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

// 매핑에 빠진 canonical 필드의 기본값 (추측 금지: null / 빈 배열만 사용).
function defaultFor(key) {
  return key === 'redirectFrom' ? [] : null;
}

/**
 * 원본 텍스트 + 매핑 항목을 받아 이관 후 전체 파일 내용을 반환한다.
 * 원본 YAML 노드 스타일은 parseDocument 로 보존하고, 추가/갱신 필드는
 * yaml-1.1 스키마(날짜 문자열 인용) + flowCollectionPadding:false(공백 없는 flow 배열)로 직렬화한다.
 */
function migrateText(text, extension, order, mapEntry) {
  let block;
  let body = null;

  if (FRONTMATTER_EXTS.has(extension)) {
    const m = FRONTMATTER_RE.exec(text);
    if (m) {
      block = m[1];
      body = text.slice(m[0].length); // 닫는 `---\n` 이후의 바이트 그대로
    } else {
      // frontmatter가 없는 문서: 본문 전체를 보존하고 새 frontmatter를 앞에 붙인다.
      block = '';
      body = text;
    }
  } else {
    block = text;
  }

  const doc = YAML.parseDocument(block, { schema: 'yaml-1.1' });

  // 빈 문서(yaml-1.1 스키마에서 contents가 null)는 set 전에 일반 map으로 초기화해
  // `!!omap` 태그가 붙는 것을 방지한다.
  if (doc.contents === null) doc.contents = doc.createNode({}, { flow: false });

  if (mapEntry) {
    // removeFields: 레거시 탑레벨 필드를 결정적으로 제거한다 (canonical 병합보다 먼저).
    // - 명시된 필드만 탑레벨에서 지우고, 없는 키는 안전한 no-op 이다 (삭제 실패 시 예외 없음).
    // - removeFields 키 자체는 order 에 없으므로 절대 직렬화되지 않는다.
    const removeFields = Array.isArray(mapEntry.removeFields) ? mapEntry.removeFields : [];
    for (const field of removeFields) {
      if (typeof field === 'string') doc.delete(field);
    }
    // 매핑된 파일: canonical 필드를 결정적 순서로 병합 (원본에 없는 키는 끝에 추가).
    for (const key of order) {
      const value = Object.prototype.hasOwnProperty.call(mapEntry, key)
        ? mapEntry[key]
        : defaultFor(key);
      doc.set(key, doc.createNode(value, { flow: true }));
    }
  } else if (doc.get('reviewStatus', true) === undefined) {
    // 매핑에 없는 파일: 리뷰 필요 플래그만 추가 (값 추측 금지).
    doc.set('reviewStatus', doc.createNode('human-review-needed'));
  }

  const blockOut = doc.toString({ flowCollectionPadding: false });

  if (body === null) return blockOut;
  return `---\n${blockOut}---\n${body}`;
}

/** 같은 디렉토리에 임시 파일을 쓰고 rename 으로 교체한다 (원자적 쓰기). */
function atomicWrite(targetPath, content) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  );
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 정리 실패는 무시 */
    }
    throw err;
  }
}

/**
 * 기존 콘텐츠를 결정적으로 이관한다.
 * @param {{ root: string, dryRun?: boolean, mapPath?: string }} opts
 */
export async function migrateExistingContent({ root, dryRun = false, mapPath } = {}) {
  if (!root) throw new Error('migrateExistingContent: `root` is required');
  const rootAbs = path.resolve(root);
  if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
    throw new Error(`migrateExistingContent: \`root\` is not a directory: ${root}`);
  }

  const map = mapPath ? JSON.parse(fs.readFileSync(path.resolve(mapPath), 'utf8')) : {};

  // rel -> { before, after } (POSIX 상대 경로)
  const pending = new Map();

  for (const rel of walkFiles(rootAbs)) {
    const extension = path.extname(rel).slice(1).toLowerCase();
    if (!PROCESSED_EXTS.has(extension)) continue; // registry/json·기타 파일은 건드리지 않는다
    // README 문서(예: registries/people/README.md)는 정책 문서이지 콘텐츠가 아니므로 이관 대상에서 제외한다.
    if (/^README(?:\.|$)/i.test(path.basename(rel))) continue;

    const abs = path.join(rootAbs, ...rel.split('/'));
    const before = fs.readFileSync(abs, 'utf8');
    const mapEntry = Object.prototype.hasOwnProperty.call(map, rel) ? map[rel] : undefined;
    const order = FRONTMATTER_EXTS.has(extension) ? DOC_ORDER : GLOSSARY_ORDER;
    const after = migrateText(before, extension, order, mapEntry);

    if (after !== before) pending.set(rel, { before, after });
  }

  const changedFiles = [...pending.keys()].sort(); // POSIX 정렬, 결정적

  if (!dryRun) {
    for (const rel of changedFiles) {
      atomicWrite(path.join(rootAbs, ...rel.split('/')), pending.get(rel).after);
    }
  }

  const diff = Object.fromEntries(
    [...pending.entries()].map(([rel, { before, after }]) => [rel, { before, after }]),
  );

  return { changedFiles: dryRun ? [] : changedFiles, diff };
}

// --- CLI --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { root: undefined, map: undefined, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--root') args.root = argv[++i];
    else if (arg === '--map') args.map = argv[++i];
    else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length);
    else if (arg.startsWith('--map=')) args.map = arg.slice('--map='.length);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: node scripts/migrate-existing-content.mjs --root <content-dir> --map <map.json> [--dry-run]',
    );
    return;
  }
  const root = args.root ?? process.cwd();
  if (!args.map) {
    throw new Error('migrate-existing-content: --map <map.json> is required');
  }

  const result = await migrateExistingContent({
    root,
    dryRun: args.dryRun,
    mapPath: args.map,
  });

  const mode = args.dryRun ? 'DRY-RUN (no files written)' : 'MIGRATED';
  console.log(`[migrate-existing-content] ${mode}`);
  console.log(`root: ${path.resolve(root)}`);
  console.log(`map: ${path.resolve(args.map)}`);
  console.log(`changedFiles: ${result.changedFiles.length}`);
  for (const rel of result.changedFiles) console.log(`  changed  ${rel}`);
  for (const rel of Object.keys(result.diff).sort()) {
    if (!result.changedFiles.includes(rel)) console.log(`  preview  ${rel}`);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(`[migrate-existing-content] ERROR: ${err.message}`);
    process.exitCode = 1;
  });
}
