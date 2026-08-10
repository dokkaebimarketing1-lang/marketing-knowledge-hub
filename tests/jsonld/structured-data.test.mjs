// tests/jsonld/structured-data.test.mjs
//
// 순수 JSON-LD 구조화 데이터 빌더 계약 테스트 (Wave4 TODO23).
//
// 대상 API: `src/lib/structured-data.ts` (Astro/Starlight 의존성 0, Node 24 타입 스트리핑)
//   buildArticle / buildDefinedTerm / buildBreadcrumbList / buildGraph
//   buildArticleGraph / buildDefinedTermGraph
//   serializeJsonLd          `<` → `\u003c` 치환 직렬화
//   jsonLdHeadEntry / hasJsonLdHeadEntry   단일 소유자 dedup
//   classifyRoute / normalizePathname      라우트 분류 (article/categoryHub/glossary/skip)
//   normalizeSiteUrl / isHttpUrl
//
// 계약:
//   1. article/categoryHub(카테고리·클러스터 허브) → Article, 정확히 `/glossary/{id}/` utility → DefinedTerm,
//      홈/용어사전 인덱스/미니 툴 → skip
//   2. author/datePublished가 null이면 해당 키를 누락시킨다
//   3. siteUrl이 유효한 http(s)일 때만 @id/url/mainEntityOfPage/BreadcrumbList 생성,
//      없으면 core 스키마(headline/about/citation)만 유지
//   4. `</script><script>` 문자열도 리터럴 `<` 없이 직렬화되고 JSON.parse round-trip 보존
//   5. FAQPage는 어떤 출력에서도 등장하지 않는다
//
// 실행: node --test tests/jsonld/structured-data.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const MODULE_URL = new URL('../../src/lib/structured-data.ts', import.meta.url);

let sd;

before(async () => {
	sd = await import(MODULE_URL.href);
});

// ── fixtures ─────────────────────────────────────────────────────────────────

const SITE = 'https://hub.example.test';
const ARTICLE_PATH = '/search/seo-basic/';
const CATEGORY_PATH = '/search/';
const CLUSTER_PATH = '/search/clusters/seo-foundations/';
const GLOSSARY_PATH = '/glossary/roas/';

const SOURCES = [
	{
		id: 'naver-search-advisor-seo-guide',
		title: '네이버 서치어드바이저 검색 가이드',
		publisher: '네이버',
		url: 'https://searchadvisor.naver.com/guide',
	},
	{
		id: 'google-ai-features-doc',
		title: 'Google AI features in Search',
		publisher: 'Google',
		url: 'https://developers.google.com/search/docs/fundamentals/ai-features',
	},
];

function articleMeta(overrides = {}) {
	return {
		title: 'SEO 기초 (온페이지·오프페이지·기술적 SEO)',
		description: '검색 엔진 상위 노출을 위한 SEO의 기본 개념',
		lang: 'ko',
		entityName: 'SEO (Search Engine Optimization)',
		author: { id: 'author-kim', name: '김마케터', url: 'https://hub.example.test/authors/kim' },
		datePublished: '2026-08-01T00:00:00.000Z',
		dateModified: '2026-08-07T00:00:00.000Z',
		sources: SOURCES,
		...overrides,
	};
}

function articleBreadcrumb() {
	return [
		{ name: '검색 마케팅', path: CATEGORY_PATH },
		{ name: 'SEO 기초 (온페이지·오프페이지·기술적 SEO)', path: ARTICLE_PATH },
	];
}

function articleGraph(metaOverrides = {}, opts = {}) {
	return sd.buildArticleGraph(articleMeta(metaOverrides), {
		siteUrl: SITE,
		path: ARTICLE_PATH,
		breadcrumb: articleBreadcrumb(),
		...opts,
	});
}

function glossaryGraph(opts = {}) {
	return sd.buildDefinedTermGraph(
		{
			term: 'ROAS',
			definition: '광고비 대비 발생한 매출의 비율(Return On Ad Spend).',
			aliases: ['광고 투자 수익률', 'Return On Ad Spend'],
		},
		{
			siteUrl: SITE,
			path: GLOSSARY_PATH,
			breadcrumb: [
				{ name: '용어사전', path: '/glossary/' },
				{ name: 'ROAS', path: GLOSSARY_PATH },
			],
			...opts,
		}
	);
}

function graphByType(graph, type) {
	return graph['@graph'].find((node) => node['@type'] === type);
}

// ── module surface ───────────────────────────────────────────────────────────

