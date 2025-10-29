// generateXPaths.js
// Usage:
//   node generateXPaths.js input.xml output.txt [--ns d] [--include PROPERTY,IMAGE] [--attr ValuationType]
//
// Default: namespace 'd', include PROPERTY and IMAGE, attribute-name 'ValuationType'

const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('Usage: node generateXPaths.js <input.xml> <output.txt> [--ns d] [--include A,B] [--attr ValuationType]');
  process.exit(1);
}

const inputPath = argv[0];
const outputPath = argv[1];

let nsShort = 'd'; // namespace short name (prefix used as 'd:')
let includeElements = ['PROPERTY', 'IMAGE']; // default includes (case-insensitive)
let attrName = 'ValuationType'; // attribute to prefer for indexing (also accepts 'ValutationType' if present)

for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--ns' && argv[i+1]) { nsShort = argv[++i]; }
  else if (a === '--include' && argv[i+1]) { includeElements = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean); }
  else if (a === '--attr' && argv[i+1]) { attrName = argv[++i]; }
}

// helper to format literal safely for XPath (handles both single and double quotes)
function formatXPathLiteral(value) {
  if (value.indexOf("'") === -1) return `'${value}'`;
  if (value.indexOf('"') === -1) return `"${value}"`;
  // contains both -> produce concat('a', '"', 'b', "'", 'c', ...)
  const parts = value.split("'");
  const concatParts = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length > 0) concatParts.push(`'${parts[i]}'`);
    if (i < parts.length - 1) concatParts.push(`"'"`);
  }
  return `concat(${concatParts.join(',')})`;
}

// load xml
const xmlText = fs.readFileSync(inputPath, 'utf8');
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  textNodeName: '#text'
});
const obj = parser.parse(xmlText);

// helper: determine if node object is a leaf (no element children) and extract its text
function isLeafNode(value) {
  // strings or numbers considered leaf text nodes
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { leaf: true, text: String(value).trim() };
  }
  if (value == null || typeof value !== 'object') return { leaf: true, text: String(value ?? '').trim() };

  // object - check for child element keys (keys not starting with '@_' and not '#text')
  const childKeys = Object.keys(value).filter(k => !k.startsWith('@_') && k !== '#text');
  if (childKeys.length === 0) {
    // get text either in '#text' or as empty
    const t = (typeof value['#text'] === 'string') ? value['#text'].trim() : '';
    return { leaf: true, text: t };
  }
  return { leaf: false, text: null };
}

// build xpaths by traversing object tree. We'll maintain ancestor stack where each entry:
// { tag: 'TAGNAME', nodeObj: <object>, elementsArray: <array-of-siblings-if-parent-collapsed> }
const results = [];

// helper to get bare tag (no namespace prefix)
function bareTag(tag) {
  if (!tag) return tag;
  const idx = tag.indexOf(':');
  return idx === -1 ? tag : tag.substring(idx + 1);
}

// when building path step, prefer attribute-based predicate if attribute exists on the node
function buildStep(tag, nodeObj, siblingsArray, positionIndex) {
  // tag: element name as seen in parsed object (may include prefix)
  const b = bareTag(tag);
  const prefixed = `${nsShort}:${b}`;

  // check for attribute (fast-xml-parser attributes are stored as '@_attrName')
  // accept both exact attrName and possible typo 'ValutationType'
  const attrKeysToCheck = [attrName, (attrName === 'ValuationType' ? 'ValutationType' : null)].filter(Boolean);
  let attrPredicate = null;
  for (const ak of attrKeysToCheck) {
    const attrKey = '@_' + ak;
    if (nodeObj && Object.prototype.hasOwnProperty.call(nodeObj, attrKey)) {
      const raw = nodeObj[attrKey];
      if (raw != null && String(raw).trim().length > 0) {
        attrPredicate = `[@${ak}=${formatXPathLiteral(String(raw))}]`;
        break;
      }
    }
  }

  // determine numeric index only if siblingsArray length > 1 and attribute predicate not used
  let numeric = '';
  if (!attrPredicate && Array.isArray(siblingsArray) && siblingsArray.length > 1) {
    numeric = `[${positionIndex + 1}]`;
  }

  return `${prefixed}${attrPredicate || ''}${numeric}`;
}

// traverse function: takes an object (node) and the current path components (ancestors array of {tag,node,siblings,pos})
function traverseNode(objNode, ancestors) {
  if (objNode == null || typeof objNode !== 'object') return;

  const elementNames = Object.keys(objNode).filter(k => !k.startsWith('@_') && k !== '#text');

  for (const tag of elementNames) {
    const val = objNode[tag];
    const elements = Array.isArray(val) ? val : [val];

    elements.forEach((el, idx) => {
      // create ancestor entry for this element
      const thisAncestor = { tag, node: el, siblings: elements, pos: idx };
      const newAncestors = ancestors.concat(thisAncestor);

      // determine if this element is a leaf
      const leafInfo = isLeafNode(el);
      if (leafInfo.leaf && leafInfo.text.length > 0) {
        // only include results if any ancestor's bare tag matches includeElements
        const anyIncludedAncestor = newAncestors.some(a => includeElements.includes(bareTag(a.tag).toUpperCase()));
        if (anyIncludedAncestor) {
          // build path from root of document to this leaf using '//' prefix (relative xpath)
          // join steps with '/'
          const steps = newAncestors.map((a, i) => {
            const parent = i > 0 ? newAncestors[i-1] : null;
            // the siblings array for computing index is a.siblings
            return buildStep(a.tag, a.node, a.siblings, a.pos);
          });
          const xpath = '//' + steps.join('/');

          results.push(`${leafInfo.text} : ${xpath}`);
        }
        // leaf handled, do not traverse deeper
      } else {
        // not leaf -> traverse children
        traverseNode(el, newAncestors);
      }
    });
  }
}

// start traversal from root object. fast-xml-parser yields root object with single root tag
traverseNode(obj, []);

// write output
fs.writeFileSync(outputPath, results.join('\n'), 'utf8');
console.log(`✅ Generated ${results.length} XPath entries -> ${outputPath}`);
