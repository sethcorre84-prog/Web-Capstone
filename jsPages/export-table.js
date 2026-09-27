// export-table.js
// One Export menu for the portal: the admin picks PDF or Excel, and the same
// table is saved in that format. Used by User Management's Export button and
// by the archive dialogs in Settings.
//
//   openExportMenu(button, {
//     getTable: () => ({ title, headers, rows, filename, countLabel }),
//     onDone: (format, table) => {}   // optional, after the file is saved
//   })
//
// title       shown at the top of the PDF, e.g. "Archived Hazard Reports"
// headers     column names
// rows        arrays of cell values, in header order
// filename    without extension or date, e.g. "archived-hazard-reports"
// countLabel  optional, e.g. "12 report(s)", shown under the PDF title
//
// The PDF looks like the archive exports always have: landscape, PeakPath
// green header row, a "Generated ..." line. The Excel file gets the same
// green header row, so the column names stand out from the data. jsPDF, its
// table plugin and ExcelJS are loaded from cdnjs the first time they are
// needed, so pages that never export never download them.

import { formatPortalDateTime } from './datetime-prefs.js';

const LIBRARIES = {
  jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  autotable: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  // ExcelJS, not SheetJS: the free SheetJS build cannot colour cells.
  exceljs: 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js'
};

const loading = {};
function loadScript(src) {
  loading[src] ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => {
      delete loading[src];
      reject(new Error('The export library could not be downloaded. Check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return loading[src];
}

// Settings already loads jsPDF in its <head>; only fetch what is missing.
// The table plugin needs jsPDF in place first, so these run in order.
async function loadPdfLibraries() {
  if (!window.jspdf) await loadScript(LIBRARIES.jspdf);
  if (!window.jspdf.jsPDF.API.autoTable) await loadScript(LIBRARIES.autotable);
}

async function loadExcelLibrary() {
  if (!window.ExcelJS) await loadScript(LIBRARIES.exceljs);
}

const today = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const cellText = (value) => (value === null || value === undefined ? '' : String(value));

async function savePdf(table) {
  await loadPdfLibraries();
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'landscape' });

  pdf.setFontSize(14);
  pdf.text(`PeakPath — ${table.title}`, 14, 15);
  pdf.setFontSize(10);
  pdf.setTextColor(100);
  const count = table.countLabel || `${table.rows.length} row(s)`;
  pdf.text(`Generated ${formatPortalDateTime(new Date())} • ${count}`, 14, 21);

  pdf.autoTable({
    startY: 26,
    head: [table.headers],
    body: table.rows.map((row) => row.map(cellText)),
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [47, 143, 78] },
    alternateRowStyles: { fillColor: [247, 249, 247] }
  });

  pdf.save(`${table.filename}-${today()}.pdf`);
}

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F8F4E' } }; // PeakPath green
const ZEBRA_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9F7' } };
const RULE = { style: 'thin', color: { argb: 'FFDCE6DF' } };

async function saveExcel(table) {
  await loadExcelLibrary();
  const book = new window.ExcelJS.Workbook();
  book.creator = 'PeakPath Admin';
  book.created = new Date();
  // Excel limits sheet names to 31 characters and a few symbols. The header
  // row stays in view while scrolling.
  const sheet = book.addWorksheet(table.title.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Export', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  const rows = table.rows.map((row) => row.map(cellText));

  // Each column as wide as its longest value (within reason), so the file
  // opens readable instead of every cell cut off at Excel's default width.
  sheet.columns = table.headers.map((header, column) => ({
    width: Math.min(60, Math.max(12, ...[header, ...rows.map((row) => row[column])].map((value) => cellText(value).length + 3)))
  }));

  // Column names: green fill, bold white text, so they read as the header.
  const headerRow = sheet.addRow(table.headers);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF1F6B39' } } };
  });

  rows.forEach((values, index) => {
    const row = sheet.addRow(values);
    row.eachCell({ includeEmpty: true }, (cell) => {
      if (index % 2) cell.fill = ZEBRA_FILL;
      cell.border = { bottom: RULE };
      cell.alignment = { vertical: 'top', wrapText: true };
    });
  });

  const buffer = await book.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: `${table.filename}-${today()}.xlsx` });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- The menu ---------- */

