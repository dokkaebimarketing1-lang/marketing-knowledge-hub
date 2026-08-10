// src/starlightRouteData.ts
//
// Starlight 라우트 데이터 미들웨어 (routeMiddleware 단일 소유자).
// `astro.config.mjs`의 `starlight({ routeMiddleware: ['./src/starlightRouteData.ts'] })`
// 등록을 준비한다 (본 파일은 아직 astro.config를 수정하지 않는다).
//
// 동작:
//   - 문서(article/categoryHub) → Article + BreadcrumbList JSON-LD
//   - 정확히 `/glossary/{id}/` utility → 용어사전 재로딩 + DefinedTerm + BreadcrumbList
//   - 홈/용어사전 인덱스/미니 툴 → skip (head 스크립트 미삽입)
//   - active 컬렉션 참조(category/entity/person/source/cluster/glossary)는 fail-closed:
//     해소 불가 시 빌드 오류를 던진다
//   - 단일 소유자: head에 `application/ld+json` 스크립트가 이미 있으면 절대 중복 추가하지 않는다
//   - siteUrl이 유효한 http(s)일 때만 내부 URL/@id/mainEntityOfPage/BreadcrumbList 생성
//
// FAQPage는 생성하지 않는다.
//
// 컬렉션 로딩: `src/lib/content-index.ts`의 공유 인덱스를 사용한다. getCollection과
// 배열 선형 스캔은 content-index가 모듈 수명 주기당 1회 수행하고, active 레코드만
// 담긴 id→entry Map을 경로 간에 공유한다. 이 파일에는 getCollection/선형 스캔이
// 남아 있지 않다.

import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { getContentIndex, type ContentIndex } from './lib/content-index';
import {
	buildArticleGraph,
	buildDefinedTermGraph,
	classifyRoute,
	hasJsonLdHeadEntry,
	jsonLdHeadEntry,
	normalizeSiteUrl,
	type ArticleMeta,
	type BreadcrumbItemInput,
	type BuildOptions,
	type ResolvedPerson,
	type ResolvedSource,
} from './lib/structured-data';

// ── fail-closed 참조 해소 (공유 콘텐츠 인덱스 기반) ───────────────────────────
// content-index가 getCollection 6종 + active 필터를 1회 수행하고 id→entry Map을
// 공유한다. 이 파일은 인덱스 번들(`getIndex()`)만 소비한다.

function requireId(value: string | null | undefined, label: string): string {
	if (value == null || value === '') {
		throw new Error(`Structured data: ${label} is required and could not be resolved.`);
	}
	return value;
}

function resolveCategory(index: ContentIndex, categoryId: string) {
	const category = index.activeTaxonomy.get(categoryId);
	if (!category) {
		throw new Error(
			`Structured data: unresolved active category "${categoryId}". ` +
				`Refusing to emit incomplete JSON-LD.`
		);
	}
	return category;
}

function resolveEntity(index: ContentIndex, entityId: string) {
	const entity = index.activeEntities.get(entityId);
	if (!entity) {
		throw new Error(
			`Structured data: unresolved active entity "${entityId}". ` +
				`Refusing to emit incomplete JSON-LD.`
		);
	}
	return entity;
}

function resolvePerson(index: ContentIndex, authorId: string): ResolvedPerson {
	const person = index.activePeople.get(authorId);
	if (!person) {
		throw new Error(
			`Structured data: unresolved active person (author) "${authorId}". ` +
				`Refusing to emit incomplete JSON-LD.`
		);
	}
	return { id: person.data.id, name: person.data.name, url: person.data.url };
}

function resolveSources(index: ContentIndex, sourceIds: string[]): ResolvedSource[] {
	return sourceIds.map((sourceId) => {
		const source = index.activeSources.get(sourceId);
		if (!source) {
			throw new Error(
				`Structured data: unresolved active source "${sourceId}". ` +
					`Refusing to emit incomplete JSON-LD.`
			);
		}
		return {
			id: source.data.id,
			title: source.data.title,
			publisher: source.data.publisher,
			url: source.data.url,
		};
	});
}

