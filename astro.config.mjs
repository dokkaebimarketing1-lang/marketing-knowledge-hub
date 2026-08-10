// @ts-check
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mdx from '@astrojs/mdx';
import { deriveExpectations } from './scripts/lib/build-expectations.mjs';

/**
 * @typedef {{ id: string, order: number, status: 'active' | 'deprecated' }} OrderedRegistryEntry
 * @typedef {OrderedRegistryEntry & { kind: 'knowledge' | 'glossary', label: string, hubPath: string }} TaxonomyRegistryEntry
 * @typedef {OrderedRegistryEntry & { categoryId: string, title: string, hubPath: string }} QueryClusterRegistryEntry
 */

/**
 * Load registry JSON in a stable filename order and enforce the registry id contract.
 * @template {OrderedRegistryEntry} T
 * @param {URL} directoryUrl
 * @returns {T[]}
 */
function loadRegistry(directoryUrl) {
	return readdirSync(directoryUrl, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
		.map((entry) => entry.name)
		.sort()
		.map((fileName) => {
			const stem = fileName.slice(0, -'.json'.length);
			const fileUrl = new URL(fileName, directoryUrl);
			let registryEntry;

			try {
				registryEntry = JSON.parse(readFileSync(fileUrl, 'utf8'));
			} catch (error) {
				throw new Error(`Failed to parse registry JSON: ${fileUrl.pathname}`, { cause: error });
			}

			if (
				registryEntry === null ||
				typeof registryEntry !== 'object' ||
				Array.isArray(registryEntry) ||
				registryEntry.id !== stem
			) {
				throw new Error(
					`Registry id must match filename stem: expected "${stem}" in ${fileUrl.pathname}`
				);
			}

			return registryEntry;
		});
}

/** @param {string | undefined} value */
function parseSiteUrl(value) {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	let parsed;
	try {
		parsed = new URL(trimmed);
	} catch (error) {
		throw new Error('SITE_URL must be a valid absolute http(s) URL.', { cause: error });
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('SITE_URL must use the http: or https: protocol.');
	}

	return parsed.href;
}

const projectRootUrl = pathToFileURL(`${process.cwd()}/`);
const taxonomyRegistryUrl = new URL('./src/content/registries/taxonomy/', projectRootUrl);
const queryClusterRegistryUrl = new URL(
	'./src/content/registries/query-clusters/',
	projectRootUrl
);

/** @type {TaxonomyRegistryEntry[]} */
const taxonomyRegistry = loadRegistry(taxonomyRegistryUrl);
/** @type {QueryClusterRegistryEntry[]} */
const queryClusterRegistry = loadRegistry(queryClusterRegistryUrl);
const redirectExpectations = deriveExpectations(process.cwd());
const visibleClusterIds = new Set(redirectExpectations.clusters.map((cluster) => cluster.id));

const activeCategories = taxonomyRegistry
	.filter((entry) => entry.kind === 'knowledge' && entry.status === 'active')
	.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

/** @type {Map<string, QueryClusterRegistryEntry[]>} */
const clustersByCategory = new Map();
for (const category of activeCategories) clustersByCategory.set(category.id, []);

for (const cluster of queryClusterRegistry) {
	if (cluster.status !== 'active' || !visibleClusterIds.has(cluster.id)) continue;

	const categoryClusters = clustersByCategory.get(cluster.categoryId);
	if (!categoryClusters) {
		throw new Error(
			`Active query cluster "${cluster.id}" references missing or inactive knowledge category "${cluster.categoryId}".`
		);
	}
	categoryClusters.push(cluster);
}

for (const clusters of clustersByCategory.values()) {
	clusters.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

const knowledgeSidebar = activeCategories.map((category) => ({
	label: category.label,
	items: [
		{ label: '개요', link: category.hubPath },
		...(clustersByCategory.get(category.id) ?? []).map((cluster) => ({
			label: cluster.title,
			link: cluster.hubPath,
		})),
	],
}));

const site = parseSiteUrl(process.env.SITE_URL);

// ── 리다이렉트: 활성 콘텐츠의 `redirectFrom` 절대 경로 → 현재 활성 라우트 ──
// 중복·충돌(자기 자신, 기존 라우트와 겹침, 잘못된 경로)은 거부한다.
// redirectFrom이 비어 있으면 리다이렉트도 없다 (가짜 리다이렉트 금지).
if (redirectExpectations.redirectErrors.length > 0) {
	throw new Error(
		`Invalid redirectFrom declarations:\n${redirectExpectations.redirectErrors.join('\n')}`
	);
}
const redirects = /** @type {Record<string, string>} */ (redirectExpectations.redirects);

// https://astro.build/config
export default defineConfig({
	...(site ? { site } : {}),
	redirects,
	integrations: [
		starlight({
			title: '마케팅 지식허브',
			description: '검색·SNS·퍼포먼스·콘텐츠 마케팅 지식을 한곳에 — 마케터를 위한 종합 지식허브',
			head: [
				{
					tag: 'link',
					attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
				},
				{
					tag: 'link',
					attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
				},
				{
					tag: 'link',
					attrs: {
						rel: 'stylesheet',
						href: 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;800&display=swap',
					},
				},
			],
			// 루트 로케일: 단일 한국어 사이트를 `/ko/` 프리픽스 없이 루트에서 서빙한다.
			// (기존 `defaultLocale: 'ko'` + `locales: { ko }`는 사이드바 수동 링크에
			//  `/ko/`를 잘못 주입해 `/ko/tools/...`, `/ko/glossary/` 404를 유발함)
			defaultLocale: 'root',
			locales: {
				root: { label: '한국어', lang: 'ko' },
			},
			customCss: ['./src/styles/custom.css'],
			logo: {
				src: './src/assets/logo.svg',
			},
			lastUpdated: true,
			components: { Footer: './src/components/Footer.astro' },
			routeMiddleware: ['./src/starlightRouteData.ts'],
			sidebar: [
				...knowledgeSidebar,
				{
					label: '용어사전',
					items: [{ label: '용어사전', link: '/glossary/' }],
				},
				{
					label: '미니 툴',
					items: [
						{
							label: '광고 성과 계산기 (ROAS·CPA·CAC)',
							link: '/tools/roas-calculator/',
						},
						{ label: '키워드 조합기', link: '/tools/keyword-combiner/' },
					],
				},
			],
		}),
		mdx(),
	],
});
