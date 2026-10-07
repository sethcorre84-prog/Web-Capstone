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
// A report of several lists (the Dashboard's View Reports) passes sections
// instead of headers/rows:
//   { title, filename, sections: [{ title, headers, rows, note? }] }
// The PDF then has one heading and table per section, one after another;
// the Excel workbook has one sheet per section.
//
// A section that is a chart on the page can carry it, drawn beside its table
// (to the right in the PDF, next to the table on its Excel sheet):
//   chart: { type: 'donut', items: [{ label, value, color }], centerLabel, centerValue }
//   chart: { type: 'bar',   items: [{ label, value }], color }
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

/* ---------- Charts, drawn on a canvas as a PNG ---------- */

const CHART_W = 800;
const CHART_H = 480;
const FONT = '"Segoe UI", Arial, sans-serif';
const INK = '#1b211b';
const MUTED = '#5b6b60';

function fitText(ctx, text, width) {
  let value = String(text);
  if (ctx.measureText(value).width <= width) return value;
  while (value.length > 1 && ctx.measureText(`${value}…`).width > width) value = value.slice(0, -1);
  return `${value}…`;
}

function drawDonut(ctx, chart) {
  const items = chart.items.filter((item) => item.value > 0);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const cx = 210;
  const cy = chart.title ? CHART_H / 2 + 18 : CHART_H / 2;
  const outer = 170;
  const inner = 105;
  let angle = -Math.PI / 2;
  items.forEach((item) => {
    const sweep = (item.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, angle, angle + sweep);
    ctx.arc(cx, cy, inner, angle + sweep, angle, true);
    ctx.closePath();
    ctx.fillStyle = item.color;
    ctx.fill();
    // A thin white gap between slices, as on the Dashboard.
    if (items.length > 1) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    angle += sweep;
  });
  ctx.textAlign = 'center';
  ctx.fillStyle = MUTED;
  ctx.font = `24px ${FONT}`;
  ctx.fillText(chart.centerLabel || 'Total', cx, cy - 12);
  ctx.fillStyle = INK;
  ctx.font = `bold 44px ${FONT}`;
  ctx.fillText(String(chart.centerValue ?? total), cx, cy + 34);

  // Legend: swatch, name, share and count.
  ctx.textAlign = 'left';
  const rowH = 62;
  let y = cy - ((chart.items.length - 1) * rowH) / 2 - 12;
  chart.items.forEach((item) => {
    ctx.fillStyle = item.value > 0 ? item.color : '#c9d1cb';
    ctx.fillRect(420, y - 14, 22, 22);
    ctx.fillStyle = item.value > 0 ? INK : '#93a199';
    ctx.font = `bold 24px ${FONT}`;
    ctx.fillText(fitText(ctx, item.label, CHART_W - 460), 456, y + 4);
    ctx.fillStyle = item.value > 0 ? MUTED : '#93a199';
    ctx.font = `22px ${FONT}`;
    const share = total ? Math.round((item.value / total) * 100) : 0;
    ctx.fillText(`${share}% (${item.value.toLocaleString()})`, 456, y + 32);
    y += rowH;
  });
}

// A round step for the count axis and the top it reaches, with headroom
// above the tallest bar so equal small counts do not fill the whole chart.
function countScale(max) {
  const raw = Math.max(1, max) / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * power).find((v) => v >= raw));
  return { step, top: Math.ceil((max * 1.25) / step) * step || step };
}

