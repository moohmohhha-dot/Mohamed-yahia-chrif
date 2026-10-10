/**
 * Bulk inventory import / export (CSV and Excel).
 *
 * Import columns (header row required, case-insensitive; French/Arabic-friendly aliases accepted):
 *   sku        the merchant SKU of the offer                         (required)
 *   quantity   a whole number                                         (required)
 *   location   location code, e.g. MAIN; empty = default location
 *   mode       "set" (stock count, default) or "adjust" (+/- change)
 *   note       free text
 *
 * An import is checked first (dry run: every row validated, nothing written), then applied as one
 * transaction: all rows are written or none.
 */
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { and, eq, inArray } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { AppError, badRequest } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { requireMembership } from '../merchants/index.js';
import { audit, recordEvent } from '../platform/index.js';
import { applyChange, lockLevel } from './levels.js';
import { ensureDefaultLocation } from './locations.js';
import { listInventory } from './service.js';

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

type RawRow = Record<string, string>;
export type ImportRow = {
  line: number;
  sku: string;
  location: string;
  mode: 'set' | 'adjust';
  quantity: number | null;
  note: string | null;
  before?: number;
  after?: number;
  error?: string;
};

const ALIASES: Record<string, keyof RawRow> = {
  sku: 'sku',
  référence: 'sku',
  reference: 'sku',
  quantity: 'quantity',
  quantité: 'quantity',
  quantite: 'quantity',
  qty: 'quantity',
  الكمية: 'quantity',
  location: 'location',
  emplacement: 'location',
  entrepôt: 'location',
  warehouse: 'location',
  المستودع: 'location',
  mode: 'mode',
  note: 'note',
};

/** RFC 4180 CSV with auto-detected `,` or `;` separator (Excel in French locales uses `;`). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += c;
  }
  if (field !== '' || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export async function parseXlsx(body: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(body as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as unknown[]).slice(1); // ExcelJS rows are 1-based
    rows.push(
      values.map((v) => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'object' && 'result' in (v as object)) return String((v as { result: unknown }).result ?? ''); // formula
        if (typeof v === 'object' && 'text' in (v as object)) return String((v as { text: unknown }).text ?? ''); // rich text / link
        return String(v);
      }),
    );
  });
  return rows;
}

function toRows(table: string[][]): ImportRow[] {
  const [header, ...body] = table;
  if (!header) throw badRequest('EMPTY_FILE', 'The file has no rows');
  const columns = header.map((h) => ALIASES[h.trim().toLowerCase()] ?? null);
  if (!columns.includes('sku') || !columns.includes('quantity')) {
    throw badRequest('MISSING_COLUMNS', 'The header row needs at least "sku" and "quantity"');
  }
  if (body.length > MAX_IMPORT_ROWS) throw badRequest('TOO_MANY_ROWS', `At most ${MAX_IMPORT_ROWS} rows per import`);
  return body.map((cells, i) => {
    const raw: RawRow = {};
    columns.forEach((col, j) => col && (raw[col] = (cells[j] ?? '').trim()));
    const mode = (raw.mode || 'set').toLowerCase();
    const quantity = /^[+-]?\d+$/.test(raw.quantity ?? '') ? Number(raw.quantity) : null;
    const row: ImportRow = {
      line: i + 2,
      sku: (raw.sku ?? '').toUpperCase(),
      location: (raw.location ?? '').toUpperCase(),
      mode: mode === 'adjust' ? 'adjust' : 'set',
      quantity,
      note: raw.note || null,
    };
    if (!row.sku) row.error = 'Missing SKU';
    else if (mode !== 'set' && mode !== 'adjust') row.error = 'Mode must be "set" or "adjust"';
    else if (quantity === null || Math.abs(quantity) > 1_000_000) row.error = 'Quantity must be a whole number';
    else if (row.mode === 'set' && quantity < 0) row.error = 'A stock count cannot be negative';
    else if (row.mode === 'adjust' && quantity === 0) row.error = 'An adjustment cannot be zero';
    return row;
  });
}

/**
 * Validates (dryRun) or applies an import. Rows are evaluated in order, so two rows for the same SKU
 * and location see each other's effect. Returns every row with its before/after quantity or its error.
 */
