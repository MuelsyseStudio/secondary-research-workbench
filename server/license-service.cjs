'use strict';

/**
 * 商业化底座 · 离线 Ed25519 非对称加密授权码验证服务（SRW2 + 向后兼容 SRW1，零外部依赖）
 *
 * 架构特性（JetBrains 永久回退订阅 + 可选 2 台设备指纹绑定）：
 * - 发行包内仅嵌入 Ed25519 公钥（server/license-public-key.pem），离线毫秒级数学验签；
 * - 私钥保存在 private-keys/license-ed25519.pem（严禁进入任何对外分发包）；
 * - 支持版本：
 *   - SRW2（推荐）：支持 updatesUntil、perpetualFallback（JetBrains 永久回退：buildDate <= updatesUntil）、
 *     maxDevices(<=2)、machineHashes 脱敏 12 位设备指纹绑机校验、edition 与 features 精细化授权；
 *   - SRW1（兼容）：向下兼容历史签发的所有 SRW1 体验/年费/买断码；
 * - 授权档位：
 *   - developer     ：本机开发者主理人模式（全功能）
 *   - free          ：免费基础版（三库闭环、基础看盘、手工账本与基础复盘永久可用）
 *   - friend_trial  ：朋友体验授权（全功能限时）
 *   - pro_annual    ：Pro 年度更新订阅（含永久回退权）
 *   - pro_lifetime  ：Pro 创世买断版（锁主版本永久有效）
 *   - max_annual    ：Max 量化年度订阅（含 Stage 4 Python 回测 + 永久回退权）
 *   - max_lifetime  ：Max 量化终身买断版
 *   - partner       ：机构白标合作版（全功能 + 机构清单钩子）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { APP_ROOT, IS_PORTABLE_MODE, stateFile } = require('./app-paths.cjs');
const { getEditionInfo } = require('./edition.cjs');

const PUBLIC_KEY_FILE = path.join(__dirname, 'license-public-key.pem');
const RELEASE_CONFIG_FILE = path.join(APP_ROOT, 'release-config.json');

// 编译期固化商业验签参数（商业发行包由 esbuild 注入，杜绝篡改外置 release-config.json 或替换 license-public-key.pem 绕过）
const BAKED_ENFORCEMENT_MODE =
  typeof __SRW_BAKED_ENFORCEMENT__ === 'string' && __SRW_BAKED_ENFORCEMENT__ ? __SRW_BAKED_ENFORCEMENT__ : null;
const BAKED_PUBLIC_KEY_PEM =
  typeof __SRW_BAKED_PUBLIC_KEY_PEM__ === 'string' && __SRW_BAKED_PUBLIC_KEY_PEM__.includes('BEGIN PUBLIC KEY')
    ? __SRW_BAKED_PUBLIC_KEY_PEM__
    : null;

const TIER_LABELS = {
  developer: '主理人开发者版（全功能）',
  community_oss: '开源社区版（全功能开放）',
  friend_trial: '朋友尊享体验授权（全功能）',
  pro_lifetime: 'Pro 创世买断版（v2.x 永久有效）',
  pro_annual: 'Pro 年度专业版（含永久回退权）',
  max_lifetime: 'Max 量化买断版（全功能永久有效）',
  max_annual: 'Max 量化年度版（含永久回退权）',
  partner: '机构合作白标版（Partner）',
  free: '免费基础版（Free）',
};

const PRO_FEATURES = [
  'multi_workspace',
  'ai_daily_review',
  'ic_adversarial_debate',
  'ai_batch_ingest',
  'trade_ledger_ai_import',
  'custom_chart_drawings',
  'scheduler_webhooks',
  'periodic_meta_review',
  'slime_bot_autonomous',
  'brand_custom',
  'bar_replay_trainer',
  'multi_chart',
];

const MAX_FEATURES = ['quant_backtest'];

let cachedMachineCode = null;

// 常见虚拟网卡 / VPN / Docker / VMware / Hyper-V 厂商 MAC 前缀，避免切 VPN 或插拔扩展坞导致设备码漂移
const VIRTUAL_MAC_PREFIXES = ['00:05:69', '00:0c:29', '00:1c:14', '00:50:56', '00:15:5d', '08:00:27', '02:42:', '00:ff:', '0a:00:27'];

function readWindowsMachineGuid() {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 2500, windowsHide: true }
    );
    const m = out.match(/MachineGuid\s+REG_SZ\s+([A-Za-z0-9\-]+)/i);
    return m ? m[1].trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * 计算脱敏 12 位本机设备指纹码（不可逆 SHA-256 截断，仅用于离线绑机核验，不暴露原始硬件信息）
 * Windows 下优先绑定系统注册表 MachineGuid（不受切换 VPN/Wi-Fi/扩展坞网卡变化影响）。
 */
