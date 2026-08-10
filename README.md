# 마케팅 지식허브 운영 매뉴얼

검색(SEO)·AI 검색(AEO/GEO)·SNS·퍼포먼스·콘텐츠 마케팅 지식을 한곳에 모으는 **확장 가능한 마케팅 지식허브**입니다.
원천 자료(아이보스 공개 글 등)를 그대로 복제하지 않고, 원천 자료를 읽어 **독립적으로 재작성한 지식 문서**만 공개합니다.

수천 개 문서로 확장해도 안정적으로 동작하도록, 모든 콘텐츠와 메타데이터는 파일 하나 = 레코드 하나로 관리되며
빌드 전 감사(audit)·테스트·타입 검사·빌드 후 검증이 순서대로 실행됩니다.

---

## 1. 목적

- 마케터가 검색 의도에 맞는 지식 문서와 용어를 빠르게 찾는 공개 사이트 제공
- 문서·용어·엔티티·출처·저자를 **레지스트리(registry) 단일 소스**로 관리해 규모 확장
- 원천 자료의 원문 전재를 금지하고, 검증된 출처만 공개 콘텐츠에 연결
- CMS·DB·벡터DB·크롤러 없이 파일 기반(Git)으로만 운영되는 구조 (P0 범위)

## 2. 아키텍처

```
raw/ (비공개 원천 스냅샷, Git·빌드·배포 제외)
  │  독립 재작성(paraphrase/rewrite) + 출처 레코드 연결
  ▼
src/content/
  ├── docs/         지식 문서 (categoryHub 6 · article 12, .mdx)
  ├── glossary/     용어사전 (용어 100, .yaml)
  └── registries/   레지스트리 (JSON, 파일 = 레코드 1개)
        ├── taxonomy/        지식 6 + 용어 5 = 11개 카테고리
        ├── query-clusters/  쿼리 클러스터 11개
        ├── entities/        엔티티 15개
        ├── people/          사람 (현재 0건 — 의도적 비움)
        └── sources/         검증된 출처 19개
  ▼
Astro + Starlight 정적 빌드 → dist/
  ├── 6 category hub / 11 cluster hub / 12 leaf / 100 glossary 상세 / 툴 / 홈
  └── Article·DefinedTerm·BreadcrumbList JSON-LD (SITE_URL 설정 시)
```

- **파일 기반**: 콘텐츠·레지스트리는 전부 Git에 커밋되는 일반 파일이며, 별도 CMS/DB가 필요 없습니다.
- **단일 소스**: 문서·용어가 참조하는 카테고리·클러스터·엔티티·출처·저자 ID는 레지스트리에만 존재하고, 참조 무결성은 감사가 보장합니다.
- **검증 체인**: `test:content` → `content:audit` → `check` → `build` → `verify:build` 순서로 실행됩니다 (`npm run verify`).

## 3. 콘텐츠 계약 (데이터 계약)

모든 계약은 `src/schemas/content-contract.ts`의 strict Zod 스키마로 정의되며, `src/content.config.ts`가 이를 적용합니다.

### 3.1 지식 문서 (`docs/`, frontmatter)

| 필드 | 설명 | article | categoryHub | utility |
|---|---|---|---|---|
| `contentKind` | 문서 종류 | `article` | `categoryHub` | `utility` |
| `categoryId` | 카테고리 ID | 필수 | 필수 | null 허용 |
| `queryClusterId` | 쿼리 클러스터 ID | **필수** | **null** | **null** |
| `primaryQuery` | 대표 검색어 | 필수 | 필수 | 필수 |
| `searchIntent` | 검색 의도 | informational / commercial / transactional / navigational | | |
| `primaryQuestion` | 대표 질문 | 필수 | 필수 | 필수 |
| `shortAnswer` | 직접 답변 | 필수 | 필수 | 필수 |
| `primaryEntityId` | 대표 엔티티 | 필수 | 필수 | null 허용 |
| `authorId` | 저자 ID | **확인 전 null 허용** (임의 저자 금지) | | |
| `publishedAt` | 발행일 | 확인 전 null 허용 | | |
| `updatedAt` | 갱신일 | 필수 | | |
| `reviewedAt` | 검수일 | 확인 전 null 허용 | | |
| `reviewStatus` | 검수 상태 | `auto-mapped` / `human-review-needed` / `reviewed` | | |
| `sourceIds` | 출처 ID 배열 | active 문서는 **1개 이상** (utility는 빈 배열 허용) | | |
| `relatedIds` | 연관 문서 ID 배열 | 기본 빈 배열 | | |
| `status` | 게시 상태 | `active` / `deprecated` | | |
| `redirectFrom` | 이전 URL 배열 | 기본 빈 배열 | | |

