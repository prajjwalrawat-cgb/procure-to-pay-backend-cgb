import { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';
import type { AuditQueryInput, AuditVerifyResult } from '@procureflow/shared';
import PDFDocument from 'pdfkit';

import { PrismaService } from '../prisma/prisma.service';
import { AuditQueryService } from './audit-query.service';

const CSV_HEADER =
  'timestamp,actor,actor_type,action,entity_type,entity_id,ip,hash_current,hash_previous\n';

/**
 * AuditExportService — CSV (streamed, never buffering > 10K rows) and a
 * print-ready HTML report (with the hash-chain verification footer).
 *
 * The PDF export renders a real, binary application/pdf via pdfkit (a pure-JS
 * PDF engine — no Chromium/Puppeteer dependency; the same approach used by
 * PoDocumentService, see ADR-010). buildReportHtml is retained for the
 * on-screen print preview and shares its data-gathering with the PDF path.
 */
@Injectable()
export class AuditExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly query: AuditQueryService,
  ) {}

  /** Streams CSV in 1K-row pages via cursor paging — bounded memory. */
  exportCsv(
    filters: Pick<AuditQueryInput, 'from' | 'to' | 'action' | 'entityType'>,
  ): Readable {
    const prisma = this.prisma;
    const where = {
      ...(filters.from || filters.to
        ? {
            timestamp: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {}),
      ...(filters.action?.length ? { action: { in: filters.action } } : {}),
      ...(filters.entityType?.length ? { entityType: { in: filters.entityType } } : {}),
    };

    async function* generate(): AsyncGenerator<string> {
      yield CSV_HEADER;
      let cursor: string | undefined;
      const pageSize = 1000;
      for (;;) {
        const rows = await prisma.client.auditLog.findMany({
          where,
          take: pageSize,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
        });
        if (rows.length === 0) break;
        for (const r of rows) {
          yield [
            r.timestamp.toISOString(),
            r.actorId ?? '',
            r.actorType,
            r.action,
            r.entityType,
            r.entityId,
            r.ipAddress ?? '',
            r.hashCurrent,
            r.hashPrevious ?? '',
          ]
            .map(csvCell)
            .join(',') + '\n';
        }
        cursor = rows[rows.length - 1]?.id;
        if (rows.length < pageSize) break;
      }
    }

    return Readable.from(generate());
  }

  /** Shared data-gathering for both the HTML preview and the PDF export. */
  private async gatherReport(input: AuditQueryInput): Promise<{
    page: Awaited<ReturnType<AuditQueryService['find']>>;
    verification: AuditVerifyResult;
    filterSummary: string;
  }> {
    const page = await this.query.find({ ...input, limit: 200 });
    const verification = await this.query.verifyChain(
      input.from ?? null,
      input.to ?? null,
    );
    const filterSummary = [
      input.from ? `from ${input.from}` : null,
      input.to ? `to ${input.to}` : null,
      input.action?.length ? `actions: ${input.action.join(', ')}` : null,
      input.entityType?.length ? `entities: ${input.entityType.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return { page, verification, filterSummary };
  }

  /** Build the print-ready HTML report + verification footer (on-screen preview). */
  async buildReportHtml(
    tenantName: string,
    input: AuditQueryInput,
  ): Promise<{ html: string; verification: AuditVerifyResult }> {
    const { page, verification, filterSummary } = await this.gatherReport(input);

    const rows = page.items
      .map(
        (r) => `<tr>
          <td>${esc(r.timestamp)}</td>
          <td>${esc(r.actorName ?? r.actorId ?? 'system')}</td>
          <td>${esc(r.action)}</td>
          <td>${esc(r.entityType)}</td>
          <td class="mono">${esc(r.entityId)}</td>
          <td class="mono">${esc(r.hashCurrent.slice(0, 12))}…</td>
        </tr>`,
      )
      .join('');

    const banner = verification.verified
      ? `<div class="ok">Chain verified · ${verification.eventsChecked} events · no tampering detected</div>`
      : `<div class="fail">Chain BROKEN · first break at ${esc(
          verification.firstBreakAt ?? '',
        )}</div>`;

    const html = `<!doctype html><html><head><meta charset="utf-8"/>
      <title>Audit report — ${esc(tenantName)}</title>
      <style>
        body{font-family:ui-sans-serif,system-ui;color:#0A0A0A;padding:24px;font-size:12px}
        h1{font-size:18px;margin:0 0 4px}
        .muted{color:#78786F}
        table{width:100%;border-collapse:collapse;margin-top:12px}
        th,td{border-bottom:1px solid #E8E8E1;text-align:left;padding:6px 8px}
        th{color:#78786F;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
        .mono{font-family:ui-monospace,monospace}
        .ok{margin-top:16px;padding:10px;background:#ECFDF5;color:#047857;border-radius:6px}
        .fail{margin-top:16px;padding:10px;background:#FFE4E6;color:#E11D48;border-radius:6px}
      </style></head><body>
      <h1>Audit log report</h1>
      <div class="muted">${esc(tenantName)} · generated ${esc(nowIso())}</div>
      <div class="muted">Filters: ${esc(filterSummary || 'none (last 30 days)')}</div>
      <table><thead><tr>
        <th>Timestamp</th><th>Actor</th><th>Action</th><th>Entity</th><th>ID</th><th>Hash</th>
      </tr></thead><tbody>${rows}</tbody></table>
      ${banner}
    </body></html>`;

    return { html, verification };
  }

  /** Render the audit report as a real binary PDF (application/pdf) via pdfkit. */
  async buildReportPdf(tenantName: string, input: AuditQueryInput): Promise<Buffer> {
    const { page, verification, filterSummary } = await this.gatherReport(input);

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const cols: { label: string; w: number; mono: boolean }[] = [
      { label: 'Timestamp', w: 108, mono: false },
      { label: 'Actor', w: 92, mono: false },
      { label: 'Action', w: 94, mono: false },
      { label: 'Entity', w: 68, mono: false },
      { label: 'ID', w: 92, mono: true },
      { label: 'Hash', w: 61, mono: true },
    ];
    const left = doc.page.margins.left;
    const tableWidth = cols.reduce((s, c) => s + c.w, 0);
    const drawHeader = (yPos: number): number => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#78786F');
      let x = left;
      for (const c of cols) {
        doc.text(c.label.toUpperCase(), x, yPos, { width: c.w });
        x += c.w;
      }
      doc
        .moveTo(left, yPos + 12)
        .lineTo(left + tableWidth, yPos + 12)
        .strokeColor('#E8E8E1')
        .stroke();
      return yPos + 18;
    };

    doc.font('Helvetica-Bold').fontSize(18).fillColor('#0A0A0A').text('Audit log report');
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#78786F')
      .text(`${tenantName} · generated ${nowIso()}`)
      .text(`Filters: ${filterSummary || 'none (last 30 days)'}`);
    doc.moveDown(0.8);

    let y = drawHeader(doc.y);
    const bottom = doc.page.height - doc.page.margins.bottom - 40;
    for (const r of page.items) {
      if (y > bottom) {
        doc.addPage();
        y = drawHeader(doc.page.margins.top);
      }
      const cells = [
        r.timestamp,
        r.actorName ?? r.actorId ?? 'system',
        r.action,
        r.entityType,
        r.entityId,
        `${r.hashCurrent.slice(0, 10)}…`,
      ];
      let x = left;
      cols.forEach((c, i) => {
        doc
          .font(c.mono ? 'Courier' : 'Helvetica')
          .fontSize(8)
          .fillColor('#0A0A0A')
          .text(String(cells[i]), x, y, {
            width: c.w - 4,
            height: 10,
            ellipsis: true,
            lineBreak: false,
          });
        x += c.w;
      });
      y += 13;
    }

    y += 8;
    if (y > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    const ok = verification.verified;
    doc.rect(left, y, tableWidth, 22).fill(ok ? '#ECFDF5' : '#FFE4E6');
    doc
      .fillColor(ok ? '#047857' : '#E11D48')
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(
        ok
          ? `Chain verified · ${verification.eventsChecked} events · no tampering detected`
          : `Chain BROKEN · first break at ${verification.firstBreakAt ?? ''}`,
        left + 8,
        y + 7,
        { width: tableWidth - 16 },
      );

    doc.end();
    return done;
  }
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// process-time helper kept out of the class so it can be swapped in tests.
function nowIso(): string {
  return new Date().toISOString();
}