function getMachineCode() {
  if (cachedMachineCode) return cachedMachineCode;
  try {
    const winGuid = readWindowsMachineGuid();
    if (winGuid) {
      const seed = ['srw-device-v3-win', os.arch(), winGuid].join('|');
      cachedMachineCode = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12).toUpperCase();
      return cachedMachineCode;
    }
    const ifaces = os.networkInterfaces();
    const macs = [];
    for (const [ifaceName, list] of Object.entries(ifaces || {})) {
      if (/vethernet|docker|vmware|virtualbox|tailscale|wireguard|tun|tap|wsl/i.test(ifaceName)) continue;
      for (const item of list || []) {
        if (!item || item.internal) continue;
        const mac = String(item.mac || '').toLowerCase();
        if (!mac || mac === '00:00:00:00:00:00') continue;
        if (VIRTUAL_MAC_PREFIXES.some((p) => mac.startsWith(p))) continue;
        macs.push(mac);
      }
    }
    macs.sort();
    const cpuModel = (os.cpus()?.[0]?.model || '').trim();
    const seed = [
      'srw-device-v2',
      os.platform(),
      os.arch(),
      os.hostname(),
      cpuModel,
      macs.slice(0, 3).join(','),
    ].join('|');
    cachedMachineCode = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12).toUpperCase();
  } catch {
    cachedMachineCode = crypto
      .createHash('sha256')
      .update(`srw-device-fallback|${os.hostname()}|${os.platform()}`)
      .digest('hex')
      .slice(0, 12)
      .toUpperCase();
  }
  return cachedMachineCode;
}

function loadReleaseConfig() {
  const ed = getEditionInfo();
  let cfg = {
    edition: ed.edition,
    editionLabel: ed.editionLabel,
    buildDate: ed.buildDate,
    features: ed.features,
    enforcementMode: BAKED_ENFORCEMENT_MODE || (process.env.SRW_LICENSE_ENFORCE === '1' ? 'enforced' : 'permissive'),
    appVersion: '2.0.0',
    productName: '二级投研 · 三库研究工作台',
  };
  try {
    if (fs.existsSync(RELEASE_CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(RELEASE_CONFIG_FILE, 'utf8'));
      cfg = {
        ...cfg,
        ...raw,
        edition: ed.edition,
        editionLabel: ed.editionLabel,
        buildDate: ed.buildDate,
        features: ed.features,
        // 商业打包固化 enforcementMode 不可被外置 release-config.json 篡改为 permissive
        enforcementMode: BAKED_ENFORCEMENT_MODE || raw.enforcementMode || cfg.enforcementMode,
      };
    }
  } catch {
    // ignore
  }
  if (BAKED_ENFORCEMENT_MODE === 'enforced' || process.env.SRW_LICENSE_ENFORCE === '1') {
    cfg.enforcementMode = 'enforced';
  }
  return cfg;
}

function getLicenseStoragePath() {
  return stateFile('license.local.json');
}

function loadPublicKeyPem() {
  if (BAKED_PUBLIC_KEY_PEM) return BAKED_PUBLIC_KEY_PEM;
  try {
    if (fs.existsSync(PUBLIC_KEY_FILE)) {
      return fs.readFileSync(PUBLIC_KEY_FILE, 'utf8').trim();
    }
  } catch {
    // ignore
  }
  return null;
}

function decodeBase64Url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function getClockWatermarkPath() {
  try {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(localAppData, 'ResearchWorkbench', '.clock-watermark.json');
    }
    return path.join(os.homedir(), '.config', 'ResearchWorkbench', '.clock-watermark.json');
  } catch {
    return stateFile('.clock-watermark.json');
  }
}

