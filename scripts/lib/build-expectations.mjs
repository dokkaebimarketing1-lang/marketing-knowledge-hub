// scripts/lib/build-expectations.mjs
//
// 단일 소스의 빌드 기대값(expectations) 파생 모듈.
// `scripts/verify-build.mjs`(빌드 후 검증), `astro.config.mjs`(리다이렉트 생성),
// 그리고 단위 테스트가 공용으로 사용한다.
//
// 핵심 원칙:
//   - 모든 개수(HTML 페이지, Article, DefinedTerm, 리프, 용어, 클러스터)는
//     파일시스템의 실제 콘텐츠에서 유도한다. 고정 상수(134/12/100/29 등) 금지.
//   - 가시성(visibility): 문서는 `draft !== true && status === 'active'`,
//     용어는 `status === 'active'`(그리고 방어적으로 `draft`도 체크)만 공개된다.
//   - 클러스터는 보이는 리프(visible leaf)가 하나 이상일 때만 라우트를 가진다.
//   - 리다이렉트는 활성 콘텐츠의 고유 절대 `redirectFrom` 경로에서만 생성되며,
//     중복·충돌(자기 자신/기존 라우트와 겹침)은 거부(reject)한다.

import fs from 'node:fs';
import path from 'node:path';
import { walkFiles, parseContentFile } from './content-files.mjs';

const CONTENT_EXTS = new Set(['md', 'mdx', 'markdown']);
const YAML_EXTS = new Set(['yaml', 'yml']);


