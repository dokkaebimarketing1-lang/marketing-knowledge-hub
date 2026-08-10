import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';
import { scalableDocsLoader } from './loaders/scalableDocsLoader';
import {
	docsKnowledgeContract,
	glossaryContract,
	externalUrlSchema,
} from './schemas/content-contract';

// ── 레지스트리 공통 상태 ──
const registryStatus = z.enum(['active', 'deprecated']).default('active');

export const collections = {
	// ── docs: 게시 지식 계약(strict) + Starlight 네이티브 필드 ──
	//   - 지식 계약 필드는 전부 required (nullable 명시 필드 제외)
	//   - 교차 규칙(superRefine): article/categoryHub 강화, categoryHub/utility
	//     queryClusterId null, reviewed authorId/publishedAt/reviewedAt,
	//     status=deprecated → draft=true
	//   - `.strict()`는 병합(merged) 스키마 레이어에서 적용 — Starlight 네이티브
	//     title/description/draft/head/tags/audience 등 선언된 필드는 유효하고,
	//     미선언 커스텀 필드(레거시 등)는 거부된다
	docs: defineCollection({
		loader: scalableDocsLoader(),
		schema: (context) =>
			docsSchema({
				extend: docsKnowledgeContract.extend({
					tags: z.array(z.string()).default([]), // 복수 태그
					audience: z
						.enum(['beginner', 'intermediate', 'advanced'])
						.default('beginner'), // 마케팅 허브 전용
				}),
			})(context).strict(),
	}),
	// ── glossary: 게시 지식 계약(strict) ──
	//   신규 지식 필드 전부 required, sourceIds min 1,
	//   reviewStatus=reviewed면 reviewedAt 필수, 미선언 필드 거부
	glossary: defineCollection({
		loader: glob({ pattern: '**/*.yaml', base: './src/content/glossary' }),
		schema: glossaryContract,
	}),
	taxonomy: defineCollection({
		loader: glob({ pattern: '**/*.json', base: './src/content/registries/taxonomy' }),
		schema: z
			.object({
				id: z.string(),
				label: z.string(),
				kind: z.enum(['knowledge', 'glossary']),
				description: z.string().optional(),
				order: z.number(),
				hue: z.number().optional(),
				hubPath: z.string(),
				status: registryStatus,
			})
			.strict(),
	}),
	queryClusters: defineCollection({
		loader: glob({ pattern: '**/*.json', base: './src/content/registries/query-clusters' }),
		schema: z
			.object({
				id: z.string(),
				categoryId: z.string(),
				title: z.string(),
				description: z.string().optional(),
				order: z.number(),
				hubPath: z.string(),
				primaryEntityId: z.string(),
				leafSlugs: z.array(z.string()),
				status: registryStatus,
			})
			.strict(),
	}),
	entities: defineCollection({
		loader: glob({ pattern: '**/*.json', base: './src/content/registries/entities' }),
		schema: z
			.object({
				id: z.string(),
				name: z.string(),
				type: z.enum(['discipline', 'practice', 'platform', 'channel', 'metric']),
				description: z.string().optional(),
				sameAs: z.array(externalUrlSchema).default([]),
				status: registryStatus,
			})
			.strict(),
	}),
	people: defineCollection({
		loader: glob({ pattern: '**/*.json', base: './src/content/registries/people' }),
		schema: z
			.object({
				id: z.string(),
				name: z.string(),
				role: z.string().optional(),
				url: externalUrlSchema.optional(), // 외부 URL은 절대 http(s)만
				sameAs: z.array(externalUrlSchema).default([]),
				status: registryStatus,
			})
			.strict(),
	}),
	sources: defineCollection({
		loader: glob({ pattern: '**/*.json', base: './src/content/registries/sources' }),
		schema: z
			.object({
				id: z.string(),
				title: z.string(),
				publisher: z.string(),
				url: externalUrlSchema, // 출처 URL은 절대 http(s)만 (ftp/mailto 거부)
				sourceType: z.enum(['official-docs', 'official-notice', 'official-news', 'academic', 'industry-report', 'vendor-report']),
				accessedAt: z.coerce.date(),
				supports: z.array(z.string()).default([]),
				status: registryStatus,
			})
			.strict(),
	}),
};
