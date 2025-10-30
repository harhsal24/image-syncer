#!/usr/bin/env node
// buildImageMappings.js
// Usage:
//   node buildImageMappings.js mappings.txt output.xml [--imageSource d:ImageFileLocationIdentifier] [--wrapPrefix tag]
//
// Input format (mappings.txt):
//   KEY : VALUE
//   (blank lines ignored)
//   Lines starting with # or // are comments
//
// Example line:
//   IMG_001 : //d:PROPERTY//d:IMAGE/d:MIMETypeIdentifier[text()='image/png']
//
// Output: XML file with <ImageMappings><common>... per mapping.

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('Usage: node buildImageMappings.js <input.txt> <output.xml> [--imageSource X] [--wrapPrefix tag]');
  process.exit(1);
}

const inputPath = argv[0];
const outputPath = argv[1];

let imageSource = 'd:ImageFileLocationIdentifier';
let wrapPrefix = 'tag';

for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if ((a === '--imageSource' || a === '-s') && argv[i+1]) {
    imageSource = argv[++i];
  } else if ((a === '--wrapPrefix' || a === '-w') && argv[i+1]) {
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
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
  if (!raw) continue;               // skip empty
  if (raw.startsWith('#') || raw.startsWith('//')) continue; // skip comments
  const idx = raw.indexOf(':');
  if (idx === -1) {
    console.warn(`Skipping line (no colon found): ${raw}`);
    continue;
  }
  const key = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  if (!key) {
    console.warn(`Skipping line (empty key): ${raw}`);
    continue;
  }
  mappings.push({ key, value });
}

if (mappings.length === 0) {
  console.warn('No mappings found in input file.');
  // still produce empty root
}

const indent = (n) => '  '.repeat(n);

let out = '<?xml version="1.0" encoding="utf-8"?>\n';
out += '<ImageMappings>\n';

for (const m of mappings) {
  const k = escapeXml(m.key);
  const v = escapeXml(m.value);

  // Example structure per your sample:
  // <common>
  //   <ACI_TagRedirector>tag(key)</ACI_TagRedirector>
  //   <ACI_Tag>key</ACI_Tag>
  //   <ACI_Image>true</ACI_Image>
  //   <ACI_ImageSource>d:ImageFileLocationIdentifier</ACI_ImageSource>
  //   <UAD_Xpath>xpath(value)</UAD_Xpath>
  // </common>

  out += indent(1) + '<common>\n';
  // ACI_TagRedirector: wrapPrefix(key)
  out += indent(2) + `<ACI_TagRedirector>${escapeXml(`${wrapPrefix}(${m.key})`)}</ACI_TagRedirector>\n`;
  // ACI_Tag: raw key (user requested examples sometimes show tag(key) here too; using raw key is more common)
  out += indent(2) + `<ACI_Tag>${k}</ACI_Tag>\n`;
  out += indent(2) + `<ACI_Image>true</ACI_Image>\n`;
  out += indent(2) + `<ACI_ImageSource>${escapeXml(imageSource)}</ACI_ImageSource>\n`;
  // UAD_Xpath: put the raw value (do not wrap with 'xpath(...)' by default)
  out += indent(2) + `<UAD_Xpath>${v}</UAD_Xpath>\n`;
  out += indent(1) + '</common>\n';
}

out += '</ImageMappings>\n';

try {
  fs.writeFileSync(outputPath, out, 'utf8');
  console.log(`✅ Wrote ${mappings.length} mappings to ${outputPath}`);
} catch (err) {
  console.error(`Failed to write output file ${outputPath}: ${err.message}`);
  process.exit(3);
}
