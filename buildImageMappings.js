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
// If VALUE ends with '/<imageSource>' (default '/d:ImageFileLocationIdentifier'),
// that trailing segment is removed from the UAD_Xpath and placed into the ACI_ImageSource
// element for that mapping. This version also strips the suffix if it has a different namespace
// prefix or if it carries predicates (e.g. /x:ImageFileLocationIdentifier[text()='...']).

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('Usage: node buildImageMappings.js <input.txt> <output.xml> [--imageSource X] [--wrapPrefix tag]');
  process.exit(1);
}

const inputPath = argv[0];
const outputPath = argv[1];

// defaults
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

// prepare regexes for detection:
// 1) exact imageSource match (with optional predicate), e.g. /d:ImageFileLocationIdentifier or /d:ImageFileLocationIdentifier[...]
// 2) local-name match with any prefix, e.g. /prefix:ImageFileLocationIdentifier[...]
// both allow optional trailing slash/spaces
const localName = imageSource.includes(':') ? imageSource.split(':').pop() : imageSource;
const exactRe = new RegExp(`/${reEscape(imageSource)}(?:\\s*\\[.*\\])?\\s*\\/?$`);
const anyPrefixRe = new RegExp(`/(?:[A-Za-z0-9_\\-]+:)?${reEscape(localName)}(?:\\s*\\[.*\\])?\\s*\\/?$`);

for (const m of mappings) {
  // For each mapping, check if value ends with '/<imageSource>' (exact or any-prefix local-name)
  const rawValue = (m.value || '').trim();
  let usedImageSource = imageSource; // default
  let uadXpath = rawValue;

  // Try exact match first, then any-prefix match
  if (exactRe.test(rawValue) || anyPrefixRe.test(rawValue)) {
    // remove the trailing segment that matches the regex
    // We remove the last '/' + node (with optional predicate) by replacing the matched part with ''
    // Find last slash before the matched node
    const matchExact = rawValue.match(exactRe);
    const matchAny = rawValue.match(anyPrefixRe);
    const match = matchExact || matchAny;
    if (match) {
      // chop off matched suffix
      uadXpath = rawValue.slice(0, match.index);
      // if uadXpath ends with a slash, remove it
      if (uadXpath.endsWith('/')) uadXpath = uadXpath.slice(0, -1);
      usedImageSource = imageSource; // keep configured imageSource as the ACI_ImageSource value
    }
  }

  const k = escapeXml(m.key);
  const v = escapeXml(uadXpath);

  out += indent(1) + '<common>\n';
  // ACI_TagRedirector: use wrapPrefix(KEY) or just KEY if wrapPrefix empty
  const redirector = wrapPrefix ? `${wrapPrefix}(${m.key})` : `${m.key}`;
  out += indent(2) + `<ACI_TagRedirector>${escapeXml(redirector)}</ACI_TagRedirector>\n`;
  out += indent(2) + `<ACI_Tag>${k}</ACI_Tag>\n`;
  out += indent(2) + `<ACI_Image>true</ACI_Image>\n`;
  out += indent(2) + `<ACI_ImageSource>${escapeXml(usedImageSource)}</ACI_ImageSource>\n`;
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
