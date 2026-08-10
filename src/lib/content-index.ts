// src/lib/content-index.ts
//
// 콘텐츠 컬렉션 액티브 인덱스 — 모듈 수명 주기당 한 번만 빌드하고 공유한다.
//
// 동기 (제거 대상 반복 스캔):
//   - 라우트 미들웨어(`src/starlightRouteData.ts`)가 경로마다 getCollection 6종 +
//     배열 선형 스캔(find)과 일회성 Map 생성을 반복했다.
//   - `SourceList.astro`가 페이지마다, `GlossaryTooltip.astro`가 인스턴스마다
//     getCollection을 다시 호출했다.
//
// 해법:
//   - `createContentIndex(loader)` 순수 팩토리: 컬렉션별 **lazy Promise**를
//     모듈 스코프에 캐시하고, status === 'active' 레코드만 id→entry Map으로
//     1회 변환한다. 반복·동시 호출은 동일 Promise를 공유하므로 로더는
//     컬렉션당 정확히 1회만 호출된다.
//   - 소비자는 getter(`getActiveSources()`, `getActiveGlossary()`, …) 또는
//     미들웨어용 번들(`getIndex()`)만 사용하고, getCollection/선형 스캔을
//     직접 수행하지 않는다.
//   - 거부(rejection) 시에는 실패한 캐시를 버려 다음 호출에서 재시도한다
//     (영구 poison 방지).
//   - 프로덕션 싱글턴 `getContentIndex()`는 astro:content를 정적 import하지 않고
//     getter 최초 호출 시점에 동적 import한다. 단위 테스트는 순수 팩토리를 직접
//     사용하므로 astro:content에 접근하지 않는다.
//
// dev HMR: Astro dev 서버는 모듈 단위 HMR을 수행하므로 파일 수정 시 이 모듈이
// 무효화되고 모듈 스코프 캐시(Promise·Map)가 자연히 초기화된다. 별도 재설정 API는
// 노출하지 않는다.
//
// 키 계약 (기존 resolve 로직과 동일):
//   - 레지스트리(taxonomy/entities/people/sources/queryClusters)는 `data.id`를 키로,
//   - glossary는 `id`(파일 stem)를 키로 사용한다.

import type { CollectionEntry, CollectionKey } from 'astro:content';

// ── 타입 ─────────────────────────────────────────────────────────────────────

export type TaxonomyEntry = CollectionEntry<'taxonomy'>;
export type EntityEntry = CollectionEntry<'entities'>;
export type PersonEntry = CollectionEntry<'people'>;
export type SourceEntry = CollectionEntry<'sources'>;
export type QueryClusterEntry = CollectionEntry<'queryClusters'>;
export type GlossaryEntry = CollectionEntry<'glossary'>;

/** 컬렉션 원본 로더 — 팩토리 주입점 (테스트는 counting loader를 주입한다). */
export interface ContentLoader {
	taxonomy: () => Promise<readonly TaxonomyEntry[]>;
	entities: () => Promise<readonly EntityEntry[]>;
	people: () => Promise<readonly PersonEntry[]>;
	sources: () => Promise<readonly SourceEntry[]>;
	queryClusters: () => Promise<readonly QueryClusterEntry[]>;
	glossary: () => Promise<readonly GlossaryEntry[]>;
}

/** active 레코드만 담긴 id→entry 인덱스. 빌드 후 불변으로 취급한다. */
export interface ContentIndex {
	activeTaxonomy: ReadonlyMap<string, TaxonomyEntry>;
	activeEntities: ReadonlyMap<string, EntityEntry>;
	activePeople: ReadonlyMap<string, PersonEntry>;
	activeSources: ReadonlyMap<string, SourceEntry>;
	activeQueryClusters: ReadonlyMap<string, QueryClusterEntry>;
	activeGlossary: ReadonlyMap<string, GlossaryEntry>;
}

/** 집중 getter — 각 컬렉션은 lazy 1회 로드, 이후 동일 Promise/Map을 공유. */
export interface ContentIndexGetters {
	getActiveTaxonomy(): Promise<ReadonlyMap<string, TaxonomyEntry>>;
	getActiveEntities(): Promise<ReadonlyMap<string, EntityEntry>>;
	getActivePeople(): Promise<ReadonlyMap<string, PersonEntry>>;
	getActiveSources(): Promise<ReadonlyMap<string, SourceEntry>>;
	getActiveQueryClusters(): Promise<ReadonlyMap<string, QueryClusterEntry>>;
	getActiveGlossary(): Promise<ReadonlyMap<string, GlossaryEntry>>;
	/** 미들웨어용 번들: 여섯 컬렉션을 병렬 조립 (각 컬렉션은 공유 캐시 사용). */
	getIndex(): Promise<ContentIndex>;
}

