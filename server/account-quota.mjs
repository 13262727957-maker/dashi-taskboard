export async function readAccountQuota() {
  const response = await fetch('https://apiops.caijai.com/api/live-dashboard?range=24h', {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`额度平台请求失败 (${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data.accounts) || !Array.isArray(data.kpis)) throw new Error('额度平台返回格式异常');
  const accounts = data.accounts.filter(row => Array.isArray(row) && row[0] !== '未关联账号');
  const kpi = data.kpis.find(row => row[0] === '账号平均剩余额度');
  const remainingPercent = kpi ? Number(String(kpi[1]).replace(/%$/, '')) : NaN;
  if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) throw new Error('账号额度数据无效');
  let remaining = 0, pace = 0;
  for (const row of accounts) {
    const used = Number(row[6] || 0), elapsed = Number(row[13]?.elapsedDays || 1);
    if (!Number.isFinite(used) || !Number.isFinite(elapsed)) throw new Error('账号用量数据无效');
    const fraction = Math.max(0, Math.min(1, used / 100));
    remaining += 1 - fraction;
    pace += fraction * 7 / Math.max(1, elapsed);
  }
  return { remainingPercent, accountCount: accounts.length,
    remainingDays: pace > 0 ? Number((remaining * 7 / pace).toFixed(1)) : null };
}
