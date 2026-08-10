// scripts/lib/registry-validation.mjs
// Wave1 TODO4 — registry 스키마 validator
//
// Contract (tests/registries/registries.test.mjs):
//   export function validateRegistries(root) -> Promise<{ errors: Array<{ code, file, message }> }>
//
// Registry layout:
//   <root>/registries/{taxonomy,query-clusters,entities,people,sources}/<id>.json
//   - 각 파일은 단일 레코드 객체 하나이며, 레코드 `id`는 파일 stem과 같아야 한다
//   - error code 목록:
//       DUPLICATE_ID                레코드 id가 2개 이상 파일에서 중복(또는 id != file stem)
//       INVALID_PATH                registries/{5개 kind}/ 밖에 위치한 .json 파일
//       INVALID_URL                 source `url`이 절대 http(s) URL이 아님(또는 누락)
//       INVALID_STATUS              레코드 `status`가 { active, deprecated } 밖의 값
//       CLUSTER_CATEGORY_MISMATCH   query-cluster의 `categoryId`가 taxonomy id로 해소 불가
//   - cross-registry 관계: cluster.categoryId -> taxonomy.id,
//                          cluster.primaryEntityId ?? entityId -> entities.id
//                          (primaryEntityId가 있으면 우선, 없으면 entityId 폴백)
//
// 콘텐츠 audit(scripts/content-audit.mjs)이 이 validator를 재사용한다.

import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_KINDS = new Set(['taxonomy', 'query-clusters', 'entities', 'people', 'sources']);
const VALID_STATUSES = new Set(['active', 'deprecated']);
function isAbsoluteHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const ERR = {
  DUPLICATE_ID: 'DUPLICATE_ID',
  INVALID_PATH: 'INVALID_PATH',
  INVALID_URL: 'INVALID_URL',
  INVALID_STATUS: 'INVALID_STATUS',
  CLUSTER_CATEGORY_MISMATCH: 'CLUSTER_CATEGORY_MISMATCH',
};

/** OS에 무관하게 POSIX 경로(/)로 정규화 */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** root 아래의 모든 .json 파일을 절대 경로로 재귀 수집 */
function collectJsonFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 디렉터리가 없으면 빈 결과 (치명적이지 않음)
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonFiles(abs, out);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(abs);
    }
  }
  return out;
}

/** 단일 .json 파일을 레코드로 읽음 (rel: root 기준 POSIX 경로) */
function readRecord(root, abs) {
  const rel = toPosix(path.relative(root, abs));
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    data = null; // 파싱 실패 시 데이터 기반 검증은 건너뜀
  }
  return {
    abs,
    rel,
    parts: rel.split('/'),
    stem: path.basename(abs, '.json'),
    data,
    kind: undefined,
  };
}

