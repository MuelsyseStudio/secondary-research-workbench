'use strict';

/**
 * 多格式投研文档纯文本提取器
 * 支持：.pdf（带页码标注）、.docx、.html/.htm、.md、.txt、.csv、.json
 */

const path = require('node:path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const MAX_EXTRACTED_CHARS = 90000;

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从上传文件（base64）中提取可读纯文本
 */
async function extractDocumentText({ fileName, base64 }) {
  if (!fileName || !base64) {
    throw new Error('缺少文件名或文件内容。');
  }
  const cleanBase64 = String(base64).includes(',') ? String(base64).split(',').pop() : String(base64);
  const buf = Buffer.from(cleanBase64, 'base64');
  if (buf.length === 0) throw new Error('上传文件为空。');
  if (buf.length > 25 * 1024 * 1024) throw new Error('单个文档超过 25MB 限制，请拆分后上传。');

  const ext = path.extname(fileName).toLowerCase();
  let text = '';
  let pageCount = null;
  let warnings = [];

  if (ext === '.pdf') {
    let pageIdx = 0;
    const parsed = await pdfParse(buf, {
      pagerender: (pageData) =>
        pageData.getTextContent().then((tc) => {
          pageIdx += 1;
          const pageStr = tc.items.map((it) => it.str).join(' ');
          return `\n--- [第 ${pageIdx} 页] ---\n${pageStr}\n`;
        }),
    });
    text = (parsed.text || '').replace(/\n{3,}/g, '\n\n').trim();
    pageCount = parsed.numpages || pageIdx;
    if (text.replace(/--- \[第 \d+ 页\] ---/g, '').trim().length < 80) {
      warnings.push('该 PDF 可提取文字极少，疑似纯扫描图片版，建议先 OCR 后再转化，避免遗漏图表数据。');
    }
  } else if (ext === '.docx') {
    const res = await mammoth.extractRawText({ buffer: buf });
    text = (res.value || '').replace(/\n{3,}/g, '\n\n').trim();
  } else if (ext === '.html' || ext === '.htm') {
    text = stripHtml(buf.toString('utf8'));
  } else if (['.md', '.markdown', '.txt', '.csv', '.json', '.tsv', '.log'].includes(ext)) {
    text = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
  } else {
    throw new Error(`暂不支持的文件类型「${ext || '无扩展名'}」，支持 PDF / DOCX / MD / TXT / HTML / CSV / JSON。`);
  }

  const originalChars = text.length;
  let truncated = false;
  if (text.length > MAX_EXTRACTED_CHARS) {
    // 保留前 70% 与后 25% 兼顾开头摘要与文末结论/数据表
    const headLen = Math.floor(MAX_EXTRACTED_CHARS * 0.72);
    const tailLen = MAX_EXTRACTED_CHARS - headLen;
    text =
      text.slice(0, headLen) +
      `\n\n... [原文档共 ${originalChars} 字，中间部分已省略以适配上下文窗口] ...\n\n` +
      text.slice(-tailLen);
    truncated = true;
    warnings.push(`文档较长（${originalChars} 字），已按前72%+后28%智能截断至 ${MAX_EXTRACTED_CHARS} 字。`);
  }

  return {
    fileName,
    ext,
    sizeBytes: buf.length,
    pageCount,
    originalChars,
    extractedChars: text.length,
    truncated,
    warnings,
    text,
  };
}

module.exports = {
  extractDocumentText,
};
