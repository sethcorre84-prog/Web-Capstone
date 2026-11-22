import { portalTimeZone } from './datetime-prefs.js';
import { escapeHtml, normalizeText } from './utils.js';
import { datedHikesOnTrails } from './hike-events.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const nameKey = value => normalizeText(value).replace(/\s+/g, ' ').toLowerCase();
const numberText = value => value.toLocaleString('en-US');
const dateText = value => new Date(value).toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric'
});
const estimateText = value => value === null ? 'Awaiting data'
    : value > 0 && value < 0.1 ? '<0.1'
    : value.toLocaleString('en-US', { maximumFractionDigits: 1 });

/* Every hike of every hiker, app and imported dummy session data alike
   (hike-events.js datedHikesOnTrails, the list the Dashboard, the rest of
   Analytics and User Management count from): the app's per-hike records,
   its monthly Start Hike counters, and the profile totals -- the dummy
   hikers' first and last hikes on their own dates, their other hikes on
   the last hike's date. Hikes on deleted trails are already left out.
   Hazard submissions are not hiking visits. */
export function predictTrailUsage({ trails = [], users = [], sessions = [], knownTrails = null, now = new Date() } = {}) {
    const timeZone = portalTimeZone();
    const calendar = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    // A moment -> its calendar day in the portal time zone, at UTC midnight
    // for timezone-safe arithmetic.
    const dayOf = date => {
        const parts = {};
        calendar.formatToParts(date).forEach(({ type, value }) => { parts[type] = value; });
        return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    };
    const today = dayOf(now);
    const todayDate = new Date(today);
    const windowStart = Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth() - 2, 1);
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
    const withIds = users.map((user, index) => ({ ...user, id: normalizeText(user.id || user.uid || user.userId) || `user:${index}` }));
    datedHikesOnTrails(withIds, sessions, knownTrails || trails, timeZone).forEach(hike => {
        const day = dayOf(hike.date);
        if (day > today) return;
        // The month the hike was in: a trail's history starts on its first one.
        const dayDate = new Date(day);
        const month = Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth(), 1);
        new Set(hike.trailIds.map(resolve).filter(Boolean)).forEach(row => {
            row.hikers.add(hike.uid);
            row.firstMonth = row.firstMonth === null ? month : Math.min(row.firstMonth, month);
            if (day >= windowStart) {
                row.starts += 1;
                row.recentHikers.add(hike.uid);
            }
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

export function renderTrailUsagePrediction({ root, trails, users, sessions = [], knownTrails = null, errors = {}, now = new Date() }) {
    const chart = root?.querySelector('#trailUsageChart');
    const note = root?.querySelector('#trailUsageNote');
    const period = root?.querySelector('#trailUsageWindow');
    if (!chart || !note || !period) return;
    chart.setAttribute('aria-busy', String((trails === null || users === null) && !errors.trails && !errors.users));
    if (errors.trails || errors.users) {
        chart.innerHTML = '<div class="empty-state" role="status">Trail usage could not be loaded. Check your connection and admin permissions.</div>';
        note.textContent = '';
        period.textContent = 'Estimated hikes · Next 7 days';
        return;
    }
    if (trails === null || users === null) {
        chart.innerHTML = '<div class="empty-state" role="status">Loading trails and hiking activity...</div>';
        note.textContent = '';
        return;
    }
    const data = predictTrailUsage({ trails, users, sessions, knownTrails, now });
    period.textContent = `Estimated hikes · ${dateText(data.today)} – ${dateText(data.nextWeekEnd)}`;
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
            ? `${numberText(row.hikers)} hikers in saved history · no hikes in the observation period`
            : `${numberText(row.starts)} ${row.starts === 1 ? 'hike' : 'hikes'} · ${numberText(row.recentHikers)} hikers in the observation period`;
        const tip = [
            row.estimate === null ? 'No dated hikes on this trail yet, so there is no forecast.' : `${estimateText(row.estimate)} estimated hikes over the next 7 days`,
            history,
            row.baselineStart === null ? '' : `Observed from ${dateText(row.baselineStart)} to ${dateText(data.today)}`,
            row.baselineDays === null ? '' : `Rate = hikes / ${row.baselineDays} baseline days × 7; minimum 7 days`,
            isPeak ? 'Highest estimated usage among the current trails' : ''
        ].filter(Boolean).join('\n');
        return `<div class="trail-usage-row" data-tip-title="${escapeHtml(row.name)}" data-tip="${escapeHtml(tip)}">
            <div class="trail-usage-head"><strong>${escapeHtml(row.name)}</strong><span class="trail-usage-value${row.estimate === null ? ' is-pending' : ''}">${escapeHtml(estimateText(row.estimate))}</span></div>
            <div class="trail-usage-track" aria-hidden="true"><span class="${isPeak ? 'is-peak' : ''}" style="width:${width}%"></span></div>
            <div class="trail-usage-meta">${escapeHtml(history)}</div>
            ${row.starts > 0 && row.starts < 5 ? '<span class="low-data">Limited history · fewer than 5 hikes</span>' : ''}
        </div>`;
    }).join('');
    const ready = data.rows.filter(row => row.estimate !== null).length;
    const pending = data.rows.length - ready;
    note.textContent = `${numberText(ready)} ${ready === 1 ? 'trail' : 'trails'} with forecasts${pending ? ` · ${numberText(pending)} with no dated hikes yet` : ''}. `
        + 'Each estimate uses that trail’s hike rate over the current and previous two months, with a minimum seven-day baseline, counting every recorded hike. New trails and hikes update automatically.';
}
