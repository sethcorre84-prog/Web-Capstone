// report-ids.js
// The IDs of resolved, rejected and archived hazard reports. Each list
// numbers its reports per year, with no gaps, from 001:
//
//   Resolved Reports (Hazard Reports page)   RES-2026-001, 002, 003 ...
//   Rejected Reports (Hazard Reports page)   R-2026-001, 002, 003 ...
//   Archived Resolved Reports (Settings)     AR-2026-001, 002, 003 ...
//   Archived Hazard Reports (Settings)       A-2026-001, 002, 003 ...
//
// A report that moves into a list (resolved, rejected, archived,
// unarchived) takes the next number, and the list it left closes the gap
// by moving everyone after it up one. The lists show the highest number
// first (sortByReportId in utils.js), so a new arrival appears at the top.
//
// planReportIds() only works out the IDs; the caller writes them in the same
// batch as the move itself, so the lists are never seen half renumbered.
// The active (HR-) sequence is handled on the Hazard Reports page, since
// the mobile app numbers new reports from it.

const GROUPS = {
  resolved: 'RES',
  rejected: 'R',
  archivedResolved: 'AR',
  archivedRejected: 'A'
};

// Which numbered list a report belongs in, or null for none of them.
export function idGroupOf(report) {
  const status = String(report.status || '').toLowerCase();
  if (status === 'resolved') return report.archived === true ? 'archivedResolved' : 'resolved';
  if (status === 'rejected') return 'rejected';
  if (status === 'archived') return 'archivedRejected';
  return null;
}

const toDate = (value) => {
  if (!value) return null;
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

// Numbered by the year the hazard was reported, like every other report ID.
export function reportYear(report) {
  return (toDate(report.timestamp) || new Date()).getFullYear();
}

/* reports  every hazard report, as { id, ...data }
   moves    Map of report id -> the fields about to change (status and/or
            archived), for reports being moved in this same write. Reports
            moving into a list go after everyone already in it, in the
            order they appear in the map.

   Returns a Map of report id -> the reportId it should have, listing only
   reports whose ID changes (including moved ones that land in a list). */
export function planReportIds(reports, moves = new Map()) {
  const moveOrder = [...moves.keys()];
  const buckets = new Map(); // "group|year" -> [{ report, key }]

  reports.forEach((original) => {
    const report = moves.has(original.id) ? { ...original, ...moves.get(original.id) } : original;
    const group = idGroupOf(report);
    if (!group) return;
    const year = reportYear(report);
    const moving = moves.has(original.id) && idGroupOf(original) !== group;

    // Order within the list: current number, then unnumbered (older data,
    // or IDs from another list) by date, then reports moving in.
    let key;
    const match = new RegExp(`^${GROUPS[group]}-\\d{4}-(\\d+)$`).exec(report.reportId || '');
    if (moving) key = [2, moveOrder.indexOf(original.id)];
    else if (match) key = [0, Number(match[1])];
    else key = [1, toDate(report.archivedAt || report.resolvedAt || report.timestamp)?.getTime() || 0];

    const bucketKey = `${group}|${year}`;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push({ report, key });
  });

  const changes = new Map();
  buckets.forEach((entries, bucketKey) => {
    const [group, year] = bucketKey.split('|');
    entries
      .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])
      .forEach(({ report }, index) => {
        const wanted = `${GROUPS[group]}-${year}-${String(index + 1).padStart(3, '0')}`;
        if (report.reportId !== wanted) changes.set(report.id, wanted);
      });
  });
  return changes;
}
