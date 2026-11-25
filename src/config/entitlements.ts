import type { EntitlementsSnapshot, UpgradeRequiredEventDetail } from '../types';

let currentEntitlements: EntitlementsSnapshot | null = null;
let currentMachineCode = '';

export function setClientEntitlements(entitlements?: EntitlementsSnapshot | null, machineCode?: string) {
  if (entitlements) currentEntitlements = entitlements;
  if (typeof machineCode === 'string') currentMachineCode = machineCode;
}

export function getClientEntitlements(): EntitlementsSnapshot | null {
  return currentEntitlements;
}

export function isClientFeatureUnlocked(featureKey: string): boolean {
  if (!currentEntitlements || !currentEntitlements.enforced) return true;
  if (typeof currentEntitlements.features?.[featureKey] === 'boolean') {
    return currentEntitlements.features[featureKey];
  }
  return true;
}

export function triggerUpgradeGate(featureKey: string): void {
  const meta = currentEntitlements?.featureMeta?.[featureKey];
  const requiredTier = (meta?.requiredTier || 'pro') as 'pro' | 'max' | 'partner';
  const featureLabel = meta?.label || featureKey;
  const tierName = requiredTier === 'max' ? 'Max 量化版' : requiredTier === 'partner' ? 'Partner 合作版' : 'Pro 专业版';
  const detail: UpgradeRequiredEventDetail = {
    ok: false,
    code: 'UPGRADE_REQUIRED',
    feature: featureKey,
    requiredTier,
    featureLabel,
    machineCode: currentMachineCode,
    message: `「${featureLabel}」属于 ${tierName} 权益，请激活对应 SRW2 离线授权码后使用。`,
  };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('srw-upgrade-required', { detail }));
  }
}

export function requireClientFeature(featureKey: string): boolean {
  if (isClientFeatureUnlocked(featureKey)) return true;
  triggerUpgradeGate(featureKey);
  return false;
}
