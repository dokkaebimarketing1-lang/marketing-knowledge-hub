// src/schemas/content-contract.ts
//
// 게시 지식 계약(Published Knowledge Contract) — 재사용 가능한 strict Zod 스키마.
// `src/content.config.ts`의 docs/glossary 컬렉션이 이 계약을 그대로 사용한다.
//
// 설계 원칙:
//   - 오직 `zod`만 import (Node 24 type-stripping으로 단위 테스트에서 직접 파싱 가능)
//   - 문서(frontmatter) 계약은 모두 required (nullable로 명시된 필드 제외)
//   - `.strict()` — 미선언 커스텀 필드(레거시 등)는 거부, 선언된 필드만 허용
//   - contentKind 분기:
//       * article     → categoryId/primaryEntityId 필수, sourceIds min 1, queryClusterId 비어 있으면 안 됨
//       * categoryHub → categoryId/primaryEntityId 필수, sourceIds min 1, queryClusterId 반드시 null
//       * utility     → queryClusterId 반드시 null, categoryId/primaryEntityId는 null 허용, sourceIds 빈 배열 허용
//   - 교차 필드 규칙은 superRefine으로 표현:
//       * reviewed       → authorId/publishedAt/reviewedAt 필수
//       * status=deprecated → draft=true 필수 (draft 기본값 false — 현행 active 문서 보존)
//   - 외부 URL은 `externalUrlSchema` — 절대 http(s)만 허용 (ftp/mailto/상대경로 거부)
//   - 레거시 필드(category/summary/related/isTool/toolType)는 제거 — 계약에 존재하지 않음

import { z } from 'zod';

// ── 공유 enum (지식 계약 상수) ──────────────────────────────────────────────

export const CONTENT_KINDS = ['article', 'categoryHub', 'utility'] as const;
export const SEARCH_INTENTS = ['informational', 'navigational', 'transactional', 'commercial'] as const;
export const REVIEW_STATUSES = ['human-review-needed', 'auto-mapped', 'reviewed'] as const;
export const CONTENT_STATUSES = ['active', 'deprecated'] as const;

export const contentKindSchema = z.enum(CONTENT_KINDS);
export const searchIntentSchema = z.enum(SEARCH_INTENTS);
export const reviewStatusSchema = z.enum(REVIEW_STATUSES);
export const contentStatusSchema = z.enum(CONTENT_STATUSES);

const isoDate = z.coerce.date();
const nonEmptyString = z.string().min(1);

/**
 * 절대 http(s) URL만 허용하는 프로토콜 인지 스키마.
 * `new URL()`로 실제 파싱해 protocol이 http:/https: 인지 확인하므로
 * ftp:, mailto:, 상대경로 등은 모두 거부된다.
 */
export const externalUrlSchema = z.string().refine(
	(value) => {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return false;
		}
		return url.protocol === 'http:' || url.protocol === 'https:';
	},
	{ message: '절대 http(s) URL이어야 합니다 (ftp/mailto 등 다른 프로토콜 금지)' },
);

// ── docs 지식 메타 계약 ─────────────────────────────────────────────────────

/**
 * docs 컬렉션 지식 메타 계약 (strict). `docsSchema({ extend: ... })`의 extend로
 * 사용한다. base에서는 categoryId/primaryEntityId가 nullable이고 sourceIds는
 * 빈 배열을 허용한다. article/categoryHub 강화 조건과 utility 규칙은
 * superRefine이 담당한다 (`.extend()` 후에도 유지됨). `.strict()`로 미선언
 * 커스텀 필드는 거부된다 (Starlight 네이티브 필드는 병합 스키마에 선언됨).
 * Starlight 네이티브 `draft`(기본 false)를 계약에도 선언해
 * `status=deprecated → draft=true` 규칙을 단독 파싱에서도 검증한다.
 */
