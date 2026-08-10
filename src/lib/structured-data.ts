// src/lib/structured-data.ts
//
// 순수 JSON-LD 구조화 데이터 빌더 — Astro/Starlight 의존성 0.
// `src/starlightRouteData.ts` 라우트 미들웨어가 이 모듈의 순수 함수만 호출한다.
// Node 24 타입 스트리핑으로 단위 테스트(tests/jsonld)에서 직접 import 가능.
//
// 설계 원칙:
//   - Article / DefinedTerm / BreadcrumbList / @graph 빌더는 순수 함수
//   - 내부 URL 계열(@id, url, mainEntityOfPage, BreadcrumbList)은
//     유효한 http(s) `siteUrl`이 주어진 경우에만 생성 — site 미설정 시 core 스키마만 유지
//   - 인용(citation) URL은 registry 계약상 절대 http(s)이므로 site와 무관하게 허용
//   - FAQPage는 생성하지 않는다
//   - 직렬화는 `JSON.stringify(...).replace(/</g, '\\u003c')`로
//     `</script>` HTML 파괴 문자열 주입을 차단한다
//   - author/datePublished는 null이면 누락시킨다

// ── 공용 타입 ────────────────────────────────────────────────────────────────

export type JsonLdValue =
	| string
	| number
	| boolean
	| null
	| JsonLdValue[]
	| { [key: string]: JsonLdValue | undefined };

export interface JsonLdNode {
	'@type': string;
	[key: string]: JsonLdValue | undefined;
}

export interface JsonLdGraphRoot {
	'@context': 'https://schema.org';
	'@graph': JsonLdNode[];
}

/** registry `sources` 컬렉션의 active 레코드 (url은 절대 http(s) 계약). */
export interface ResolvedSource {
	id: string;
	title: string;
	publisher: string;
	url: string;
}

/** registry `people` 컬렉션의 active 레코드. */
export interface ResolvedPerson {
	id: string;
	name: string;
	url?: string;
}

/** Article/categoryHub 문서의 해소된 메타데이터. */
export interface ArticleMeta {
	title: string;
	description?: string;
	lang?: string;
	/** 해소된 active primary entity 이름 (about). */
	entityName?: string;
	/** authorId가 확인된 경우에만 전달 (없으면 author 누락). */
	author?: ResolvedPerson;
	/** null이면 datePublished 누락. */
	datePublished?: string | Date | null;
	/** updatedAt (항상 존재). */
	dateModified?: string | Date;
	/** 해소된 active source 목록 (citation). */
	sources: ResolvedSource[];
}

/** glossary 컬렉션의 실제 용어 데이터. */
export interface DefinedTermData {
	term: string;
	definition: string;
	aliases: string[];
}

export interface BreadcrumbItemInput {
	name: string;
	/** 사이트 루트 기준 상대 경로 (예: '/search/'). */
	path: string;
}

export interface BuildOptions {
	/** 유효한 http(s) 사이트 origin. 없으면 내부 URL 계열 필드를 생성하지 않는다. */
	siteUrl?: string | URL;
	/** 현재 페이지 경로 (예: '/search/seo-basic/'). 내부 URL/@id 생성에 사용. */
	path?: string;
	/** BreadcrumbList 항목 (Home은 자동 선행). 없으면 path 기반 단일 항목. */
	breadcrumb?: BreadcrumbItemInput[];
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

/** 절대 http(s) URL인지 검사. */
export function isHttpUrl(value: unknown): value is string {
	return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value);
}

/**
 * `site`를 유효한 http(s) origin으로 정규화한다.
 * 문자열 또는 `URL` 인스턴스를 모두 허용한다 (Astro `context.site`는 런타임에
 * URL 객체일 수 있다). 유효하지 않으면 undefined — 가짜/내부 URL을 생성하지 않는다.
 *
 * 경로 유지 정책: **origin만 유지**한다 (configured pathname은 폐기).
 * Astro는 canonical/sitemap 생성 시 `new URL(pathname, site)`로 `site`를 소비하는데,
 * 절대 경로(pathname)는 site origin 기준으로 해석되므로 origin-only가 Astro `site`
 * 의미와 일치한다. 호출자가 전달한 URL 인스턴스는 절대 변형하지 않는다.
 */