test('module: 순수 빌더/serializer/classifier가 모두 export되어야 한다', () => {
	for (const name of [
		'buildArticle',
		'buildDefinedTerm',
		'buildBreadcrumbList',
		'buildGraph',
		'buildArticleGraph',
		'buildDefinedTermGraph',
		'serializeJsonLd',
		'jsonLdHeadEntry',
		'hasJsonLdHeadEntry',
		'classifyRoute',
		'normalizePathname',
		'normalizeSiteUrl',
	]) {
		assert.equal(typeof sd[name], 'function', `${name} export`);
	}
});

// ── classifyRoute ────────────────────────────────────────────────────────────

test('classifyRoute: article → Article', () => {
	assert.deepEqual(sd.classifyRoute({ contentKind: 'article', pathname: ARTICLE_PATH }), {
		kind: 'article',
	});
});

test('classifyRoute: categoryHub(카테고리 인덱스) → Article', () => {
	assert.deepEqual(sd.classifyRoute({ contentKind: 'categoryHub', pathname: CATEGORY_PATH }), {
		kind: 'article',
	});
});

test('classifyRoute: categoryHub(클러스터 허브) → Article', () => {
	assert.deepEqual(sd.classifyRoute({ contentKind: 'categoryHub', pathname: CLUSTER_PATH }), {
		kind: 'article',
	});
});

test('classifyRoute: 정확히 /glossary/{id}/ utility → DefinedTerm(id 추출)', () => {
	assert.deepEqual(sd.classifyRoute({ contentKind: 'utility', pathname: GLOSSARY_PATH }), {
		kind: 'glossary',
		glossaryId: 'roas',
	});
});

test('classifyRoute: 후행 슬래시 없음도 같은 분류 (glossary)', () => {
	assert.deepEqual(
		sd.classifyRoute({ contentKind: 'utility', pathname: '/glossary/roas' }),
		{ kind: 'glossary', glossaryId: 'roas' }
	);
});

test('classifyRoute: 홈(index.astro utility) → skip', () => {
	assert.deepEqual(sd.classifyRoute({ contentKind: 'utility', pathname: '/' }), { kind: 'skip' });
});

test('classifyRoute: 용어사전 인덱스(/glossary/) → skip', () => {
	assert.deepEqual(sd.classifyRoute({ contentKind: 'utility', pathname: '/glossary/' }), {
		kind: 'skip',
	});
});

test('classifyRoute: 미니 툴(roas-calculator/keyword-combiner) → skip', () => {
	for (const pathname of ['/tools/roas-calculator/', '/tools/keyword-combiner/']) {
		assert.deepEqual(sd.classifyRoute({ contentKind: 'utility', pathname }), { kind: 'skip' });
	}
});

test('classifyRoute: contentKind 미정의/알 수 없음 → skip', () => {
	assert.deepEqual(sd.classifyRoute({ contentKind: undefined, pathname: ARTICLE_PATH }), {
		kind: 'skip',
	});
	assert.deepEqual(sd.classifyRoute({ contentKind: 'nonsense', pathname: '/x/' }), {
		kind: 'skip',
	});
});

test('normalizePathname: 후행 슬래시 제거 + 루트는 / 유지', () => {
	assert.equal(sd.normalizePathname('/search/seo-basic/'), '/search/seo-basic');
	assert.equal(sd.normalizePathname('//'), '/');
	assert.equal(sd.normalizePathname(''), '/');
});

// ── normalizeSiteUrl ─────────────────────────────────────────────────────────

test('normalizeSiteUrl: http(s)만 유효, 그 외 undefined', () => {
	assert.equal(sd.normalizeSiteUrl('https://hub.example.test'), 'https://hub.example.test');
	assert.equal(sd.normalizeSiteUrl('https://hub.example.test/'), 'https://hub.example.test');
	assert.equal(sd.normalizeSiteUrl('http://localhost:4321'), 'http://localhost:4321');
	assert.equal(sd.normalizeSiteUrl(''), undefined);
	assert.equal(sd.normalizeSiteUrl('localhost'), undefined);
	assert.equal(sd.normalizeSiteUrl('ftp://hub.example.test'), undefined);
	assert.equal(sd.normalizeSiteUrl(undefined), undefined);
});

// ── URL 인스턴스 지원 (Astro site는 런타임에 URL일 수 있다) ──────────────────

test('normalizeSiteUrl: URL 인스턴스를 지원한다 (RED: 현재 string만 허용)', () => {
	assert.equal(
		sd.normalizeSiteUrl(new URL('https://hub.example.test/path/')),
		'https://hub.example.test'
	);
	assert.equal(sd.normalizeSiteUrl(new URL('http://localhost:4321/')), 'http://localhost:4321');
});

