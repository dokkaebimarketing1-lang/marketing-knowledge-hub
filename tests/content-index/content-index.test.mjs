// tests/content-index/content-index.test.mjs
//
// 공유 콘텐츠 인덱스 계약 테스트.
//
// 대상 API: `src/lib/content-index.ts` (Astro/Starlight 의존성 0 — astro:content는
// 동적 import로 지연 로드되므로 이 모듈 import 시점에는 접근하지 않는다).
//   createContentIndex(loader)   순수 팩토리 (주입형 counting loader로 테스트)
//   getContentIndex()            프로덕션 싱글턴 (지연 생성, 리셋 API 없음)
//   ContentIndexGetters          getActiveTaxonomy/Entities/People/Sources/
//                                QueryClusters/Glossary + getIndex(번들)
//
// 계약:
//   1. 반복 호출은 컬렉션 로더를 정확히 1회만 호출한다 (모듈 수명 주기당 1회 빌드)
//   2. 동시 호출(Promise.all)도 로더 1회만 호출하고 동일 Map 인스턴스를 공유한다
//   3. 집중 getter(getActiveSources)는 해당 컬렉션만 로드하고 나머지는 건드리지 않는다
//   4. getIndex 번들은 컬렉션당 1회 로드하고 반복 호출 간 Map을 공유한다
//   5. status === 'active' 레코드만 인덱스에 포함된다 (fail-closed 필터 1회 적용)
//   6. 레지스트리는 data.id, glossary는 entry.id(파일 stem)로 키잉한다
//   7. 거부(rejection)는 캐시를 비워 재시도를 허용한다 — 영구 poison 없음
//
// 실행: node --test tests/content-index/content-index.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const MODULE_URL = new URL('../../src/lib/content-index.ts', import.meta.url);

let ci;

