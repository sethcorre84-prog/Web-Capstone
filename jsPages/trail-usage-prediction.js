import { portalTimeZone } from './datetime-prefs.js';
import { escapeHtml, normalizeText } from './utils.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const nameKey = value => normalizeText(value).replace(/\s+/g, ' ').toLowerCase();
const count = value => {
    if (value == null || typeof value === 'boolean' || String(value).trim() === '') return 0;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};
const numberText = value => value.toLocaleString('en-US');
const dateText = value => new Date(value).toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric'
});
const estimateText = value => value === null ? 'Awaiting data'
    : value > 0 && value < 0.1 ? '<0.1'
    : value.toLocaleString('en-US', { maximumFractionDigits: 1 });

// Monthly Start Hike counters identify the actual trail. A profile's single
// lastHikeAt cannot be assigned to every trail in its lifetime hikedTrails
// list, and hazard submissions are not hiking visits.
export function predictTrailUsage({ trails = [], users = [], now = new Date() } = {}) {
    const parts = {};
    new Intl.DateTimeFormat('en-US', {
        timeZone: portalTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now).forEach(({ type, value }) => { parts[type] = value; });
    // Calendar dates expressed at UTC midnight for timezone-safe arithmetic.
    const today = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    const windowStart = Date.UTC(Number(parts.year), Number(parts.month) - 3, 1);
    const rows = new Map();
    const byId = new Map();
    const byName = new Map();
    trails.forEach((trail, index) => {
        const id = normalizeText(trail.id) || `trail:${index}`;
        const name = normalizeText(trail.Trail || trail.name || trail.trailName) || 'Unnamed trail';
        rows.set(id, { id, name, starts: 0, firstMonth: null, hikers: new Set(), recentHikers: new Set() });
        byId.set(id, id);
        [trail.Trail, trail.name, trail.trailName].forEach(alias => {
            const key = nameKey(alias);
            if (key) byName.set(key, byName.has(key) && byName.get(key) !== id ? null : id);
        });
    });
    const resolve = value => typeof value === 'string'
        ? rows.get(byId.get(value.trim()) || byName.get(nameKey(value)))
        : null;
    const profiles = new Map();
    users.forEach((user, index) => profiles.set(normalizeText(user.id || user.uid || user.userId) || `user:${index}`, user));
    profiles.forEach((user, uid) => {
        if (Array.isArray(user.hikedTrails)) {
            user.hikedTrails.forEach(trail => resolve(trail)?.hikers.add(uid));
        }
        Object.entries(user.hikeStarts || {}).forEach(([key, entry]) => {
            const match = /^m(\d{4})_(0[1-9]|1[0-2])$/.exec(key);
            if (!match) return;
            const month = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
            if (month > today) return;
            Object.entries(entry?.trails || {}).forEach(([reference, value]) => {
                const row = resolve(reference);
                const starts = count(value);
                if (!row || !starts) return;
                row.hikers.add(uid);
                row.firstMonth = row.firstMonth === null ? month : Math.min(row.firstMonth, month);
                if (month >= windowStart) {
                    row.starts += starts;
                    row.recentHikers.add(uid);
                }
            });
        });
    });
    const predictions = [...rows.values()].map(row => {
        const baselineStart = row.firstMonth === null ? null : Math.max(windowStart, row.firstMonth);
        const baselineDays = baselineStart === null ? null : Math.max(7, Math.round((today - baselineStart) / DAY_MS) + 1);
        return {
            id: row.id, name: row.name, starts: row.starts,
            hikers: row.hikers.size, recentHikers: row.recentHikers.size,
            baselineStart, baselineDays,
            // Unknown history stays unknown, while a previously tracked but
            // quiet trail genuinely has zero starts in the recent window.
            estimate: baselineDays === null ? null : row.starts / baselineDays * 7
        };
    }).sort((a, b) => (b.estimate ?? -1) - (a.estimate ?? -1) || a.name.localeCompare(b.name));
    return { rows: predictions, windowStart, today, nextWeekEnd: today + 6 * DAY_MS };
}

export function renderTrailUsagePrediction({ root, trails, users, errors = {}, now = new Date() }) {
    const chart = root?.querySelector('#trailUsageChart');
    const note = root?.querySelector('#trailUsageNote');
    const period = root?.querySelector('#trailUsageWindow');
    if (!chart || !note || !period) return;
    chart.setAttribute('aria-busy', String((trails === null || users === null) && !errors.trails && !errors.users));
    if (errors.trails || errors.users) {
        chart.innerHTML = '<div class="empty-state" role="status">Trail usage could not be loaded. Check your connection and admin permissions.</div>';
        note.textContent = '';
        period.textContent = 'Estimated hike starts · Next 7 days';
        return;
    }
    if (trails === null || users === null) {
        chart.innerHTML = '<div class="empty-state" role="status">Loading trails and hiking activity...</div>';
        note.textContent = '';
        return;
    }
    const data = predictTrailUsage({ trails, users, now });
    period.textContent = `Estimated hike starts · ${dateText(data.today)} – ${dateText(data.nextWeekEnd)}`;
    if (!data.rows.length) {
        chart.innerHTML = '<div class="empty-state">No registered trails available yet. New trails appear here as they become available in the app.</div>';
        note.textContent = '';
        return;
    }
    const maxEstimate = Math.max(...data.rows.map(row => row.estimate ?? 0), 0);
    chart.innerHTML = data.rows.map(row => {
        const width = row.estimate > 0 && maxEstimate > 0 ? Math.max(2, row.estimate / maxEstimate * 100) : 0;
        const isPeak = maxEstimate > 0 && row.estimate === maxEstimate;
        const history = row.estimate === null
            ? `${numberText(row.hikers)} hikers in saved history · awaiting recorded hike starts`
            : `${numberText(row.starts)} recorded starts · ${numberText(row.recentHikers)} hikers in the observation period`;
        const tip = [
            row.estimate === null ? 'No dated trail starts are available for a forecast.' : `${estimateText(row.estimate)} estimated hike starts over the next 7 days`,
            history,
            row.baselineStart === null ? '' : `Observed from ${dateText(row.baselineStart)} to ${dateText(data.today)}`,
            row.baselineDays === null ? '' : `Rate = recorded starts / ${row.baselineDays} baseline days; minimum 7 days`,
            isPeak ? 'Highest estimated usage among the current trails' : ''
        ].filter(Boolean).join('\n');
        return `<div class="trail-usage-row" data-tip-title="${escapeHtml(row.name)}" data-tip="${escapeHtml(tip)}">
            <div class="trail-usage-head"><strong>${escapeHtml(row.name)}</strong><span class="trail-usage-value${row.estimate === null ? ' is-pending' : ''}">${escapeHtml(estimateText(row.estimate))}</span></div>
            <div class="trail-usage-track" aria-hidden="true"><span class="${isPeak ? 'is-peak' : ''}" style="width:${width}%"></span></div>
            <div class="trail-usage-meta">${escapeHtml(history)}</div>
            ${row.starts > 0 && row.starts < 5 ? '<span class="low-data">Limited history · fewer than 5 starts</span>' : ''}
        </div>`;
    }).join('');
    const ready = data.rows.filter(row => row.estimate !== null).length;
    const pending = data.rows.length - ready;
    note.textContent = `${numberText(ready)} ${ready === 1 ? 'trail' : 'trails'} with forecasts${pending ? ` · ${numberText(pending)} awaiting dated hike starts` : ''}. `
        + 'Each estimate uses that trail’s recorded start rate over the current and previous two months, with a minimum seven-day baseline. New trails and hike starts update automatically.';
}