test('normalizeSiteUrl: URL 인스턴스도 http(s)-only 검증을 유지한다', () => {
	assert.equal(sd.normalizeSiteUrl(new URL('ftp://hub.example.test/x')), undefined);
	assert.equal(sd.normalizeSiteUrl(new URL('file:///tmp/x')), undefined);
});

test('normalizeSiteUrl: 전달된 URL 인스턴스를 변형하지 않는다 (APIContext 불변)', () => {
	const url = new URL('https://hub.example.test/path/?a=1');
	const before = url.href;
	const result = sd.normalizeSiteUrl(url);
	assert.equal(url.href, before, '호출자가 보낸 URL 인스턴스는 불변');
	assert.equal(result, 'https://hub.example.test');
});

test('normalizeSiteUrl: string ↔ URL round-trip 결과가 동일하다', () => {
	const stringSite = 'https://hub.example.test';
	assert.equal(sd.normalizeSiteUrl(new URL(stringSite)), sd.normalizeSiteUrl(stringSite));
});

test('article: siteUrl을 URL 인스턴스로 전달해도 절대 URL이 생성된다', () => {
	const graph = articleGraph({}, { siteUrl: new URL(SITE) });
	const article = graphByType(graph, 'Article');
	const url = `${SITE}${ARTICLE_PATH}`;
	assert.equal(article.url, url);
	assert.equal(article['@id'], url);
	assert.deepEqual(article.mainEntityOfPage, { '@type': 'WebPage', '@id': url });
	const breadcrumb = graphByType(graph, 'BreadcrumbList');
	assert.equal(breadcrumb.itemListElement[0].item, `${SITE}/`);
	assert.equal(breadcrumb.itemListElement[2].item, `${SITE}${ARTICLE_PATH}`);
});

test('article: URL 인스턴스 siteUrl round-trip → JSON.parse 복원', () => {
	const graph = articleGraph({}, { siteUrl: new URL(SITE) });
	const serialized = sd.serializeJsonLd(graph);
	assert.ok(!serialized.includes('<'));
	assert.deepEqual(JSON.parse(serialized), graph);
});

// ── buildArticleGraph (site 설정) ────────────────────────────────────────────

test('article: @graph에 Article 1개 + BreadcrumbList 1개', () => {
	const graph = articleGraph();
	const types = graph['@graph'].map((node) => node['@type']).sort();
	assert.deepEqual(types, ['Article', 'BreadcrumbList']);
	assert.equal(graph['@context'], 'https://schema.org');
});

test('article: Article 노드는 메타데이터 기반 필드를 가진다', () => {
	const article = graphByType(articleGraph(), 'Article');
	assert.equal(article['@type'], 'Article');
	assert.equal(article.headline, articleMeta().title);
	assert.equal(article.description, articleMeta().description);
	assert.equal(article.inLanguage, 'ko');
	assert.deepEqual(article.about, { '@type': 'Thing', name: 'SEO (Search Engine Optimization)' });
	assert.deepEqual(article.author, {
		'@type': 'Person',
		name: '김마케터',
		url: 'https://hub.example.test/authors/kim',
	});
	assert.equal(article.datePublished, '2026-08-01T00:00:00.000Z');
	assert.equal(article.dateModified, '2026-08-07T00:00:00.000Z');
});

test('article: citation은 해소된 source URL 목록이다', () => {
	const article = graphByType(articleGraph(), 'Article');
	assert.deepEqual(article.citation, [
		{
			'@type': 'CreativeWork',
			name: SOURCES[0].title,
			publisher: SOURCES[0].publisher,
			url: SOURCES[0].url,
		},
		{
			'@type': 'CreativeWork',
			name: SOURCES[1].title,
			publisher: SOURCES[1].publisher,
			url: SOURCES[1].url,
		},
	]);
});

test('article: site 설정 시 url/@id/mainEntityOfPage가 생성된다', () => {
	const article = graphByType(articleGraph(), 'Article');
	const url = `${SITE}${ARTICLE_PATH}`;
	assert.equal(article.url, url);
	assert.equal(article['@id'], url);
	assert.deepEqual(article.mainEntityOfPage, { '@type': 'WebPage', '@id': url });
});

