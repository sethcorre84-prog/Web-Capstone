// Profile counters overlap: reconcile them instead of adding the same hikes twice.
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
export function hikeHistory(raw = {}) {
    const months = Object.entries(raw.hikeStarts || {})
        .filter(([key, value]) => /^m\d{4}_(0[1-9]|1[0-2])$/.test(key) && count(value?.count) > 0)
        .sort(([a], [b]) => a.localeCompare(b));
    const dated = months.reduce((sum, [, value]) => sum + count(value.count), 0);
    const total = Math.max(dated, count(raw.hikeCount), count(raw.totalHikes),
        count(raw.completedHikes) + count(raw.partialHikes));
    return { total, dated, undated: total - dated, first: months[0]?.[0] || null,
        months: Object.fromEntries(months.map(([key, value]) => [key, count(value.count)])) };
}
