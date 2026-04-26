import ExcelJS from 'exceljs';

interface CsvToXlsxOptions {
  title?: string;
  sheetName?: string;
}

/**
 * Convert CSV content string to an XLSX buffer.
 * Parses the CSV, auto-sizes columns, styles the header row,
 * and freezes the first row.
 */
export async function csvToXlsx(
  csvContent: string,
  options: CsvToXlsxOptions = {}
): Promise<Buffer> {
  const { sheetName = 'Sheet1' } = options;

  // Parse CSV into rows
  const rows = parseCsvRows(csvContent);
  if (rows.length === 0) {
    throw new Error('CSV content is empty');
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Khef';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  // Add header row
  const headers = rows[0];
  const headerRow = worksheet.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE8E8E8' },
  };

  // Add data rows with type detection
  for (let i = 1; i < rows.length; i++) {
    const dataRow = rows[i];
    const excelRow = worksheet.addRow(
      dataRow.map((cell) => coerceValue(cell))
    );

    // Apply number formatting for detected number cells
    dataRow.forEach((cell, colIdx) => {
      const trimmed = cell.trim();
      if (isNumericString(trimmed)) {
        const col = excelRow.getCell(colIdx + 1);
        if (trimmed.includes('.')) {
          col.numFmt = '#,##0.00';
        } else {
          col.numFmt = '#,##0';
        }
      }
    });
  }

  // Auto-size columns based on content
  worksheet.columns.forEach((column) => {
    let maxLength = 10;
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > maxLength) maxLength = len;
    });
    column.width = Math.min(maxLength + 2, 50);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Simple CSV row parser that handles quoted fields.
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let current = '';
  let inQuotes = false;
  let row: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(current);
        current = '';
      } else if (ch === '\n') {
        row.push(current);
        current = '';
        if (row.some((c) => c.trim() !== '')) {
          rows.push(row);
        }
        row = [];
      } else if (ch === '\r') {
        // skip CR
      } else {
        current += ch;
      }
    }
  }

  // Last field/row
  row.push(current);
  if (row.some((c) => c.trim() !== '')) {
    rows.push(row);
  }

  return rows;
}

function isNumericString(s: string): boolean {
  if (!s) return false;
  return /^-?\d+\.?\d*$/.test(s) || /^-?\d{1,3}(,\d{3})*(\.\d+)?$/.test(s);
}

function coerceValue(cell: string): string | number {
  const trimmed = cell.trim();
  if (isNumericString(trimmed)) {
    const num = parseFloat(trimmed.replace(/,/g, ''));
    if (!isNaN(num)) return num;
  }
  return cell;
}

/**
 * Convert an XLSX buffer to CSV text.
 * Reads the first worksheet and converts all cells to CSV.
 */
export async function xlsxToCsv(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('No worksheets found in XLSX file');
  }

  const rows: string[] = [];
  worksheet.eachRow((row) => {
    const cells: string[] = [];
    for (let i = 1; i <= worksheet.columnCount; i++) {
      const cell = row.getCell(i);
      const value = cell.value;
      let str = '';
      if (value === null || value === undefined) {
        str = '';
      } else if (typeof value === 'object' && 'result' in value) {
        // Formula cell — use the result
        str = String(value.result ?? '');
      } else if (value instanceof Date) {
        str = value.toISOString().split('T')[0];
      } else {
        str = String(value);
      }
      // Escape for CSV
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        str = `"${str.replace(/"/g, '""')}"`;
      }
      cells.push(str);
    }
    rows.push(cells.join(','));
  });

  return rows.join('\n');
}