function resolveClusterTitle(index: ContentIndex, clusterId: string): string {
	const cluster = index.activeQueryClusters.get(clusterId);
	if (!cluster) {
		throw new Error(
			`Structured data: unresolved active query cluster "${clusterId}". ` +
				`Refusing to emit incomplete JSON-LD.`
		);
	}
	return cluster.data.title;
}

function resolveGlossaryTerm(index: ContentIndex, glossaryId: string) {
	const entry = index.activeGlossary.get(glossaryId);
	if (!entry) {
		throw new Error(
			`Structured data: unresolved active glossary term "${glossaryId}". ` +
				`Refusing to emit incomplete JSON-LD.`
		);
	}
	return entry;
}

// ── 그래프 조립 ──────────────────────────────────────────────────────────────

function buildOptionsFor(
	pathname: string,
	siteUrl: string | undefined,
	breadcrumb: BreadcrumbItemInput[]
): BuildOptions {
	return { siteUrl, path: pathname, breadcrumb };
}

async function resolveArticleGraph(
	route: NonNullable<App.Locals['starlightRoute']>,
	pathname: string,
	siteUrl: string | undefined
) {
	const data = route.entry.data;
	const index = await getContentIndex().getIndex();

	const category = resolveCategory(index, requireId(data.categoryId, 'categoryId'));
	const entity = resolveEntity(index, requireId(data.primaryEntityId, 'primaryEntityId'));
	const sources = resolveSources(index, data.sourceIds);

	let author: ResolvedPerson | undefined;
	if (data.authorId) {
		author = resolvePerson(index, data.authorId);
	}

	// 카테고리 허브 본인(제목==카테고리 라벨)이면 Home → 카테고리 2단 브레드크럼,
	// 그 외(article/클러스터 허브)는 Home → 카테고리 → 페이지 제목 3단.
	const breadcrumb: BreadcrumbItemInput[] = [
		{ name: category.data.label, path: category.data.hubPath },
	];
	if (data.title !== category.data.label) {
		breadcrumb.push({ name: data.title, path: pathname });
	}

	const meta: ArticleMeta = {
		title: data.title,
		description: data.description,
		lang: route.entryMeta?.lang,
		entityName: entity.data.name,
		author,
		datePublished: data.publishedAt,
		dateModified: data.updatedAt,
		sources,
	};

	// cluster 참조도 해소한다 (article은 queryClusterId 필수, categoryHub는 null).
	if (data.queryClusterId) {
		resolveClusterTitle(index, data.queryClusterId);
	}

	return buildArticleGraph(meta, buildOptionsFor(pathname, siteUrl, breadcrumb));
}

async function resolveGlossaryGraph(
	glossaryId: string,
	pathname: string,
	siteUrl: string | undefined
) {
	const index = await getContentIndex().getIndex();
	const entry = resolveGlossaryTerm(index, glossaryId);

	const breadcrumb: BreadcrumbItemInput[] = [
		{ name: '용어사전', path: '/glossary/' },
		{ name: entry.data.term, path: pathname },
	];

	return buildDefinedTermGraph(
		{
			term: entry.data.term,
			definition: entry.data.definition,
			aliases: entry.data.aliases,
		},
		buildOptionsFor(pathname, siteUrl, breadcrumb)
	);
}

// ── 라우트 미들웨어 ──────────────────────────────────────────────────────────

export const onRequest = defineRouteMiddleware(async (context, next) => {
	await next();

	const route = context.locals.starlightRoute;
	// 단일 소유자: 이미 application/ld+json 스크립트가 있으면 절대 중복 추가하지 않는다.
	if (!route || hasJsonLdHeadEntry(route.head)) return;

	const siteUrl = normalizeSiteUrl(context.site);
	const pathname = context.url.pathname;
	const decision = classifyRoute({
		contentKind: route.entry?.data?.contentKind,
		pathname,
	});

	let graph;
	if (decision.kind === 'article') {
		graph = await resolveArticleGraph(route, pathname, siteUrl);
	} else if (decision.kind === 'glossary') {
		graph = await resolveGlossaryGraph(decision.glossaryId, pathname, siteUrl);
	} else {
		return; // 홈/용어사전 인덱스/미니 툴 등 — head 스크립트 미삽입
	}

	route.head.push(jsonLdHeadEntry(graph));
});