// ── 캐시 프리미티브 ───────────────────────────────────────────────────────────

/**
 * lazy 1회 실행 + Promise 공유 메모이제이션.
 * - 첫 호출 시 load를 실행하고 Promise를 캐시한다 (동시 호출은 동일 Promise 수신).
 * - 거부 시 캐시를 비워 다음 호출에서 재시도한다 (영구 poison 방지).
 * - 동기 throw도 거부로 정규화한다.
 */
function lazyOnce<T>(load: () => Promise<T>): () => Promise<T> {
	let promise: Promise<T> | undefined;
	return () => {
		if (!promise) {
			promise = Promise.resolve()
				.then(load)
				.catch((error: unknown) => {
					promise = undefined;
					throw error;
				});
		}
		return promise;
	};
}

/** status === 'active' 레코드만 keyOf(id)로 인덱싱한다 (fail-closed 필터 1회 적용). */
function activeMap<T extends { data: { status?: string } }>(
	entries: readonly T[],
	keyOf: (entry: T) => string
): ReadonlyMap<string, T> {
	const map = new Map<string, T>();
	for (const entry of entries) {
		if (entry.data.status === 'active') {
			map.set(keyOf(entry), entry);
		}
	}
	return map;
}

// ── 순수 팩토리 ───────────────────────────────────────────────────────────────

export function createContentIndex(loader: ContentLoader): ContentIndexGetters {
	const loadActiveTaxonomy = lazyOnce(async () =>
		activeMap(await loader.taxonomy(), (entry) => entry.data.id)
	);
	const loadActiveEntities = lazyOnce(async () =>
		activeMap(await loader.entities(), (entry) => entry.data.id)
	);
	const loadActivePeople = lazyOnce(async () =>
		activeMap(await loader.people(), (entry) => entry.data.id)
	);
	const loadActiveSources = lazyOnce(async () =>
		activeMap(await loader.sources(), (entry) => entry.data.id)
	);
	const loadActiveQueryClusters = lazyOnce(async () =>
		activeMap(await loader.queryClusters(), (entry) => entry.data.id)
	);
	const loadActiveGlossary = lazyOnce(async () =>
		activeMap(await loader.glossary(), (entry) => entry.id)
	);

	return {
		getActiveTaxonomy: () => loadActiveTaxonomy(),
		getActiveEntities: () => loadActiveEntities(),
		getActivePeople: () => loadActivePeople(),
		getActiveSources: () => loadActiveSources(),
		getActiveQueryClusters: () => loadActiveQueryClusters(),
		getActiveGlossary: () => loadActiveGlossary(),
		getIndex: async (): Promise<ContentIndex> => {
			const [
				activeTaxonomy,
				activeEntities,
				activePeople,
				activeSources,
				activeQueryClusters,
				activeGlossary,
			] = await Promise.all([
				loadActiveTaxonomy(),
				loadActiveEntities(),
				loadActivePeople(),
				loadActiveSources(),
				loadActiveQueryClusters(),
				loadActiveGlossary(),
			]);
			return {
				activeTaxonomy,
				activeEntities,
				activePeople,
				activeSources,
				activeQueryClusters,
				activeGlossary,
			};
		},
	};
}

// ── 프로덕션 싱글턴 ───────────────────────────────────────────────────────────

async function loadAstroCollection<C extends CollectionKey>(
	name: C
): Promise<CollectionEntry<C>[]> {
	const { getCollection } = await import('astro:content');
	return getCollection(name);
}

let sharedIndex: ContentIndexGetters | undefined;

/**
 * 프로덕션 싱글턴 (모듈 캐시).
 * import 시점에는 astro:content에 접근하지 않고, getter 최초 호출 시에만
 * 동적 import + 컬렉션 로드를 시작한다. HMR 모듈 무효화 시 캐시 초기화.
 */
export function getContentIndex(): ContentIndexGetters {
	if (!sharedIndex) {
		sharedIndex = createContentIndex({
			taxonomy: () => loadAstroCollection('taxonomy'),
			entities: () => loadAstroCollection('entities'),
			people: () => loadAstroCollection('people'),
			sources: () => loadAstroCollection('sources'),
			queryClusters: () => loadAstroCollection('queryClusters'),
			glossary: () => loadAstroCollection('glossary'),
		});
	}
	return sharedIndex;
}
