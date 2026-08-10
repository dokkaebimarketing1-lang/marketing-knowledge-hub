// scripts/verify-build.mjs
//
// Dependency-free post-build verifier.
//
// Contract (runs after `astro build`, reads `dist/`):
//   모든 개수(HTML 페이지, Article, DefinedTerm, 리프, 용어, 클러스터)는
//   `scripts/lib/build-expectations.mjs`가 파일시스템의 실제 콘텐츠에서 유도한다.
//   고정 상수(134/12/100/29 등)는 없다 — 문서/용어를 추가하면 기대값도 함께 늘어난다.
//
//   1. HTML inventory  : HTML 페이지 수 == 파생 htmlCount; 루트/404/용어 인덱스/툴,
//                        활성 카테고리, 보이는 리프가 있는 활성 클러스터, 활성 비초안 리프,
//                        활성 용어 상세 라우트가 모두 존재한다.
//   2. Cross-links     : 카테고리 페이지가 자신의 클러스터를 모두 링크; 클러스터 카드
//                        href == 가시 리프 leafSlugs; 용어사전 인덱스가 활성 용어를 모두
//                        링크; 툴 사이드바가 카테고리·클러스터 링크만 갖고 리프 링크 없음.
//   3. SourceList      : 대표 article/category/cluster/glossary-detail 페이지에 존재;
//                        홈과 용어사전 인덱스에 부재; 툴에는 존재.
//   4. JSON-LD         : 파생 eligiblePages개 페이지에 정확히 1개 ld+json;
//                        파생 Article/DefinedTerm 노드 수; FAQPage 없음; 리터럴 `<` 없음.
//   5. SITE_URL branch : 설정 시 canonical/sitemap/내부 URL/BreadcrumbList,
//                        미설정 시 전부 부재 (리다이렉트 스텁 페이지 제외).
//   6. Redirects       : 파생 redirects의 from 경로마다 dist에 HTML 스텁이 있고
//                        목표(to)로 meta-refresh된다. (현재 redirectFrom 비어 있음 → no-op)
//   7. Hygiene         : dist/raw 부재, /raw/ 참조 없음, Pagefind 자산 존재.
//
// Usage: node scripts/verify-build.mjs [root]
//   root: project root (default: cwd). `dist/` is expected under root.
// Exit code: 0 = all assertions pass, 1 = violations found.

import fs from 'node:fs';
import path from 'node:path';
import { deriveExpectations } from './lib/build-expectations.mjs';

const ROOT = path.resolve(process.argv[2] ?? process.cwd());
const DIST = path.join(ROOT, 'dist');

// ── helpers ───────────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Recursively list files under a directory. */
function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else out.push(abs);
  }
  return out.sort();
}

const fail = (message) => {
  throw new Error(message);
};

// ── 기대값 파생 (단일 소스: scripts/lib/build-expectations.mjs) ─────────────

const SITE_URL_RAW = process.env.SITE_URL?.trim();

/** @type {ReturnType<typeof deriveExpectations>} */
const EXPECTED = deriveExpectations(ROOT);

if (EXPECTED.redirectErrors.length > 0) {
  fail(`invalid redirectFrom declarations:\n${EXPECTED.redirectErrors.join('\n')}`);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
};

// ── SITE_URL handling ─────────────────────────────────────────────────────

