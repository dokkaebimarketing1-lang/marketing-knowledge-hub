import { glob } from 'astro/loaders';
import type { Loader } from 'astro/loaders';

/**
 * 스케일러블 docs 콜렉션 로더 팩토리.
 *
 * `./src/content/docs` 아래의 마크다운(md/mdx) 문서를 glob으로 로드한다.
 * 계약:
 *   - base: `./src/content/docs` (프로젝트 루트 기준)
 *   - pattern: 모든 md·mdx 파일을 재귀 포함(glob: 별표, 별표, 슬래시, 별표,
 *     점, md / mdx), 밑줄(`_`)로 시작하는 디렉토리·파일은 어느 깊이든 제외
 *   - `retainBody: false` — 파싱된 원문 body를 데이터 스토어에 보존하지 않음
 *   - `deferRender: true` — 대용량 콜렉션의 메모리를 위해 렌더링 지연
 *   - 커스텀 `generateId` 없음 — 기본 파일 파생 slug ID/라우트 보존
 *
 * 아직 `content.config`에 연결하지 않는다(스테이징). 스키마 워커가
 * content.config를 수정할 때 충돌 없이 이 로더를 사용할 수 있다.
 */
export function scalableDocsLoader(): Loader {
	return glob({
		pattern: ['**/*.md', '**/*.mdx', '!**/_*/**', '!_*/**', '!**/_*'],
		base: './src/content/docs',
		retainBody: false,
		deferRender: true,
	});
}
