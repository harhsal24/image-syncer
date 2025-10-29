// generateXPaths.js
// Usage:
//   node generateXPaths.js input.xml output.txt [--ns d] [--include PROPERTY,IMAGE]
//        [--attr ValuationUseType] [--filterParent IMAGE --filterChild ImageCategoryType]
//        [--defaults path/to/json] [--debug]
//
// Notes:
//  - Global element-instance indexing: identical element signatures (ns:TAG + predicate) are numbered
//    in document order and the index [n] is appended when n > 1.
//  - Default attribute for attribute-based indexing is ValuationUseType (single attribute).
//  - Default filter: IMAGE[@ImageCategoryType='...'] (applies when ImageCategoryType child exists).

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error(`Usage:
  node generateXPaths.js <input.xml> <output.txt>
    [--ns d]
    [--include PROPERTY,IMAGE]
    [--attr ValuationUseType]
    [--filterParent IMAGE --filterChild ImageCategoryType]
    [--defaults <defaults.json>]
    [--debug]`);
  process.exit(1);
}

const inputPath = argv[0];
const outputPath = argv[1];

// built-in defaults
const builtInDefaults = {
  nsShort: 'd',
  includeElements: ['PROPERTY', 'IMAGE'],
  attrName: 'ValuationUseType',
  filterParent: 'IMAGE',
  filterChild: 'ImageCategoryType'
};

// parse CLI
let defaultsFileFromCLI = null;
let cliOptions = {};
let debug = false;
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--ns' && argv[i+1]) { cliOptions.nsShort = argv[++i]; }
  else if (a === '--include' && argv[i+1]) { cliOptions.includeElements = argv[++i]; }
  else if (a === '--attr' && argv[i+1]) { cliOptions.attrName = argv[++i]; }
  else if (a === '--filterParent' && argv[i+1]) { cliOptions.filterParent = argv[++i]; }
  else if (a === '--filterChild' && argv[i+1]) { cliOptions.filterChild = argv[++i]; }
  else if (a === '--defaults' && argv[i+1]) { defaultsFileFromCLI = argv[++i]; }
  else if (a === '--debug') { debug = true; }
}

function tryLoadDefaults(filePath) {
  try {
    if (!filePath) return null;
    if (!fs.existsSync(filePath)) return null;
    const txt = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    console.warn(`Warning: failed to load defaults JSON at ${filePath}: ${err.message}`);
    return null;
  }
}

const defaultsJsonPath = defaultsFileFromCLI || path.join(process.cwd(), 'generateXPaths.defaults.json');
const fileDefaults = tryLoadDefaults(defaultsJsonPath) || {};

const cfg = {
  ...builtInDefaults,
  ...fileDefaults,
  ...cliOptions
};

// normalize
if (typeof cfg.includeElements === 'string') {
  cfg.includeElements = cfg.includeElements.split(',').map(s => s.trim()).filter(Boolean);
}
cfg.includeElements = (Array.isArray(cfg.includeElements) ? cfg.includeElements : []).map(s => String(s).toUpperCase());
cfg.nsShort = String(cfg.nsShort || builtInDefaults.nsShort);
cfg.attrName = String(cfg.attrName || builtInDefaults.attrName);
cfg.filterParent = cfg.filterParent ? String(cfg.filterParent).toUpperCase() : null;
cfg.filterChild = cfg.filterChild ? String(cfg.filterChild) : null;

if (debug) console.log('Using configuration:', JSON.stringify(cfg, null, 2));

// helpers
function formatXPathLiteral(value) {
  value = String(value);
  if (value.indexOf("'") === -1) return `'${value}'`;
  if (value.indexOf('"') === -1) return `"${value}"`;
  const parts = value.split("'");
  const concatParts = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length > 0) concatParts.push(`'${parts[i]}'`);
    if (i < parts.length - 1) concatParts.push(`"'"`);
  }
  return `concat(${concatParts.join(',')})`;
}

let xmlText;
try {
  xmlText = fs.readFileSync(inputPath, 'utf8');
} catch (err) {
  console.error(`Failed to read input XML: ${err.message}`);
  process.exit(2);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  textNodeName: '#text'
});

let obj;
try {
  obj = parser.parse(xmlText);
} catch (err) {
  console.error(`Failed to parse XML: ${err.message}`);
  process.exit(3);
}

function bareTag(tag) {
  if (!tag) return tag;
  const idx = tag.indexOf(':');
  return idx === -1 ? tag : tag.substring(idx + 1);
}

// improved leaf detection
function isLeafNode(value) {
  if (value == null) return { leaf: true, text: '' };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { leaf: true, text: String(value).trim() };
  }
  if (typeof value !== 'object') return { leaf: true, text: String(value).trim() };

  const childKeys = Object.keys(value).filter(k => !k.startsWith('@_') && k !== '#text');
  if (childKeys.length === 0) {
    const textVal = (typeof value['#text'] === 'string' && value['#text'].trim().length > 0) ? value['#text'].trim() : '';
    return { leaf: true, text: textVal };
  }
  return { leaf: false, text: null };
}

function getChildText(node, childTag) {
  if (!node || typeof node !== 'object') return null;
  const key = Object.keys(node).find(k => bareTag(k).toUpperCase() === childTag.toUpperCase());
  if (!key) return null;
  const v = node[key];
  if (v == null) return null;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && typeof v['#text'] === 'string') return v['#text'].trim();
  return null;
}

// global signature counts (signature => count)
const signatureCounts = new Map();