export function normalizeSiteUrl(site: unknown): string | undefined {
	let url: URL;
	if (site instanceof URL) {
		// 호출자(APIContext)의 인스턴스를 변형하지 않도록 사본으로 취급한다.
		url = new URL(site.href);
	} else if (typeof site === 'string') {
		try {
			url = new URL(site);
		} catch {
			return undefined;
		}
	} else {
		return undefined;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
	return url.origin;
}

/** site origin + 상대 path → 절대 URL. */
function pageUrl(siteUrl: string, path?: string): string {
	return new URL(path ?? '/', siteUrl + '/').href;
}

function toIsoDate(value: unknown): string | undefined {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
	}
	return undefined;
}

// ── 빌더 ─────────────────────────────────────────────────────────────────────

/**
 * Article 노드 빌더.
 * - author/datePublished는 제공되지 않으면 누락
 * - siteUrl이 유효하면 url/@id/mainEntityOfPage 생성, 아니면 core 스키마만 유지
 * - citation은 registry 계약상 절대 http(s) URL
 */
export function buildArticle(meta: ArticleMeta, opts: BuildOptions = {}): JsonLdNode {
	const siteUrl = normalizeSiteUrl(opts.siteUrl);
	const article: JsonLdNode = { '@type': 'Article' };
	article.headline = meta.title;
	if (meta.description) article.description = meta.description;
	if (meta.lang) article.inLanguage = meta.lang;
	if (meta.entityName) article.about = { '@type': 'Thing', name: meta.entityName };
	if (meta.author) {
		const author: JsonLdNode = { '@type': 'Person', name: meta.author.name };
		if (meta.author.url && isHttpUrl(meta.author.url)) author.url = meta.author.url;
		article.author = author;
	}
	if (meta.datePublished) article.datePublished = toIsoDate(meta.datePublished);
	if (meta.dateModified) article.dateModified = toIsoDate(meta.dateModified);
	if (meta.sources.length > 0) {
		article.citation = meta.sources.map(
			(source): JsonLdNode => ({
				'@type': 'CreativeWork',
				name: source.title,
				publisher: source.publisher,
				url: source.url,
			})
		);
	}
	if (siteUrl && opts.path !== undefined) {
		const url = pageUrl(siteUrl, opts.path);
		article.url = url;
		article['@id'] = url;
		article.mainEntityOfPage = { '@type': 'WebPage', '@id': url };
	}
	return article;
}

/**
 * DefinedTerm 노드 빌더.
 * - name/description/alternateName은 실제 glossary 항목에서 온다
 * - siteUrl이 유효하면 @id/url/inDefinedTermSet 생성
 */
export function buildDefinedTerm(term: DefinedTermData, opts: BuildOptions = {}): JsonLdNode {
	const siteUrl = normalizeSiteUrl(opts.siteUrl);
	const node: JsonLdNode = {
		'@type': 'DefinedTerm',
		name: term.term,
		description: term.definition,
	};
	if (term.aliases.length > 0) node.alternateName = term.aliases;
	if (siteUrl && opts.path !== undefined) {
		const url = pageUrl(siteUrl, opts.path);
		node['@id'] = url;
		node.url = url;
		node.inDefinedTermSet = {
			'@type': 'DefinedTermSet',
			name: '마케팅 용어사전',
			url: pageUrl(siteUrl, '/glossary/'),
		};
	}
	return node;
}

/**
 * BreadcrumbList 노드 빌더.
 * siteUrl이 유효하지 않으면 undefined (브레드크럼 미생성).
 * 항목 앞에 '홈'이 자동으로 선행된다.
 */
export function buildBreadcrumbList(
	items: BreadcrumbItemInput[],
	opts: BuildOptions = {}
): JsonLdNode | undefined {
	const siteUrl = normalizeSiteUrl(opts.siteUrl);
	if (!siteUrl) return undefined;
	const itemListElement = [{ name: '홈', path: '/' }, ...items].map(
		(item, index): JsonLdNode => ({
			'@type': 'ListItem',
			position: index + 1,
			name: item.name,
			item: pageUrl(siteUrl, item.path),
		})
	);
	return { '@type': 'BreadcrumbList', itemListElement };
}

/** @graph 루트 어셈블리. */
export function buildGraph(nodes: JsonLdNode[]): JsonLdGraphRoot {
	return { '@context': 'https://schema.org', '@graph': nodes };
}

