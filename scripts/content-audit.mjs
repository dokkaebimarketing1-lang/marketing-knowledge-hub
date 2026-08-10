// scripts/content-audit.mjs
//
// Wave2 TODO4 — 콘텐츠 불변조건 audit CLI (fail-closed)
//
// Contract (tests/content-audit/*.test.mjs):
//   export function auditWorkspace(root, { kind? }) -> Promise<{ violations: Array<{ rule, file, message }> }>
//
// Rule IDs:
//   DUPLICATE_INTENT    normalized primaryQuery + searchIntent 조합 중복
//   BROKEN_REFERENCE    알 수 없는 relatedIds 문서 / queryClusterId / cluster entityId / cluster leafSlug 참조,
//                       primaryEntityId·authorId가 entities·people 레지스트리(active)로 해소 불가
//   ORPHAN_LEAF         queryClusterId 귀속 문서가 cluster leafSlugs에 없거나, leafSlugs가 다른 클러스터를 참조
//   MISSING_SOURCE      active 문서/용어의 sourceIds가 비어 있거나 sources 레지스트리로 해소 불가,
//                       source status가 active가 아님
//   CATEGORY_DRIFT      문서 경로 카테고리 vs categoryId vs cluster.categoryId 불일치
//   INVALID_RELATED     self / 중복 / draft·deprecated 대상 relatedIds (native draft:true 포함)
//   RAW_LEAKAGE         src/public·public 아래 raw 디렉토리, public 소스의 /raw/ 링크, 본문의 /raw/ 링크·raw import
//   PARSE_ERROR         docs/glossary/registry 파싱 실패 (swallow 금지)
//   INVALID_REGISTRY    live per-record registry를 validateRegistries로 검증한 오류 매핑
//   INVALID_ARGUMENT    auditWorkspace에 잘못된 kind 전달
//   REPUBLICATION       root/raw 존재 시 20-token 이상 연속 n-gram이 public 문서에 복제
//
// CLI: node scripts/content-audit.mjs [root] [--kind docs|glossary] [--format text|json]
//   - violations 존재 시 exit 1, 없으면 exit 0
//   - 잘못된 --kind/--format → exit 2 + stderr (fail-closed)
//   - root 기본값: cwd (프로젝트 루트 → src/content/docs, glossary, registries 매핑)
//
// 레이아웃 정규화:
//   - 콘텐츠: <root>/docs 또는 <root>/src/content/docs (kind: docs / undefined)
//   - glossary: <root>/src/content/glossary 또는 <root>/glossary (kind: glossary)
//   - 레지스트리: <root>/registries 또는 <root>/src/content/registries
//     * collection 형식: registries/sources.json = { "sources": [...] }
//     * per-id 형식:     registries/sources/<id>.json = { "id": ... } (registry-validation.mjs 계약)
//     * per-id 형식(live)은 validateRegistries로 스키마 검증 후 INVALID_REGISTRY로 매핑
//
// 공유 파서/validator 재사용:
//   - scripts/lib/content-files.mjs  : walkFiles / parseContentFile
//   - scripts/lib/registry-validation.mjs : validateRegistries (live registry 스키마 검증)

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { walkFiles, parseContentFile } from './lib/content-files.mjs';
import { validateRegistries } from './lib/registry-validation.mjs';

const CONTENT_EXTS = new Set(['md', 'mdx', 'markdown']);
const YAML_EXTS = new Set(['yaml', 'yml']);

/** REPUBLICATION n-gram 최소 토큰 수 (연속 일치 기준) */
const REPUBLICATION_MIN_TOKENS = 20;

/** /raw/ 링크·import 패턴 (docs/glossary 본문 + public 소스 공용) */
const RAW_REF_RE = /\/raw\/|(?:from|import)\s+['"][^'"]*raw\/|require\s*\(\s*['"][^'"]*raw\//;

/** OS에 무관하게 POSIX 경로(/)로 정규화 */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** intent 정규화: 소문자 + 양끝 trim + 연속 공백 축약 */
function normalizeIntent(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** slug 참조 정규화: 선행 / · ./ 제거, 확장자 제거, POSIX 통일 */
function normalizeSlugRef(ref) {
  let s = String(ref).trim();
  if (!s) return '';
  s = s.split(path.sep).join('/');
  if (s.startsWith('/')) s = s.slice(1);
  if (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\.(md|mdx|markdown)$/i, '');
  return s;
}

/** 존재하는 디렉토리 후보 중 첫 번째를 반환 (없으면 null) */
function pickDir(candidates) {
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* 없으면 다음 후보 */
    }
  }
  return null;
}

function isProjectRoot(root) {
  for (const rel of ['package.json', 'src', 'docs', 'registries', 'glossary']) {
    try {
      fs.statSync(path.join(root, rel));
      return true;
    } catch {
      /* 계속 */
    }
  }
  return false;
}

/**
 * root 아래의 레이아웃 디렉토리를 해석한다.
 * 반환: { docsRoot, glossaryRoot, registriesRoot } (없으면 null)
 */
