/**
 * PDF table overflow verification (run: node scripts/pdf-overflow-check.mjs)
 *
 * Replicates the EXACT autoTable configuration from
 * src/components/OfficialAwardPdf.tsx (baseTableStyles, constrainLongCells,
 * column widths) and renders the award tables with extreme bid amounts and
 * long timestamps. Asserts that every rendered text line stays within its
 * cell's content width (i.e. nothing spills outside the cell borders).
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

// --- Same helpers as the real PDF template --------------------------------
function inr(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return '—';
  return '₹' + Number(n).toLocaleString('en-IN');
}
function fmtTimeCompact(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

const baseTableStyles = {
  fontSize: 9.5,
  cellPadding: { top: 2.4, right: 2.8, bottom: 2.4, left: 2.8 },
  textColor: [40, 45, 60],
  lineColor: [200, 205, 218],
  lineWidth: 0.15,
  overflow: 'linebreak',
  valign: 'middle',
  minCellHeight: 7
};
const bidColWidths = { 0: 72, 1: 50, 2: 52 };
const makeConstrainLongCells = (columnWidths, spanWidth) => (hookData) => {
  const { cell } = hookData;
  if (!cell || !cell.text || cell.text.length === 0) return;
  const text = cell.text.join(' ');
  // cell.width is not finalized during didParseCell - use configured widths.
  let colW;
  if (cell.colSpan && cell.colSpan > 1) {
    let w = 0;
    for (let i = hookData.column.index; i < hookData.column.index + cell.colSpan; i++) {
      w += columnWidths[i] ?? 0;
    }
    colW = w || spanWidth;
  } else {
    colW = columnWidths[hookData.column.index] || spanWidth;
  }
  const usable = colW - cell.padding('left') - cell.padding('right');
  if (usable <= 4) return;
  const scale = hookData.doc.internal.scaleFactor || 2.835;
  const baseSize = cell.styles.fontSize || 9.5;
  const widthAt = (s) => (hookData.doc.getStringUnitWidth(text) * s) / scale;
  let size = baseSize;
  while (widthAt(size) > usable && size > 5.5) size -= 0.5;
  if (size < baseSize) cell.styles.fontSize = size;
};

// --- Extreme data ----------------------------------------------------------
const hugeAmount = 999999999999; // ₹9,99,99,99,99,999 - far wider than a cell
const hugeAmount2 = 123456789012;
const longTimestamp = '16 Aug 2026, 11:59 pm';

const doc = new jsPDF({ unit: 'mm', format: 'a4' });
const pageW = doc.internal.pageSize.getWidth(); // 210
const margin = 18;

// 30+ character unbroken currency string - far wider than the 50mm amount
// column even after padding, forces the didParseCell shrink branch.
const monstrous = '₹' + (99999999999999999999n).toLocaleString('en-IN');

const bidRows = [
  [ 'Extremely Long Transporter Company Name Pvt Ltd', inr(hugeAmount), longTimestamp ],
  [ 'Another Long Carrier Name Logistics Solutions', inr(hugeAmount2), '26 Dec 2026, 08:45 pm' ],
  [ 'Gati Transport', inr(987654321), '16 Aug 2026, 07:23 pm' ],
  [ 'Monster Fleet Carriers', monstrous, '31 Dec 2026, 11:59 pm' ]
];

autoTable(doc, {
  startY: 40,
  margin: { left: margin, right: margin },
  head: [
    [{ content: 'BID COMPARISON HISTORY', colSpan: 3, styles: { fillColor: [23, 42, 79], textColor: 255, fontStyle: 'bold', fontSize: 10 } }],
    [
      { content: 'Transporter Name', styles: { fillColor: [238, 242, 250], fontStyle: 'bold', textColor: [23, 42, 79] } },
      { content: 'Bid Rate', styles: { fillColor: [238, 242, 250], fontStyle: 'bold', textColor: [23, 42, 79] } },
      { content: 'Time of Bid', styles: { fillColor: [238, 242, 250], fontStyle: 'bold', textColor: [23, 42, 79] } }
    ]
  ],
  body: bidRows,
  theme: 'grid',
  styles: baseTableStyles,
  columnStyles: { 0: { cellWidth: bidColWidths[0] }, 1: { cellWidth: bidColWidths[1] }, 2: { cellWidth: bidColWidths[2] } },
  headStyles: { fillColor: [23, 42, 79], textColor: 255, fontStyle: 'bold', fontSize: 10 },
  didParseCell: makeConstrainLongCells(bidColWidths, 174)
});

// --- Verify every rendered line fits inside its cell -----------------------
const table = doc.lastAutoTable;
const scale = doc.internal.scaleFactor;
let failures = 0;
let shrunk = 0;

for (const row of table.body) {
  for (const cell of Object.values(row.cells)) {
    if (!cell) continue;
    const contentWidth = cell.width - cell.padding('left') - cell.padding('right');
    const font = cell.styles.font || 'helvetica';
    const fontStyle = cell.styles.fontStyle || 'normal';
    doc.setFont(font, fontStyle);
    for (const line of cell.text) {
      doc.setFontSize(cell.styles.fontSize);
      const w = (doc.getStringUnitWidth(line) * cell.styles.fontSize) / scale;
      if (w > contentWidth + 0.3) {
        failures++;
        console.error(`OVERFLOW: "${line}" width=${w.toFixed(2)}mm > cell content width=${contentWidth.toFixed(2)}mm`);
      }
    }
    if (cell.styles.fontSize < 9.5) shrunk++;
  }
}

console.log('Bid Rate column (col 1) width:', 50, 'mm');
console.log(`Cells whose font was auto-shrunk: ${shrunk}`);
console.log(failures === 0 ? 'PASS: no cell text overflows its borders' : `FAIL: ${failures} overflow(s)`);

// Prove the huge/monstrous amounts were contained (wrapped/shrunk, never spilled):
for (const row of table.body) {
  const amountCell = row.cells[1];
  const nameCell = row.cells[0];
  const amount = amountCell.text.join(' | ');
  const name = nameCell.text.join(' | ');
  console.log(`row: name="${name.slice(0, 40)}${name.length > 40 ? '...' : ''}" | amount="${amount}" (fontSize ${amountCell.styles.fontSize})`);
}

const bytes = doc.output('arraybuffer');
console.log(`PDF generated OK (${bytes.byteLength} bytes)`);
process.exit(failures === 0 ? 0 : 1);