const STYLES = `
.export-menu { position: fixed; z-index: 3000; min-width: 196px; padding: 6px; border: 1px solid var(--border); border-radius: 10px; background: var(--card-bg); box-shadow: 0 12px 30px rgba(20, 35, 20, .18); }
.export-menu[hidden] { display: none; }
.export-menu-title { padding: 6px 10px 8px; font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--text-secondary); }
.export-menu button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border: 0; border-radius: 7px; background: transparent; font: inherit; font-size: 13px; font-weight: 600; color: var(--text-primary); text-align: left; cursor: pointer; }
.export-menu button:hover,
.export-menu button:focus-visible { background: var(--accent-light); outline: none; }
.export-menu button:disabled { opacity: .6; cursor: progress; }
.export-menu button i { width: 18px; font-size: 16px; text-align: center; }
.export-menu .fa-file-pdf { color: #c8402f; }
.export-menu .fa-file-excel { color: #1f7a45; }
.export-menu-error { padding: 6px 10px 4px; font-size: 11.5px; color: var(--danger); }
.export-menu-error:empty { display: none; }
`;

let menu = null;
let current = null; // { anchor, options }

function closeMenu() {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  current?.anchor.setAttribute('aria-expanded', 'false');
  current = null;
}

function buildMenu() {
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: STYLES }));
  menu = document.createElement('div');
  menu.className = 'export-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  menu.innerHTML = `
    <div class="export-menu-title">Export as</div>
    <button type="button" role="menuitem" data-format="pdf"><i class="fa-solid fa-file-pdf" aria-hidden="true"></i>PDF document</button>
    <button type="button" role="menuitem" data-format="excel"><i class="fa-solid fa-file-excel" aria-hidden="true"></i>Excel spreadsheet</button>
    <div class="export-menu-error" role="alert"></div>`;
  document.body.appendChild(menu);

  menu.addEventListener('click', async (event) => {
    event.stopPropagation();
    const button = event.target.closest('[data-format]');
    if (!button || !current) return;

    const { options } = current;
    const format = button.dataset.format;
    const errorEl = menu.querySelector('.export-menu-error');
    const buttons = menu.querySelectorAll('[data-format]');
    errorEl.textContent = '';
    buttons.forEach((item) => { item.disabled = true; });
    try {
      const table = options.getTable();
      if (format === 'pdf') await savePdf(table);
      else await saveExcel(table);
      closeMenu();
      options.onDone?.(format, table);
    } catch (error) {
      console.error('Export failed:', error);
      errorEl.textContent = error?.message || 'The file could not be created.';
    } finally {
      buttons.forEach((item) => { item.disabled = false; });
    }
  });

  // Clicks outside, Escape, and scrolling or resizing (which would leave the
  // menu floating away from its button) all close it.
  document.addEventListener('click', (event) => {
    if (current && !current.anchor.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && current) {
      event.stopPropagation();
      const { anchor } = current;
      closeMenu();
      anchor.focus();
    }
  }, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', (event) => {
    if (!menu.contains(event.target)) closeMenu();
  }, true);
}

export function openExportMenu(anchor, options) {
  if (!menu) buildMenu();
  if (current?.anchor === anchor) {
    closeMenu(); // a second click on the same button closes it
    return;
  }

  current = { anchor, options };
  menu.querySelector('.export-menu-error').textContent = '';
  menu.hidden = false;
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'true');

  // Under the button, right edges lined up, kept inside the window.
  const box = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
  const below = box.bottom + 6;
  const top = below + menu.offsetHeight > window.innerHeight - 8
    ? Math.max(8, box.top - menu.offsetHeight - 6)
    : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector('[data-format]').focus();
}