function resolveRoots(root) {
  const docsRoot = pickDir([path.join(root, 'docs'), path.join(root, 'src', 'content', 'docs')]);
  const glossaryRoot = pickDir([
    path.join(root, 'src', 'content', 'glossary'),
    path.join(root, 'glossary'),
  ]);
  const registriesRoot = pickDir([
    path.join(root, 'src', 'content', 'registries'),
    path.join(root, 'registries'),
  ]);

  if (docsRoot || glossaryRoot || registriesRoot || isProjectRoot(root)) {
    return { docsRoot, glossaryRoot, registriesRoot };
  }

  // root 자체가 docs/glossary 디렉토리로 직접 호출된 경우
  let files = [];
  try {
    if (fs.statSync(root).isDirectory()) files = walkFiles(root);
  } catch {
    /* root 미존재 → 빈 결과 */
  }
  const hasMd = files.some((f) => CONTENT_EXTS.has(path.extname(f).slice(1).toLowerCase()));
  const hasYaml = files.some((f) => YAML_EXTS.has(path.extname(f).slice(1).toLowerCase()));
  return {
    docsRoot: hasMd ? root : null,
    glossaryRoot: hasYaml && !hasMd ? root : null,
    registriesRoot: null,
  };
}

/**
 * 문서 콘텐츠를 로드한다.
 * 각 문서: { file(root 기준 POSIX), slug(docs root 기준 확장자 제거 POSIX), data, body }
 * 파싱 실패 파일은 PARSE_ERROR violations에 기록한다 (swallow 금지).
 */
