import React, { useState } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { FileDown, Loader2 } from 'lucide-react';
import api from '../lib/api';
import { useAuth } from './AuthContext';
// Great Vibes - cursive signature font, bundled as a static asset (Vite emits
// it to dist/ and gives us a URL to load at runtime).
import greatVibesUrl from '../assets/fonts/GreatVibes-Regular.ttf';

/**
 * Data required to render the official award record. The page resolves the
 * winning transporter (staff fetch the transporters roster; the winning
 * transporter uses their own profile) and passes a plain object here.
 */
export interface AwardPdfData {
  requirementId: string;
  pickupLocation: string;
  deliveryLocation: string;
  material: string;
  weight: number;
  vehicleType: string;
  numberOfVehicles: number;
  pickupDate: string;
  originalBudget: number | null; // targetRate
  bidClosingTime: string; // auction close timestamp
  awardedAmount: number | null;
  winnerName: string;
  winnerEmail: string;
  /** Every quotation received in the auction, best rate first. */
  bidHistory: { transporterName: string; amount: number; timestamp: string | null }[];
}

const COMPANY = 'SHYAM FERRO ALLOYS LTD';
const SUBTITLE = 'Official Logistics Award Record';
const PLATFORM = 'FleexBid';

// ---------------------------------------------------------------------------
// Font registration
// ---------------------------------------------------------------------------
let fontBase64Promise: Promise<string> | null = null;

/**
 * Fetch the cursive signature font once and cache its base64 payload.
 * (jsPDF fonts are per-document-instance, so the base64 is cached here and
 * registered on each generating doc inside generateOfficialAwardPdf.)
 */
function getSignatureFontBase64(): Promise<string> {
  if (!fontBase64Promise) {
    fontBase64Promise = (async () => {
      const res = await fetch(greatVibesUrl);
      const buffer = await res.arrayBuffer();
      // jsPDF wants a base64 string in its virtual file system.
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as any);
      }
      return btoa(binary);
    })();
  }
  return fontBase64Promise;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function inr(n: number | null): string {
  if (n === null || n === undefined || isNaN(Number(n))) return '—';
  return '₹' + Number(n).toLocaleString('en-IN');
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
}

function fmtDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return (
    d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) +
    ' at ' +
    d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
  );
}

