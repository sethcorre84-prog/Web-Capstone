// pagination.js
// Which page numbers a paginated list shows, so every list in the portal
// shortens a long run of pages the same way.
//
//   pageList(current, total)  ->  e.g. [1, '…', 9, 10, 11, '…', 20]
//
// Up to MAX_ALL pages are all shown. Past that: the first and last page and
// the current page with its neighbours, with '…' for each skipped run. A
// '…' that would stand for a single page shows that page instead, since it
// would take the same room. The list never grows past 7 entries, so the
// controls keep their width however many pages there are.

const MAX_ALL = 7;
export const PAGE_GAP = '…';

export function pageList(current, total) {
  total = Math.max(0, Math.floor(total));
  if (total <= MAX_ALL) return Array.from({ length: total }, (_, i) => i + 1);

  current = Math.min(Math.max(1, current), total);
  // Near either end, show a run of five so the list keeps one length.
  let from = Math.max(2, current - 1);
  let to = Math.min(total - 1, current + 1);
  if (current <= 4) { from = 2; to = 5; }
  if (current >= total - 3) { from = total - 4; to = total - 1; }

  const pages = [1];
  if (from > 2) pages.push(from === 3 ? 2 : PAGE_GAP);
  for (let page = from; page <= to; page += 1) pages.push(page);
  if (to < total - 1) pages.push(to === total - 2 ? total - 1 : PAGE_GAP);
  pages.push(total);
  return pages;
}

// A '…' element for between page buttons; styled in pages.css.
export function pageGap() {
  const gap = document.createElement('span');
  gap.className = 'dots';
  gap.setAttribute('aria-hidden', 'true');
  gap.textContent = PAGE_GAP;
  return gap;
}
