// syncImageCategory.js
// Usage: node syncImageCategory.js <xml1> <xml2> <output.xml>
// Example: node syncImageCategory.js imagesA.xml imagesB.xml imagesB.updated.xml

const fs = require('fs');
const path = require('path');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');

if (process.argv.length < 5) {
  console.error('Usage: node syncImageCategory.js <xml1> <xml2> <output.xml>');
  process.exit(1);
}

const [,, xml1Path, xml2Path, outPath] = process.argv;

function readFileOrExit(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    console.error(`Failed to read ${p}:`, err.message);
    process.exit(2);
  }
}

const xml1Text = readFileOrExit(xml1Path);
const xml2Text = readFileOrExit(xml2Path);

const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text', // for consistent handling when attributes exist
  parseTagValue: false,  // keep text as string
  parseAttributeValue: false,
};
const parser = new XMLParser(parserOptions);
const builder = new XMLBuilder({ ...parserOptions, format: true });

const obj1 = parser.parse(xml1Text);
const obj2 = parser.parse(xml2Text);

// helpers

// Recursively find all nodes that are <Image> (case-insensitive).
// Returns array of references to the image node objects.
function findImageNodes(root) {
  const found = [];
  function recurse(node) {
    if (!node || typeof node !== 'object') return;
    // node is an object with keys -> tags
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (!val) continue;

      if (typeof key === 'string' && key === 'IMAGE') {
        // val might be an array or single object
        if (Array.isArray(val)) {
          for (const item of val) if (item && typeof item === 'object') found.push(item);
        } else if (typeof val === 'object') {
          found.push(val);
        } else {
          // Leaf text node treated as object with text
          found.push({ '#text': val });
        }
      } else {
        // Recurse into val (it may be an object or array)
        if (Array.isArray(val)) {
          for (const item of val) recurse(item);
        } else if (typeof val === 'object') {
          recurse(val);
        }
      }
    }
  }
  recurse(root);
  return found;
}

// Read child's text safely (handles plain string or object with #text)
function getChildText(node, childName) {
  if (!node || typeof node !== 'object') return null;
  // case-insensitive search for child key
  const key = Object.keys(node).find(k => k.toLowerCase() === childName.toLowerCase());
  if (!key) return null;
  const val = node[key];
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && '#text' in val) return String(val['#text']);
  // if value is an object with further children, skip
  return null;
}

// Set child's text (overwrites or creates). We will set as simple string.
function setChildText(node, childName, text) {
  if (!node || typeof node !== 'object') return;
  // try to find existing child key case-insensitively
  const existingKey = Object.keys(node).find(k => k.toLowerCase() === childName.toLowerCase());
  if (existingKey) {
    node[existingKey] = text;
  } else {
    // create new child with the exact name requested
    node[childName] = text;
  }
}

// Build map MIME -> ImageCategoryType from xml1 (first occurrence wins)
const images1 = findImageNodes(obj1);
const mimeToCategory = new Map();
for (const img of images1) {
  const mime = getChildText(img, 'MIMETypeIdentifier');
  if (!mime) continue;
  if (!mimeToCategory.has(mime)) {
    const cat = getChildText(img, 'ImageCategoryType') || null;
    mimeToCategory.set(mime, cat);
  }
}

// Now update xml2 images
const images2 = findImageNodes(obj2);
let updates = 0;
for (const img of images2) {
  const mime = getChildText(img, 'MIMETypeIdentifier');
  if (!mime) continue;
  if (mimeToCategory.has(mime)) {
    const newCat = mimeToCategory.get(mime);
    // only change if newCat is non-null and different (or always change if you prefer)
    if (newCat !== null) {
      const oldCat = getChildText(img, 'ImageCategoryType');
      if (oldCat !== newCat) {
        setChildText(img, 'ImageCategoryType', newCat);
        updates++;
      }
    }
  }
}

// Serialize back to XML
const updatedXml2 = builder.build(obj2);

// write output
try {
  fs.writeFileSync(outPath, updatedXml2, 'utf8');
  console.log(`Done. ${updates} image(s) updated. Output written to ${outPath}`);
} catch (err) {
  console.error('Failed to write output file:', err.message);
  process.exit(3);
}
