'use strict';

/**
 * 零外部依赖 YAML Frontmatter 确定性序列化与解析器
 * - 序列化输出 100% 合法的标准 YAML 1.2（Obsidian / PyYAML / js-yaml 原生兼容）
 * - 解析器支持块级对象、块级数组、内联 JSON/YAML Flow 对象数组与注释
 */

function quoteYamlString(str) {
  return JSON.stringify(String(str ?? ''));
}

function isSimpleScalar(val) {
  return val === null || typeof val === 'boolean' || typeof val === 'number' || typeof val === 'string';
}

function serializeScalar(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'null';
  return quoteYamlString(val);
}

function serializeFlowObject(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    parts.push(`${k}: ${serializeFlowValue(v)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

function serializeFlowValue(val) {
  if (isSimpleScalar(val)) return serializeScalar(val);
  if (Array.isArray(val)) return `[${val.map((x) => serializeFlowValue(x)).join(', ')}]`;
  if (typeof val === 'object') return serializeFlowObject(val);
  return 'null';
}

function serializeYamlBlock(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    if (isSimpleScalar(val)) {
      lines.push(`${pad}${key}: ${serializeScalar(val)}`);
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else if (val.every((x) => isSimpleScalar(x)) && val.length <= 12 && JSON.stringify(val).length <= 140) {
        lines.push(`${pad}${key}: [${val.map((x) => serializeScalar(x)).join(', ')}]`);
      } else {
        lines.push(`${pad}${key}:`);
        for (const item of val) {
          if (isSimpleScalar(item)) {
            lines.push(`${pad}  - ${serializeScalar(item)}`);
          } else if (item && typeof item === 'object' && !Array.isArray(item)) {
            lines.push(`${pad}  - ${serializeFlowObject(item)}`);
          } else {
            lines.push(`${pad}  - ${serializeFlowValue(item)}`);
          }
        }
      }
    } else if (typeof val === 'object') {
      const entries = Object.entries(val).filter(([, v]) => v !== undefined);
      if (entries.length === 0) {
        lines.push(`${pad}${key}: {}`);
      } else {
        lines.push(`${pad}${key}:`);
        lines.push(serializeYamlBlock(val, indent + 2));
      }
    }
  }
  return lines.join('\n');
}

function stringifyFrontmatter(frontmatter, body) {
  const yaml = serializeYamlBlock(frontmatter, 0);
  const cleanBody = String(body ?? '').replace(/^\r?\n+/, '').replace(/\s+$/, '');
  return `---\n${yaml}\n---\n\n${cleanBody}\n`;
}

/**
 * 解析 YAML Flow 表达式（支持双引号、单引号、无引号键名、嵌套数组与对象）
 */
function parseFlowValue(raw) {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowTopLevel(inner, ',').map((part) => parseFlowValue(part));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return {};
    const out = {};
    for (const entry of splitFlowTopLevel(inner, ',')) {
      const colonIdx = findFlowColon(entry);
      if (colonIdx === -1) continue;
      const rawKey = entry.slice(0, colonIdx).trim();
      const key =
        (rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))
          ? rawKey.slice(1, -1)
          : rawKey;
      const valStr = entry.slice(colonIdx + 1).trim();
      out[key] = parseFlowValue(valStr);
    }
    return out;
  }
  return s;
}

function splitFlowTopLevel(str, sep) {
  const parts = [];
  let cur = '';
  let depthBracket = 0;
  let depthBrace = 0;
  let inDouble = false;
  let inSingle = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (inDouble) {
      cur += ch;
      if (ch === '\\') escape = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      cur += ch;
      if (ch === "'" && str[i + 1] === "'") {
        cur += "'";
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      cur += ch;
    } else if (ch === "'") {
      inSingle = true;
      cur += ch;
    } else if (ch === '[') {
      depthBracket++;
      cur += ch;
    } else if (ch === ']') {
      depthBracket--;
      cur += ch;
    } else if (ch === '{') {
      depthBrace++;
      cur += ch;
    } else if (ch === '}') {
      depthBrace--;
      cur += ch;
    } else if (ch === sep && depthBracket === 0 && depthBrace === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) parts.push(cur);
  return parts;
}

function findFlowColon(str) {
  let inDouble = false;
  let inSingle = false;
  let escape = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === ':') return i;
  }
  return -1;
}

function stripInlineComment(line) {
  let inDouble = false;
  let inSingle = false;
  let escape = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function parseYamlLines(yamlText) {
  const rawLines = String(yamlText || '').split(/\r?\n/);
  const cleaned = [];
  for (const raw of rawLines) {
    const noComment = stripInlineComment(raw);
    if (!noComment.trim()) continue;
    const indent = noComment.match(/^(\s*)/)[1].length;
    cleaned.push({ indent, text: noComment.trim() });
  }

  let idx = 0;

  function parseBlock() {
    if (idx >= cleaned.length) return {};
    if (cleaned[idx].text.startsWith('- ') || cleaned[idx].text === '-') {
      const arr = [];
      const listIndent = cleaned[idx].indent;
      while (
        idx < cleaned.length &&
        cleaned[idx].indent === listIndent &&
        (cleaned[idx].text.startsWith('- ') || cleaned[idx].text === '-')
      ) {
        const rest = cleaned[idx].text.slice(1).trim();
        idx++;
        if (!rest) {
          if (idx < cleaned.length && cleaned[idx].indent > listIndent) {
            arr.push(parseBlock());
          } else {
            arr.push(null);
          }
        } else {
          arr.push(parseFlowValue(rest));
        }
      }
      return arr;
    }

    const obj = {};
    const mapIndent = cleaned[idx].indent;
    while (idx < cleaned.length && cleaned[idx].indent === mapIndent) {
      const line = cleaned[idx].text;
      if (line.startsWith('- ')) break;
      const colonIdx = findFlowColon(line);
      if (colonIdx === -1) {
        idx++;
        continue;
      }
      const key = line.slice(0, colonIdx).trim();
      const valStr = line.slice(colonIdx + 1).trim();
      idx++;
      if (valStr !== '') {
        obj[key] = parseFlowValue(valStr);
      } else if (idx < cleaned.length && cleaned[idx].indent > mapIndent) {
        obj[key] = parseBlock();
      } else {
        obj[key] = null;
      }
    }
    return obj;
  }

  return parseBlock();
}

function parseFrontmatter(markdownText) {
  const text = String(markdownText || '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    return { frontmatter: {}, body: text };
  }
  return {
    frontmatter: parseYamlLines(m[1]),
    body: m[2].replace(/^\r?\n/, ''),
  };
}

module.exports = {
  stringifyFrontmatter,
  parseFrontmatter,
  serializeYamlBlock,
  parseYamlLines,
  parseFlowValue,
};