/** Article + (site가 있으면) BreadcrumbList를 묶은 @graph. */
export function buildArticleGraph(meta: ArticleMeta, opts: BuildOptions = {}): JsonLdGraphRoot {
	const nodes: JsonLdNode[] = [buildArticle(meta, opts)];
	const breadcrumb =
		opts.breadcrumb && opts.breadcrumb.length > 0
			? buildBreadcrumbList(opts.breadcrumb, opts)
			: opts.path !== undefined
				? buildBreadcrumbList([{ name: meta.title, path: opts.path }], opts)
				: undefined;
	if (breadcrumb) nodes.push(breadcrumb);
	return buildGraph(nodes);
}

/** DefinedTerm + (site가 있으면) BreadcrumbList를 묶은 @graph. */
export function buildDefinedTermGraph(
	term: DefinedTermData,
	opts: BuildOptions = {}
): JsonLdGraphRoot {
	const nodes: JsonLdNode[] = [buildDefinedTerm(term, opts)];
	const breadcrumb =
		opts.breadcrumb && opts.breadcrumb.length > 0
			? buildBreadcrumbList(opts.breadcrumb, opts)
			: opts.path !== undefined
				? buildBreadcrumbList([{ name: term.term, path: opts.path }], opts)
				: undefined;
	if (breadcrumb) nodes.push(breadcrumb);
	return buildGraph(nodes);
}

// ── 직렬화 ───────────────────────────────────────────────────────────────────

/**
 * JSON-LD를 `</script>` 파괴가 불가능한 문자열로 직렬화한다.
 * `<`를 `\u003c`로 치환하면 HTML 파서가 스크립트 종료로 해석하지 않으며,
 * `JSON.parse`는 원래 값으로 복원한다(round-trip 보존).
 */
export function serializeJsonLd(graph: JsonLdGraphRoot): string {
	return JSON.stringify(graph).replace(/</g, '\\u003c');
}

// ── head 진입점 (단일 소유자 dedup) ──────────────────────────────────────────

/** `application/ld+json` head 스크립트 진입점. */
export interface JsonLdHeadEntry {
	tag: 'script';
	attrs: { type: 'application/ld+json' };
	content: string;
}

/** 직렬화된 JSON-LD를 담은 head 스크립트 진입점. */
export function jsonLdHeadEntry(graph: JsonLdGraphRoot): JsonLdHeadEntry {
	return {
		tag: 'script',
		attrs: { type: 'application/ld+json' },
		content: serializeJsonLd(graph),
	};
}

/** head에 `application/ld+json` 스크립트가 이미 있는지 검사 (중복 방지). */
export function hasJsonLdHeadEntry(head: readonly unknown[] | undefined | null): boolean {
	if (!head) return false;
	return head.some((entry) => {
		if (entry === null || typeof entry !== 'object') return false;
		const { tag, attrs } = entry as { tag?: unknown; attrs?: Record<string, unknown> };
		return tag === 'script' && attrs?.type === 'application/ld+json';
	});
}

// ── 라우트 분류 ──────────────────────────────────────────────────────────────

export type RouteDecision =
	| { kind: 'article' }
	| { kind: 'glossary'; glossaryId: string }
	| { kind: 'skip' };

/** 경로 정규화: 후행 슬래시 제거, 빈 경로는 '/'로. */
export function normalizePathname(pathname: string): string {
	let p = pathname;
	if (p.length > 1) p = p.replace(/\/+$/, '');
	return p === '' ? '/' : p;
}

/**
 * 라우트 분류.
 * - contentKind article/categoryHub → Article (카테고리 허브·클러스터 허브 포함)
 * - 정확히 `/glossary/{id}/`인 utility → DefinedTerm
 * - 홈·용어사전 인덱스·미니 툴 등 그 외 utility → skip
 */
export function classifyRoute(input: {
	contentKind?: string | null;
	pathname: string;
}): RouteDecision {
	const pathname = normalizePathname(input.pathname);
	const kind = input.contentKind;
	if (kind === 'article' || kind === 'categoryHub') return { kind: 'article' };
	if (kind === 'utility') {
		const match = /^\/glossary\/([^/]+)$/.exec(pathname);
		if (match) return { kind: 'glossary', glossaryId: match[1] };
	}
	return { kind: 'skip' };
}