// build predicate string for an element (without numeric index)
function predicateStringForElement(tag, nodeObj) {
  const b = bareTag(tag);
  // filterParent (e.g., IMAGE[@ImageCategoryType='...'])
  if (cfg.filterParent && cfg.filterChild && b.toUpperCase() === cfg.filterParent) {
    const childVal = getChildText(nodeObj, cfg.filterChild);
    if (childVal != null && childVal !== '') {
      return `[@${cfg.filterChild}=${formatXPathLiteral(childVal)}]`;
    }
  }
  // attribute-based predicate using single cfg.attrName
  if (cfg.attrName) {
    const attrKey = '@_' + cfg.attrName;
    if (nodeObj && Object.prototype.hasOwnProperty.call(nodeObj, attrKey)) {
      const raw = nodeObj[attrKey];
      if (raw != null && String(raw).trim().length > 0) {
        return `[@${cfg.attrName}=${formatXPathLiteral(String(raw))}]`;
      }
    }
  }
  return '';
}

// build step string, accept assignedGlobalIndex (number) to optionally append [n] when >1
function buildStep(tag, nodeObj, assignedGlobalIndex) {
  const b = bareTag(tag);
  const prefixed = `${cfg.nsShort}:${b}`;
  const pred = predicateStringForElement(tag, nodeObj);
  const base = `${prefixed}${pred}`;
  if (assignedGlobalIndex && assignedGlobalIndex > 1) {
    return `${base}[${assignedGlobalIndex}]`;
  }
  return base;
}

// traversal: when we visit element instance, compute its signature and increment global count once.
// attach assigned index to the ancestor object so it's available when building paths for leaves.
const results = [];
let totalLeaves = 0;
let leavesWithIncludedAncestors = 0;

function traverseNode(objNode, ancestors) {
  if (!objNode || typeof objNode !== 'object') return;

  const elementNames = Object.keys(objNode).filter(k => !k.startsWith('@_') && k !== '#text');
  for (const tag of elementNames) {
    const val = objNode[tag];
    const elements = Array.isArray(val) ? val : [val];

    elements.forEach((el, idx) => {
      // compute predicate string for this element and signature key
      const predStr = predicateStringForElement(tag, el); // may be ''
      const signatureKey = `${cfg.nsShort}:${bareTag(tag)}${predStr}`;

      // increment global signature count for the element instance
      const prev = signatureCounts.get(signatureKey) || 0;
      const newCount = prev + 1;
      signatureCounts.set(signatureKey, newCount);

      // create ancestor entry (store assignedGlobalIndex)
      const thisAncestor = { tag, node: el, siblings: elements, pos: idx, assignedIndex: newCount };
      const newAncestors = ancestors.concat(thisAncestor);

      const leafInfo = isLeafNode(el);
      if (leafInfo.leaf) totalLeaves++;

      // find included ancestors among the full chain
      const includedAncestors = newAncestors
        .map((a, indexInNew) => ({ ...a, idxInNew: indexInNew }))
        .filter(a => cfg.includeElements.includes(bareTag(a.tag).toUpperCase()));

      if (leafInfo.leaf && leafInfo.text.length > 0 && includedAncestors.length > 0) {
        leavesWithIncludedAncestors++;

        // Build path using only includedAncestors (in document order).
        const parts = [];
        for (let i = 0; i < includedAncestors.length; i++) {
          const anc = includedAncestors[i];
          const stepStr = buildStep(anc.tag, anc.node, anc.assignedIndex);
          if (i === 0) parts.push(stepStr);
          else {
            const prevAnc = includedAncestors[i - 1];
            if (anc.idxInNew === prevAnc.idxInNew + 1) parts.push('/' + stepStr);
            else parts.push('//' + stepStr);
          }
        }

        // append leaf element if it's not same as last included element
        const lastIncluded = includedAncestors[includedAncestors.length - 1];
        const leafIsSameAsLastIncluded = (bareTag(lastIncluded.tag).toUpperCase() === bareTag(thisAncestor.tag).toUpperCase());
        if (!leafIsSameAsLastIncluded) {
          // leaf step likely has its own assignedIndex already (we set it earlier)
          const leafStep = buildStep(thisAncestor.tag, thisAncestor.node, thisAncestor.assignedIndex);
          parts.push('//' + leafStep);
        }

        const xpath = '//' + parts.join('');
        results.push(`${leafInfo.text} : ${xpath}`);
      }

      if (!leafInfo.leaf) traverseNode(el, newAncestors);
    });
  }
}

// run
traverseNode(obj, []);

// write output
try {
  fs.writeFileSync(outputPath, results.join('\n'), 'utf8');
  console.log(`✅ Generated ${results.length} XPath entries → ${outputPath}`);
} catch (err) {
  console.error(`Failed to write output: ${err.message}`);
  process.exit(4);
}

// diagnostics
if (results.length === 0) {
  console.warn('⚠️  No XPath entries were produced.');
  console.warn(` - total leaf nodes found: ${totalLeaves}`);
  console.warn(` - leaf nodes that have at least one ancestor in includeElements (${cfg.includeElements.join(', ')}): ${leavesWithIncludedAncestors}`);
  console.warn('Possible reasons:');
  console.warn('  • includeElements may not match your XML element names (check namespaces/prefixes).');
  console.warn('  • leaf nodes may contain no text (empty or whitespace-only).');
  console.warn(`  • attribute-based indexing uses only single attribute: '${cfg.attrName}'. Use --attr to change.`);
  if (!debug) console.warn('Run again with --debug to print config and help troubleshoot.');
} else if (debug) {
  console.log(`Debug: totalLeaves=${totalLeaves}, leavesWithIncludedAncestors=${leavesWithIncludedAncestors}`);
}
