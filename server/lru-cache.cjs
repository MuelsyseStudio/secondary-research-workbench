'use strict';

/**
 * 共享内存有界缓存（LRU + TTL + Singleflight 并发合并 + 失败短熔断）与安全原子写盘工具
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class LruTtlCache {
  constructor({ maxEntries = 300, defaultTtlMs = 60000 } = {}) {
    this.maxEntries = Math.max(16, Number(maxEntries) || 300);
    this.defaultTtlMs = Math.max(1000, Number(defaultTtlMs) || 60000);
    this._map = new Map();
    this._inflight = new Map();
    this._negUntil = new Map();
  }

  getMeta(key, ttlMs = this.defaultTtlMs) {
    const hit = this._map.get(key);
    if (!hit) return null;
    const now = Date.now();
    if (now - hit.ts >= ttlMs) {
      this._map.delete(key);
      return null;
    }
    // LRU touch
    this._map.delete(key);
    this._map.set(key, hit);
    return {
      data: hit.data,
      ts: hit.ts,
      ageSec: Math.max(0, Math.round((now - hit.ts) / 1000)),
    };
  }

  get(key, ttlMs = this.defaultTtlMs) {
    const hit = this.getMeta(key, ttlMs);
    return hit ? hit.data : null;
  }

  getStale(key) {
    const hit = this._map.get(key);
    if (!hit) return null;
    return {
      data: hit.data,
      ts: hit.ts,
      ageSec: Math.max(0, Math.round((Date.now() - hit.ts) / 1000)),
    };
  }

  set(key, data) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, { ts: Date.now(), data });
    while (this._map.size > this.maxEntries) {
      const oldestKey = this._map.keys().next().value;
      if (oldestKey === undefined) break;
      this._map.delete(oldestKey);
    }
    this._negUntil.delete(key);
    return data;
  }

  delete(key) {
    this._map.delete(key);
    this._negUntil.delete(key);
  }

  clear() {
    this._map.clear();
    this._negUntil.clear();
  }

  /**
   * Singleflight 并发合并 + 失败短熔断（避免弱网/断网期间相同上游请求雪崩穿透）
   */
  async singleflight(key, ttlMs, fn, { force = false, negTtlMs = 20000 } = {}) {
    if (!force) {
      const cached = this.get(key, ttlMs);
      if (cached !== null) return cached;
      const negExp = this._negUntil.get(key);
      if (negExp && Date.now() < negExp) {
        const stale = this.getStale(key);
        if (stale) return stale.data;
        throw new Error('上游数据源短时熔断保护中，请稍后重试');
      }
    }

    if (this._inflight.has(key)) {
      return this._inflight.get(key);
    }

    const p = Promise.resolve()
      .then(() => fn())
      .then((res) => {
        this._inflight.delete(key);
        if (res !== undefined && res !== null) {
          this.set(key, res);
        }
        return res;
      })
      .catch((err) => {
        this._inflight.delete(key);
        if (negTtlMs > 0) {
          this._negUntil.set(key, Date.now() + negTtlMs);
        }
        throw err;
      });

    this._inflight.set(key, p);
    return p;
  }
}

/**
 * 带随机后缀 + Windows EPERM/EBUSY 短退避重试的原子写盘函数
 */
function atomicWriteFileSync(targetPath, content, encoding = 'utf8', opts = {}) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const suffix = `${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const tmpPath = `${targetPath}.${suffix}`;
  const writeOpts = opts.mode ? { encoding, mode: opts.mode } : encoding;
  fs.writeFileSync(tmpPath, content, writeOpts);
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      if (err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') && attempt < 3) {
        // Brief sync spin (15ms * (attempt + 1)) to let AV/indexer release handle on Windows
        const end = Date.now() + 15 * (attempt + 1);
        while (Date.now() < end) {
          // wait
        }
        continue;
      }
      break;
    }
  }
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch {
    // ignore cleanup failure
  }
  throw lastErr;
}

module.exports = {
  LruTtlCache,
  atomicWriteFileSync,
};