function loadDocs(root, docsRoot, violations) {
  if (!docsRoot || !fs.existsSync(docsRoot)) return [];
  const docs = [];
  for (const rel of walkFiles(docsRoot)) {
    const ext = path.extname(rel).slice(1).toLowerCase();
    if (!CONTENT_EXTS.has(ext)) continue;
    const abs = path.join(docsRoot, ...rel.split('/'));
    let parsed;
    try {
      parsed = parseContentFile(abs);
    } catch (err) {
      violations.push({
        rule: 'PARSE_ERROR',
        file: toPosix(path.relative(root, abs)),
        message: `문서 파싱 실패: ${err.message}`,
      });
      continue;
    }
    const slug = rel.slice(0, -(ext.length + 1));
    docs.push({
      file: toPosix(path.relative(root, abs)),
      slug,
      data: parsed.data ?? {},
      body: parsed.body ?? '',
    });
  }
  return docs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * glossary 용어를 로드한다.
 * 각 용어: { file(root 기준 POSIX), slug(stem = term id), data, body }
 * 파싱 실패 파일은 PARSE_ERROR violations에 기록한다 (swallow 금지).
 */
function loadGlossary(root, glossaryRoot, violations) {
  if (!glossaryRoot || !fs.existsSync(glossaryRoot)) return [];
  const terms = [];
  for (const rel of walkFiles(glossaryRoot)) {
    const ext = path.extname(rel).slice(1).toLowerCase();
    if (!YAML_EXTS.has(ext)) continue;
    const abs = path.join(glossaryRoot, ...rel.split('/'));
    let parsed;
    try {
      parsed = parseContentFile(abs);
    } catch (err) {
      violations.push({
        rule: 'PARSE_ERROR',
        file: toPosix(path.relative(root, abs)),
        message: `glossary 파싱 실패: ${err.message}`,
      });
      continue;
    }
    const slug = path.basename(rel, path.extname(rel));
    terms.push({
      file: toPosix(path.relative(root, abs)),
      slug,
      data: parsed.data ?? {},
      body: parsed.body ?? '',
    });
  }
  return terms.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * 레지스트리 모델을 로드한다 (collection / per-id 두 형식 정규화).
 * 반환: { sources: Map<id, rec>, clusters: Map<id, { rec, regFile }>,
 *         taxonomy: Map<id, rec>, entities: Map<id, rec>, people: Map<id, rec> }
 * 파싱 실패 파일은 PARSE_ERROR violations에 기록한다 (swallow 금지).
 */
function loadRegistryModel(root, registriesRoot, violations) {
  const model = {
    sources: new Map(),
    clusters: new Map(),
    taxonomy: new Map(),
    entities: new Map(),
    people: new Map(),
  };
  if (!registriesRoot || !fs.existsSync(registriesRoot)) return model;

  const stemToKind = {
    sources: 'sources',
    'query-clusters': 'query-clusters',
    clusters: 'query-clusters',
    taxonomy: 'taxonomy',
    entities: 'entities',
    people: 'people',
  };

  for (const rel of walkFiles(registriesRoot)) {
    if (!rel.endsWith('.json')) continue;
    const abs = path.join(registriesRoot, ...rel.split('/'));
    let data;
    try {
      data = parseContentFile(abs).data;
    } catch (err) {
      violations.push({
        rule: 'PARSE_ERROR',
        file: toPosix(path.relative(root, abs)),
        message: `registry 파싱 실패: ${err.message}`,
      });
      continue;
    }
    if (data === null || typeof data !== 'object') continue;

    const parts = rel.split('/');
    const regFile = toPosix(path.relative(root, abs));
    let kind;
    let records;
    if (parts.length === 1) {
      // collection 형식: registries/sources.json = { "sources": [...] }
      const stem = path.basename(rel, '.json');
      kind = stemToKind[stem];
      records = Array.isArray(data)
        ? data
        : Object.values(data).find((v) => Array.isArray(v)) ?? [];
    } else {
      // per-id 형식: registries/<kind>/<id>.json = { ... }
      kind = parts[0];
      records = [data];
    }
    if (!kind) continue;

    for (const rec of records) {
      if (!rec || typeof rec !== 'object') continue;
      const id = typeof rec.id === 'string' ? rec.id : null;
      if (!id) continue;
      if (kind === 'sources') model.sources.set(id, rec);
      else if (kind === 'query-clusters') model.clusters.set(id, { ...rec, regFile });
      else if (kind === 'taxonomy') model.taxonomy.set(id, rec);
      else if (kind === 'entities') model.entities.set(id, rec);
      else if (kind === 'people') model.people.set(id, rec);
    }
  }
  return model;
}

// --- Rule audits -------------------------------------------------------------

function auditDuplicateIntent(docs, violations) {
  const groups = new Map(); // key -> { pq, si, docs }
  for (const doc of docs) {
    const { primaryQuery: pq, searchIntent: si } = doc.data;
    if (typeof pq !== 'string' || !pq.trim()) continue;
    if (typeof si !== 'string' || !si.trim()) continue;
    const key = `${normalizeIntent(pq)}\u0000${normalizeIntent(si)}`;
    if (!groups.has(key)) groups.set(key, { pq: pq.trim(), si: si.trim(), docs: [] });
    groups.get(key).docs.push(doc);
  }
  for (const { pq, si, docs: group } of groups.values()) {
    if (group.length < 2) continue;
    for (const doc of group) {
      const others = group
        .map((d) => d.file)
        .filter((f) => f !== doc.file);
      violations.push({
        rule: 'DUPLICATE_INTENT',
        file: doc.file,
        message: `primaryQuery "${pq}" + searchIntent "${si}" 조합이 중복됩니다 (다른 문서: ${others.join(', ')})`,
      });
    }
  }
}

function auditBrokenReferences(docs, model, violations) {
  const docSlugs = new Set(docs.map((d) => d.slug));

  for (const doc of docs) {
    const clusterId = doc.data.queryClusterId;
    if (typeof clusterId === 'string' && clusterId && !model.clusters.has(clusterId)) {
      violations.push({
        rule: 'BROKEN_REFERENCE',
        file: doc.file,
        message: `queryClusterId "${clusterId}"는 query-clusters 레지스트리에 존재하지 않습니다`,
      });
    }

    // primaryEntityId: non-null이면 entities 레지스트리에서 active로 해소되어야 한다
    const entityId = doc.data.primaryEntityId;
    if (typeof entityId === 'string' && entityId) {
      const entity = model.entities.get(entityId);
      if (!entity) {
        violations.push({
          rule: 'BROKEN_REFERENCE',
          file: doc.file,
          message: `primaryEntityId "${entityId}"는 entities 레지스트리에 존재하지 않습니다`,
        });
      } else if ((entity.status ?? 'active') !== 'active') {
        violations.push({
          rule: 'BROKEN_REFERENCE',
          file: doc.file,
          message: `primaryEntityId "${entityId}"의 status는 "${entity.status}"입니다 (active 엔티티 필요)`,
        });
      }
    }

    // authorId: nullable 허용, non-null이면 people 레지스트리에서 active로 해소되어야 한다
    const authorId = doc.data.authorId;
    if (typeof authorId === 'string' && authorId) {
      const author = model.people.get(authorId);
      if (!author) {
        violations.push({
          rule: 'BROKEN_REFERENCE',
          file: doc.file,
          message: `authorId "${authorId}"는 people 레지스트리에 존재하지 않습니다`,
        });
      } else if ((author.status ?? 'active') !== 'active') {
        violations.push({
          rule: 'BROKEN_REFERENCE',
          file: doc.file,
          message: `authorId "${authorId}"의 status는 "${author.status}"입니다 (active 저자 필요)`,
        });
      }
    }

    const related = doc.data.relatedIds;
    if (Array.isArray(related)) {
      for (const ref of related) {
        const slug = normalizeSlugRef(ref);
        if (slug && !docSlugs.has(slug)) {
          violations.push({
            rule: 'BROKEN_REFERENCE',
            file: doc.file,
            message: `relatedIds 참조 "${ref}"는 존재하지 않는 문서입니다`,
          });
        }
      }
    }
  }

  for (const [id, cluster] of model.clusters) {
    const regFile = cluster.regFile ?? 'registries/query-clusters.json';
    const clusterEntityId = cluster.primaryEntityId ?? cluster.entityId;
    const clusterEntityField = cluster.primaryEntityId !== undefined ? 'primaryEntityId' : 'entityId';
    if (typeof clusterEntityId === 'string' && clusterEntityId) {
      const entity = model.entities.get(clusterEntityId);
      if (!entity) {
        violations.push({
          rule: 'BROKEN_REFERENCE',
          file: regFile,
          message: `query-cluster "${id}"의 ${clusterEntityField} "${clusterEntityId}"는 entities 레지스트리에 존재하지 않습니다`,
        });
      } else if ((entity.status ?? 'active') !== 'active') {
        violations.push({
          rule: 'BROKEN_REFERENCE',
          file: regFile,
          message: `query-cluster "${id}"의 ${clusterEntityField} "${clusterEntityId}"의 status는 "${entity.status}"입니다 (active 엔티티 필요)`,
        });
      }
    }
    if (Array.isArray(cluster.leafSlugs)) {
      for (const leaf of cluster.leafSlugs) {
        const slug = normalizeSlugRef(leaf);
        if (slug && !docSlugs.has(slug)) {
          violations.push({
            rule: 'BROKEN_REFERENCE',
            file: regFile,
            message: `query-cluster "${id}"의 leafSlug "${leaf}"가 문서로 존재하지 않습니다`,
          });
        }
      }
    }
  }
}

function auditOrphanLeaves(docs, model, violations) {
  for (const doc of docs) {
    const clusterId = doc.data.queryClusterId;
    if (typeof clusterId !== 'string' || !clusterId) continue;
    const cluster = model.clusters.get(clusterId);
    if (!cluster) continue; // 이미 BROKEN_REFERENCE로 처리
    const leafSlugs = Array.isArray(cluster.leafSlugs)
      ? cluster.leafSlugs.map(normalizeSlugRef)
      : [];
    if (!leafSlugs.includes(doc.slug)) {
      violations.push({
        rule: 'ORPHAN_LEAF',
        file: doc.file,
        message: `queryClusterId "${clusterId}" 클러스터의 leafSlugs에 문서 "${doc.slug}"가 선언되지 않았습니다`,
      });
    }
  }

  // 역방향: leafSlugs에 선언된 slug가 해당 클러스터를 queryClusterId로 참조하지 않는 경우
  const claimedBy = new Map(); // slug -> [clusterId, ...]
  for (const [id, cluster] of model.clusters) {
    if (!Array.isArray(cluster.leafSlugs)) continue;
    for (const leaf of cluster.leafSlugs) {
      const slug = normalizeSlugRef(leaf);
      if (!slug) continue;
      if (!claimedBy.has(slug)) claimedBy.set(slug, []);
      claimedBy.get(slug).push(id);
    }
  }
  const docBySlug = new Map(docs.map((d) => [d.slug, d]));
  for (const [slug, clusterIds] of claimedBy) {
    const doc = docBySlug.get(slug);
    if (!doc) continue; // leafSlug가 문서로 없으면 BROKEN_REFERENCE가 처리
    const claimed = doc.data.queryClusterId;
    for (const clusterId of clusterIds) {
      if (claimed !== clusterId) {
        violations.push({
          rule: 'ORPHAN_LEAF',
          file: doc.file,
          message: `문서 "${slug}"는 클러스터 "${clusterId}"의 leafSlugs에 있지만 queryClusterId는 "${claimed ?? '(없음)'}"입니다`,
        });
      }
    }
  }
}

function auditMissingSources(docs, model, violations) {
  for (const doc of docs) {
    if (doc.data.status === 'deprecated') continue; // active 콘텐츠만 검사
    const sourceIds = doc.data.sourceIds;
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      violations.push({
        rule: 'MISSING_SOURCE',
        file: doc.file,
        message: 'sourceIds가 비어 있습니다 (active 문서는 최소 1개 출처 필요)',
      });
      continue;
    }
    for (const sid of sourceIds) {
      const rec = model.sources.get(sid);
      if (!rec) {
        violations.push({
          rule: 'MISSING_SOURCE',
          file: doc.file,
          message: `sourceIds "${sid}"는 sources 레지스트리에 존재하지 않습니다`,
        });
        continue;
      }
      const status = rec.status ?? 'active'; // schema 기본값은 active
      if (status !== 'active') {
        violations.push({
          rule: 'MISSING_SOURCE',
          file: doc.file,
          message: `sourceIds "${sid}"의 status는 "${status}"입니다 (active 출처만 허용)`,
        });
      }
    }
  }
}

function auditCategoryDrift(docs, model, violations) {
  for (const doc of docs) {
    const pathCategory = doc.slug.split('/')[0];
    const categoryId = doc.data.categoryId;
    if (typeof categoryId !== 'string' || !categoryId) continue;

    if (pathCategory !== categoryId) {
      violations.push({
        rule: 'CATEGORY_DRIFT',
        file: doc.file,
        message: `문서 경로 카테고리 "${pathCategory}"와 categoryId "${categoryId}"가 일치하지 않습니다`,
      });
    }

    const clusterId = doc.data.queryClusterId;
    if (typeof clusterId === 'string' && clusterId) {
      const cluster = model.clusters.get(clusterId);
      if (
        cluster &&
        typeof cluster.categoryId === 'string' &&
        cluster.categoryId &&
        cluster.categoryId !== categoryId
      ) {
        violations.push({
          rule: 'CATEGORY_DRIFT',
          file: doc.file,
          message: `문서 categoryId "${categoryId}"와 클러스터 "${clusterId}"의 categoryId "${cluster.categoryId}"가 일치하지 않습니다`,
        });
      }
    }
  }
}

function auditInvalidRelated(docs, violations) {
  const docBySlug = new Map(docs.map((d) => [d.slug, d]));
  for (const doc of docs) {
    const related = doc.data.relatedIds;
    if (!Array.isArray(related)) continue;
    const seen = new Set();
    for (const ref of related) {
      const slug = normalizeSlugRef(ref);
      if (!slug) continue;

      if (slug === doc.slug) {
        violations.push({
          rule: 'INVALID_RELATED',
          file: doc.file,
          message: `relatedIds에 자기 자신 "${ref}"을(를) 참조합니다`,
        });
      }
      if (seen.has(slug)) {
        violations.push({
          rule: 'INVALID_RELATED',
          file: doc.file,
          message: `relatedIds에 중복 참조 "${ref}"가 있습니다`,
        });
      }
      seen.add(slug);

      const target = docBySlug.get(slug);
      if (
        target &&
        (target.data.status === 'draft' ||
          target.data.status === 'deprecated' ||
          target.data.draft === true)
      ) {
        const why = target.data.draft === true
          ? 'native draft:true'
          : `status "${target.data.status}"`;
        violations.push({
          rule: 'INVALID_RELATED',
          file: doc.file,
          message: `relatedIds 대상 "${ref}"은(는) ${why}입니다 (draft/deprecated 문서 참조 금지)`,
        });
      }
    }
  }
}

function auditRawLeakage(root, docs, violations) {
  // 공개 소스 경로(src/public, public)에 raw 자료 디렉토리/파일 노출
  for (const publicRoot of ['src/public', 'public']) {
    const base = path.join(root, ...publicRoot.split('/'));
    try {
      if (!fs.statSync(base).isDirectory()) continue;
      for (const rel of walkFiles(base)) {
        const parts = rel.split('/');
        if (!parts.some((part) => part.toLowerCase() === 'raw')) continue;
        const file = `${publicRoot}/${rel}`;
        violations.push({
          rule: 'RAW_LEAKAGE',
          file,
          message: `비공개 raw 자료가 공개 소스 경로에 있습니다: ${file}`,
        });
      }
    } catch {
      /* 존재하지 않으면 통과 */
    }
  }

  // public 소스 텍스트 파일 본문의 /raw/ 참조 스캔
  for (const publicRoot of ['src/public', 'public']) {
    const base = path.join(root, ...publicRoot.split('/'));
    try {
      if (!fs.statSync(base).isDirectory()) continue;
      for (const rel of walkFiles(base)) {
        const abs = path.join(base, ...rel.split('/'));
        let text;
        try {
          text = fs.readFileSync(abs, 'utf8');
        } catch {
          continue; // 바이너리/읽기 불가 파일은 스킵
        }
        if (text.includes('\0')) continue; // 바이너리
        if (RAW_REF_RE.test(text)) {
          violations.push({
            rule: 'RAW_LEAKAGE',
            file: `${publicRoot}/${rel}`,
            message: `public 소스 텍스트에 /raw/ 링크 또는 raw import가 포함되어 있습니다: ${publicRoot}/${rel}`,
          });
        }
      }
    } catch {
      /* 존재하지 않으면 통과 */
    }
  }

  for (const doc of docs) {
    if (RAW_REF_RE.test(doc.body)) {
      violations.push({
        rule: 'RAW_LEAKAGE',
        file: doc.file,
        message: '본문에 /raw/ 링크 또는 raw import가 포함되어 있습니다',
      });
    }
  }
}

// --- REPUBLICATION (raw republication n-gram guard) -----------------------------

/** HTML 태그/엔티티 제거 후 공백 기준 토큰 배열로 정규화 (결정적) */
function normalizeTextTokens(text) {
  return String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ') // HTML 태그 → 공백
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // 구두점 제거
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * REPUBLICATION: root/raw 존재 시 raw 원문과 public 문서의 정확히 연속된
 * >= 20-token n-gram 복제를 감지한다. root/raw 존재 자체는 위반이 아니다.
 */
function auditRepublication(root, docs, terms, violations) {
  const rawDir = path.join(root, 'raw');
  let rawStat;
  try {
    rawStat = fs.statSync(rawDir);
  } catch {
    return; // root/raw 없음 → 가드 비활성 (존재 자체는 허용)
  }
  if (!rawStat.isDirectory()) return;

  // raw 원문 파일 토큰 수집 (결정적 정렬)
  const rawFiles = [];
  for (const rel of walkFiles(rawDir)) {
    const abs = path.join(rawDir, ...rel.split('/'));
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // 바이너리 제외
    rawFiles.push({ file: toPosix(path.relative(root, abs)), tokens: normalizeTextTokens(text) });
  }

  // raw 20-gram 윈도우 → 원본 raw 파일 매핑 (첫 번째 정렬 파일 우선, 결정적)
  const windowMap = new Map(); // joined-window -> rawFile
  for (const rf of rawFiles.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    const { file, tokens } = rf;
    for (let i = 0; i + REPUBLICATION_MIN_TOKENS <= tokens.length; i++) {
      const window = tokens.slice(i, i + REPUBLICATION_MIN_TOKENS).join('\u0000');
      if (!windowMap.has(window)) windowMap.set(window, file);
    }
  }
  if (windowMap.size === 0) return;

  // public 문서 텍스트 수집: docs 본문 + 공개 frontmatter + glossary + public 텍스트 파일
  const publicTexts = [];
  for (const doc of docs) {
    const publicFrontmatter = [
      doc.data.title,
      doc.data.description,
      doc.data.primaryQuery,
      doc.data.primaryQuestion,
      doc.data.shortAnswer,
      ...(Array.isArray(doc.data.tags) ? doc.data.tags : []),
    ];
    const tokens = normalizeTextTokens(
      [doc.body, ...publicFrontmatter.filter((value) => typeof value === 'string')].join(' '),
    );
    if (tokens.length >= REPUBLICATION_MIN_TOKENS) publicTexts.push({ file: doc.file, tokens });
  }
  for (const term of terms) {
    const fields = [term.data.definition, ...(Array.isArray(term.data.aliases) ? term.data.aliases : [])];
    const tokens = normalizeTextTokens(fields.filter((s) => typeof s === 'string').join(' '));
    if (tokens.length >= REPUBLICATION_MIN_TOKENS) publicTexts.push({ file: term.file, tokens });
  }
  for (const publicRoot of ['src/public', 'public']) {
    const base = path.join(root, ...publicRoot.split('/'));
    try {
      if (!fs.statSync(base).isDirectory()) continue;
      for (const rel of walkFiles(base)) {
        const abs = path.join(base, ...rel.split('/'));
        let text;
        try {
          text = fs.readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\0')) continue;
        const tokens = normalizeTextTokens(text);
        if (tokens.length >= REPUBLICATION_MIN_TOKENS) {
          publicTexts.push({ file: `${publicRoot}/${rel}`, tokens });
        }
      }
    } catch {
      /* 존재하지 않으면 통과 */
    }
  }

  for (const pt of publicTexts.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    const { file, tokens } = pt;
    for (let i = 0; i + REPUBLICATION_MIN_TOKENS <= tokens.length; i++) {
      const window = tokens.slice(i, i + REPUBLICATION_MIN_TOKENS).join('\u0000');
      const rawFile = windowMap.get(window);
      if (rawFile) {
        violations.push({
          rule: 'REPUBLICATION',
          file,
          message: `raw 원문 "${rawFile}"의 ${REPUBLICATION_MIN_TOKENS}개 이상 연속 토큰이 그대로 복제되었습니다`,
        });
        break; // 문서당 1건 보고
      }
    }
  }
}

// --- Glossary rule audits ------------------------------------------------------

/**
 * glossary MISSING_SOURCE: active 용어는 sourceIds 최소 1개가 필요하고,
 * 모든 sourceId가 sources 레지스트리에 존재하며 status가 active여야 한다.
 */
function auditGlossaryMissingSources(terms, model, violations) {
  for (const term of terms) {
    if (term.data.status === 'deprecated') continue; // active 용어만 검사

    const sourceIds = term.data.sourceIds;
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      violations.push({
        rule: 'MISSING_SOURCE',
        file: term.file,
        message: 'sourceIds가 비어 있습니다 (active 용어는 최소 1개 출처 필요)',
      });
      continue;
    }
    for (const sid of sourceIds) {
      const rec = model.sources.get(sid);
      if (!rec) {
        violations.push({
          rule: 'MISSING_SOURCE',
          file: term.file,
          message: `sourceIds "${sid}"는 sources 레지스트리에 존재하지 않습니다`,
        });
        continue;
      }
      const status = rec.status ?? 'active'; // schema 기본값은 active
      if (status !== 'active') {
        violations.push({
          rule: 'MISSING_SOURCE',
          file: term.file,
          message: `sourceIds "${sid}"의 status는 "${status}"입니다 (active 출처만 허용)`,
        });
      }
    }
  }
}

/**
 * glossary CATEGORY_DRIFT: categoryId는 taxonomy 레지스트리에서
 * kind=glossary + status=active인 레코드로 해소되어야 한다.
 */
function auditGlossaryCategoryDrift(terms, model, violations) {
  for (const term of terms) {
    const categoryId = term.data.categoryId;
    if (typeof categoryId !== 'string' || !categoryId) {
      violations.push({
        rule: 'CATEGORY_DRIFT',
        file: term.file,
        message: 'categoryId가 없습니다 (glossary 용어는 categoryId 필수)',
      });
      continue;
    }
    const tax = model.taxonomy.get(categoryId);
    if (!tax) {
      violations.push({
        rule: 'CATEGORY_DRIFT',
        file: term.file,
        message: `categoryId "${categoryId}"는 taxonomy 레지스트리에 존재하지 않습니다`,
      });
      continue;
    }
    if (tax.kind !== 'glossary') {
      violations.push({
        rule: 'CATEGORY_DRIFT',
        file: term.file,
        message: `categoryId "${categoryId}"의 taxonomy kind는 "${tax.kind}"입니다 (glossary 용어는 kind=glossary 필요)`,
      });
      continue;
    }
    const status = tax.status ?? 'active';
    if (status !== 'active') {
      violations.push({
        rule: 'CATEGORY_DRIFT',
        file: term.file,
        message: `categoryId "${categoryId}"의 taxonomy status는 "${status}"입니다 (active taxonomy 필요)`,
      });
    }
  }
}

/**
 * glossary BROKEN_REFERENCE: relatedIds는 존재하는 glossary 용어(stem)로 해소되어야 한다.
 */
function auditGlossaryBrokenReferences(terms, violations) {
  const termSlugs = new Set(terms.map((t) => t.slug));
  for (const term of terms) {
    const related = term.data.relatedIds;
    if (!Array.isArray(related)) continue;
    for (const ref of related) {
      const slug = normalizeSlugRef(ref);
      if (slug && !termSlugs.has(slug)) {
        violations.push({
          rule: 'BROKEN_REFERENCE',
          file: term.file,
          message: `relatedIds 참조 "${ref}"는 존재하지 않는 glossary 용어입니다`,
        });
      }
    }
  }
}

/**
 * glossary INVALID_RELATED: 자기 자신 / 중복 / deprecated 대상 참조 금지.
 */
function auditGlossaryInvalidRelated(terms, violations) {
  const termBySlug = new Map(terms.map((t) => [t.slug, t]));
  for (const term of terms) {
    const related = term.data.relatedIds;
    if (!Array.isArray(related)) continue;
    const seen = new Set();
    for (const ref of related) {
      const slug = normalizeSlugRef(ref);
      if (!slug) continue;

      if (slug === term.slug) {
        violations.push({
          rule: 'INVALID_RELATED',
          file: term.file,
          message: `relatedIds에 자기 자신 "${ref}"을(를) 참조합니다`,
        });
      }
      if (seen.has(slug)) {
        violations.push({
          rule: 'INVALID_RELATED',
          file: term.file,
          message: `relatedIds에 중복 참조 "${ref}"가 있습니다`,
        });
      }
      seen.add(slug);

      const target = termBySlug.get(slug);
      if (
        target &&
        (target.data.status === 'draft' ||
          target.data.status === 'deprecated' ||
          target.data.draft === true)
      ) {
        const why = target.data.draft === true
          ? 'native draft:true'
          : `status "${target.data.status}"`;
        violations.push({
          rule: 'INVALID_RELATED',
          file: term.file,
          message: `relatedIds 대상 "${ref}"은(는) ${why}입니다 (active 용어만 참조 가능)`,
        });
      }
    }
  }
}

/**
 * glossary RAW_LEAKAGE: definition·aliases에 /raw/ 링크 또는 raw import 금지.
 */
function auditGlossaryRawLeakage(terms, violations) {
  for (const term of terms) {
    const fields = [term.data.definition, ...(Array.isArray(term.data.aliases) ? term.data.aliases : [])];
    const haystack = fields.filter((s) => typeof s === 'string').join('\n');
    if (RAW_REF_RE.test(haystack)) {
      violations.push({
        rule: 'RAW_LEAKAGE',
        file: term.file,
        message: 'definition 또는 aliases에 /raw/ 링크 또는 raw import가 포함되어 있습니다',
      });
    }
  }
}

function auditGlossary(terms, model) {
  const violations = [];
  auditGlossaryMissingSources(terms, model, violations);
  auditGlossaryCategoryDrift(terms, model, violations);
  auditGlossaryBrokenReferences(terms, violations);
  auditGlossaryInvalidRelated(terms, violations);
  auditGlossaryRawLeakage(terms, violations);
  return violations;
}

function sortViolations(violations) {
  return violations.sort((a, b) => {
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.message !== b.message) return a.message < b.message ? -1 : 1;
    return 0;
  });
}

function auditDocs(docs, model, root) {
  const violations = [];
  auditDuplicateIntent(docs, violations);
  auditBrokenReferences(docs, model, violations);
  auditOrphanLeaves(docs, model, violations);
  auditMissingSources(docs, model, violations);
  auditCategoryDrift(docs, model, violations);
  auditInvalidRelated(docs, violations);
  auditRawLeakage(root, docs, violations);
  return violations;
}

/**
 * workspace audit 수행 (fail-closed).
 *   kind:
 *     'docs'     → docs 콘텐츠 규칙만
 *     'glossary' → glossary 규칙만
 *     undefined  → docs + glossary 결합
 *
 * fail-closed:
 *   - 존재하지 않는 root → throw
 *   - 기본(undefined) audit에 docs/registries 미존재 → throw
 *   - 잘못된 kind → INVALID_ARGUMENT violations
 *   - live per-record registry → validateRegistries 검증 결과를 INVALID_REGISTRY로 매핑
 */
export async function auditWorkspace(root, { kind } = {}) {
  const resolved = path.resolve(String(root ?? ''));
  if (!fs.existsSync(resolved)) {
    throw new Error(`audit root가 존재하지 않습니다: ${resolved}`);
  }
  if (kind !== undefined && kind !== 'docs' && kind !== 'glossary') {
    return {
      violations: [
        { rule: 'INVALID_ARGUMENT', file: '', message: `유효하지 않은 kind "${kind}"입니다 (docs|glossary)` },
      ],
    };
  }

  const { docsRoot, glossaryRoot, registriesRoot } = resolveRoots(resolved);
  const runDocs = kind === undefined || kind === 'docs';
  const runGlossary = kind === undefined || kind === 'glossary';

  if (kind === undefined && (!docsRoot || !registriesRoot)) {
    throw new Error(`기본 audit에는 docs와 registries가 필요합니다 (root: ${resolved})`);
  }
  if (kind === 'docs' && !docsRoot) {
    throw new Error(`docs 콘텐츠가 없습니다 (root: ${resolved})`);
  }
  if (kind === 'glossary' && !glossaryRoot) {
    throw new Error(`glossary 콘텐츠가 없습니다 (root: ${resolved})`);
  }

  const violations = [];
  const model = loadRegistryModel(resolved, registriesRoot, violations);

  // live per-record registry → validateRegistries 스키마 검증 후 INVALID_REGISTRY 매핑
  if (registriesRoot && registryLayout(registriesRoot) === 'per-id') {
    const { errors } = await validateRegistries(path.dirname(registriesRoot));
    for (const e of errors) {
      violations.push({
        rule: 'INVALID_REGISTRY',
        file: e.file,
        message: `[${e.code}] ${e.message}`,
      });
    }
  }

  let docs = [];
  let terms = [];
  if (runDocs) docs = loadDocs(resolved, docsRoot, violations);
  if (runGlossary) terms = loadGlossary(resolved, glossaryRoot, violations);
  if (runDocs) violations.push(...auditDocs(docs, model, resolved));
  if (runGlossary) violations.push(...auditGlossary(terms, model));
  auditRepublication(resolved, docs, terms, violations);

  return { violations: sortViolations(violations) };
}

/** 레지스트리 레이아웃 판정: 'per-id'(kind 서브디렉토리) | 'collection' | 'none' */
const REGISTRY_KINDS = new Set(['taxonomy', 'query-clusters', 'entities', 'people', 'sources']);

function registryLayout(registriesRoot) {
  if (!registriesRoot || !fs.existsSync(registriesRoot)) return 'none';
  let entries;
  try {
    entries = fs.readdirSync(registriesRoot, { withFileTypes: true });
  } catch {
    return 'none';
  }
  for (const entry of entries) {
    if (entry.isDirectory() && REGISTRY_KINDS.has(entry.name)) return 'per-id';
  }
  return 'collection';
}

// --- CLI ---------------------------------------------------------------------

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/content-audit.mjs [root] [--kind docs|glossary] [--format text|json]',
      '',
      '  root        audit 대상 workspace 루트 (기본: 현재 디렉토리)',
      '  --kind      docs(기본) 또는 glossary',
      '  --format    text(기본) 또는 json',
      '',
      'Exit code: 0 = violations 없음, 1 = violations 존재, 2 = 인자 오류',
      '',
    ].join('\n'),
  );
}