function readAndAdvanceClockWatermark(todayISO) {
  const wmPath = getClockWatermarkPath();
  let maxSeen = todayISO;
  let clockRollbackDetected = false;
  try {
    if (fs.existsSync(wmPath)) {
      const parsed = JSON.parse(fs.readFileSync(wmPath, 'utf8'));
      const prev = String(parsed?.maxDate || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(prev)) {
        const diff = daysBetweenISO(todayISO, prev);
        // 若系统时钟较历史最高水位回拨超过 1 天，触发防回拨保护
        if (diff != null && diff > 2) {
          clockRollbackDetected = true;
          maxSeen = prev;
        } else if (prev > todayISO) {
          maxSeen = prev;
        }
      }
    }
    if (!clockRollbackDetected && (!fs.existsSync(wmPath) || maxSeen === todayISO)) {
      fs.mkdirSync(path.dirname(wmPath), { recursive: true });
      fs.writeFileSync(wmPath, JSON.stringify({ maxDate: todayISO, updatedAt: new Date().toISOString() }) + '\n', 'utf8');
    }
  } catch {
    // non-fatal
  }
  return { effectiveToday: maxSeen > todayISO ? maxSeen : todayISO, clockRollbackDetected };
}

function getCurrentAppMajorVersion() {
  if (typeof __SRW_BAKED_APP_MAJOR__ === 'number' && __SRW_BAKED_APP_MAJOR__ > 0) {
    return __SRW_BAKED_APP_MAJOR__;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    const m = String(pkg?.version || '2.0.0').match(/^(\d+)/);
    return m ? Number(m[1]) : 2;
  } catch {
    return 2;
  }
}

function todayLocalISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysBetweenISO(fromISO, toISO) {
  const a = new Date(`${String(fromISO).slice(0, 10)}T00:00:00+08:00`).getTime();
  const b = new Date(`${String(toISO).slice(0, 10)}T23:59:59+08:00`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.ceil((b - a) / 86400000);
}

function verifyLicenseKeyString(rawKey, options = {}) {
  const key = String(rawKey || '').trim().replace(/\s+/g, '');
  if (!key) {
    return { valid: false, error: '授权码不能为空' };
  }
  const parts = key.split('.');
  const prefix = parts[0];
  if (parts.length !== 3 || (prefix !== 'SRW1' && prefix !== 'SRW2')) {
    return { valid: false, error: '授权码格式不正确（应以 SRW2. 或 SRW1. 开头，共三段）' };
  }

  const pubPem = options.publicKeyPem || loadPublicKeyPem();
  if (!pubPem) {
    return { valid: false, error: '当前版本未嵌入验签公钥（license-public-key.pem）' };
  }

  try {
    const payloadBuf = decodeBase64Url(parts[1]);
    const sigBuf = decodeBase64Url(parts[2]);
    const pubKey = crypto.createPublicKey(pubPem);
    const verified = crypto.verify(null, payloadBuf, pubKey, sigBuf);
    if (!verified) {
      return { valid: false, error: '授权码数字签名校验失败（疑似被篡改或非官方签发）' };
    }

    const payload = JSON.parse(payloadBuf.toString('utf8'));
    if (!payload || !payload.tier || !payload.holder) {
      return { valid: false, error: '授权载荷缺少必要字段' };
    }

    // 防单字符改前缀绕过（SRW1 -> SRW2）：强制前缀与已签名的 payload.v 一致
    if (prefix === 'SRW2' && Number(payload.v) !== 2) {
      return { valid: false, error: '授权码协议前缀与数字签名载荷版本不匹配，疑似被篡改' };
    }
    if (prefix === 'SRW1' && Number(payload.v) === 2) {
      return { valid: false, error: '授权码协议前缀与数字签名载荷版本不匹配' };
    }
    const schemaVersion = prefix === 'SRW2' && Number(payload.v) === 2 ? 2 : 1;
    const relCfg = options.releaseConfig || loadReleaseConfig();
    const buildDate = String(options.buildDate || relCfg.buildDate || todayLocalISO()).slice(0, 10);
    const rawToday = String(options.today || todayLocalISO()).slice(0, 10);
    const wm = options.today
      ? { effectiveToday: rawToday, clockRollbackDetected: false }
      : readAndAdvanceClockWatermark(rawToday);
    const today = wm.effectiveToday;
    const currentMachine = String(options.machineCode || getMachineCode()).trim().toUpperCase();

    // 0. 商业正式强校验态下收紧旧版无版本/无绑机校验的 SRW1 旁路；个人/开发态保持兼容
    if (
      schemaVersion === 1 &&
      relCfg.edition !== 'personal' &&
      relCfg.enforcementMode === 'enforced' &&
      !options.allowLegacySrw1
    ) {
      return {
        valid: false,
        error: '商业正式版要求使用 SRW2 新版授权码，请联系签发方免费换发 SRW2 授权码',
      };
    }

    // 0B. 时钟回拨与未来签发日期校验
    if (wm.clockRollbackDetected) {
      return {
        valid: false,
        clockTampered: true,
        error: '检测到本机系统日期异常回拨，请校准操作系统时间后重试',
      };
    }
    const issuedAt = payload.issuedAt ? String(payload.issuedAt).slice(0, 10) : null;
    if (issuedAt && /^\d{4}-\d{2}-\d{2}$/.test(issuedAt) && today < issuedAt) {
      const aheadDays = daysBetweenISO(today, issuedAt);
      if (aheadDays != null && aheadDays > 2) {
        return {
          valid: false,
          clockTampered: true,
          error: `本机日期 (${today}) 早于授权签发日 (${issuedAt})，请校准系统时钟`,
        };
      }
    }

    // 1. Edition isolation check for SRW2 (if license specifies a target edition)
    const licEdition = String(payload.edition || '').trim().toLowerCase();
    if (
      schemaVersion === 2 &&
      licEdition &&
      licEdition !== 'any' &&
      relCfg.edition !== 'personal' &&
      licEdition !== relCfg.edition
    ) {
      return {
        valid: false,
        editionMismatch: true,
        error: `该授权码签发给 ${licEdition} 版本，与当前客户端版本 (${relCfg.edition}) 不匹配`,
      };
    }

    // 2. Device binding check (SRW2 optional machineHashes, up to maxDevices=2)
    const maxDevices = Math.min(2, Math.max(1, Number(payload.maxDevices || 2)));
    const machineHashes = Array.isArray(payload.machineHashes)
      ? payload.machineHashes
          .map((h) => String(h || '').trim().toUpperCase())
          .filter(Boolean)
          .slice(0, maxDevices)
      : [];

    if (machineHashes.length > 0 && !machineHashes.includes(currentMachine)) {
      return {
        valid: false,
        deviceMismatch: true,
        error: `本机设备码 (${currentMachine}) 未在该 SRW2 授权码允许的绑定设备列表中（最多 ${maxDevices} 台），请核对设备码或联系签发方换绑`,
      };
    }

    // 3. Expiration & JetBrains Perpetual Fallback evaluation
    const tier = String(payload.tier);
    const isLifetime = tier === 'pro_lifetime' || tier === 'max_lifetime';
    const updatesUntil = payload.updatesUntil
      ? String(payload.updatesUntil).slice(0, 10)
      : payload.expiresAt && (tier === 'pro_annual' || tier === 'max_annual')
      ? String(payload.expiresAt).slice(0, 10)
      : null;
    const expiresAt = payload.expiresAt ? String(payload.expiresAt).slice(0, 10) : updatesUntil;
    const perpetualFallback =
      schemaVersion === 2
        ? Boolean(payload.perpetualFallback)
        : false;
    const fallbackMajor = Number(payload.fallbackMajor || payload.majorVersion || 2);

    let expired = false;
    let perpetualFallbackActive = false;
    let updatesExpired = false;
    let daysRemaining = null;
    let error = null;

    if (isLifetime) {
      if (schemaVersion === 2) {
        const appMajor = getCurrentAppMajorVersion();
        const licensedMajor = Number(payload.majorVersion || payload.fallbackMajor || 0);
        if (licensedMajor > 0 && appMajor > licensedMajor) {
          expired = true;
          error = `该买断授权适用于 v${licensedMajor}.x 版本，当前客户端为 v${appMajor}.x，请升级跨代授权或使用 v${licensedMajor}.x 版本`;
        }
      }
    } else {
      if (schemaVersion === 2 && updatesUntil) {
        const diffDays = daysBetweenISO(today, updatesUntil);
        daysRemaining = diffDays;
        if (diffDays != null && diffDays < 0) {
          updatesExpired = true;
          if (perpetualFallback && buildDate <= updatesUntil) {
            // JetBrains 模式：软件构建日 <= 订阅更新截止日，永久回退有效！
            perpetualFallbackActive = true;
            expired = false;
          } else {
            expired = true;
            error = perpetualFallback
              ? `当前程序构建日期 (${buildDate}) 晚于您的永久回退截止日 (${updatesUntil})，请续费或回退至 ${updatesUntil} 及之前发布的 v${fallbackMajor}.x 版本`
              : `该授权码已于 ${updatesUntil} 到期，请续费或更换新授权码`;
          }
        }
      } else if (expiresAt) {
        const diffDays = daysBetweenISO(today, expiresAt);
        daysRemaining = diffDays;
        if (diffDays != null && diffDays < 0) {
          expired = true;
          error = `该授权码已于 ${expiresAt} 过期，请续费或更换新授权码`;
        }
      }
    }

    // Optional lease check (for Phase 2 thin cloud lease)
    if (!expired && payload.leaseUntil) {
      const leaseDiff = daysBetweenISO(today, String(payload.leaseUntil).slice(0, 10));
      if (leaseDiff != null && leaseDiff < 0) {
        expired = true;
        error = `离线租约已于 ${String(payload.leaseUntil).slice(0, 10)} 到期，请联网续签`;
      }
    }

    const grantedFeatures = Array.isArray(payload.features)
      ? payload.features.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    return {
      valid: !expired,
      expired,
      perpetualFallbackActive,
      updatesExpired,
      error,
      schemaVersion,
      payload: {
        v: schemaVersion,
        licenseId: String(payload.licenseId || ''),
        edition: licEdition || 'any',
        tier,
        tierLabel: TIER_LABELS[tier] || tier,
        holder: String(payload.holder),
        issuedAt: String(payload.issuedAt || ''),
        expiresAt,
        updatesUntil,
        perpetualFallback,
        fallbackMajor,
        maxDevices,
        machineHashes,
        leaseUntil: payload.leaseUntil ? String(payload.leaseUntil) : null,
        features: grantedFeatures,
        majorVersion: Number(payload.majorVersion || fallbackMajor || 2),
        note: String(payload.note || ''),
      },
      daysRemaining,
    };
  } catch (err) {
    return { valid: false, error: `授权码解析异常：${err.message}` };
  }
}

function getLicenseStatus(options = {}) {
  const relCfg = options.releaseConfig || loadReleaseConfig();
  const machineCode = String(options.machineCode || getMachineCode());
  if (relCfg.edition === 'open_source') {
    return {
      ok: true,
      activated: true,
      valid: true,
      schemaVersion: 2,
      tier: 'community_oss',
      tierLabel: TIER_LABELS.community_oss,
      holder: '开源社区用户',
      licenseId: 'OSS-APACHE-2.0',
      issuedAt: relCfg.buildDate || todayLocalISO(),
      expiresAt: null,
      updatesUntil: null,
      perpetualFallback: true,
      perpetualFallbackActive: false,
      fallbackMajor: getCurrentAppMajorVersion(),
      maxDevices: 0,
      boundDevicesCount: 0,
      machineCode,
      buildDate: relCfg.buildDate,
      daysRemaining: null,
      note: 'Apache-2.0 Open-Source Community Edition',
      activatedAt: null,
      keyPreview: '',
      enforcementMode: 'open_source',
      edition: 'open_source',
      features: ['*'],
      proUnlocked: true,
      maxUnlocked: true,
      partnerUnlocked: false,
      proFeatures: PRO_FEATURES,
      maxFeatures: MAX_FEATURES,
    };
  }
  const filePath = options.storagePath || getLicenseStoragePath();
  let savedKey = '';
  let activatedAt = null;
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      savedKey = String(raw.licenseKey || '');
      activatedAt = raw.activatedAt || null;
    }
  } catch {
    // ignore
  }

  if (savedKey) {
    const check = verifyLicenseKeyString(savedKey, {
      releaseConfig: relCfg,
      buildDate: options.buildDate || relCfg.buildDate,
      today: options.today,
      machineCode,
    });
    if (check.valid && check.payload) {
      const t = check.payload.tier;
      const feats = Array.isArray(check.payload.features) ? check.payload.features : [];
      const isPro = ['pro_lifetime', 'pro_annual', 'max_lifetime', 'max_annual', 'friend_trial', 'partner'].includes(t);
      const isMax =
        ['max_lifetime', 'max_annual', 'partner'].includes(t) ||
        (t === 'friend_trial' && (feats.length === 0 || feats.includes('*') || feats.includes('max:*') || feats.includes('quant_backtest')));
      const isPartner = t === 'partner';
      return {
        ok: true,
        activated: true,
        valid: true,
        schemaVersion: check.schemaVersion,
        tier: t,
        tierLabel: check.perpetualFallbackActive
          ? `${check.payload.tierLabel}（永久回退生效中）`
          : check.payload.tierLabel,
        holder: check.payload.holder,
        licenseId: check.payload.licenseId,
        issuedAt: check.payload.issuedAt,
        expiresAt: check.payload.expiresAt,
        updatesUntil: check.payload.updatesUntil,
        perpetualFallback: check.payload.perpetualFallback,
        perpetualFallbackActive: Boolean(check.perpetualFallbackActive),
        fallbackMajor: check.payload.fallbackMajor,
        maxDevices: check.payload.maxDevices,
        boundDevicesCount: check.payload.machineHashes.length,
        machineCode,
        buildDate: relCfg.buildDate,
        daysRemaining: check.daysRemaining,
        note: check.payload.note,
        activatedAt,
        keyPreview: `${savedKey.slice(0, 14)}...${savedKey.slice(-8)}`,
        enforcementMode: relCfg.enforcementMode,
        edition: relCfg.edition,
        features: check.payload.features,
        proUnlocked: isPro || relCfg.enforcementMode === 'permissive',
        maxUnlocked: isMax || relCfg.enforcementMode === 'permissive',
        partnerUnlocked: isPartner,
        proFeatures: PRO_FEATURES,
        maxFeatures: MAX_FEATURES,
      };
    }
  }

  // 未激活或授权失效状态
  const isDev = relCfg.edition === 'personal' && !IS_PORTABLE_MODE && relCfg.enforcementMode !== 'enforced';
  const fallbackTier = isDev ? 'developer' : 'free';
  const permissiveOpen = relCfg.enforcementMode === 'permissive' || isDev;
  return {
    ok: true,
    activated: false,
    valid: false,
    schemaVersion: 2,
    tier: fallbackTier,
    tierLabel: isDev
      ? TIER_LABELS.developer
      : relCfg.enforcementMode === 'permissive'
      ? '体验预览模式（全功能暂开放）'
      : TIER_LABELS.free,
    holder: isDev ? '本机主理人' : '未激活用户',
    licenseId: '',
    issuedAt: '',
    expiresAt: null,
    updatesUntil: null,
    perpetualFallback: false,
    perpetualFallbackActive: false,
    fallbackMajor: 2,
    maxDevices: 2,
    boundDevicesCount: 0,
    machineCode,
    buildDate: relCfg.buildDate,
    daysRemaining: null,
    note: '',
    activatedAt: null,
    keyPreview: '',
    enforcementMode: relCfg.enforcementMode,
    edition: relCfg.edition,
    features: [],
    proUnlocked: permissiveOpen,
    maxUnlocked: permissiveOpen,
    partnerUnlocked: false,
    proFeatures: PRO_FEATURES,
    maxFeatures: MAX_FEATURES,
  };
}

function activateLicenseKey(rawKey, options = {}) {
  const check = verifyLicenseKeyString(rawKey, options);
  if (!check.valid) {
    throw new Error(check.error || '授权码无效');
  }
  const cleanKey = String(rawKey || '').trim().replace(/\s+/g, '');
  const payload = {
    schemaVersion: check.schemaVersion,
    licenseKey: cleanKey,
    activatedAt: new Date().toISOString(),
    holder: check.payload.holder,
    tier: check.payload.tier,
    machineCode: options.machineCode || getMachineCode(),
  };
  const filePath = options.storagePath || getLicenseStoragePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return getLicenseStatus(options);
}

function deactivateLicenseKey(options = {}) {
  const p = options.storagePath || getLicenseStoragePath();
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
  return getLicenseStatus(options);
}

module.exports = {
  PUBLIC_KEY_FILE,
  PRO_FEATURES,
  MAX_FEATURES,
  TIER_LABELS,
  getMachineCode,
  loadReleaseConfig,
  verifyLicenseKeyString,
  getLicenseStatus,
  activateLicenseKey,
  deactivateLicenseKey,
};