/** 존재하는 디렉토리 후보 중 첫 번째를 반환 (없으면 null) */
function pickDir(candidates) {
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

/**
 * root 아래의 콘텐츠/레지스트리 디렉토리를 해석한다.
 * 콘텐츠: <root>/docs 또는 <root>/src/content/docs (audit fixture 호환)
 * glossary: <root>/src/content/glossary 또는 <root>/glossary
 * registries: <root>/src/content/registries 또는 <root>/registries
 */
export function resolveContentRoots(root) {
  return {
    docsRoot: pickDir([path.join(root, 'src', 'content', 'docs'), path.join(root, 'docs')]),
    glossaryRoot: pickDir([path.join(root, 'src', 'content', 'glossary'), path.join(root, 'glossary')]),
    registriesRoot: pickDir([
      path.join(root, 'src', 'content', 'registries'),
      path.join(root, 'registries'),
    ]),
  };
}

/** md/mdx 문서를 파싱해 { id(슬러그), data } 목록으로 반환한다 (결정적 정렬). */
export function loadDocs(docsRoot) {
  if (!docsRoot || !fs.existsSync(docsRoot)) return [];
  const docs = [];
  for (const rel of walkFiles(docsRoot)) {
    const ext = path.extname(rel).slice(1).toLowerCase();
    if (!CONTENT_EXTS.has(ext)) continue;
    const abs = path.join(docsRoot, ...rel.split('/'));
    let parsed;
    try {
      parsed = parseContentFile(abs);
    } catch {
      continue; // malformed 문서는 파싱 대상에서 제외
    }
    const id = rel.slice(0, -(ext.length + 1)).replace(/\/index$/, '');
    docs.push({ id, data: parsed.data ?? {} });
  }
  return docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** glossary YAML 용어를 파싱해 { id(파일 stem), data } 목록으로 반환한다. */
export function loadGlossary(glossaryRoot) {
  if (!glossaryRoot || !fs.existsSync(glossaryRoot)) return [];
  const terms = [];
  for (const rel of walkFiles(glossaryRoot)) {
    const ext = path.extname(rel).slice(1).toLowerCase();
    if (!YAML_EXTS.has(ext)) continue;
    const abs = path.join(glossaryRoot, ...rel.split('/'));
    let parsed;
    try {
      parsed = parseContentFile(abs);
    } catch {
      continue;
    }
    terms.push({ id: path.basename(rel, path.extname(rel)), data: parsed.data ?? {} });
  }
  return terms.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 레지스트리 디렉토리의 모든 JSON 레코드를 filename 순서로 로드한다. */
function loadRegistry(registriesRoot, kind) {
  if (!registriesRoot || !fs.existsSync(registriesRoot)) return [];
  const dir = path.join(registriesRoot, kind);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => path.join(dir, e.name))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
}

/**
 * 문서/용어의 가시성 판정.
 * 문서: `draft`가 true면 비공개, `status !== 'active'`면 비공개 (deprecated).
 * 용어: `status === 'active'` (스키마에 draft가 없어 방어적으로 체크).
 */
export function isVisibleDoc(data) {
  return data.draft !== true && data.status === 'active';
}

export function isVisibleTerm(data) {
  return data.status === 'active' && data.draft !== true;
}

/** 절대 redirectFrom 경로를 표준형으로 정규화한다. */
export function normalizeRedirectFrom(raw) {
  if (typeof raw !== 'string') return undefined;
  let s = raw.trim();
  if (!s) return undefined;
  s = s.split(/[?#]/, 1)[0]; // 쿼리/해시 제거
  s = s.replace(/\/{2,}/g, '/');
  if (!s.startsWith('/')) return undefined; // 절대 경로만 허용
  if (s.length > 1) {
    if (s.endsWith('/')) s = s.slice(0, -1);
    s = `${s}/`; // 사이트는 후행 슬래시 라우트를 사용한다
  }
  return s === '/' ? undefined : s; // 루트로의 리다이렉트는 의미 없음
}

/**
 * 활성 콘텐츠의 `redirectFrom`으로부터 리다이렉트 맵을 만든다.
 *   entries: [{ id, to, redirectFrom: string[], kind }]
 * 반환: { redirects: Record<from,to>, errors: string[] }
 * 거부 규칙:
 *   - 잘못된 경로(비절대, 빈 값, 루트)
 *   - 자기 자신으로의 리다이렉트 (from === to)
 *   - 기존 라우트와의 충돌 (from이 활성 라우트와 동일)
 *   - 서로 다른 대상으로의 중복 (같은 from, 다른 to)
 */
export function buildRedirectMap(entries, existingRoutes) {
  /** @type {Record<string, string>} */
  const redirects = {};
  const errors = [];
  const usedFrom = new Set();

  for (const entry of entries) {
    for (const raw of entry.redirectFrom ?? []) {
      const from = normalizeRedirectFrom(raw);
      if (!from) {
        errors.push(
          `${entry.kind} "${entry.id}": redirectFrom ${JSON.stringify(raw)}는 절대 경로가 아닙니다`,
        );
        continue;
      }
      if (from === entry.to) {
        errors.push(`${entry.kind} "${entry.id}": redirectFrom ${from}가 자기 자신(현재 라우트)입니다`);
        continue;
      }
      if (existingRoutes.has(from)) {
        errors.push(
          `${entry.kind} "${entry.id}": redirectFrom ${from}는 이미 존재하는 활성 라우트와 충돌합니다`,
        );
        continue;
      }
      const previous = redirects[from];
      if (previous !== undefined && previous !== entry.to) {
        errors.push(
          `${entry.kind} "${entry.id}": redirectFrom ${from}가 다른 대상(${previous})으로 중복 선언됐습니다`,
        );
        continue;
      }
      redirects[from] = entry.to;
      usedFrom.add(from);
    }
  }
  return { redirects, errors };
}

/**
 * root에서 빌드 기대값을 유도한다.
 * 반환:
 *   categories   [{ id, label, hubPath }]                     — 활성 knowledge 카테고리
 *   clusters     [{ id, title, hubPath, leafSlugs(보이는 것만) }] — 보이는 리프 ≥1인 활성 클러스터
 *   leaves       [`/slug/`]                                   — 활성 클러스터의 보이는 리프 경로
 *   glossary     [`/glossary/{id}/`]                          — 활성 용어 상세 경로
 *   tools        [`/tools/{id}/`]                             — tools 페이지 경로
 *   articleCount   활성 비초안 문서 + 보이는 리프를 가진 클러스터 (Article JSON-LD 페이지 수)
 *   definedTermCount 활성 용어 수 (DefinedTerm JSON-LD 페이지 수)
 *   eligiblePages  articleCount + definedTermCount
 *   htmlCount      eligiblePages + 유틸리티 페이지(홈/404/용어 인덱스/툴)
 *   redirects / redirectErrors  활성 콘텐츠 redirectFrom 파생
 *   existingRoutes  현재 활성 라우트 집합 (충돌 검출용)
 */
export function deriveExpectations(root) {
  const resolved = path.resolve(root);
  const { docsRoot, glossaryRoot, registriesRoot } = resolveContentRoots(resolved);

  // ── 레지스트리 ──
  const taxonomy = loadRegistry(registriesRoot, 'taxonomy');
  const queryClusters = loadRegistry(registriesRoot, 'query-clusters');

  const categories = taxonomy
    .filter((t) => t.kind === 'knowledge' && t.status === 'active')
    .map((t) => ({ id: t.id, label: t.label, hubPath: t.hubPath }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ── 콘텐츠 ──
  const docs = loadDocs(docsRoot);
  const glossaryTerms = loadGlossary(glossaryRoot);

  const activeDocs = docs.filter((d) => isVisibleDoc(d.data));
  const activeDocsById = new Set(activeDocs.map((d) => d.id));
  const activeTerms = glossaryTerms.filter((t) => isVisibleTerm(t.data));

  // ── 클러스터: 보이는 리프만 유지 ──
  const activeClusters = queryClusters
    .filter((c) => c.status === 'active')
    .map((c) => ({
      id: c.id,
      categoryId: c.categoryId,
      title: c.title,
      hubPath: c.hubPath,
      leafSlugs: (c.leafSlugs ?? []).filter((slug) => activeDocsById.has(slug)),
    }))
    .filter((c) => c.leafSlugs.length > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const leaves = Array.from(new Set(activeClusters.flatMap((c) => c.leafSlugs))).sort();

  // ── tools 페이지 ──
  const toolsDir = path.join(resolved, 'src', 'pages', 'tools');
  let toolIds = [];
  try {
    toolIds = fs
      .readdirSync(toolsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.astro'))
      .map((e) => path.basename(e.name, '.astro'))
      .sort();
  } catch {
    toolIds = [];
  }

  // ── 라우트 집합 ──
  const categoryRoutes = categories.map((c) => c.hubPath);
  const clusterRoutes = activeClusters.map((c) => c.hubPath);
  const leafRoutes = leaves.map((slug) => `/${slug}/`);
  const glossaryRoutes = activeTerms.map((t) => `/glossary/${t.id}/`);
  const toolRoutes = toolIds.map((t) => `/tools/${t}/`);

  const existingRoutes = new Set([
    '/',
    '/glossary/',
    ...categoryRoutes,
    ...clusterRoutes,
    ...leafRoutes,
    ...glossaryRoutes,
    ...toolRoutes,
  ]);

  // ── 리다이렉트 (활성 콘텐츠만) ──
  const redirectEntries = [
    ...activeDocs.map((d) => ({
      id: d.id,
      kind: 'doc',
      to: `/${d.id}/`,
      redirectFrom: d.data.redirectFrom ?? [],
    })),
    ...activeTerms.map((t) => ({
      id: t.id,
      kind: 'glossary',
      to: `/glossary/${t.id}/`,
      redirectFrom: t.data.redirectFrom ?? [],
    })),
  ];
  const { redirects, errors: redirectErrors } = buildRedirectMap(redirectEntries, existingRoutes);

  // ── 개수 ──
  const articleCount = activeDocs.length + activeClusters.length;
  const definedTermCount = activeTerms.length;
  const eligiblePages = articleCount + definedTermCount;
  // 홈 + 404 + 용어사전 인덱스 + 툴 (고정된 유틸리티 페이지 — 콘텐츠에 비례하지 않음)
  // 리다이렉트는 Astro가 dist에 HTML 스텁 페이지로 출력한다.
  const htmlCount = eligiblePages + toolRoutes.length + 3 + Object.keys(redirects).length;

  return {
    categories,
    clusters: activeClusters,
    leaves: leafRoutes,
    glossary: glossaryRoutes,
    tools: toolRoutes,
    articleCount,
    definedTermCount,
    eligiblePages,
    htmlCount,
    existingRoutes,
    redirects,
    redirectErrors,
  };
}
