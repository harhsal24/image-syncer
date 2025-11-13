#!/usr/bin/env node
// buildImageMappings.js
// Usage:
//   node buildImageMappings.js mappings.txt output.xml [--imageSource d:ImageFileLocationIdentifier]

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('Usage: node buildImageMappings.js <input.txt> <output.xml> [--imageSource X]');
  process.exit(1);
}

const inputPath = argv[0];
const outputPath = argv[1];

let imageSource = 'd:ImageFileLocationIdentifier';
let wrapPrefix = null;

for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if ((a === '--imageSource' || a === '-s') && argv[i + 1]) {
    imageSource = argv[++i];
  } else if ((a === '--wrapPrefix' || a === '-w') && argv[i + 1]) {
    wrapPrefix = argv[++i];
  } else {
    console.warn(`Unknown argument ${a} (ignored)`);
  }
}

function escapeXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;'); // keep single quotes as-is
}

// escape regex special chars
function reEscape(s) {
  return String(s).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

let text;
try {
  text = fs.readFileSync(inputPath, 'utf8');
} catch (err) {
  console.error(`Failed to read input file ${inputPath}: ${err.message}`);
  process.exit(2);
}

const lines = text.split(/\r?\n/);
const mappings = [];

// parse lines: split at first colon
for (let raw of lines) {
  raw = raw.trim();
  if (!raw) continue;
  if (raw.startsWith('#') || raw.startsWith('//')) continue;

  const idx = raw.indexOf(':');
  if (idx === -1) {
    console.warn(`Skipping line (no colon found): ${raw}`);
    continue;
  }

  const key = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();

  // ✅ include only keys starting with URAR or USER
  if (!/^URAR|^USER/i.test(key)) continue;

  mappings.push({ key, value });
}

if (mappings.length === 0) {
  console.warn('No mappings found with keys starting with URAR or USER.');
}

const indent = (n) => '  '.repeat(n);

let out = '<?xml version="1.0" encoding="utf-8"?>\n';
out += '<ImageMappings>\n';

// regexes for imageSource detection
const localName = imageSource.includes(':') ? imageSource.split(':').pop() : imageSource;
const exactRe = new RegExp(`/${reEscape(imageSource)}(?:\\s*\\[.*\\])?\\s*\\/?$`);
const anyPrefixRe = new RegExp(`/(?:[A-Za-z0-9_\\-]+:)?${reEscape(localName)}(?:\\s*\\[.*\\])?\\s*\\/?$`);

for (const m of mappings) {
  const rawValue = (m.value || '').trim();
  let usedImageSource = imageSource;
  let uadXpath = rawValue;

  // detect trailing imageSource segment
  if (exactRe.test(rawValue) || anyPrefixRe.test(rawValue)) {
    const match = rawValue.match(exactRe) || rawValue.match(anyPrefixRe);
    if (match) {
      uadXpath = rawValue.slice(0, match.index);
      if (uadXpath.endsWith('/')) uadXpath = uadXpath.slice(0, -1);
      usedImageSource = imageSource;
    }
  }

  const k = escapeXml(m.key);
  const v = escapeXml(uadXpath);

  // ✅ derive tagName = last segment after '\'
  const tagName = escapeXml(m.key.split('\\').pop());

  out += indent(1) + '<common>\n';
  out += indent(2) + `<ACI_TagPath>${k}</ACI_TagPath>\n`;
  out += indent(2) + `<ACI_TagName>${tagName}</ACI_TagName>\n`;
  out += indent(2) + `<ACI_Tag>${k}</ACI_Tag>\n`;
  out += indent(2) + `<ACI_TagIsCheckbox>false</ACI_TagIsCheckbox>\n`;
  out += indent(2) + `<UAD_Xpath>${v}</UAD_Xpath>\n`;
  out += indent(1) + '</common>\n';
}

out += '</ImageMappings>\n';

try {
  fs.writeFileSync(outputPath, out, 'utf8');
  console.log(`✅ Wrote ${mappings.length} mappings (URAR/USER only) to ${outputPath}`);
} catch (err) {
  console.error(`Failed to write output file ${outputPath}: ${err.message}`);
  process.exit(3);
}