async function main() {
  const argv = process.argv.slice(2);
  let root = process.cwd();
  let format = 'text';
  let kind;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    }
    if (arg === '--format') {
      format = argv[i + 1] ?? 'text';
      i += 1;
    } else if (arg === '--kind') {
      kind = argv[i + 1];
      i += 1;
    } else if (!arg.startsWith('-')) {
      root = arg;
    }
  }

  // fail-closed: 잘못된 --kind/--format → exit 2 + stderr
  if (kind !== undefined && kind !== 'docs' && kind !== 'glossary') {
    process.stderr.write(`content-audit: 유효하지 않은 --kind "${kind}"입니다 (docs|glossary)\n`);
    process.exitCode = 2;
    return;
  }
  if (format !== 'text' && format !== 'json') {
    process.stderr.write(`content-audit: 유효하지 않은 --format "${format}"입니다 (text|json)\n`);
    process.exitCode = 2;
    return;
  }

  const { violations } = await auditWorkspace(root, { kind });

  if (format === 'json') {
    process.stdout.write(JSON.stringify({ violations, count: violations.length }, null, 2) + '\n');
  } else {
    for (const v of violations) {
      process.stdout.write(`[${v.rule}] ${v.file}: ${v.message}\n`);
    }
    process.stdout.write(
      violations.length > 0 ? `\n${violations.length} violation(s) found.\n` : 'No violations found.\n',
    );
  }

  process.exitCode = violations.length > 0 ? 1 : 0;
}

const IS_MAIN =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (IS_MAIN) {
  main().catch((err) => {
    console.error(`content-audit: ${err.message}`);
    process.exitCode = 2;
  });
}
