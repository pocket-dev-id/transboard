const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const uiSource = fs.readFileSync(path.join(root, 'frontend/js/ui.js'), 'utf8');
const historySource = fs.readFileSync(path.join(root, 'frontend/js/history.js'), 'utf8');
const mastersSource = fs.readFileSync(path.join(root, 'frontend/js/settings/masters.js'), 'utf8');
const csvServiceSource = fs.readFileSync(path.join(root, 'frontend/js/csv-service.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const helpers = vm.runInNewContext(
  `${uiSource}\n({ sanitizeCsvValue, restoreSanitizedCsvValue });`,
  {},
  { filename: 'js/ui.js' }
);

const dangerousValues = [
  '=1+1',
  '+SUM(A1:A2)',
  '-cmd|calc',
  '@SUM(A1:A2)',
  '  =HYPERLINK("https://example.invalid")',
  '\t=1+1',
  '\r=1+1',
  '\n=1+1',
];

for (const value of dangerousValues) {
  const sanitized = helpers.sanitizeCsvValue(value);
  assert(sanitized.startsWith("'"), `Dangerous CSV value was not prefixed: ${JSON.stringify(value)}`);
  assert(
    helpers.restoreSanitizedCsvValue(sanitized) === value,
    `Dangerous CSV value did not survive export/import round-trip: ${JSON.stringify(value)}`
  );
}

for (const value of [-5, 12.5, '-5', '+5', '.5', '1e3', ' -5 ']) {
  assert(
    helpers.sanitizeCsvValue(value) === String(value),
    `Numeric CSV value must remain numeric: ${JSON.stringify(value)}`
  );
}

for (const value of ['患者A', '0012', '', null, undefined]) {
  assert(
    helpers.sanitizeCsvValue(value) === String(value ?? ''),
    `Ordinary CSV value changed unexpectedly: ${JSON.stringify(value)}`
  );
}

const originalQuotedFormula = "'=1+1";
assert(
  helpers.restoreSanitizedCsvValue(helpers.sanitizeCsvValue(originalQuotedFormula)) === originalQuotedFormula,
  'An intentional leading apostrophe must survive export/import round-trip'
);

assert(
  (historySource.match(/UI\.sanitizeCsvValue\(val\)/g) || []).length === 2,
  'Both history CSV exporters must sanitize every field'
);
assert(
  ((mastersSource.includes('const str = UI.sanitizeCsvValue(val);') &&
    mastersSource.includes('val = UI.restoreSanitizedCsvValue(val);')) ||
   (mastersSource.includes('CSVService.generate(headers, rows)') &&
    csvServiceSource.includes('UI.sanitizeCsvValue') &&
    mastersSource.includes('val = UI.restoreSanitizedCsvValue(val);'))),
  'Master CSV export/import must apply and restore formula-injection protection'
);

console.log('CSV security checks passed.');