test('article: BreadcrumbList는 Home → 카테고리 → 페이지 순서를 가진다', () => {
	const breadcrumb = graphByType(articleGraph(), 'BreadcrumbList');
	assert.deepEqual(breadcrumb.itemListElement, [
		{ '@type': 'ListItem', position: 1, name: '홈', item: `${SITE}/` },
		{ '@type': 'ListItem', position: 2, name: '검색 마케팅', item: `${SITE}${CATEGORY_PATH}` },
		{ '@type': 'ListItem', position: 3, name: articleMeta().title, item: `${SITE}${ARTICLE_PATH}` },
	]);
});

// ── buildArticleGraph (site 미설정) ──────────────────────────────────────────

test('article: site 미설정 시 내부 URL/BreadcrumbList 없이 core 스키마만 유지', () => {
	const graph = articleGraph({}, { siteUrl: undefined });
	assert.equal(graph['@graph'].length, 1, 'BreadcrumbList 없이 Article만');
	const article = graph['@graph'][0];
	assert.equal(article['@type'], 'Article');
	assert.equal(article.headline, articleMeta().title);
	assert.deepEqual(article.about, { '@type': 'Thing', name: 'SEO (Search Engine Optimization)' });
	assert.ok(article.citation, '외부 인용은 유지');
	assert.equal('url' in article, false, 'url 없음');
	assert.equal('@id' in article, false, '@id 없음');
	assert.equal('mainEntityOfPage' in article, false, 'mainEntityOfPage 없음');
	assert.equal('BreadcrumbList' in graph['@graph'][0], false);
	assert.ok(!graph['@graph'].some((n) => n['@type'] === 'BreadcrumbList'));
});

test('article: site 미설정 시에도 fake/localhost URL을 생성하지 않는다', () => {
	const serialized = sd.serializeJsonLd(articleGraph({}, { siteUrl: undefined }));
	assert.ok(!serialized.includes('localhost'), 'localhost 금지');
	assert.ok(!serialized.includes('example.com'), 'example.com 금지');
});

// ── null author/datePublished omission ───────────────────────────────────────

test('article: author/datePublished가 null이면 해당 키가 누락된다', () => {
	const article = graphByType(
		articleGraph({ author: undefined, datePublished: null }),
		'Article'
	);
	assert.equal('author' in article, false, 'author 누락');
	assert.equal('datePublished' in article, false, 'datePublished 누락');
	assert.ok(article.headline, 'core 필드는 유지');
});

test('article: author url이 http(s)가 아니면 author.url을 생략한다', () => {
	const article = graphByType(
		articleGraph({ author: { id: 'x', name: '익명', url: 'not-a-url' } }),
		'Article'
	);
	assert.deepEqual(article.author, { '@type': 'Person', name: '익명' });
});

// ── buildDefinedTermGraph ────────────────────────────────────────────────────

test('glossary: DefinedTerm + BreadcrumbList, 실제 용어 데이터 기반', () => {
	const graph = glossaryGraph();
	const term = graphByType(graph, 'DefinedTerm');
	assert.equal(term['@type'], 'DefinedTerm');
	assert.equal(term.name, 'ROAS');
	assert.equal(term.description, '광고비 대비 발생한 매출의 비율(Return On Ad Spend).');
	assert.deepEqual(term.alternateName, ['광고 투자 수익률', 'Return On Ad Spend']);
	const url = `${SITE}${GLOSSARY_PATH}`;
	assert.equal(term['@id'], url);
	assert.equal(term.url, url);
	assert.deepEqual(term.inDefinedTermSet, {
		'@type': 'DefinedTermSet',
		name: '마케팅 용어사전',
		url: `${SITE}/glossary/`,
	});
	const breadcrumb = graphByType(graph, 'BreadcrumbList');
	assert.equal(breadcrumb.itemListElement.length, 3);
	assert.equal(breadcrumb.itemListElement[1].name, '용어사전');
	assert.equal(breadcrumb.itemListElement[2].name, 'ROAS');
});

test('glossary: aliases가 없으면 alternateName을 생략한다', () => {
	const graph = sd.buildDefinedTermGraph(
		{ term: 'ROAS', definition: '정의', aliases: [] },
		{ siteUrl: SITE, path: GLOSSARY_PATH }
	);
	const term = graphByType(graph, 'DefinedTerm');
	assert.equal('alternateName' in term, false);
	assert.equal(term.name, 'ROAS');
});

