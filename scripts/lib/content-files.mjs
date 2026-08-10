// scripts/lib/content-files.mjs
//
// Wave2 TODO2.1 — 공유 콘텐츠 파일 parser.
// Markdown/MDX frontmatter, YAML glossary, JSON registry를 읽는 공유 파서로
// `scripts/content-audit.mjs`와 `scripts/migrate-existing-content.mjs`가 공용으로 사용한다.
//
// Exports:
//   walkFiles(root)                        -> string[]  (POSIX relative, sorted, deterministic)
//   parseContentFile(filePath)             -> { data, body, format }
//       format: 'frontmatter' (md/mdx/markdown) | 'yaml' | 'json'
//   parseFrontmatter(text, filePath?)      -> { data, body }
//   serializeFrontmatter(data, body, { extension })
//
// 정책:
//   - UTF-8로 읽고, CRLF/LF 라인엔딩 모두 지원 (본문 바이트 보존)
//   - 결정적 key 순서: JS 객체/배열의 입력 순서를 가능한 한 유지
//   - malformed YAML/JSON은 상대 경로를 포함한 Error를 던진다
//   - serialization은 body 바이트와 끝 newline을 보존한다

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const FRONTMATTER_EXTS = new Set(['md', 'mdx', 'markdown']);
const YAML_EXTS = new Set(['yaml', 'yml']);
const JSON_EXTS = new Set(['json']);

// 닫는 `---`가 행의 시작에 있는 frontmatter 블록 (CRLF/LF 모두 허용).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** 파일 경로를 cwd 기준 상대 경로로 표시한다 (불가능하면 절대 경로 유지). */
function displayPath(filePath) {
  const rel = path.relative(process.cwd(), filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return filePath;
}

/**
 * root 아래의 모든 파일을 POSIX 상대 경로(string[])로 정렬해 반환한다.
 * 디렉토리는 제외하며, 호출 순서와 무관하게 항상 같은 순서를 보장한다.
 */
export function walkFiles(root) {
  const out = [];
  const walk = (dir, base) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = base ? path.join(base, entry.name) : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.push(rel.split(path.sep).join('/'));
    }
  };
  walk(root, '');
  return out.sort();
}

/**
 * 파일 하나를 파싱해 { data, body, format }을 반환한다.
 *   - md/mdx/markdown: frontmatter → { data, body, format: 'frontmatter' }
 *   - yaml/yml:        → { data, body: null, format: 'yaml' }
 *   - json:            → { data, body: null, format: 'json' }
 * malformed YAML/JSON/미지원 확장자는 상대 경로를 포함한 Error를 던진다.
 */
export function parseContentFile(filePath) {
  const abs = path.resolve(filePath);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const text = fs.readFileSync(abs, 'utf8');

  if (FRONTMATTER_EXTS.has(ext)) {
    const { data, body } = parseFrontmatter(text, abs);
    return { data, body, format: 'frontmatter' };
  }
  if (YAML_EXTS.has(ext)) {
    return { data: parseYamlText(text, abs), body: null, format: 'yaml' };
  }
  if (JSON_EXTS.has(ext)) {
    return { data: parseJsonText(text, abs), body: null, format: 'json' };
  }
  throw new Error(
    `Unsupported content file extension ".${ext}" in ${displayPath(abs)} ` +
      `(supported: md/mdx/markdown, yaml/yml, json)`,
  );
}

/**
 * 텍스트에서 frontmatter 블록(파일 시작의 `---` … `---`)을 추출한다.
 * frontmatter가 없으면 { data: {}, body: 전체 텍스트 }를 반환한다.
 * `filePath`가 주어지면(YAML 오류 시) 상대 경로를 오류 메시지에 포함한다.
 */
export function parseFrontmatter(text, filePath) {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { data: {}, body: text };
  const block = m[1];
  const data = block.trim() === '' ? {} : parseYamlText(block, filePath);
  return { data, body: text.slice(m[0].length) };
}

/**
 * data(+body)를 지정한 확장자로 직렬화한다.
 *   - md/mdx/markdown: `---\n<yaml>\n---\n<body>` (body 바이트·끝 newline 보존)
 *   - yaml/yml:        YAML 텍스트 (끝 newline)
 *   - json:            들여쓰기 JSON 텍스트 (끝 newline)
 */
export function serializeFrontmatter(data, body, { extension } = {}) {
  const ext = String(extension ?? '').replace(/^\./, '').toLowerCase();

  if (FRONTMATTER_EXTS.has(ext)) {
    return `---\n${stringifyYaml(data)}---\n${body ?? ''}`;
  }
  if (YAML_EXTS.has(ext)) {
    return stringifyYaml(data);
  }
  if (JSON_EXTS.has(ext)) {
    const json = JSON.stringify(data, null, 2);
    return json.endsWith('\n') ? json : `${json}\n`;
  }
  throw new Error(
    `Unsupported serialization extension "${extension}" ` +
      `(supported: md/mdx/markdown, yaml/yml, json)`,
  );
}

function parseYamlText(text, filePath) {
  try {
    return YAML.parse(text);
  } catch (err) {
    const where = filePath ? ` in ${displayPath(filePath)}` : '';
    throw new Error(`Failed to parse YAML${where}: ${err.message}`, { cause: err });
  }
}

function parseJsonText(text, filePath) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse JSON in ${displayPath(filePath)}: ${err.message}`, { cause: err });
  }
}

function stringifyYaml(data) {
  const text = YAML.stringify(data);
  return text.endsWith('\n') ? text : `${text}\n`;
}