- Starlight 네이티브 필드(`title`·`description`·`draft`·`tags`·`audience`)는 그대로 유지됩니다.
- `reviewStatus: reviewed`는 `authorId`·`publishedAt`·`reviewedAt`가 모두 있어야 합니다.
- `queryClusterId`가 비어 있으면 안 되고, categoryHub/utility는 반드시 null이어야 합니다.

### 3.2 용어사전 (`glossary/<id>.yaml`)

`term`, `definition`, `aliases`, `categoryId`, `sourceIds`(최소 1개), `relatedIds`,
`updatedAt`, `reviewedAt`, `reviewStatus`, `status`, `redirectFrom`.

- `reviewStatus: reviewed`면 `reviewedAt` 필수.
- 용어 하나 = YAML 파일 하나, 파일명 stem = 용어 ID.

### 3.3 레지스트리 (파일 = 레코드 1개)

모든 레지스트리는 **파일 하나 = 레코드 하나**, 파일명 stem(`<id>.json`)과 레코드의 `id`가 반드시 같아야 합니다.

| 레지스트리 | 필드 | 규칙 |
|---|---|---|
| `taxonomy/<id>.json` | `id`, `label`, `kind`(knowledge/glossary), `order`, `hubPath`, `status` | 지식 6 + 용어 5, ID·hubPath 고유 |
| `query-clusters/<id>.json` | `id`, `categoryId`, `title`, `order`, `hubPath`, `primaryEntityId`, `leafSlugs`, `status` | 11개, 카테고리·엔티티 참조 전부 해소 |
| `entities/<id>.json` | `id`, `name`, `type`(discipline/practice/platform/channel/metric), `sameAs[]`, `status` | 가짜 `sameAs` 0건 |
| `people/<id>.json` | `id`, `name`, `role`, `url`, `sameAs[]`, `status` | **검증된 저자만** 보관, 임시·추정 저자 금지 |
| `sources/<id>.json` | `id`, `title`, `publisher`, `url`(절대 http/https), `sourceType`, `accessedAt`, `supports[]`, `status` | URL은 HTTPS 권장, ID 고유 |

## 4. 정보 아키텍처 (IA)

`카테고리 허브 → 쿼리 클러스터 허브 → 리프 문서` 3단 구조입니다.

```
카테고리 허브 (6)                 /search/            (검색)
  └─ 쿼리 클러스터 허브 (11)      /search/clusters/seo-foundations/
       └─ 리프 문서 (12)          /search/seo-basic/
```

- 카테고리 허브: `/ai-search/`, `/analytics/`, `/content/`, `/performance/`, `/search/`, `/sns/`
- 쿼리 클러스터 허브: `/{categoryId}/clusters/{queryClusterId}/` — 11개
- 리프 문서: 12개, 각각 고유 검색 의도·대표 질문·직접 답변·엔티티·클러스터 보유
- 용어사전: `/glossary/` 인덱스 + `/glossary/{id}/` 상세 100개
- 툴: `/tools/roas-calculator/`, `/tools/keyword-combiner/`

## 5. 저작·수집 워크플로

