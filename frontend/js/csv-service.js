/* Shared CSV parsing, escaping, and field coercion for master imports/exports. */
const CSVService = Object.freeze({
  parse(text) {
    const lines = [];
    let row = [''];
    let inQuotes = false;
    const source = String(text ?? '');
    for (let i = 0; i < source.length; i += 1) {
      const current = source[i];
      const next = source[i + 1];
      if (current === '"') {
        if (inQuotes && next === '"') { row[row.length - 1] += '"'; i += 1; }
        else inQuotes = !inQuotes;
      } else if (current === ',' && !inQuotes) row.push('');
      else if ((current === '\r' || current === '\n') && !inQuotes) {
        if (current === '\r' && next === '\n') i += 1;
        lines.push(row); row = [''];
      } else row[row.length - 1] += current;
    }
    if (row.length > 1 || row[0] !== '') lines.push(row);
    return lines;
  },

  sanitize(value) {
    if (typeof UI !== 'undefined' && UI.sanitizeCsvValue) return UI.sanitizeCsvValue(value);
    const text = String(value ?? '');
    return /^[=+\-@]/.test(text) ? `'${text}` : text;
  },

  generate(headers, rows) {
    const escapeField = value => {
      if (value === null || value === undefined) return '';
      const text = this.sanitize(value);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [
      headers.map(escapeField).join(','),
      ...(rows || []).map(row => headers.map(header => escapeField(row?.[header])).join(',')),
    ].join('\r\n');
  },

  coerce(value, type) {
    const text = String(value ?? '').trim();
    if (type === 'integer') {
      if (text === '') return null;
      if (!/^-?\d+$/.test(text)) throw new Error('整数で指定してください');
      return Number.parseInt(text, 10);
    }
    if (type === 'boolean') return text === 'true' || text === '1';
    if (type === 'nullable') return text === 'null' || text === '' ? null : text;
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null') return null;
    return text;
  },
});