function drawBars(ctx, chart) {
  const items = chart.items;
  const { step, top } = countScale(Math.max(...items.map((item) => item.value)));
  const left = 70;
  const right = CHART_W - 30;
  const plotTop = chart.title ? 80 : 40;
  const base = CHART_H - 80;
  const scaleY = (value) => base - ((base - plotTop) * value) / top;

  // Count axis: light gridlines, small labels on the left.
  ctx.font = `20px ${FONT}`;
  ctx.textAlign = 'right';
  for (let value = 0; value <= top; value += step) {
    const y = scaleY(value);
    ctx.strokeStyle = value === 0 ? '#cfd8cc' : '#edf1eb';
    ctx.lineWidth = value === 0 ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillStyle = '#93a199';
    ctx.fillText(String(value), left - 12, y + 7);
  }

  // Slim bars, centred in their slots, rounded only at the top.
  const slot = (right - left) / items.length;
  const barW = Math.min(56, slot * 0.42);
  items.forEach((item, index) => {
    const x = left + slot * index + (slot - barW) / 2;
    const y = scaleY(item.value);
    const h = Math.max(3, base - y);
    const r = Math.min(6, barW / 2, h);
    ctx.beginPath();
    ctx.moveTo(x, base);
    ctx.lineTo(x, base - h + r);
    ctx.quadraticCurveTo(x, base - h, x + r, base - h);
    ctx.lineTo(x + barW - r, base - h);
    ctx.quadraticCurveTo(x + barW, base - h, x + barW, base - h + r);
    ctx.lineTo(x + barW, base);
    ctx.closePath();
    ctx.fillStyle = chart.color || '#2f8f4e';
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.fillStyle = INK;
    ctx.font = `bold 22px ${FONT}`;
    ctx.fillText(String(item.value), x + barW / 2, base - h - 10);

    // Category label under the bar, on up to two lines.
    ctx.fillStyle = MUTED;
    ctx.font = `19px ${FONT}`;
    const lines = [''];
    String(item.label).split(/\s+/).forEach((word) => {
      const next = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${word}` : word;
      if (ctx.measureText(next).width > slot - 10 && lines[lines.length - 1]) lines.push(word);
      else lines[lines.length - 1] = next;
    });
    lines.slice(0, 2).forEach((line, i) => {
      const text = i === 1 && lines.length > 2 ? `${line}…` : line;
      ctx.fillText(fitText(ctx, text, slot - 10), x + barW / 2, base + 28 + i * 23);
    });
  });
}

// A small heading at the top-left of a chart.
function drawTitle(ctx, title) {
  if (!title) return;
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText(title, 24, 42);
}

// The chart as a data URL (PNG for Excel; JPEG for the PDF, where jsPDF
// stores a PNG uncompressed and a page of charts runs to megabytes), or null
// when there is nothing to draw.
function chartImage(chart, type = 'image/png') {
  if (!chart?.items?.length || !chart.items.some((item) => item.value > 0)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = CHART_W;
  canvas.height = CHART_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, CHART_W, CHART_H);
  if (chart.type === 'donut') drawDonut(ctx, chart);
  else drawBars(ctx, chart);
  drawTitle(ctx, chart.title);
  return canvas.toDataURL(type, 0.92);
}

const TABLE_STYLE = {
  styles: { fontSize: 8, cellPadding: 3 },
  headStyles: { fillColor: [47, 143, 78] },
  alternateRowStyles: { fillColor: [247, 249, 247] }
};

async function saveSectionsPdf(table) {
  await loadPdfLibraries();
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'landscape' });
  const pageHeight = pdf.internal.pageSize.getHeight();

  pdf.setFontSize(14);
  pdf.text(`PeakPath — ${table.title}`, 14, 15);
  pdf.setFontSize(10);
  pdf.setTextColor(100);
  pdf.text(`Generated ${formatPortalDateTime(new Date())}`, 14, 21);

  const pageWidth = pdf.internal.pageSize.getWidth();
  const MARGIN = 14;
  const CHART_MM_W = 120;
  const CHART_MM_H = CHART_MM_W * (CHART_H / CHART_W);
  let y = 30;
  table.sections.forEach((section) => {
    const image = chartImage(section.chart, 'image/jpeg');
    // A heading never sits alone at the foot of a page, and a chart is
    // never cut by one.
    if (y > pageHeight - 40 || (image && y + CHART_MM_H + 14 > pageHeight - 10)) {
      pdf.addPage();
      y = 18;
    }
    pdf.setFontSize(12);
    pdf.setTextColor(31, 107, 57);
    pdf.text(section.title, 14, y);
    y += 3;
    if (section.note) {
      pdf.setFontSize(9);
      pdf.setTextColor(110);
      pdf.text(section.note, 14, y + 3);
      y += 5;
    }
    const startY = y + 2;
    const startPage = pdf.internal.getCurrentPageInfo().pageNumber;
    // With a chart, the table takes the left part and the chart sits beside it.
    const tableWidth = image ? pageWidth - MARGIN * 2 - CHART_MM_W - 8 : 'auto';
    pdf.autoTable({
      startY,
      head: [section.headers],
      body: section.rows.length
        ? section.rows.map((row) => row.map(cellText))
        : [[{ content: 'Nothing to show.', colSpan: section.headers.length, styles: { textColor: 130, fontStyle: 'italic' } }]],
      tableWidth,
      margin: { left: MARGIN, right: MARGIN },
      ...TABLE_STYLE
    });
    let bottom = pdf.lastAutoTable.finalY;
    if (image) {
      pdf.addImage(image, 'JPEG', pageWidth - MARGIN - CHART_MM_W, startY, CHART_MM_W, CHART_MM_H);
      // A table that ran onto the next page leaves the chart behind on this one.
      if (pdf.internal.getCurrentPageInfo().pageNumber === startPage) {
        bottom = Math.max(bottom, startY + CHART_MM_H);
      }
    }
    y = bottom + 12;
  });

  pdf.save(`${table.filename}-${today()}.pdf`);
}

async function savePdf(table) {
  if (table.sections) return saveSectionsPdf(table);
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

// Excel limits sheet names to 31 characters and a few symbols, and each
// must be unique in the workbook.
function sheetName(book, title) {
  const base = String(title).replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Export';
  let name = base;
  for (let n = 2; book.getWorksheet(name); n += 1) name = `${base.slice(0, 28)} ${n}`;
  return name;
}

async function saveExcel(table) {
  await loadExcelLibrary();
  const book = new window.ExcelJS.Workbook();
  book.creator = 'PeakPath Admin';
  book.created = new Date();
  const sections = table.sections || [table];
  sections.forEach((section) => addSheet(book, section));

  const buffer = await book.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: `${table.filename}-${today()}.xlsx` });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// One table as a worksheet. The header row stays in view while scrolling.
function addSheet(book, table) {
  const sheet = book.addWorksheet(sheetName(book, table.title), {
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
  if (!rows.length) sheet.addRow(['Nothing to show.']).getCell(1).font = { italic: true, color: { argb: 'FF8A948C' } };
  const image = chartImage(table.chart);
  if (image) {
    // One empty column after the table, then the chart.
    const id = book.addImage({ base64: image, extension: 'png' });
    sheet.addImage(id, { tl: { col: table.headers.length + 1, row: 0 }, ext: { width: CHART_W * 0.5, height: CHART_H * 0.5 } });
  }
  if (table.note) {
    sheet.addRow([]);
    sheet.addRow([table.note]).getCell(1).font = { italic: true, color: { argb: 'FF6B7A70' } };
  }
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
      // Chart exports can keep their own document layout using onExport.
      const table = options.getTable?.();
      if (options.onExport) await options.onExport(format);
      else if (format === 'pdf') await savePdf(table);
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