test('glossary: site 미설정 시 @id/url/inDefinedTermSet 없이 core만 유지', () => {
	const graph = glossaryGraph({ siteUrl: undefined });
	assert.equal(graph['@graph'].length, 1, 'BreadcrumbList 없음');
	const term = graph['@graph'][0];
	assert.equal(term.name, 'ROAS');
	assert.equal(term.description, '광고비 대비 발생한 매출의 비율(Return On Ad Spend).');
	assert.equal('@id' in term, false);
	assert.equal('url' in term, false);
	assert.equal('inDefinedTermSet' in term, false);
});

// ── BreadcrumbList 빌더 ──────────────────────────────────────────────────────

test('buildBreadcrumbList: site 미설정이면 undefined를 반환한다', () => {
	assert.equal(
		sd.buildBreadcrumbList([{ name: '검색 마케팅', path: CATEGORY_PATH }], { siteUrl: undefined }),
		undefined
	);
});

test('buildBreadcrumbList: site 설정 시 Home이 선행되고 position이 1부터 증가한다', () => {
	const breadcrumb = sd.buildBreadcrumbList(
		[
			{ name: '검색 마케팅', path: CATEGORY_PATH },
			{ name: '글', path: ARTICLE_PATH },
		],
		{ siteUrl: SITE }
	);
	assert.equal(breadcrumb['@type'], 'BreadcrumbList');
	assert.equal(breadcrumb.itemListElement.length, 3);
	assert.deepEqual(
		breadcrumb.itemListElement.map((item) => item.position),
		[1, 2, 3]
	);
	assert.equal(breadcrumb.itemListElement[0].item, `${SITE}/`);
});

// ── 직렬화: `<` 치환 + round-trip ───────────────────────────────────────────

test('serializeJsonLd: 리터럴 `<` 없이 직렬화되고 JSON.parse로 복원된다', () => {
	const graph = articleGraph({
		title: '악성 </script><script>alert(1)</script> 제목',
		sources: [{ id: 'x', title: '</script><script>', publisher: 'p', url: 'https://x.example' }],
	});
	const serialized = sd.serializeJsonLd(graph);
	assert.ok(!serialized.includes('<'), `리터럴 < 금지: ${serialized.slice(0, 200)}`);
	assert.ok(serialized.includes('\\u003c'), '치환 이스케이프 존재');
	assert.deepEqual(JSON.parse(serialized), graph, 'JSON round-trip 보존');
});

test('serializeJsonLd: 일반 텍스트는 `<` 이외 문자를 그대로 유지한다', () => {
	const graph = sd.buildGraph([{ '@type': 'Article', headline: 'SEO 기초 & 소개' }]);
	const serialized = sd.serializeJsonLd(graph);
	assert.ok(serialized.includes('SEO 기초 & 소개'), '&는 그대로');
	assert.deepEqual(JSON.parse(serialized), graph);
});

// ── FAQPage 금지 ─────────────────────────────────────────────────────────────

test('FAQPage: article/glossary 출력 어디에도 FAQPage가 없다', () => {
	for (const graph of [articleGraph(), glossaryGraph()]) {
		const serialized = sd.serializeJsonLd(graph);
		assert.ok(!serialized.includes('FAQPage'), `FAQPage 금지: ${serialized.slice(0, 120)}`);
	}
});

// ── head 진입점 (단일 소유자 dedup) ──────────────────────────────────────────

test('jsonLdHeadEntry: application/ld+json script 진입점을 만든다', () => {
	const graph = articleGraph();
	const entry = sd.jsonLdHeadEntry(graph);
	assert.deepEqual(entry, {
		tag: 'script',
		attrs: { type: 'application/ld+json' },
		content: sd.serializeJsonLd(graph),
	});
	// content는 리터럴 `<`가 없고 JSON으로 복원된다
	assert.ok(!entry.content.includes('<'));
	assert.deepEqual(JSON.parse(entry.content), graph);
});

test('hasJsonLdHeadEntry: 기존 ld+json 스크립트가 있으면 true (중복 방지)', () => {
	const graph = articleGraph();
	const entry = sd.jsonLdHeadEntry(graph);
	assert.equal(sd.hasJsonLdHeadEntry([{ tag: 'meta', attrs: { name: 'x' } }]), false);
	assert.equal(sd.hasJsonLdHeadEntry([entry]), true);
	assert.equal(sd.hasJsonLdHeadEntry([{ ...entry }]), true);
	assert.equal(sd.hasJsonLdHeadEntry([]), false);
	assert.equal(sd.hasJsonLdHeadEntry(undefined), false);
	assert.equal(
		sd.hasJsonLdHeadEntry([{ tag: 'script', attrs: { type: 'application/json' } }]),
		false,
		'ld+json이 아닌 script는 무시'
	);
});