/** Compact date+time for table cells, e.g. "16 Aug 2026, 07:23 pm". */
function fmtTimeCompact(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

// ---------------------------------------------------------------------------
// PDF generator
// ---------------------------------------------------------------------------
export async function generateOfficialAwardPdf(data: AwardPdfData): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  // Register the cursive signature font on THIS document instance (jsPDF fonts
  // are not global — they must be added to the doc that renders them).
  const signatureBase64 = await getSignatureFontBase64();
  doc.addFileToVFS('GreatVibes-Regular.ttf', signatureBase64);
  doc.addFont('GreatVibes-Regular.ttf', 'GreatVibes', 'normal');
  const pageW = doc.internal.pageSize.getWidth(); // 210
  const pageH = doc.internal.pageSize.getHeight(); // 297
  const margin = 18;
  const contentW = pageW - margin * 2;
  const navy: [number, number, number] = [23, 42, 79];
  const gold: [number, number, number] = [176, 141, 61];

  // ---- Corporate header ----
  doc.setFillColor(...navy);
  doc.rect(0, 0, pageW, 26, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(21);
  doc.text(COMPANY, pageW / 2, 12, { align: 'center' });
  doc.setFontSize(9);
  doc.setTextColor(212, 215, 226);
  doc.text('FERR0 ALLOYS & LOGISTICS DIVISION', pageW / 2, 19, { align: 'center' });

  // ---- Subtitle + generation date ----
  doc.setTextColor(...navy);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(SUBTITLE, pageW / 2, 38, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(110, 115, 130);
  doc.text(`Document generated on ${fmtDateTime(new Date().toISOString())}`, pageW / 2, 44, { align: 'center' });

  // Double gold rule
  doc.setDrawColor(...gold);
  doc.setLineWidth(0.6);
  doc.line(margin, 48, pageW - margin, 48);
  doc.setLineWidth(0.2);
  doc.line(margin, 50.5, pageW - margin, 50.5);

  // ---- Auction metadata ----
  let y = 58;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...navy);
  doc.text('AUCTION RECORD', margin, y);

  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(60, 65, 80);
  doc.text(`Auction ID:`, margin, y);
  doc.setFont('courier', 'bold');
  doc.setTextColor(...navy);
  doc.text(data.requirementId, margin + 32, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(110, 115, 130);
  doc.text(
    `This reverse-auction record was facilitated via the ${PLATFORM} digital procurement platform.`,
    margin,
    y + 6
  );
  y += 16;

  // ---- Requirement details table ----
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [[{ content: 'REQUIREMENT DETAILS', colSpan: 4, styles: { fillColor: navy, textColor: 255, fontStyle: 'bold', fontSize: 10 } }]],
    body: [
      [
        { content: 'Cargo Description', styles: { fontStyle: 'bold', fillColor: [244, 246, 250] } },
        { content: data.material + ` (${data.weight} Tons)` },
        { content: 'Origin', styles: { fontStyle: 'bold', fillColor: [244, 246, 250] } },
        { content: data.pickupLocation }
      ],
      [
        { content: 'Destination', styles: { fontStyle: 'bold', fillColor: [244, 246, 250] } },
        { content: data.deliveryLocation },
        { content: 'Vehicle Type', styles: { fontStyle: 'bold', fillColor: [244, 246, 250] } },
        { content: `${data.vehicleType}${data.numberOfVehicles > 1 ? ` (x${data.numberOfVehicles})` : ''}` }
      ],
      [
        { content: 'Placement Date', styles: { fontStyle: 'bold', fillColor: [244, 246, 250] } },
        { content: fmtDate(data.pickupDate) },
        { content: 'Original Budget (Target Rate)', styles: { fontStyle: 'bold', fillColor: [244, 246, 250] } },
        { content: inr(data.originalBudget) }
      ]
    ],
    theme: 'grid',
    styles: { fontSize: 9.5, cellPadding: 2.6, textColor: [40, 45, 60], lineColor: [200, 205, 218], lineWidth: 0.15 },
    columnStyles: { 0: { cellWidth: 52 }, 2: { cellWidth: 52 } }
  });

  y = (doc as any).lastAutoTable.finalY + 10;

  // ---- Award details table ----
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [[{ content: 'AWARD DETAILS', colSpan: 4, styles: { fillColor: navy, textColor: 255, fontStyle: 'bold', fontSize: 10 } }]],
    body: [
      [
        { content: 'Winning Transporter', styles: { fontStyle: 'bold', fillColor: [244, 246, 250] } },
        { content: data.winnerName, colSpan: 3 }
      ],
      [
        { content: 'Contact Email', styles: { fontStyle: 'bold', fillColor: [244, 246, 250] } },
        { content: data.winnerEmail, colSpan: 3 }
      ],
      [
        { content: 'Final Winning Bid Amount', styles: { fontStyle: 'bold', fillColor: [244, 246, 250] } },
        { content: inr(data.awardedAmount), colSpan: 3 }
      ],
      [
        { content: 'Auction Closed On', styles: { fontStyle: 'bold', fillColor: [244, 246, 250] } },
        { content: fmtDateTime(data.bidClosingTime), colSpan: 3 }
      ]
    ],
    theme: 'grid',
    styles: { fontSize: 9.5, cellPadding: 2.6, textColor: [40, 45, 60], lineColor: [200, 205, 218], lineWidth: 0.15 },
    columnStyles: { 0: { cellWidth: 52 } }
  });

  y = (doc as any).lastAutoTable.finalY + 10;

  // ---- Bid comparison history table ----
  const winnerKey = (data.winnerName || '').trim().toLowerCase();
  const bidRows: any[] = (data.bidHistory || []).map(b => {
    const isWinner =
      winnerKey &&
      winnerKey !== 'unknown' &&
      b.transporterName &&
      b.transporterName.trim().toLowerCase() === winnerKey;
    const winnerStyle = isWinner ? { fontStyle: 'bold', fillColor: [250, 246, 234] } : undefined;
    return [
      { content: b.transporterName || 'Unknown', styles: winnerStyle },
      { content: inr(b.amount), styles: winnerStyle || { fontStyle: 'bold' } },
      { content: fmtTimeCompact(b.timestamp), styles: isWinner ? { fillColor: [250, 246, 234] } : undefined }
    ];
  });
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [
      [{ content: 'BID COMPARISON HISTORY', colSpan: 3, styles: { fillColor: navy, textColor: 255, fontStyle: 'bold', fontSize: 10 } }],
      [
        { content: 'Transporter Name', styles: { fillColor: [238, 242, 250], fontStyle: 'bold', textColor: navy } },
        { content: 'Bid Rate', styles: { fillColor: [238, 242, 250], fontStyle: 'bold', textColor: navy } },
        { content: 'Time of Bid', styles: { fillColor: [238, 242, 250], fontStyle: 'bold', textColor: navy } }
      ]
    ],
    body:
      bidRows.length > 0
        ? bidRows
        : [[{ content: 'No bids were submitted for this auction.', colSpan: 3, styles: { fontStyle: 'italic', textColor: [120, 125, 140] } }]],
    theme: 'grid',
    styles: { fontSize: 9.5, cellPadding: 2.6, textColor: [40, 45, 60], lineColor: [200, 205, 218], lineWidth: 0.15 },
    columnStyles: { 0: { cellWidth: 92 }, 2: { cellWidth: 46 } },
    // autoTable breaks long histories onto additional pages automatically and
    // repeats the head rows so a multi-page table stays readable.
    headStyles: { fillColor: navy, textColor: 255, fontStyle: 'bold', fontSize: 10 }
  });

  y = (doc as any).lastAutoTable.finalY + 14;

  // If the bid comparison history filled the page, move the closing block
  // (disclaimer + signature) onto a fresh page so nothing gets clipped.
  if (y + 34 > pageH - 15) {
    doc.addPage();
    y = 30;
  }

  // ---- Terms note ----
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(120, 125, 140);
  const note =
    'This document is a system-generated official record of the awarded logistics contract and is electronically ' +
    'authenticated. It is governed by the terms agreed between SHYAM FERRO ALLOYS LTD and the winning transporter ' +
    'through the FleexBid sealed reverse-auction process.';
  const lines = doc.splitTextToSize(note, contentW);
  doc.text(lines, margin, y);
  y += lines.length * 3.5 + 6;

  // ---- Signature block (bottom right) ----
  const sigX = margin + contentW - 88;
  const sigW = 88;
  const blockY = Math.max(y, pageH - 64);

  // Cursive digital-signature placeholder (Great Vibes) above the title.
  doc.setFont('GreatVibes', 'normal');
  doc.setFontSize(26);
  doc.setTextColor(...navy);
  doc.text('A. Kumar', sigX, blockY);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(110, 115, 130);
  doc.text('Authorized by: Logistics Head', sigX, blockY + 6);
  doc.setDrawColor(...gold);
  doc.setLineWidth(0.5);
  doc.line(sigX, blockY + 8, sigX + sigW, blockY + 8);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...navy);
  doc.text(COMPANY, sigX, blockY + 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(120, 125, 140);
  doc.text('Authorized Signatory', sigX, blockY + 19);

  // ---- Footer on every page (page 1 now gets one too) ----
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(150, 155, 170);
    doc.text(`${COMPANY}  |  ${SUBTITLE}  |  Auction ${data.requirementId}`, pageW / 2, pageH - 10, { align: 'center' });
    doc.text(`Page ${i} of ${pageCount}`, pageW - margin, pageH - 10, { align: 'right' });
  }

  doc.save(`${data.requirementId}-official-award-record.pdf`);
}