let siteOrigin = undefined;
if (SITE_URL_RAW) {
  let parsed;
  try {
    parsed = new URL(SITE_URL_RAW);
  } catch {
    fail(`SITE_URL must be a valid absolute URL (got: ${JSON.stringify(SITE_URL_RAW)})`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(`SITE_URL must use http: or https: (got: ${parsed.protocol})`);
  }
  siteOrigin = parsed.origin;
}

// ── 1. HTML inventory ─────────────────────────────────────────────────────

const allFiles = walkFiles(DIST);
const htmlFiles = allFiles.filter((f) => f.endsWith('.html'));

// Astro가 리다이렉트마다 출력하는 HTML 스텁 페이지 경로 (예: /old/x/ → old/x/index.html)
const redirectRelPaths = new Set(
  Object.keys(EXPECTED.redirects).map((from) => `${from.replace(/^\//, '')}index.html`)
);
// 콘텐츠 페이지 = 전체 HTML − 리다이렉트 스텁
const contentHtmlRel = htmlFiles
  .map((f) => toPosix(path.relative(DIST, f)))
  .filter((rel) => !redirectRelPaths.has(rel));

check(
  'HTML page count matches derived expectation',
  htmlFiles.length === EXPECTED.htmlCount,
  `expected ${EXPECTED.htmlCount}, found ${htmlFiles.length}`
);

const pageSet = new Set(contentHtmlRel);

const requireRoute = (rel, label) => {
  const key = toPosix(rel);
  check(`${label} route exists (/${key}/)`, pageSet.has(key), key);
};

requireRoute('index.html', 'root');
requireRoute('404.html', '404');
requireRoute('glossary/index.html', 'glossary index');
for (const p of EXPECTED.tools) requireRoute(`${p}index.html`.replace(/^\//, ''), `tool ${p}`);
for (const p of EXPECTED.categories.map((c) => c.hubPath)) requireRoute(`${p}index.html`.replace(/^\//, ''), `category ${p}`);
for (const p of EXPECTED.clusters.map((c) => c.hubPath)) requireRoute(`${p}index.html`.replace(/^\//, ''), `cluster ${p}`);
for (const p of EXPECTED.leaves) requireRoute(`${p}index.html`.replace(/^\//, ''), `leaf ${p}`);
for (const p of EXPECTED.glossary) requireRoute(`${p}index.html`.replace(/^\//, ''), `glossary detail ${p}`);

check(
  'category route count matches active knowledge taxonomy',
  EXPECTED.categories.length === new Set(EXPECTED.categories.map((c) => c.hubPath)).size,
  `count=${EXPECTED.categories.length}`
);
check(
  'cluster route count matches active clusters with visible leaves',
  EXPECTED.clusters.length === new Set(EXPECTED.clusters.map((c) => c.hubPath)).size,
  `count=${EXPECTED.clusters.length}`
);
check(
  'leaf route count matches visible (active non-draft) leaves',
  EXPECTED.leaves.length === new Set(EXPECTED.leaves).size,
  `count=${EXPECTED.leaves.length}`
);
check(
  'glossary-detail route count matches active glossary terms',
  EXPECTED.glossary.length === new Set(EXPECTED.glossary).size,
  `count=${EXPECTED.glossary.length}`
);

// ── 2. Cross-links ────────────────────────────────────────────────────────

const readPage = (rel) =>
  fs.readFileSync(path.join(DIST, ...rel.split('/')), 'utf8');

// category pages link all their clusters
for (const cat of EXPECTED.categories) {
  const html = readPage(`${cat.hubPath.replace(/^\//, '')}index.html`);
  const catClusters = EXPECTED.clusters.filter((c) => c.categoryId === cat.id);
  for (const cl of catClusters) {
    check(
      `category ${cat.id} links cluster ${cl.id}`,
      html.includes(`href="${cl.hubPath}"`),
      cl.hubPath
    );
  }
}

// cluster card hrefs == visible leafSlugs exactly
for (const cl of EXPECTED.clusters) {
  const html = readPage(`${cl.hubPath.replace(/^\//, '')}index.html`);
  const cardHrefs = Array.from(
    html.matchAll(/<a[^>]*class="[^"]*\bcluster-card\b[^"]*"[^>]*href="([^"]*)"/g)
  ).map((m) => m[1]);
  const expected = cl.leafSlugs.map((s) => `/${s}/`).sort();
  const actual = cardHrefs.sort();
  check(
    `cluster ${cl.id} cards link exactly its visible leafSlugs`,
    actual.length === expected.length && actual.every((h, i) => h === expected[i]),
    `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`
  );
}

// glossary index links all active terms
{
  const html = readPage('glossary/index.html');
  const missing = EXPECTED.glossary.filter((p) => !html.includes(`href="${p}"`));
  check('glossary index links all active terms', missing.length === 0, `missing=${missing.length}`);
}

// tools sidebar: category overview + cluster links, no leaf links
for (const tool of EXPECTED.tools) {
  const html = readPage(`tools/${tool.replace(/^\/tools\//, '').replace(/\/$/, '')}/index.html`);
  const nav = html.match(/<nav class="sidebar[^>]*>([\s\S]*?)<\/nav>/);
  if (!nav) {
    check(`tools ${tool}: sidebar found`, false, 'no <nav class="sidebar">');
    continue;
  }
  const sidebar = nav[1];
  const hrefs = new Set(Array.from(sidebar.matchAll(/href="([^"]*)"/g)).map((m) => m[1]));
  const catLinks = EXPECTED.categories.filter((c) => hrefs.has(c.hubPath)).length;
  const clusterLinks = EXPECTED.clusters.filter((c) => hrefs.has(c.hubPath)).length;
  const leafLinks = EXPECTED.leaves.filter((h) => hrefs.has(h)).length;
  check(
    `tools ${tool}: category overview links match active categories`,
    catLinks === EXPECTED.categories.length,
    `got ${catLinks}/${EXPECTED.categories.length}`
  );
  check(
    `tools ${tool}: cluster links match active clusters with visible leaves`,
    clusterLinks === EXPECTED.clusters.length,
    `got ${clusterLinks}/${EXPECTED.clusters.length}`
  );
  check(`tools ${tool}: no leaf links`, leafLinks === 0, `leaf links=${leafLinks}`);
}

// ── 3. SourceList ─────────────────────────────────────────────────────────
//
// The SourceList component (rendered by the Footer override) appears on every
// route whose declared `sourceIds` resolve to active sources: content docs
// (article/category/cluster) and glossary-detail pages all carry a source
// list. Utility pages that declare no sources (home, glossary index) render
// none. Tool pages declare sourceIds too, so they legitimately render a
// source list as well — the "absent" assertion therefore targets the pages
// that genuinely have no sources.

const SOURCE_LIST_MARKER = 'source-list-section';
const representative = {
  article: EXPECTED.leaves[0] ? `${EXPECTED.leaves[0].replace(/^\//, '')}index.html` : undefined,
  category: EXPECTED.categories[0]
    ? `${EXPECTED.categories[0].hubPath.replace(/^\//, '')}index.html`
    : undefined,
  cluster: EXPECTED.clusters[0]
    ? `${EXPECTED.clusters[0].hubPath.replace(/^\//, '')}index.html`
    : undefined,
  'glossary detail': EXPECTED.glossary[0]
    ? `${EXPECTED.glossary[0].replace(/^\//, '')}index.html`
    : undefined,
};
for (const [kind, rel] of Object.entries(representative)) {
  if (!rel) continue; // 콘텐츠가 없으면 생략
  const html = readPage(rel);
  check(`SourceList present on representative ${kind} page`, html.includes(SOURCE_LIST_MARKER), rel);
}
for (const [kind, rel] of [
  ['home', 'index.html'],
  ['glossary index', 'glossary/index.html'],
]) {
  const html = readPage(rel);
  check(`SourceList absent on ${kind}`, !html.includes(SOURCE_LIST_MARKER), rel);
}
for (const tool of EXPECTED.tools) {
  const rel = `tools/${tool.replace(/^\/tools\//, '').replace(/\/$/, '')}/index.html`;
  const html = readPage(rel);
  check(
    `tools ${tool}: SourceList present (declares sources)`,
    html.includes(SOURCE_LIST_MARKER),
    tool
  );
}

// ── 4. JSON-LD ────────────────────────────────────────────────────────────

const LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
let eligiblePages = 0;
let articleCount = 0;
let definedTermCount = 0;
let faqCount = 0;
let breadcrumbCount = 0;
const jsonLdIssues = [];
let pagesWithoutLd = [];

for (const rel of contentHtmlRel) {
  const html = readPage(rel);
  const matches = Array.from(html.matchAll(LD_RE));
  if (matches.length === 0) {
    pagesWithoutLd.push(rel);
    continue;
  }
  if (matches.length !== 1) {
    jsonLdIssues.push(`${rel}: ${matches.length} ld+json scripts (expected exactly 1)`);
    continue;
  }
  const inner = matches[0][1];
  if (inner.includes('<')) {
    jsonLdIssues.push(`${rel}: script content contains literal "<"`);
    continue;
  }
  let obj;
  try {
    obj = JSON.parse(inner);
  } catch (e) {
    jsonLdIssues.push(`${rel}: JSON.parse failed (${e.message})`);
    continue;
  }
  eligiblePages++;
  const nodes = Array.isArray(obj['@graph']) ? obj['@graph'] : [];
  for (const node of nodes) {
    switch (node?.['@type']) {
      case 'Article': articleCount++; break;
      case 'DefinedTerm': definedTermCount++; break;
      case 'FAQPage': faqCount++; break;
      case 'BreadcrumbList': breadcrumbCount++; break;
      default: break;
    }
  }
}

check(
  'JSON-LD eligible pages match derived expectation',
  eligiblePages === EXPECTED.eligiblePages,
  `expected ${EXPECTED.eligiblePages}, got ${eligiblePages}`
);
check(
  'exactly one ld+json script per eligible page',
  jsonLdIssues.length === 0,
  jsonLdIssues.slice(0, 5).join('; ')
);
check(
  'Article nodes match derived active non-draft pages + visible clusters',
  articleCount === EXPECTED.articleCount,
  `expected ${EXPECTED.articleCount}, got ${articleCount}`
);
check(
  'DefinedTerm nodes match derived active terms',
  definedTermCount === EXPECTED.definedTermCount,
  `expected ${EXPECTED.definedTermCount}, got ${definedTermCount}`
);
check('no FAQPage nodes', faqCount === 0, `got ${faqCount}`);

// pages without ld+json must be exactly the utility/error pages
const expectedNoLd = [
  'index.html',
  '404.html',
  'glossary/index.html',
  ...EXPECTED.tools.map((t) => `${t.replace(/^\//, '')}index.html`),
];
const noLdSet = new Set(pagesWithoutLd);
check(
  'pages without JSON-LD are exactly home/404/glossary index/tools',
  pagesWithoutLd.length === expectedNoLd.length &&
    expectedNoLd.every((p) => noLdSet.has(p)),
  `without=${JSON.stringify(pagesWithoutLd)}`
);

// ── 5. Redirects ──────────────────────────────────────────────────────────

for (const [from, to] of Object.entries(EXPECTED.redirects)) {
  const rel = `${from.replace(/^\//, '')}index.html`;
  const abs = path.join(DIST, ...rel.split('/'));
  const exists = fs.existsSync(abs);
  if (!exists) {
    check(`redirect ${from} → ${to}: stub page exists`, false, rel);
    continue;
  }
  const html = readPage(rel);
  const refresh = html.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["']0;\s*url=([^"']*)["']/i);
  const target = refresh ? refresh[1] : null;
  check(
    `redirect ${from} → ${to}: meta-refresh to target`,
    target === to,
    `got ${JSON.stringify(target)}`
  );
}

// ── 6. SITE_URL branch ────────────────────────────────────────────────────

const canonicalRe = /<link rel="canonical" href="([^"]*)"/;
const sitemapFiles = allFiles.filter((f) => path.basename(f).startsWith('sitemap'));

if (siteOrigin) {
  // expect canonical on every content page (redirect stubs excluded)
  const noCanonical = [];
  for (const rel of contentHtmlRel) {
    const html = readPage(rel);
    const m = html.match(canonicalRe);
    if (!m) {
      noCanonical.push(rel);
    } else if (!m[1].startsWith(`${siteOrigin}/`)) {
      noCanonical.push(`${rel} (origin mismatch: ${m[1]})`);
    }
  }
  check(
    'every content page has a canonical using the normalized origin',
    noCanonical.length === 0,
    `problems=${noCanonical.slice(0, 5).join('; ')}`
  );
  check(
    'sitemap-index.xml and sitemap-0.xml exist',
    sitemapFiles.map((f) => path.basename(f)).sort().join(',') ===
      ['sitemap-0.xml', 'sitemap-index.xml'].join(','),
    `found=${sitemapFiles.map((f) => path.basename(f)).join(',')}`
  );
  // primary internal URLs / BreadcrumbList use normalized origin
  const urlIssues = [];
  for (const rel of contentHtmlRel) {
    const html = readPage(rel);
    const m = Array.from(html.matchAll(LD_RE))[0];
    if (!m) continue;
    let obj;
    try {
      obj = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const nodes = Array.isArray(obj['@graph']) ? obj['@graph'] : [];
    for (const node of nodes) {
      const t = node?.['@type'];
      if (t === 'Article') {
        if (!node.url || !node['@id'] || !node.mainEntityOfPage) {
          urlIssues.push(`${rel}: Article missing internal url/@id/mainEntityOfPage`);
        }
        for (const key of ['url', '@id']) {
          if (node[key] && !node[key].startsWith(`${siteOrigin}/`)) {
            urlIssues.push(`${rel}: Article ${key} not on origin (${node[key]})`);
          }
        }
        if (node.mainEntityOfPage?.['@id'] && !node.mainEntityOfPage['@id'].startsWith(`${siteOrigin}/`)) {
          urlIssues.push(`${rel}: Article mainEntityOfPage not on origin`);
        }
      } else if (t === 'DefinedTerm') {
        if (!node.url || !node['@id'] || !node.inDefinedTermSet) {
          urlIssues.push(`${rel}: DefinedTerm missing internal url/@id/inDefinedTermSet`);
        }
        for (const key of ['url', '@id']) {
          if (node[key] && !node[key].startsWith(`${siteOrigin}/`)) {
            urlIssues.push(`${rel}: DefinedTerm ${key} not on origin (${node[key]})`);
          }
        }
        if (node.inDefinedTermSet?.url && node.inDefinedTermSet.url !== `${siteOrigin}/glossary/`) {
          urlIssues.push(`${rel}: DefinedTerm inDefinedTermSet.url wrong (${node.inDefinedTermSet.url})`);
        }
      } else if (t === 'BreadcrumbList') {
        for (const item of node.itemListElement ?? []) {
          if (item.item && !item.item.startsWith(`${siteOrigin}/`)) {
            urlIssues.push(`${rel}: Breadcrumb item not on origin (${item.item})`);
          }
        }
      }
    }
  }
  check(
    'Article/DefinedTerm/BreadcrumbList internal URLs use normalized origin',
    urlIssues.length === 0,
    urlIssues.slice(0, 5).join('; ')
  );
  check(
    'BreadcrumbList present on all derived eligible pages',
    breadcrumbCount === EXPECTED.eligiblePages,
    `expected ${EXPECTED.eligiblePages}, got ${breadcrumbCount}`
  );
} else {
  // no canonical / no sitemap
  const withCanonical = [];
  for (const rel of contentHtmlRel) {
    if (canonicalRe.test(readPage(rel))) withCanonical.push(rel);
  }
  check('no canonical links when SITE_URL unset', withCanonical.length === 0, `found=${withCanonical.slice(0, 5).join('; ')}`);
  check(
    'no sitemap files when SITE_URL unset',
    sitemapFiles.length === 0,
    `found=${sitemapFiles.map((f) => path.basename(f)).join(',')}`
  );
  check('no BreadcrumbList when SITE_URL unset', breadcrumbCount === 0, `got ${breadcrumbCount}`);
}

// ── 7. Hygiene ────────────────────────────────────────────────────────────

// no dist/raw directory / raw path segment
const rawPathRefs = allFiles.filter((f) => {
  const rel = toPosix(path.relative(DIST, f));
  return rel.split('/').includes('raw') || rel === 'raw' || rel.startsWith('raw/');
});
check('no raw path segments under dist', rawPathRefs.length === 0, `found=${rawPathRefs.join(', ')}`);

// no /raw/ references in dist file contents
const rawContentRefs = [];
for (const f of allFiles) {
  const ext = path.extname(f).toLowerCase();
  if (!['.html', '.js', '.css', '.xml', '.json'].includes(ext)) continue;
  let content;
  try {
    content = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (/\/raw\//.test(content)) rawContentRefs.push(toPosix(path.relative(DIST, f)));
}
check('no /raw/ references in dist contents', rawContentRefs.length === 0, `found=${rawContentRefs.slice(0, 5).join(', ')}`);

// Pagefind assets
const pagefindDir = path.join(DIST, 'pagefind');
const pagefindFiles = fs.existsSync(pagefindDir)
  ? new Set(fs.readdirSync(pagefindDir))
  : new Set();
for (const asset of ['pagefind.js', 'pagefind-worker.js', 'pagefind-ui.js', 'pagefind-ui.css', 'wasm.unknown.pagefind']) {
  check(`pagefind asset ${asset} exists`, pagefindFiles.has(asset), asset);
}
const pagefindIndex = path.join(pagefindDir, 'index');
const hasIndex =
  fs.existsSync(pagefindIndex) && fs.readdirSync(pagefindIndex).some((f) => f.endsWith('.pf_index'));
check('pagefind index contains .pf_index files', hasIndex, 'index/');

// ── summary ───────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
const passed = results.filter((r) => r.ok);

console.log('verify-build: post-build verification');
console.log('  root  :', ROOT);
console.log('  dist  :', DIST);
console.log('  SITE_URL', siteOrigin ? `set (origin ${siteOrigin})` : 'unset');
console.log(
  '  derived:',
  `html=${EXPECTED.htmlCount}, article=${EXPECTED.articleCount}, definedTerm=${EXPECTED.definedTermCount}, redirects=${Object.keys(EXPECTED.redirects).length}`
);
console.log('');
for (const r of results) {
  const mark = r.ok ? 'ok  ' : 'FAIL';
  console.log(`  [${mark}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log('');
console.log(`verify-build: ${failed.length === 0 ? 'PASSED' : 'FAILED'} — ${passed.length} passed, ${failed.length} failed`);

if (failed.length > 0) {
  process.exitCode = 1;
}