```
① raw/ 스냅샷 수집
   → ② source 레지스트리 등록 (검증된 출처만)
   → ③ 초안 작성 (draft, reviewStatus: human-review-needed, authorId: null)
   → ④ 사람 검수 (사실 검증 → 출처·엔티티·질문·답변 확인)
   → ⑤ audit 통과 (중복 의도·깨진 참조·고아·출처 누락·카테고리 이탈·raw 유출 0)
   → ⑥ published (reviewed, active)
   → ⑦ deprecated (기존 항목은 draft 처리, 대체 active 항목이 이전 URL을 redirectFrom으로 수용)
```

1. **raw 수집**: 원천 자료를 `/raw/`에 비공개 스냅샷으로 보관합니다. Git·빌드·배포 대상이 아닙니다.
2. **source 등록**: 원천 자료의 신뢰도를 검증하고 `sources/<id>.json`에 등록합니다. URL·발행처·유형·접근일을 기록합니다.
3. **초안(draft)**: `draft: true`로 작성하고 `reviewStatus: human-review-needed`, `authorId: null`, `publishedAt: null`, `reviewedAt: null`로 시작합니다. 저자를 알 수 없으면 임시 저자를 만들지 않습니다.
4. **사람 검수**: 사실과 출처를 대조해 검수합니다. 검수가 끝나면 `reviewed`로 바꾸고 검증된 `authorId`(people 레지스트리 존재 필수)·`publishedAt`·`reviewedAt`를 채웁니다.
5. **audit**: `npm run content:audit`로 위반 0을 확인합니다.
6. **published**: `draft`를 제거하고 `status: active`로 게시합니다. `npm run verify`로 전체 체인을 통과해야 합니다.
7. **deprecated**: 기존 콘텐츠는 `status: deprecated`, `draft: true`로 내려 공개 라우트에서 제외합니다. 이전 URL을 보존해야 하면 **대체할 active 콘텐츠의** `redirectFrom`에 기존 URL을 추가합니다. 대체 콘텐츠가 없다면 리다이렉트를 추측해 만들지 않습니다.

> **현재 상태**: 등재된 모든 콘텐츠(문서 18 · 용어 100)는 `human-review-needed` 상태입니다. 저자가 확인되지 않았으므로 `reviewed`로 표시된 콘텐츠는 없습니다. (사람 레지스트리 0건)

## 6. 원천 자료·저작권 정책

- `/raw/`는 로컬 비공개 원천 스냅샷 전용 디렉터리입니다. Git·빌드·배포 대상이 아니며(`.gitignore`에 `/raw/`로 명시), 절대 커밋하지 않습니다.
- `/raw/`의 자료를 `src/`·`public/`로 복사·import·link하는 것을 금지합니다.
- 공개 산출물은 원천 자료를 **독립적으로 재작성(paraphrase/rewrite)** 한 뒤 출처만 명시해야 합니다. 원문 전재(verbatim)는 금지합니다.
- 원천 자료의 무단 유입 여부는 감사(audit)의 `RAW_LEAKAGE` 규칙이 차단·적발합니다.
- 모든 콘텐츠·레지스트리 파일은 **UTF-8**로 저장합니다.

## 7. 명령어

모든 명령은 프로젝트 루트에서 실행합니다.

| 명령 | 역할 |
|---|---|
| `npm install` | 의존성 설치 |
| `npm run dev -- --background` | 개발 서버 백그라운드 실행 (AGENTS.md 규칙) |
| `astro dev status` / `astro dev logs` / `astro dev stop` | 백그라운드 서버 관리 |
| `npm run test:content` | 콘텐츠·계약 단위/픽스처 테스트 |
| `npm run content:audit` | 콘텐츠 불변조건 감사 (위반 시 exit 1) |
| `npm run check` | Astro 타입/진단 검사 |
| `npm run build` | `dist/` 프로덕션 빌드 |
| `npm run verify:build` | 빌드 후 검증 (134페이지·JSON-LD·SITE_URL·raw 격리 등) |
| `npm run verify` | `test:content` → `content:audit` → `check` → `build` → `verify:build` 전체 실행 |
| `npm run preview` | 빌드 결과 로컬 미리보기 |
| `npm run astro ...` | Astro CLI 직접 실행 |