// ---------------------------------------------------------------------------
// Button component
// ---------------------------------------------------------------------------
interface ExportAwardPdfButtonProps {
  requirement: any;
  /** Pre-resolved winner info (staff pages may pass it to skip an extra fetch). */
  winner?: { name: string; email: string } | null;
  className?: string;
}

/**
 * "Export Official PDF" button. Visible for staff/SUPER_ADMIN and the winning
 * transporter (if applicable). Resolves the winning transporter's name/email
 * when not provided, then generates + downloads the official record.
 */
export default function ExportAwardPdfButton({ requirement, winner, className = '' }: ExportAwardPdfButtonProps) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canExport =
    !!requirement &&
    requirement.status === 'AWARDED' &&
    !!requirement.awardedTransporterId &&
    (user?.role === 'SUPER_ADMIN' || user?.role === 'LOGISTICS' || user?.role === 'TRANSPORTER');

  const handleExport = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      let winnerName = winner?.name || '';
      let winnerEmail = winner?.email || '';
      const awardedId = requirement.awardedTransporterId;

      if ((!winnerName || !winnerEmail) && awardedId) {
        if (user?.role === 'TRANSPORTER' && user?.id === awardedId) {
          // Winning transporter: their own profile is the winner.
          winnerName = winnerName || user?.name || requirement.winnerName || '';
          winnerEmail = winnerEmail || user?.email || '';
        } else {
          // Staff: fetch the transporters roster to resolve name + email.
          try {
            const d = await api.get('/transporters');
            const list: any[] = d.transporters || d || [];
            const tr = list.find((t: any) => t.id === awardedId);
            if (tr) {
              winnerName = winnerName || tr.companyName || tr.name || '';
              winnerEmail = winnerEmail || tr.email || '';
            }
          } catch (e) {
            // Fall through with whatever we have.
          }
        }
      }

      // Bid comparison history. The ranks endpoint enforces transporter
      // confidentiality server-side: staff see every quotation, a transporter
      // only ever sees their own row.
      let bidHistory: { transporterName: string; amount: number; timestamp: string | null }[] = [];
      try {
        const ranksData: any = await api.get(`/requirements/${requirement.id}/ranks`);
        const ranks: any[] = ranksData.ranks || [];
        bidHistory = ranks
          .filter((r: any) => r.amount != null)
          .map((r: any) => ({
            transporterName: r.companyName || 'Unknown',
            amount: Number(r.amount),
            timestamp: r.timestamp || null
          }))
          .sort((a, b) => a.amount - b.amount);
      } catch (e) {
        // Fall through with an empty table rather than blocking the export.
      }

      await generateOfficialAwardPdf({
        requirementId: requirement.id,
        pickupLocation: requirement.pickupLocation,
        deliveryLocation: requirement.deliveryLocation,
        material: requirement.material,
        weight: Number(requirement.weight || 0),
        vehicleType: requirement.vehicleType,
        numberOfVehicles: Number(requirement.numberOfVehicles || 1),
        pickupDate: requirement.pickupDate,
        originalBudget: requirement.targetRate != null ? Number(requirement.targetRate) : null,
        bidClosingTime: requirement.bidClosingTime,
        awardedAmount: requirement.awardedAmount != null ? Number(requirement.awardedAmount) : null,
        winnerName,
        winnerEmail,
        bidHistory
      });
    } catch (e: any) {
      console.error('PDF export failed:', e);
      setErr(e?.message || 'Failed to generate PDF');
    } finally {
      setBusy(false);
    }
  };

  if (!canExport) return null;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleExport}
        disabled={busy}
        className={
          'inline-flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-lg shadow-md transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 ' +
          className
        }
        title="Download the official award record as a PDF"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
        {busy ? 'Generating PDF...' : 'Export Official PDF'}
      </button>
      {err && <span className="text-[10px] text-rose-500 font-medium">{err}</span>}
    </div>
  );
}