export const docsKnowledgeContract = z
	.object({
		contentKind: contentKindSchema,
		categoryId: nonEmptyString.nullable(),
		queryClusterId: nonEmptyString.nullable(),
		primaryQuery: nonEmptyString,
		searchIntent: searchIntentSchema,
		primaryQuestion: nonEmptyString,
		shortAnswer: nonEmptyString,
		primaryEntityId: nonEmptyString.nullable(),
		authorId: nonEmptyString.nullable(),
		publishedAt: isoDate.nullable(),
		updatedAt: isoDate,
		reviewedAt: isoDate.nullable(),
		reviewStatus: reviewStatusSchema,
		sourceIds: z.array(nonEmptyString),
		relatedIds: z.array(z.string()),
		status: contentStatusSchema,
		draft: z.boolean().default(false), // Starlight 네이티브와 동일 — deprecated→draft 규칙용
		redirectFrom: z.array(z.string()),
	})
	.strict()
	.superRefine((value, ctx) => {
		// article/categoryHub는 카테고리·엔티티·출처가 필수다 (utility는 해제)
		if (value.contentKind === 'article' || value.contentKind === 'categoryHub') {
			if (value.categoryId === null) {
				ctx.addIssue({
					code: 'custom',
					path: ['categoryId'],
					message: `${value.contentKind} 문서의 categoryId는 비어 있으면 안 됩니다`,
				});
			}
			if (value.primaryEntityId === null) {
				ctx.addIssue({
					code: 'custom',
					path: ['primaryEntityId'],
					message: `${value.contentKind} 문서의 primaryEntityId는 비어 있으면 안 됩니다`,
				});
			}
			if (value.sourceIds.length === 0) {
				ctx.addIssue({
					code: 'custom',
					path: ['sourceIds'],
					message: `${value.contentKind} 문서의 sourceIds는 최소 1개가 필요합니다`,
				});
			}
		}
		// article은 queryClusterId가 비어 있으면 안 된다
		if (value.contentKind === 'article' && value.queryClusterId === null) {
			ctx.addIssue({
				code: 'custom',
				path: ['queryClusterId'],
				message: 'article 문서의 queryClusterId는 비어 있으면 안 됩니다',
			});
		}
		// categoryHub/utility는 queryClusterId가 반드시 null이어야 한다
		if (
			(value.contentKind === 'categoryHub' || value.contentKind === 'utility') &&
			value.queryClusterId !== null
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['queryClusterId'],
				message: `${value.contentKind} 문서의 queryClusterId는 null이어야 합니다`,
			});
		}
		// status=deprecated는 반드시 draft=true여야 한다 (현행 active 문서는 draft=false 유지)
		if (value.status === 'deprecated' && value.draft !== true) {
			ctx.addIssue({
				code: 'custom',
				path: ['draft'],
				message: 'status=deprecated 문서는 draft=true가 필요합니다',
			});
		}
		if (value.reviewStatus === 'reviewed') {
			if (value.authorId === null) {
				ctx.addIssue({
					code: 'custom',
					path: ['authorId'],
					message: 'reviewStatus=reviewed는 authorId가 필요합니다',
				});
			}
			if (value.publishedAt === null) {
				ctx.addIssue({
					code: 'custom',
					path: ['publishedAt'],
					message: 'reviewStatus=reviewed는 publishedAt이 필요합니다',
				});
			}
			if (value.reviewedAt === null) {
				ctx.addIssue({
					code: 'custom',
					path: ['reviewedAt'],
					message: 'reviewStatus=reviewed는 reviewedAt이 필요합니다',
				});
			}
		}
	});

// ── glossary 지식 메타 계약 ─────────────────────────────────────────────────

/**
 * glossary 컬렉션 계약 (strict). 신규 지식 필드(categoryId, sourceIds, relatedIds,
 * updatedAt, reviewedAt, reviewStatus, status, redirectFrom) 전부 required,
 * sourceIds는 최소 1개, reviewStatus=reviewed면 reviewedAt이 필수다.
 * `.strict()`로 미선언 필드는 거부된다.
 */
export const glossaryContract = z
	.object({
		term: nonEmptyString,
		definition: nonEmptyString,
		aliases: z.array(z.string()).default([]),
		categoryId: nonEmptyString,
		sourceIds: z.array(nonEmptyString).min(1),
		relatedIds: z.array(z.string()).default([]),
		updatedAt: isoDate,
		reviewedAt: isoDate.nullable(),
		reviewStatus: reviewStatusSchema,
		status: contentStatusSchema,
		redirectFrom: z.array(z.string()).default([]),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.reviewStatus === 'reviewed' && value.reviewedAt === null) {
			ctx.addIssue({
				code: 'custom',
				path: ['reviewedAt'],
				message: 'reviewStatus=reviewed는 reviewedAt이 필요합니다',
			});
		}
	});