before(async () => {
	ci = await import(MODULE_URL.href);
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function sourceEntry(id, overrides = {}) {
	return {
		id,
		data: {
			id,
			status: 'active',
			title: `출처 ${id}`,
			publisher: '발행처',
			url: `https://example.com/${id}`,
			sourceType: 'official-docs',
			accessedAt: new Date('2026-01-01T00:00:00.000Z'),
			supports: [],
			...overrides,
		},
	};
}

function glossaryEntry(id, overrides = {}) {
	return {
		id,
		data: {
			term: id,
			definition: '정의',
			aliases: [],
			categoryId: 'search',
			sourceIds: ['s-1'],
			relatedIds: [],
			updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			reviewedAt: null,
			reviewStatus: 'auto-mapped',
			status: 'active',
			redirectFrom: [],
			...overrides,
		},
	};
}

function taxonomyEntry(id, overrides = {}) {
	return {
		id,
		data: {
			id,
			label: `라벨 ${id}`,
			kind: 'knowledge',
			order: 1,
			hubPath: `/${id}/`,
			status: 'active',
			...overrides,
		},
	};
}

function entityEntry(id, overrides = {}) {
	return {
		id,
		data: { id, name: `엔티티 ${id}`, type: 'practice', sameAs: [], status: 'active', ...overrides },
	};
}

function personEntry(id, overrides = {}) {
	return {
		id,
		data: {
			id,
			name: `저자 ${id}`,
			role: 'writer',
			url: `https://example.com/authors/${id}`,
			sameAs: [],
			status: 'active',
			...overrides,
		},
	};
}

function clusterEntry(id, overrides = {}) {
	return {
		id,
		data: {
			id,
			categoryId: 'cat-1',
			title: `클러스터 ${id}`,
			order: 1,
			hubPath: `/cat-1/clusters/${id}/`,
			primaryEntityId: 'e-1',
			leafSlugs: [],
			status: 'active',
			...overrides,
		},
	};
}

/** 각 컬렉션 호출 횟수를 세는 지연 로더 (deprecated 1건씩 포함). */
function makeLoader() {
	const calls = { taxonomy: 0, entities: 0, people: 0, sources: 0, queryClusters: 0, glossary: 0 };
	const loader = {
		calls,
		taxonomy: () => {
			calls.taxonomy++;
			return delayed([taxonomyEntry('cat-1'), taxonomyEntry('cat-2', { status: 'deprecated' })]);
		},
		entities: () => {
			calls.entities++;
			return delayed([entityEntry('e-1'), entityEntry('e-2', { status: 'deprecated' })]);
		},
		people: () => {
			calls.people++;
			return delayed([personEntry('p-1')]);
		},
		sources: () => {
			calls.sources++;
			return delayed([sourceEntry('s-1'), sourceEntry('s-2', { status: 'deprecated' })]);
		},
		queryClusters: () => {
			calls.queryClusters++;
			return delayed([clusterEntry('c-1')]);
		},
		glossary: () => {
			calls.glossary++;
			return delayed([glossaryEntry('roas'), glossaryEntry('ctr', { status: 'deprecated' })]);
		},
	};
	return loader;
}

/** 동시성 겹침을 보장하기 위한 지연 해소 헬퍼. */
function delayed(value, ms = 5) {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const COLLECTION_NAMES = [
	'taxonomy',
	'entities',
	'people',
	'sources',
	'queryClusters',
	'glossary',
];

// ── module surface ───────────────────────────────────────────────────────────

test('module: createContentIndex / getContentIndex와 집중 getter가 export된다', () => {
	assert.equal(typeof ci.createContentIndex, 'function');
	assert.equal(typeof ci.getContentIndex, 'function');

	const index = ci.createContentIndex(makeLoader());
	for (const name of [
		'getActiveTaxonomy',
		'getActiveEntities',
		'getActivePeople',
		'getActiveSources',
		'getActiveQueryClusters',
		'getActiveGlossary',
		'getIndex',
	]) {
		assert.equal(typeof index[name], 'function', `${name} getter`);
	}
});

test('getContentIndex: import 시점에 astro:content를 호출하지 않고 지연 생성된다', () => {
	// 이 테스트가 Node에서 실행된다는 것 자체가 astro:content가 import 시점에
	// 접근되지 않음을 증명한다 (getter를 호출하지 않으면 로더가 실행되지 않는다).
	const index = ci.getContentIndex();
	assert.equal(typeof index.getActiveSources, 'function');
	assert.equal(ci.getContentIndex(), index, '싱글턴: 동일 인스턴스 반환');
});

// ── 반복 호출 = 로더 1회 ──────────────────────────────────────────────────────

test('getActiveSources: 반복 호출 시 로더는 정확히 1회만 호출된다', async () => {
	const loader = makeLoader();
	const index = ci.createContentIndex(loader);

	await index.getActiveSources();
	await index.getActiveSources();
	await index.getActiveSources();

	assert.equal(loader.calls.sources, 1, 'sources 로더 1회');
});

// ── 동시 호출 = 로더 1회 + Map 공유 ───────────────────────────────────────────

test('getActiveSources: 동시 호출(Promise.all)도 로더 1회만 호출하고 Map을 공유한다', async () => {
	const loader = makeLoader();
	const index = ci.createContentIndex(loader);

	const [a, b, c] = await Promise.all([
		index.getActiveSources(),
		index.getActiveSources(),
		index.getActiveSources(),
	]);

	assert.equal(loader.calls.sources, 1, '동시 호출도 sources 로더 1회');
	assert.equal(a, b, '동일 Map 인스턴스 공유');
	assert.equal(b, c, '동일 Map 인스턴스 공유');
});

test('getIndex: 반복 호출 시 여섯 컬렉션 로더가 각각 1회만 호출된다', async () => {
	const loader = makeLoader();
	const index = ci.createContentIndex(loader);

	await index.getIndex();
	await index.getIndex();

	for (const name of COLLECTION_NAMES) {
		assert.equal(loader.calls[name], 1, `${name} 로더 1회`);
	}
});

// ── 집중 getter ≠ 거대 단일 로드 ──────────────────────────────────────────────

test('getActiveSources: sources만 로드하고 다른 컬렉션은 로드하지 않는다', async () => {
	const loader = makeLoader();
	const index = ci.createContentIndex(loader);

	await index.getActiveSources();

	assert.equal(loader.calls.sources, 1);
	assert.equal(loader.calls.glossary, 0, 'glossary 로드 안 함');
	assert.equal(loader.calls.taxonomy, 0, 'taxonomy 로드 안 함');
	assert.equal(loader.calls.entities, 0, 'entities 로드 안 함');
	assert.equal(loader.calls.queryClusters, 0, 'queryClusters 로드 안 함');
});

test('getActiveGlossary: glossary만 로드하고 다른 컬렉션은 로드하지 않는다', async () => {
	const loader = makeLoader();
	const index = ci.createContentIndex(loader);

	await index.getActiveGlossary();

	assert.equal(loader.calls.glossary, 1);
	assert.equal(loader.calls.sources, 0, 'sources 로드 안 함');
	assert.equal(loader.calls.taxonomy, 0, 'taxonomy 로드 안 함');
});

// ── 번들 Map 공유 ─────────────────────────────────────────────────────────────

test('getIndex: 반복 호출 간 동일 Map 인스턴스를 공유한다 (한 번만 빌드)', async () => {
	const loader = makeLoader();
	const index = ci.createContentIndex(loader);

	const first = await index.getIndex();
	const second = await index.getIndex();

	assert.equal(first.activeSources, second.activeSources);
	assert.equal(first.activeGlossary, second.activeGlossary);
	assert.equal(first.activeTaxonomy, second.activeTaxonomy);
	assert.equal(first.activeEntities, second.activeEntities);
});

// ── active 필터 ───────────────────────────────────────────────────────────────

test('인덱스는 status=active 레코드만 담는다 (fail-closed 필터)', async () => {
	const loader = makeLoader();
	const index = ci.createContentIndex(loader);
	const idx = await index.getIndex();

	assert.ok(idx.activeSources.has('s-1'));
	assert.ok(!idx.activeSources.has('s-2'), 'deprecated sources 제외');
	assert.ok(idx.activeTaxonomy.has('cat-1'));
	assert.ok(!idx.activeTaxonomy.has('cat-2'), 'deprecated taxonomy 제외');
	assert.ok(idx.activeEntities.has('e-1'));
	assert.ok(!idx.activeEntities.has('e-2'), 'deprecated entities 제외');
	assert.ok(idx.activeGlossary.has('roas'));
	assert.ok(!idx.activeGlossary.has('ctr'), 'deprecated glossary 제외');
});

test('해소 실패 입력(비활성/미존재 id)은 Map 조회에서 undefined를 반환한다', async () => {
	const loader = makeLoader();
	const index = ci.createContentIndex(loader);
	const idx = await index.getIndex();

	assert.equal(idx.activeSources.get('missing'), undefined);
	assert.equal(idx.activeSources.get('s-2'), undefined, 'deprecated도 해소 불가');
	assert.equal(idx.activeGlossary.get('missing'), undefined);
});

// ── 키잉 계약 ─────────────────────────────────────────────────────────────────

test('레지스트리는 data.id, glossary는 entry.id(파일 stem)로 키잉한다', async () => {
	const index = ci.createContentIndex({
		taxonomy: () =>
			delayed([{ id: 't-file', data: { id: 'tax-key', status: 'active' } }]),
		entities: () => delayed([]),
		people: () => delayed([]),
		sources: () =>
			delayed([{ id: 's-file', data: { id: 's-key', status: 'active' } }]),
		queryClusters: () => delayed([]),
		glossary: () =>
			delayed([{ id: 'g-key', data: { status: 'active' } }]),
	});
	const idx = await index.getIndex();

	assert.ok(idx.activeSources.has('s-key'), 'source는 data.id 키');
	assert.ok(!idx.activeSources.has('s-file'));
	assert.ok(idx.activeTaxonomy.has('tax-key'), 'taxonomy는 data.id 키');
	assert.ok(idx.activeGlossary.has('g-key'), 'glossary는 entry.id 키');
});

// ── 거부 처리 (영구 poison 없음) ──────────────────────────────────────────────

test('로더 거부 시 캐시를 비우고 다음 호출에서 재시도한다', async () => {
	const loader = makeLoader();
	let attempt = 0;
	loader.sources = () => {
		loader.calls.sources++;
		attempt++;
		if (attempt === 1) return Promise.reject(new Error('boom'));
		return delayed([sourceEntry('s-1')]);
	};
	const index = ci.createContentIndex(loader);

	await assert.rejects(() => index.getActiveSources(), /boom/);
	const map = await index.getActiveSources();

	assert.equal(loader.calls.sources, 2, '실패 후 재시도로 재로드');
	assert.ok(map.has('s-1'));
});

test('동시 호출은 실패를 함께 공유하고, 이후 호출은 재시도한다', async () => {
	let attempt = 0;
	const calls = { sources: 0 };
	const loader = {
		taxonomy: () => delayed([]),
		entities: () => delayed([]),
		people: () => delayed([]),
		queryClusters: () => delayed([]),
		glossary: () => delayed([]),
		sources: () => {
			calls.sources++;
			attempt++;
			if (attempt === 1) return Promise.reject(new Error('boom'));
			return delayed([sourceEntry('s-1')]);
		},
	};
	const index = ci.createContentIndex(loader);

	await assert.rejects(
		Promise.all([index.getActiveSources(), index.getActiveSources()]),
		/boom/
	);
	assert.equal(calls.sources, 1, '동시 실패도 로더 1회만 호출');

	const map = await index.getActiveSources();
	assert.equal(calls.sources, 2, '실패 후 재시도');
	assert.ok(map.has('s-1'));
});
