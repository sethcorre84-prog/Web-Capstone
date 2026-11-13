import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const number = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
export function summarizeUserSessions(users) {
    const rows = users.map(user => ({
        uid: user.id,
        name: user.fullName || user.username || user.id,
        username: user.username || '',
        role: user.role || user.Role || 'hiker',
        hikes: number(user.hikeCount), completed: number(user.completedHikes),
        partial: number(user.partialHikes), km: number(user.hikeTotalKm),
        minutes: number(user.hikeTotalMinutes),
        trails: Array.isArray(user.hikedTrails) ? user.hikedTrails.map(String) : [],
        lastHikeAt: user.lastHikeAt,
        source: user.sessionDataSource?.file ? 'Includes imported summary' : 'App / profile'
    })).sort((a, b) => a.name.localeCompare(b.name));
    const totals = rows.reduce((totals, row) => {
        for (const key of ['hikes', 'completed', 'partial', 'km', 'minutes']) totals[key] += row[key];
        totals.active += row.hikes > 0 ? 1 : 0;
        return totals;
    }, { hikes: 0, completed: 0, partial: 0, km: 0, minutes: 0, active: 0 });
    totals.km = Math.round(totals.km * 100) / 100;
    return { rows, totals };
}

export function watchUserSessionSummaries({ db, escapeHtml, formatPortalDate }) {
    const body = document.getElementById('userSessionRows');
    const summary = document.getElementById('userSessionTotals');
    const search = document.getElementById('userSessionSearch');
    const button = document.getElementById('exportUserSessions');
    let rows = [];
    button.disabled = true;
    const filtered = () => rows.filter(row => `${row.name} ${row.username} ${row.role}`.toLowerCase().includes(search.value.trim().toLowerCase()));
    const cells = row => [row.name + (row.username ? ` (@${row.username})` : ''), row.role, row.hikes, row.completed, row.partial, row.km.toFixed(2), row.minutes, row.trails.join(', ') || 'None', row.lastHikeAt ? formatPortalDate(row.lastHikeAt) : '—', row.source];
    const render = () => {
        body.innerHTML = filtered().map(row => `<tr>${cells(row).map(value => `<td>${escapeHtml(String(value))}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="10">No matching users.</td></tr>';
    };
    search.addEventListener('input', render);
    button.addEventListener('click', () => {
        const quote = value => '"' + String(value).replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
        const csv = [['User', 'Role', 'Hikes', 'Completed', 'Partial', 'Km', 'Minutes', 'Trails hiked', 'Last hike', 'Source'], ...filtered().map(cells)].map(row => row.map(quote).join(',')).join('\r\n');
        const url = URL.createObjectURL(new Blob(['\ufeff', csv], {type: 'text/csv;charset=utf-8'}));
        const link = document.createElement('a');
        link.href = url; link.download = 'all-user-hiking-sessions.csv'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    // No role, status, date, orderBy or limit filters: include every profile,
    // including imported users, zero-activity users and guides.
    return onSnapshot(collection(db, 'users'), snapshot => {
        const result = summarizeUserSessions(snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })));
        rows = result.rows;
        const t = result.totals;
        summary.textContent = `${rows.length} users · ${t.active} with hikes · ${t.hikes} hikes · ${t.completed} completed · ${t.partial} partial · ${t.km.toFixed(2)} km · ${t.minutes} minutes`;
        button.disabled = false;
        render();
    }, error => {
        console.error('Unable to load user session summaries', error);
        rows = []; button.disabled = true;
        summary.textContent = 'Unable to load session totals. Check your connection and admin permissions.';
        body.innerHTML = '<tr><td colspan="10">Session data unavailable.</td></tr>';
    });
}