export async function importInventory(
  db: Database,
  actor: Actor & { userId: string },
  merchantId: string,
  file: { body: Buffer; fileName: string | null },
  options: { dryRun: boolean },
) {
  await requireMembership(db, merchantId, actor.userId, ['owner', 'manager']);
  const isXlsx = file.body.subarray(0, 2).toString('latin1') === 'PK'; // .xlsx is a zip archive
  const table = isXlsx ? await parseXlsx(file.body) : parseCsv(file.body.toString('utf8'));
  const rows = toRows(table);

  const importId = randomUUID();
  const run = async (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => {
    const defaultLocation = await ensureDefaultLocation(tx, merchantId);
    const skus = [...new Set(rows.map((r) => r.sku).filter(Boolean))];
    const offers = skus.length
      ? await tx.select().from(s.offers).where(and(eq(s.offers.merchantId, merchantId), inArray(s.offers.sku, skus)))
      : [];
    const locations = await tx.select().from(s.inventoryLocations).where(eq(s.inventoryLocations.merchantId, merchantId));
    const simulated = new Map<string, { onHand: number; reserved: number }>();

    for (const row of rows) {
      if (row.error) continue;
      const offer = offers.find((o) => o.sku === row.sku);
      const location = row.location ? locations.find((l) => l.code === row.location) : defaultLocation;
      if (!offer) row.error = `Unknown SKU ${row.sku}`;
      else if (!location) row.error = `Unknown location ${row.location}`;
      else if (location.status !== 'active') row.error = `Location ${location.code} is archived`;
      if (row.error) continue;

      const key = `${offer!.id}:${location!.id}`;
      const current = simulated.get(key) ?? (await lockLevel(tx, offer!.id, location!.id));
      const after = row.mode === 'set' ? row.quantity! : current.onHand + row.quantity!;
      row.before = current.onHand;
      row.after = after;
      if (after < current.reserved) {
        row.error = `Would leave ${after} on hand but ${current.reserved} are reserved for orders`;
        continue;
      }
      simulated.set(key, { onHand: after, reserved: current.reserved });
      if (!options.dryRun && after !== current.onHand) {
        await applyChange(tx, offer!.id, location!.id, { onHand: after - current.onHand }, {
          merchantId,
          reason: 'import',
          note: row.note ?? file.fileName ?? 'Import',
          actorUserId: actor.userId,
          referenceType: 'import',
          referenceId: importId,
        });
      }
    }
    const errors = rows.filter((r) => r.error).length;
    if (!options.dryRun && errors) {
      throw new AppError(400, 'IMPORT_INVALID', `${errors} row(s) have errors; nothing was imported`, { rows });
    }
    if (!options.dryRun) {
      await audit(tx, actor, {
        action: 'inventory.import.applied',
        entityType: 'merchant',
        entityId: merchantId,
        metadata: { importId, rows: rows.length, fileName: file.fileName },
      });
      await recordEvent(tx, { type: 'inventory.import.applied', aggregateType: 'merchant', aggregateId: merchantId, payload: { importId } });
    }
    return { importId: options.dryRun ? null : importId, dryRun: options.dryRun, valid: errors === 0, errors, rows };
  };

  if (options.dryRun) {
    // Run the same checks in a transaction that is always rolled back, so nothing is written.
    let result: Awaited<ReturnType<typeof run>> | undefined;
    await db
      .transaction(async (tx) => {
        result = await run(tx);
        tx.rollback();
      })
      .catch((e) => {
        if (!result) throw e;
      });
    return result!;
  }
  return db.transaction(run);
}

/** Neutralizes spreadsheet formulas in exported text (CSV injection). */
const safeCell = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const csvCell = (v: string | number) => {
  const text = typeof v === 'number' ? String(v) : safeCell(v);
  return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** One row per offer and location, in the same format the import accepts. */
export async function exportInventory(db: Database, userId: string, merchantId: string, format: 'csv' | 'xlsx', locale: string) {
  const items = await listInventory(db, userId, merchantId);
  const header = ['sku', 'product', 'location', 'quantity', 'reserved', 'available', 'mode', 'note'];
  const rows: (string | number)[][] = [];
  for (const item of items) {
    const name = item.productNames[locale] ?? Object.values(item.productNames)[0] ?? '';
    const levels = item.locations.length ? item.locations : [{ locationCode: '', onHand: 0, reserved: 0, available: 0 }];
    for (const l of levels) rows.push([item.sku, name, l.locationCode, l.onHand, l.reserved, l.available, 'set', '']);
  }
  if (format === 'csv') {
    const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
    return { contentType: 'text/csv; charset=utf-8', body: Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8') };
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Inventory');
  sheet.addRow(header);
  for (const r of rows) sheet.addRow(r.map((v) => (typeof v === 'string' ? safeCell(v) : v)));
  sheet.getRow(1).font = { bold: true };
  return {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: Buffer.from(await workbook.xlsx.writeBuffer()),
  };
}
