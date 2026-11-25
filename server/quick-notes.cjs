'use strict';

/**
 * 盘中闪念速记存储服务（Ctrl+Shift+N）
 * - 数据存本机 stateFile('quick-notes.local.json')（打包严格排除）
 * - 支持绑定当前标的、分类标签、检索、删除与一键转为认知/方法论/台账草稿标记
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { workspaceStateFile } = require('./app-paths.cjs');
const { atomicWriteFileSync } = require('./lru-cache.cjs');

function getNotesPath() {
  return workspaceStateFile('quick-notes.local.json');
}

function loadStore() {
  try {
    const p = getNotesPath();
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && Array.isArray(parsed.items)) return parsed;
    }
  } catch {
    // ignore malformed store
  }
  return { version: 1, items: [] };
}

function saveStore(store) {
  atomicWriteFileSync(getNotesPath(), JSON.stringify(store, null, 2) + '\n', 'utf8');
}

function listQuickNotes() {
  const store = loadStore();
  return {
    ok: true,
    items: [...store.items].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
  };
}

function addQuickNote(payload = {}) {
  const text = String(payload.text || '').trim();
  if (!text) throw new Error('速记内容不能为空');
  const store = loadStore();
  const now = new Date().toISOString();
  const item = {
    id: `qn_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
    createdAt: now,
    updatedAt: now,
    symbol: String(payload.symbol || '').trim().slice(0, 32),
    symbolName: String(payload.symbolName || '').trim().slice(0, 40),
    tag: String(payload.tag || '盘中灵感').trim().slice(0, 24) || '盘中灵感',
    text: text.slice(0, 4000),
    convertedTo: null,
  };
  store.items.unshift(item);
  if (store.items.length > 500) store.items = store.items.slice(0, 500);
  saveStore(store);
  return { ok: true, item, items: store.items };
}

function deleteQuickNote(id) {
  const targetId = String(id || '').trim();
  const store = loadStore();
  const before = store.items.length;
  store.items = store.items.filter((x) => x.id !== targetId);
  if (store.items.length !== before) saveStore(store);
  return { ok: true, deleted: store.items.length !== before, items: store.items };
}

function markQuickNoteConverted(id, target) {
  const targetId = String(id || '').trim();
  const store = loadStore();
  const found = store.items.find((x) => x.id === targetId);
  if (!found) throw new Error('未找到对应速记条目');
  found.convertedTo = String(target || '').trim() || 'draft';
  found.updatedAt = new Date().toISOString();
  saveStore(store);
  return { ok: true, item: found, items: store.items };
}

module.exports = {
  listQuickNotes,
  addQuickNote,
  deleteQuickNote,
  markQuickNoteConverted,
};
