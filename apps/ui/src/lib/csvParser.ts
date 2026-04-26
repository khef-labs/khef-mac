import Papa from 'papaparse'

export interface ParsedCsv {
  headers: string[]
  rows: string[][]
  delimiter: string
}

export interface ColumnType {
  type: 'number' | 'date' | 'boolean' | 'text'
}

/**
 * Parse CSV text into structured data using papaparse.
 * Auto-detects delimiter (comma, tab, semicolon, pipe).
 */
export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text.trim(), {
    header: false,
    skipEmptyLines: true,
    dynamicTyping: false,
  })

  const data = result.data
  if (data.length === 0) {
    return { headers: [], rows: [], delimiter: ',' }
  }

  const headers = data[0]
  const rows = data.slice(1)

  return {
    headers,
    rows,
    delimiter: result.meta.delimiter,
  }
}

/**
 * Infer column types by sampling values.
 */
export function inferColumnTypes(rows: string[][], colCount: number): ColumnType[] {
  const types: ColumnType[] = Array.from({ length: colCount }, () => ({ type: 'text' }))

  const sampleSize = Math.min(rows.length, 50)

  for (let col = 0; col < colCount; col++) {
    let numCount = 0
    let boolCount = 0
    let nonEmpty = 0

    for (let row = 0; row < sampleSize; row++) {
      const val = (rows[row]?.[col] ?? '').trim()
      if (!val) continue
      nonEmpty++

      if (/^-?\d+\.?\d*$/.test(val) || /^-?\d{1,3}(,\d{3})*(\.\d+)?$/.test(val)) {
        numCount++
      } else if (/^(true|false|yes|no)$/i.test(val)) {
        boolCount++
      }
    }

    if (nonEmpty === 0) continue

    const threshold = nonEmpty * 0.8
    if (numCount >= threshold) {
      types[col] = { type: 'number' }
    } else if (boolCount >= threshold) {
      types[col] = { type: 'boolean' }
    }
  }

  return types
}

/**
 * Convert parsed rows back to CSV text.
 */
export function rowsToCsv(headers: string[], rows: string[][], delimiter = ','): string {
  return Papa.unparse({ fields: headers, data: rows }, { delimiter })
}