export async function validateRegistries(root) {
  const errors = [];
  const records = collectJsonFiles(path.join(root, 'registries'))
    .map((abs) => readRecord(root, abs))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const idGroups = new Map(); // `${kind}:${id}` -> [{ rel, stem, kind, data }]
  const taxonomyIds = new Set();
  const entityIds = new Set();

  // --- 1차 패스: 경로 규칙 + 개별 레코드 규칙 + id 수집 -------------------------------
  for (const rec of records) {
    const isAllowedPath = rec.parts.length === 3 && ALLOWED_KINDS.has(rec.parts[1]);
    if (!isAllowedPath) {
      errors.push({
        code: ERR.INVALID_PATH,
        file: rec.rel,
        message: `Registry .json은 registries/{${[...ALLOWED_KINDS].join(',')}}/<id>.json 경로에 있어야 합니다: ${rec.rel}`,
      });
      continue; // 잘못 위치한 파일은 kind 귀속이 불가하므로 추가 규칙 미적용
    }

    rec.kind = rec.parts[1];
    if (rec.data === null) continue;

    const recId = typeof rec.data.id === 'string' ? rec.data.id : rec.stem;
    const idGroupKey = `${rec.kind}:${recId}`;
    if (!idGroups.has(idGroupKey)) idGroups.set(idGroupKey, []);
    idGroups.get(idGroupKey).push(rec);

    // status: { active, deprecated } 밖의 값 → INVALID_STATUS
    if (rec.data.status !== undefined && !VALID_STATUSES.has(rec.data.status)) {
      errors.push({
        code: ERR.INVALID_STATUS,
        file: rec.rel,
        message: `레코드 status "${rec.data.status}"는 { active, deprecated } 중 하나여야 합니다: ${rec.rel}`,
      });
    }

    // sources: 절대 http(s) URL 필수 → INVALID_URL
    if (rec.kind === 'sources') {
      const urlOk = isAbsoluteHttpUrl(rec.data.url);
      if (!urlOk) {
        errors.push({
          code: ERR.INVALID_URL,
          file: rec.rel,
          message: `source 레코드는 절대 http(s) url이 필요합니다 (누락 또는 형식 오류): ${rec.rel}`,
        });
      }
    }

    if (rec.kind === 'people' && rec.data.url !== undefined && !isAbsoluteHttpUrl(rec.data.url)) {
      errors.push({
        code: ERR.INVALID_URL,
        file: rec.rel,
        message: `people url은 절대 http(s) URL이어야 합니다: ${rec.rel}`,
      });
    }

    if (rec.kind === 'entities' || rec.kind === 'people') {
      const sameAs = Array.isArray(rec.data.sameAs) ? rec.data.sameAs : [];
      for (const url of sameAs) {
        if (isAbsoluteHttpUrl(url)) continue;
        errors.push({
          code: ERR.INVALID_URL,
          file: rec.rel,
          message: `${rec.kind} sameAs 항목은 절대 http(s) URL이어야 합니다: ${rec.rel}`,
        });
      }
    }

    // cross-registry 참조 집합 수집
    if (rec.kind === 'taxonomy') taxonomyIds.add(rec.data.id);
    if (rec.kind === 'entities') entityIds.add(rec.data.id);
  }

  // --- 2차 패스: id 중복 + id != file stem → DUPLICATE_ID ------------------------------
  for (const recs of idGroups.values()) {
    const id = typeof recs[0]?.data?.id === 'string' ? recs[0].data.id : recs[0]?.stem;
    if (recs.length > 1) {
      for (const rec of recs) {
        errors.push({
          code: ERR.DUPLICATE_ID,
          file: rec.rel,
          message: `레코드 id "${id}"가 여러 파일에서 중복됩니다 (${recs.map((r) => r.rel).join(', ')}): ${rec.rel}`,
        });
      }
    }
    for (const rec of recs) {
      if (typeof rec.data?.id === 'string' && rec.data.id !== rec.stem) {
        errors.push({
          code: ERR.DUPLICATE_ID,
          file: rec.rel,
          message: `레코드 id "${rec.data.id}"가 파일 stem "${rec.stem}"과 일치하지 않습니다 (IDs are file stems): ${rec.rel}`,
        });
      }
    }
  }

  // --- 3차 패스: cluster → taxonomy(categoryId) / entities(primaryEntityId ?? entityId) 해소 ---
  for (const rec of records) {
    if (rec.kind !== 'query-clusters' || rec.data === null) continue;
    if (typeof rec.data.categoryId === 'string' && !taxonomyIds.has(rec.data.categoryId)) {
      errors.push({
        code: ERR.CLUSTER_CATEGORY_MISMATCH,
        file: rec.rel,
        message: `query-cluster "${rec.data.id}"의 categoryId "${rec.data.categoryId}"는 taxonomy id로 해소할 수 없습니다: ${rec.rel}`,
      });
    }
    // primaryEntityId가 있으면 우선 검증, 없으면 entityId 폴백 (기존 entityId fixture 호환)
    if (typeof rec.data.primaryEntityId === 'string' && !entityIds.has(rec.data.primaryEntityId)) {
      errors.push({
        code: ERR.CLUSTER_CATEGORY_MISMATCH,
        file: rec.rel,
        message: `query-cluster "${rec.data.id}"의 primaryEntityId "${rec.data.primaryEntityId}"는 entities id로 해소할 수 없습니다: ${rec.rel}`,
      });
    } else if (typeof rec.data.entityId === 'string' && !entityIds.has(rec.data.entityId)) {
      errors.push({
        code: ERR.CLUSTER_CATEGORY_MISMATCH,
        file: rec.rel,
        message: `query-cluster "${rec.data.id}"의 entityId "${rec.data.entityId}"는 entities id로 해소할 수 없습니다: ${rec.rel}`,
      });
    }
  }

  return { errors };
}