### 7.1 개발 서버 (백그라운드)

AGENTS.md에 따라 개발 서버는 백그라운드 모드로 실행합니다.

```
npm run dev -- --background
astro dev status
astro dev logs
astro dev stop
```

## 8. SITE_URL 동작

`SITE_URL`은 **검증된 실제 배포 원점**(절대 http(s) URL)일 때만 설정합니다. 여기서 배포 도메인을 추정하지 않습니다.

- **미설정**: canonical, sitemap, JSON-LD 내부 URL(`@id`/`url`/`mainEntityOfPage`/`inDefinedTermSet`), BreadcrumbList를 **생성하지 않습니다**. 가짜·localhost canonical과 sitemap이 만들어지지 않습니다.
- **설정 시** (`astro.config.mjs`가 http(s) 절대 URL인지 검증): 모든 페이지에 canonical, `sitemap-index.xml`·`sitemap-0.xml`, Article/DefinedTerm 내부 URL, 129개 페이지에 BreadcrumbList가 생성됩니다.

PowerShell 예시:

```powershell
# 미설정 상태로 빌드 (canonical·sitemap 없음)
Remove-Item Env:SITE_URL
npm run build

# 검증된 실제 도메인으로 빌드 (아래 주소는 반드시 실제 배포 원점으로 교체)
$env:SITE_URL = 'https://<검증된 실제 도메인>'
npm run build
```

## 9. 품질 게이트

`npm run verify`가 순서대로 실행하는 게이트입니다. 하나라도 실패하면 이후 단계를 진행하지 않습니다.

| 순서 | 게이트 | 검사 내용 |
|---|---|---|
| 1 | `test:content` | 계약·레지스트리·감사 규칙·이관의 단위/픽스처 테스트 (117개) |
| 2 | `content:audit` | `DUPLICATE_INTENT`·`BROKEN_REFERENCE`·`ORPHAN_LEAF`·`MISSING_SOURCE`·`CATEGORY_DRIFT`·`INVALID_RELATED`·`RAW_LEAKAGE` 위반 0 |
| 3 | `check` | Astro 타입/진단 오류 0 |
| 4 | `build` | 정적 빌드 성공 |
| 5 | `verify:build` | 134페이지·6/11/12/100 라우트·교차 링크·SourceList·JSON-LD 129·SITE_URL 분기·raw 격리·Pagefind 검증 |

## 10. 현재 라우트·카운트

| 항목 | 개수 |
|---|---|
| HTML 페이지 (dist) | **134** (홈·404·용어 인덱스·툴 2 포함) |
| 카테고리 허브 라우트 | **6** (`/ai-search/`, `/analytics/`, `/content/`, `/performance/`, `/search/`, `/sns/`) |
| 쿼리 클러스터 허브 라우트 | **11** |
| 리프 문서 | **12** |
| 용어사전 상세 라우트 | **100** |
| JSON-LD 대상 페이지 | **129** (Article 29 + DefinedTerm 100, 페이지당 정확히 1개) |
| 출처 레지스트리 | **19** |
| 엔티티 레지스트리 | **15** |
| 사람 레지스트리 | **0** (의도적 비움 — 검증된 저자만 수용) |

## 11. P0 제외 항목

다음은 현재 구현 범위(P0)에서 **제외**합니다.

- **CMS**: 콘텐츠는 파일 기반(Git)으로만 관리
- **DB**: 별도 데이터베이스 없음 (레지스트리 JSON이 단일 소스)
- **벡터DB / 임베딩 검색**: AI 검색용 임베딩 저장소 없음
- **크롤러**: 원천 자료 수집 자동화 없음 (raw 스냅샷을 수동으로 보관)
