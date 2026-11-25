'use strict';

/**
 * 本地凭据静态加密工具（AES-256-GCM + 本机隔离密钥文件）
 *
 * 原则：
 * - 密钥文件存放于操作系统用户本机目录（%LOCALAPPDATA%/ResearchWorkbench/.srw-vault-key），
 *   与可能被云盘同步或打包的 SRW_DATA_DIR 物理隔离，并限制 0o600 权限；
 * - 100% 向后兼容旧版明文密钥（读取时自动兼容明文，下次保存时透明升级为 enc:v1: 密文）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ENC_PREFIX = 'enc:v1:';
let cachedMasterKey = null;

function getKeyStorePath() {
  if (process.env.SRW_VAULT_KEY_PATH) {
    return path.resolve(process.env.SRW_VAULT_KEY_PATH);
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'ResearchWorkbench', '.srw-vault-key');
  }
  return path.join(os.homedir(), '.config', 'ResearchWorkbench', '.srw-vault-key');
}

function getMasterKey() {
  if (cachedMasterKey) return cachedMasterKey;
  const keyPath = getKeyStorePath();
  try {
    if (fs.existsSync(keyPath)) {
      const hex = fs.readFileSync(keyPath, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) {
        cachedMasterKey = Buffer.from(hex, 'hex');
        return cachedMasterKey;
      }
    }
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const raw = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, raw.toString('hex') + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // ignore on Windows
    }
    cachedMasterKey = raw;
    return cachedMasterKey;
  } catch {
    // Fallback deterministic machine key if home dir is read-only (e.g. restricted sandbox)
    const fallbackSeed = `srw-vault:${os.hostname()}:${os.userInfo().username}:${os.platform()}`;
    cachedMasterKey = crypto.createHash('sha256').update(fallbackSeed).digest();
    return cachedMasterKey;
  }
}

function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

function encryptSecret(plain) {
  const str = String(plain || '').trim();
  if (!str) return '';
  if (isEncryptedSecret(str)) return str;
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decryptSecret(stored) {
  const str = String(stored || '').trim();
  if (!str) return '';
  if (!isEncryptedSecret(str)) return str; // Backward-compatible plaintext
  try {
    const payload = str.slice(ENC_PREFIX.length);
    const parts = payload.split('.');
    if (parts.length !== 3) return '';
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const enc = Buffer.from(parts[2], 'base64');
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

module.exports = {
  ENC_PREFIX,
  isEncryptedSecret,
  encryptSecret,
  decryptSecret,
};
