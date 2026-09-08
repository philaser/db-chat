import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { finished, pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createInterface } from 'node:readline';
import { ZipArchive } from 'archiver';
import { ExportError, type ExportRun } from './exportJobs.js';

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
const WORKBOOK = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>';
const WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>';

function sanitizeXml(value: unknown): string {
  const source = String(value ?? '').replace(/_x([0-9a-f]{4})_/gi, '_x005F_x$1_');
  let safe = '';
  for (let index = 0; index < source.length; index++) {
    const unit = source.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = source.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) throw new ExportError('A cell contains invalid Unicode. Choose JSON or CSV to preserve the source value.');
      safe += source[index] + source[++index];
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new ExportError('A cell contains invalid Unicode. Choose JSON or CSV to preserve the source value.');
    else if (unit === 0xd) safe += '\0';
    else if (unit === 0xfffe || unit === 0xffff || (unit < 0x20 && unit !== 0x9 && unit !== 0xa)) throw new ExportError('A cell contains an XML control character. Choose JSON or CSV to preserve the source value.');
    else if (unit === 0x9 || unit === 0xa || unit >= 0x20) safe += source[index];
  }
  return safe.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!).replaceAll('\0', '&#13;');
}

function columnName(index: number): string {
  let value = index + 1, result = '';
  while (value > 0) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}

function serializeObject(value: object): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}

function scalarCellXml(value: unknown, reference: string): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return `<c r="${reference}"><v>${value}</v></c>`;
  return null;
}

function cellText(value: unknown): string {
  const text = value instanceof Date ? value.toISOString() : value !== null && typeof value === 'object' ? serializeObject(value) : String(value);
  if (text.length > 32_767) throw new ExportError('A cell exceeds Excel’s text limit. Choose JSON or CSV to preserve its full value.');
  return text;
}

async function writeXml(output: ReturnType<typeof createWriteStream>, text: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!output.write(text)) await once(output, 'drain', { signal });
}

/** Build worksheet XML with real stream backpressure, then stream it into the ZIP. */
export async function writeXlsxFromNdjson(spool: string, columns: string[], context: ExportRun): Promise<void> {
  const worksheet = `${context.filename}.worksheet.xml`;
  const sharedStrings = `${context.filename}.sharedStrings.xml`;
  const xml = createWriteStream(worksheet, { flags: 'wx', mode: 0o600 });
  const strings = createWriteStream(sharedStrings, { flags: 'wx', mode: 0o600 });
  const xmlDone = finished(xml); void xmlDone.catch(() => undefined);
  const stringsDone = finished(strings); void stringsDone.catch(() => undefined);
  let xmlBytes = 0;
  const write = async (value: string) => {
    xmlBytes += Buffer.byteLength(value);
    if (xmlBytes > context.limits.maxBytes) throw new ExportError('The Excel worksheet exceeds the file-size limit. Choose CSV or JSON, or select fewer rows or fields.');
    await writeXml(xml, value, context.signal);
  };
  const writeString = async (value: string) => {
    xmlBytes += Buffer.byteLength(value);
    if (xmlBytes > context.limits.maxBytes) throw new ExportError('The Excel worksheet exceeds the file-size limit. Choose CSV or JSON, or select fewer rows or fields.');
    await writeXml(strings, value, context.signal);
  };
  let stringCount = 0;
  const rowXml = async (values: unknown[], rowNumber: number): Promise<string> => {
    const cells: string[] = [];
    for (const [index, value] of values.entries()) {
      const reference = `${columnName(index)}${rowNumber}`;
      const scalar = scalarCellXml(value, reference);
      if (scalar !== null) { cells.push(scalar); continue; }
      const sharedIndex = stringCount++;
      await writeString(`<si><t xml:space="preserve">${sanitizeXml(cellText(value))}</t></si>`);
      cells.push(`<c r="${reference}" t="s"><v>${sharedIndex}</v></c>`);
    }
    return `<row r="${rowNumber}">${cells.join('')}</row>`;
  };
  try {
    await write('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');
    await writeString('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    await write(await rowXml(columns, 1));
    const input = createReadStream(spool);
    const lines = createInterface({ input, crlfDelay: Infinity });
    let rowNumber = 2;
    try {
      for await (const line of lines) {
        context.signal.throwIfAborted();
        const row = JSON.parse(line) as Record<string, unknown>;
        await write(await rowXml(columns.map(column => row[column]), rowNumber));
        rowNumber++;
      }
    } finally { lines.close(); input.destroy(); }
    await write('</sheetData></worksheet>');
    await writeString('</sst>');
    xml.end(); await xmlDone;
    strings.end(); await stringsDone;

    const archive = new ZipArchive({ zlib: { level: 6 } });
    const output = createWriteStream(context.filename, { flags: 'wx', mode: 0o600 });
    let zipBytes = 0;
    const limiter = new Transform({ transform(chunk, _encoding, callback) {
      zipBytes += chunk.length;
      callback(zipBytes > context.limits.maxBytes ? new ExportError('The Excel file exceeds the download size limit. Choose fewer rows or fields.') : undefined, chunk);
    } });
    archive.on('warning', error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') archive.emit('error', error); });
    const piping = pipeline(archive, limiter, output, { signal: context.signal });
    archive.append(CONTENT_TYPES, { name: '[Content_Types].xml' });
    archive.append(ROOT_RELS, { name: '_rels/.rels' });
    archive.append(WORKBOOK, { name: 'xl/workbook.xml' });
    archive.append(WORKBOOK_RELS, { name: 'xl/_rels/workbook.xml.rels' });
    archive.file(worksheet, { name: 'xl/worksheets/sheet1.xml' });
    archive.file(sharedStrings, { name: 'xl/sharedStrings.xml' });
    const finalizing = archive.finalize();
    try { await Promise.all([finalizing, piping]); }
    catch (error) {
      archive.abort(); output.destroy();
      await Promise.allSettled([finalizing, piping]);
      throw error;
    }
  } catch (error) { xml.destroy(); strings.destroy(); await Promise.allSettled([xmlDone, stringsDone]); throw error; }
  finally { await Promise.all([fs.rm(worksheet, { force: true }).catch(() => undefined), fs.rm(sharedStrings, { force: true }).catch(() => undefined)]); }
}
