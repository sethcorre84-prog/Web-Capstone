import { datedHikes, hikesWithinDays } from './hike-events.js';
import { escapeHtml, normalizeText } from './utils.js';

const nameKey = value => normalizeText(value).replace(/\s+/g, ' ').toLowerCase();
const validNumber = value => {
    if (value == null || typeof value === 'boolean' || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
};
const numberText = value => value.toLocaleString('en-US');

export function formatEngagementDuration(minutes) {
    if (minutes === null) return 'Not recorded';
    if (minutes > 0 && minutes < 1) return '<1 min';
    const rounded = Math.round(minutes);
    const hours = Math.floor(rounded / 60);
    const remainder = rounded % 60;
    return hours ? `${numberText(hours)} h${remainder ? ` ${remainder} min` : ''}` : `${rounded} min`;
}

/* Hiking engagement in the last `days` days, from dated hikes only
   (hike-events.js): the app's per-hike records, or -- for a hiker without
   any -- their last hike. Lifetime totals have no date per hike, so they
   are never spread over a period. Trail popularity measures distinct
   hikers, not visits. */
/* `trails` are the ones listed (trails in the app); `knownTrails` every trail
   document that still exists, hidden or unregistered ones included (defaults
   to `trails`). A hike on a trail that was DELETED in Trail Management no
   longer counts at all -- no row for it, and a hiker whose only hike in the
   period was there is not counted as hiking. A hike on an existing trail
   that is just not listed in the app keeps its own row. */
export function summarizeDescriptiveEngagement(users = [], trails = [], { sessions = [], days = 30, now = Date.now(), knownTrails = null } = {}) {
    const rows = new Map();
    const trailIds = new Map();
    const trailNames = new Map();
    const index = (list, listed) => list.forEach((trail, position) => {
        const id = normalizeText(trail.id);
        if (id && trailIds.has(id)) return; // listed already
        const name = normalizeText(trail.Trail || trail.name || trail.trailName) || 'Unnamed trail';
        const key = `${listed ? 'trail' : 'other'}:${id || position}`;
        if (listed) rows.set(key, { name, listed: true, users: new Set() });
        else rows.set(key, { name, listed: false, users: new Set(), hiddenUntilUsed: true });
        if (id) trailIds.set(id, key);
        [trail.Trail, trail.name, trail.trailName].forEach(alias => {
            const aliasKey = nameKey(alias);
            if (aliasKey && !trailNames.has(aliasKey)) trailNames.set(aliasKey, key);
        });
    });
    index(trails, true);
    index(knownTrails || [], false);
    // null for a trail that no longer exists.
    const resolveTrail = value => {
        if (typeof value !== 'string' || !value.trim()) return null;
        const name = value.trim();
        return trailIds.get(name) || trailNames.get(nameKey(name)) || null;
    };

    // Every trail that still exists (listed or not): hikes on deleted trails
    // are left out before results are handed out.
    const hikes = hikesWithinDays(datedHikes(users, sessions, undefined, knownTrails || trails), days, now)
        .map(hike => ({ ...hike, trailKeys: [...new Set(hike.trails.map(resolveTrail).filter(Boolean))] }))
        // Hikes naming only deleted trails are dropped; a hike with no trail
        // recorded at all still counts (as a hike without trail details).
        .filter(hike => !hike.trails.length || hike.trailKeys.length);
    const totals = {
        registeredUsers: users.length, engagedUsers: 0, hikes: hikes.length,
        completed: 0, partial: 0, ended: 0, timedSessions: 0, usersWithoutTrails: 0,
        fromSessions: 0, fromStarts: 0, fromTotals: 0
    };
    let totalMinutes = 0;
    const engaged = new Set();
    const withTrail = new Set();
    hikes.forEach(hike => {
        engaged.add(hike.uid);
        if (hike.source === 'session') totals.fromSessions += 1;
        else if (hike.source === 'start') totals.fromStarts += 1;
        else totals.fromTotals += 1;
        if (hike.status === 'completed') totals.completed += 1;
        else if (hike.status === 'partial') totals.partial += 1;
        else totals.ended += 1;
        if (hike.minutes !== null) {
            totalMinutes += hike.minutes;
            totals.timedSessions += 1;
        }
        hike.trailKeys.forEach(key => {
            rows.get(key).users.add(hike.uid);
            withTrail.add(hike.uid);
        });
    });
    totals.engagedUsers = engaged.size;
    totals.usersWithoutTrails = [...engaged].filter(uid => !withTrail.has(uid)).length;

    const trailRows = [...rows.values()]
        // An existing trail outside the app list shows only once it has hikers.
        .filter(row => !row.hiddenUntilUsed || row.users.size)
        .map(row => ({ name: row.name, listed: row.listed, users: row.users.size }))
        .sort((a, b) => b.users - a.users || a.name.localeCompare(b.name));
    const topCount = trailRows[0]?.users || 0;
    return {
        ...totals,
        totalMinutes: totals.timedSessions ? totalMinutes : null,
        averageMinutes: totals.timedSessions ? totalMinutes / totals.timedSessions : null,
        trailRows,
        topTrails: topCount ? trailRows.filter(row => row.users === topCount) : []
    };
}

const metric = (label, value, detail, { name = false, title = '' } = {}) => `
    <div class="kpi">
        <div class="kpi-label">${escapeHtml(label)}</div>
        <div class="kpi-value${name ? ' de-trail-value' : ''}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(value)}</div>
        <div class="kpi-delta">${escapeHtml(detail)}</div>
    </div>`;

const trailPieChart = (rows, hikers) => {
    // Shares use user-trail counts: someone visiting two trails belongs to
    // both slices. Dividing by distinct users overall would exceed 100%.
    const total = rows.reduce((sum, row) => sum + row.users, 0);
    const colors = ['#9dc3ec', '#e75b32', '#8fcdb8', '#e4c580', '#b3bbb5', '#b5a2d7', '#e7a3bc', '#76b5c4'];
    const colorByName = new Map([...rows].sort((a, b) => a.name.localeCompare(b.name))
        .map((row, index) => [row.name, colors[index % colors.length]]));
    const shareOf = count => {
        const percent = total ? count / total * 100 : 0;
        return percent > 0 && percent < 0.1 ? '<0.1%'
            : `${percent.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
    };
    const labelOf = row => `${row.name}: ${numberText(row.users)} ${row.users === 1 ? 'hiker' : 'hikers'} (${shareOf(row.users)})`;
    const positive = rows.filter(row => row.users > 0);
    let cumulative = 0;
    const slices = positive.map(row => {
        const start = cumulative / total * 2 * Math.PI - Math.PI / 2;
        cumulative += row.users;
        const end = cumulative / total * 2 * Math.PI - Math.PI / 2;
        const point = (angle, radius) => `${(120 + radius * Math.cos(angle)).toFixed(4)} ${(120 + radius * Math.sin(angle)).toFixed(4)}`;
        const large = row.users / total > 0.5 ? 1 : 0;
        // Draw a true ring so the center does not respond as a chart slice.
        // A single full ring needs two arcs per edge instead of one.
        const pathAt = radius => positive.length === 1
            ? `M 120 ${120 - radius} A ${radius} ${radius} 0 1 1 120 ${120 + radius} A ${radius} ${radius} 0 1 1 120 ${120 - radius} Z M 120 54 A 66 66 0 1 0 120 186 A 66 66 0 1 0 120 54 Z`
            : `M ${point(start, radius)} A ${radius} ${radius} 0 ${large} 1 ${point(end, radius)} L ${point(end, 66)} A 66 66 0 ${large} 0 ${point(start, 66)} Z`;
        const attributes = `class="de-pie-slice" fill="${colorByName.get(row.name)}" tabindex="0" role="img" aria-label="${escapeHtml(labelOf(row))}" data-trail-tooltip="${escapeHtml(labelOf(row))}" data-trail-emphasis="${pathAt(111)}"`;
        return `<path d="${pathAt(104)}" fill-rule="evenodd" ${attributes}></path>`;
    }).join('');

    const pie = total ? `<svg class="de-pie-chart" viewBox="0 0 240 240" role="img" aria-labelledby="descTrailPieTitle descTrailPieDescription">
        <title id="descTrailPieTitle">Users per trail</title>
        <desc id="descTrailPieDescription">${numberText(hikers)} hikers with recorded trail activity. Shares use ${numberText(total)} user-trail counts; users visiting several trails count once on each trail.</desc>
        ${slices}
        <g class="de-pie-center" aria-hidden="true">
            <text class="de-pie-center-label" x="120" y="111">Hikers</text>
            <text class="de-pie-center-total" x="120" y="143">${numberText(hikers)}</text>
        </g>
    </svg>` : '<div class="de-pie-empty" role="status">No trail visits recorded yet.</div>';
    return `<div class="de-pie-layout">
        ${pie}
        <ul class="de-pie-legend" aria-label="Unique users and percentage share per trail">
            ${rows.map(row => `<li title="${escapeHtml(labelOf(row))}">
                <span class="de-pie-swatch" style="background:${row.users ? colorByName.get(row.name) : 'var(--text-muted)'}" aria-hidden="true"></span>
                <span class="de-pie-name">${escapeHtml(row.name)}${row.listed ? '' : '<small class="de-history-label">Not listed in the app</small>'}</span>
                <span class="de-pie-value"><strong>${numberText(row.users)} ${row.users === 1 ? 'user' : 'users'}</strong><small>${escapeHtml(shareOf(row.users))}</small></span>
            </li>`).join('')}
        </ul>
        <div id="descTrailPieTooltip" class="de-pie-tooltip" role="tooltip" hidden></div>
    </div>`;
};

// Bind to the persistent descriptive section once. Its chart markup is
// replaced by live updates, so listeners must not be attached per slice.
const pieInteractions = new WeakMap();
const bindTrailPieInteractions = root => {
    if (pieInteractions.has(root)) return;
    let activeSlice = null;
    let originalPath = null;
    const hide = () => {
        if (activeSlice && originalPath) activeSlice.setAttribute('d', originalPath);
        activeSlice?.classList.remove('is-active');
        activeSlice?.removeAttribute('aria-describedby');
        activeSlice = null;
        originalPath = null;
        const tooltip = root.querySelector('#descTrailPieTooltip');
        if (tooltip) tooltip.hidden = true;
    };
    const show = (slice, x, y) => {
        const tooltip = root.querySelector('#descTrailPieTooltip');
        if (!tooltip) return;
        if (activeSlice !== slice) {
            hide();
            originalPath = slice.getAttribute('d');
            slice.setAttribute('d', slice.dataset.trailEmphasis);
        }
        activeSlice = slice;
        slice.classList.add('is-active');
        slice.setAttribute('aria-describedby', 'descTrailPieTooltip');
        tooltip.textContent = slice.dataset.trailTooltip;
        tooltip.hidden = false;
        const { offsetWidth: width, offsetHeight: height } = tooltip;
        const left = x + width + 14 > window.innerWidth - 8 ? x - width - 14 : x + 14;
        const top = y + height + 14 > window.innerHeight - 8 ? y - height - 14 : y + 14;
        tooltip.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
        tooltip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
    };
    const sliceFrom = event => event.target.closest?.('.de-pie-slice[data-trail-tooltip]');
    const pointer = event => {
        const slice = sliceFrom(event);
        if (slice && root.contains(slice)) show(slice, event.clientX, event.clientY);
        else hide();
    };
    root.addEventListener('pointerover', pointer);
    root.addEventListener('pointermove', pointer);
    root.addEventListener('pointerleave', hide);
    root.addEventListener('pointercancel', hide);
    root.addEventListener('focusin', event => {
        const slice = sliceFrom(event);
        if (!slice) return;
        const rect = slice.getBoundingClientRect();
        show(slice, rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    root.addEventListener('focusout', hide);
    root.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
    window.addEventListener('scroll', hide, { passive: true, capture: true });
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    pieInteractions.set(root, { hide });
};

export function renderDescriptiveEngagement({ root, users, trails, sessions = [], days = 30, knownTrails = null, errors = {} }) {
    const kpis = root?.querySelector('[data-engagement-kpis]');
    const trailCard = root?.querySelector('[data-engagement-trails]');
    const durationCard = root?.querySelector('[data-engagement-duration]');
    const summaryText = root?.querySelector('[data-engagement-summary]');
    if (!kpis || !trailCard || !durationCard || !summaryText) return;
    pieInteractions.get(root)?.hide();
    for (const element of [kpis, trailCard, durationCard]) {
        element.setAttribute('aria-busy', String(users === null && !errors.users));
    }
    const periodLabel = `Last ${days} days`;
    const trailHeading = `<h4 class="chart-title de-card-heading">Users per Trail &amp; Most Visited Trails<span class="de-period">${escapeHtml(periodLabel)}</span></h4>`;
    const durationHeading = `<h3 class="de-card-heading">Session Duration &amp; Engagement<span class="de-period">${escapeHtml(periodLabel)}</span></h3>`;
    if (errors.users || users === null) {
        kpis.innerHTML = `<div class="empty-state" role="status">${errors.users ? 'User engagement data could not be loaded. Check your connection and admin permissions.' : 'Loading user engagement...'}</div>`;
        trailCard.innerHTML = trailHeading + `<div class="empty-state">${errors.users ? 'Trail activity unavailable.' : 'Loading trail activity...'}</div>`;
        durationCard.innerHTML = durationHeading + `<div class="empty-state">${errors.users ? 'Session durations unavailable.' : 'Loading session durations...'}</div>`;
        summaryText.hidden = true;
        return;
    }

    const data = summarizeDescriptiveEngagement(users, trails || [], { sessions, days, knownTrails });
    const trailsReady = trails !== null && !errors.trails;
    const top = data.topTrails[0];
    const participation = data.registeredUsers ? Math.round(data.engagedUsers / data.registeredUsers * 100) : 0;
    const leader = !trailsReady ? (errors.trails ? 'Unavailable' : 'Loading...')
        : data.topTrails.length > 1 ? `${data.topTrails.length} trails tied`
        : top?.name || 'No visits recorded';
    const timed = `${numberText(data.timedSessions)} hike${data.timedSessions === 1 ? '' : 's'} with a recorded time, ${periodLabel.toLowerCase()}`;
    const sources = [
        data.fromSessions ? `${numberText(data.fromSessions)} per-hike records` : '',
        data.fromStarts ? `${numberText(data.fromStarts)} app Start Hike` : '',
        data.fromTotals ? `${numberText(data.fromTotals)} from hikers' totals` : ''
    ].filter(Boolean).join(' · ') || 'No dated hikes in this period';
    const metrics = metric('Users with hikes', numberText(data.engagedUsers), `${participation}% of ${numberText(data.registeredUsers)} registered hikers · ${periodLabel.toLowerCase()}`)
        + metric('Recorded hikes', numberText(data.hikes), sources)
        + metric('Average session duration', formatEngagementDuration(data.averageMinutes), timed)
        + metric('Most visited trail', leader, trailsReady && top ? `${numberText(top.users)} unique users per leading trail` : 'Ranked by unique users, including repeat hikers', {
            name: true, title: trailsReady ? data.topTrails.map(row => row.name).join(', ') : ''
        });

    let trailContent;
    if (!trailsReady) {
        trailContent = `<div class="empty-state" role="status">${errors.trails ? 'Trail data could not be loaded. Trail rankings are unavailable.' : 'Loading trail data...'}</div>`;
    } else if (!data.trailRows.length) {
        trailContent = `<div class="empty-state">No trails or trail visits recorded in the ${escapeHtml(periodLabel.toLowerCase())}.</div>`;
    } else {
        trailContent = trailPieChart(data.trailRows, data.engagedUsers - data.usersWithoutTrails);
    }

    const durationRows = [
        ['Total recorded hiking time', formatEngagementDuration(data.totalMinutes)],
        ['Completed hikes', numberText(data.completed)],
        ['Partial hikes', numberText(data.partial)],
        ['Ended early (before a station)', numberText(data.ended)],
        ['Hikes with recorded time', numberText(data.timedSessions)]
    ];
    const visitedCount = data.trailRows.filter(row => row.users > 0).length;
    const summary = [`${numberText(data.engagedUsers)} of ${numberText(data.registeredUsers)} hikers hiked in the ${periodLabel.toLowerCase()}.`];
    if (trailsReady) summary.push(`${numberText(visitedCount)} trail${visitedCount === 1 ? ' had' : 's had'} visitors.`);
    if (data.averageMinutes !== null) summary.push(`Sessions with recorded duration average ${formatEngagementDuration(data.averageMinutes)}.`);
    if (data.usersWithoutTrails) summary.push(`${numberText(data.usersWithoutTrails)} users have hikes without trail details.`);

    kpis.innerHTML = metrics;
    trailCard.innerHTML = trailHeading + `
        <p class="de-note">Each user counts once per trail, even after repeat visits. Percentages use the total across trails; users visiting several trails count on each.</p>
        ${trailContent}`;
    durationCard.innerHTML = durationHeading + `
        ${durationRows.map(([label, value]) => `<div class="row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}
        <p class="de-note">Every hike of every hiker, app and imported dummy data alike: completed, partial and ended early from their totals. A hike with no date of its own (most imported ones) is counted on the hiker's latest hike, the only date the data gives. Time is each hiker's total spread over their completed and partial hikes.</p>
        <div class="de-participation"><span>Users with hiking activity</span><strong>${participation}%</strong></div>
        <div class="de-bar-track" role="progressbar" aria-label="Registered users with hiking activity" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${participation}"><span style="width:${participation}%"></span></div>`;
    summaryText.textContent = summary.join(' ');
    summaryText.hidden = false;
    bindTrailPieInteractions(root);
}
