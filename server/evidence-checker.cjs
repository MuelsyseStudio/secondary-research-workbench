'use strict';

/**
 * 日度复盘证据离线核验模块
 * 对齐《日度复盘工作台_2026-11-23/核验复盘.cjs》的全部校验规则。
 */

const STATES = {
  observed: '已登记原始值',
  archived: '仅档案复算',
  missing: '待补',
  conflict: '口径冲突',
  not_applicable: '不适用',
};

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value);
}

function timestamp(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return NaN;
  }
  return calendarDate(value.slice(0, 10)) ? Date.parse(value) : NaN;
}

const present = (value) => typeof value === 'string' && value.trim().length > 0;

function checkEvidenceRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return {
      ok: false,
      status: '证据登记有误',
      errors: ['输入须为 JSON 对象。'],
      items: [],
      calculations: [],
      chains: [],
    };
  }

  const date = record.review_date;
  const cutoff = timestamp(record.cutoff);

  if (!calendarDate(date)) errors.push('复盘日期须为有效的 YYYY-MM-DD。');
  if (!['daily', 'archive_replay'].includes(record.mode)) {
    errors.push('mode 应为 daily 或 archive_replay。');
  }
  if ((record.mode === 'daily' || record.cutoff != null) && !Number.isFinite(cutoff)) {
    errors.push('证据冻结时点须使用有效的带时区时间（如 2026-11-23T18:00:00+08:00），当日记录须填写。');
  }
  if (Number.isFinite(cutoff) && typeof date === 'string' && record.cutoff.slice(0, 10) < date) {
    errors.push('冻结时点早于复盘日期。');
  }
  if (!Array.isArray(record.facts) || record.facts.length === 0) {
    return {
      ok: false,
      status: '证据登记有误',
      errors: [...errors, '须填写至少一条证据或一条明确缺口。'],
      items: [],
      calculations: [],
      chains: [],
    };
  }

  const byId = new Map();
  const items = [];
  const chains = new Set();

  for (const [index, fact] of record.facts.entries()) {
    const label = fact?.id || `第 ${index + 1} 行`;
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
      errors.push(`${label} 须为一条证据对象。`);
      continue;
    }
    const {
      id,
      metric,
      state,
      value,
      unit,
      scope,
      source,
      chain,
      available_at: availableAt,
    } = fact;
    const timing = fact.kind ?? 'same_day';

    if (!present(id) || byId.has(id)) {
      errors.push(`${label} 的证据 ID 为空或重复。`);
    } else {
      byId.set(id, fact);
    }

    if (!present(metric) || !Object.prototype.hasOwnProperty.call(STATES, state)) {
      errors.push(`${label} 缺指标名或状态不合法。`);
    }

    if (
      !calendarDate(fact.date) ||
      (timing === 'same_day' && fact.date !== date) ||
      (timing === 'prior' && fact.date >= date) ||
      !['same_day', 'prior'].includes(timing)
    ) {
      errors.push(`${label} 的证据日期不符合本次复盘或所声明的历史对照日。`);
    }

    if (state === 'observed' || state === 'archived') {
      if (!Number.isFinite(value) || ![unit, scope, source, chain].every(present)) {
        errors.push(`${label} 数值、单位、证券池、出处和证据链均须填写。`);
      }
      if (state === 'observed') {
        const available = timestamp(availableAt);
        if (!Number.isFinite(available) || !Number.isFinite(cutoff) || available > cutoff) {
          errors.push(`${label} 须给出首次可得时间，且不能晚于冻结时点。`);
        } else if (present(chain)) {
          chains.add(chain);
        }
      }
    } else if (value !== null || !present(fact.reason)) {
      errors.push(`${label} 的缺口应使用 null 并写明原因，不能以 0 代替。`);
    }

    items.push({ id: label, metric: metric || '', status: STATES[state] ?? '状态异常' });
  }

  const calculations = [];
  for (const [id, fact] of byId) {
    if (fact.subtract_pp === undefined) continue;
    const refs = fact.subtract_pp;
    const [left, right] =
      Array.isArray(refs) && refs.length === 2 ? refs.map((ref) => byId.get(ref)) : [];
    const inputs = [left, right];
    const hasComparableOperands = inputs.every(
      (row) =>
        row &&
        row.date === fact.date &&
        row.unit === '%' &&
        ['observed', 'archived'].includes(row.state) &&
        Number.isFinite(row.value)
    );
    if (
      fact.unit !== '百分点' ||
      !Number.isFinite(fact.value) ||
      !hasComparableOperands ||
      (fact.state === 'observed' && inputs.some((row) => row.state !== 'observed'))
    ) {
      errors.push(`${id} 须引用同日两条可用百分比证据，档案数据不得提升为已登记原始值。`);
      continue;
    }
    const recomputed = Number((left.value - right.value).toFixed(2));
    if (Math.abs(recomputed - fact.value) > 1e-9) {
      errors.push(`${id} 点差复算不一致，计算值为 ${recomputed}。`);
    }
    calculations.push({ id, recomputed, unit: '百分点' });
  }

  return {
    ok: errors.length === 0,
    status: errors.length ? '证据登记有误' : '证据登记格式与所列算式已核对',
    errors,
    items,
    calculations,
    chains: [...chains],
  };
}

module.exports = {
  STATES,
  checkEvidenceRecord,
};
