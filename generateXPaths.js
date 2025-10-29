// generateXPaths.js
// Usage:
//   node generateXPaths.js input.xml output.txt [--ns d] [--include PROPERTY,IMAGE]
//        [--attr ValuationUseType] [--filterParent IMAGE --filterChild ImageCategoryType]
//        [--defaults path/to/json] [--debug]
//
// Notes:
//  - By default the script will use IMAGE[@ImageCategoryType='<value>'] (filterParent IMAGE + filterChild ImageCategoryType).
//  - Only a single attribute is used for attribute-based indexing (default: ValuationUseType).
//  - CLI options override defaults JSON (generateXPaths.defaults.json) which overrides built-in defaults.

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

// --- built-in defaults (these are used if no defaults file and not overridden by CLI)
const builtInDefaults = {
  nsShort: 'd',
  includeElements: ['PROPERTY', 'IMAGE'],
  attrName: 'ValuationUseType',       // single attribute used for attribute-based indexing
  filterParent: 'IMAGE',              // DEFAULT: IMAGE (will add [@ImageCategoryType='...'] when possible)
  filterChild: 'ImageCategoryType'    // DEFAULT child used for filterParent predicate
};

// --- parse CLI args (partial)
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

// try load defaults JSON
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

// merge: builtInDefaults <- fileDefaults <- cliOptions
const cfg = {
  ...builtInDefaults,
  ...fileDefaults,
  ...cliOptions
};

// normalize types and casing (includeElements to uppercase, filterParent uppercase)
if (typeof cfg.includeElements === 'string') {
  cfg.includeElements = cfg.includeElements.split(',').map(s => s.trim()).filter(Boolean);
}
cfg.includeElements = (Array.isArray(cfg.includeElements) ? cfg.includeElements : []).map(s => String(s).toUpperCase());
cfg.nsShort = String(cfg.nsShort || builtInDefaults.nsShort);
cfg.attrName = String(cfg.attrName || builtInDefaults.attrName);
cfg.filterParent = cfg.filterParent ? String(cfg.filterParent).toUpperCase() : null;
cfg.filterChild = cfg.filterChild ? String(cfg.filterChild) : null;

if (debug) {
  console.log('Using configuration:', JSON.stringify(cfg, null, 2));
}

// --- helpers
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

function isLeafNode(value) {
  if (value == null) return { leaf: true, text: '' };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { leaf: true, text: String(value).trim() };
  }
  if (typeof value !== 'object') return { leaf: true, text: String(value).trim() };

  // object: if no child element keys (only attributes and/or #text) -> treat as leaf
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

function buildStep(tag, nodeObj, siblingsArray, positionIndex) {
  const b = bareTag(tag);
  const prefixed = `${cfg.nsShort}:${b}`;

  // If this tag matches filterParent (DEFAULT: IMAGE), and filterChild exists, add child-value predicate
  if (cfg.filterParent && cfg.filterChild && b.toUpperCase() === cfg.filterParent) {
    const childValue = getChildText(nodeObj, cfg.filterChild);
    if (childValue != null && childValue !== '') {
      return `${prefixed}[@${cfg.filterChild}=${formatXPathLiteral(childValue)}]`;
    }
  }

  // attribute predicate using only single attribute cfg.attrName
  let attrPredicate = null;
  if (cfg.attrName) {
    const attrKey = '@_' + cfg.attrName;
    if (nodeObj && Object.prototype.hasOwnProperty.call(nodeObj, attrKey)) {
      const raw = nodeObj[attrKey];
      if (raw != null && String(raw).trim().length > 0) {
        attrPredicate = `[@${cfg.attrName}=${formatXPathLiteral(String(raw))}]`;
      }
    }
  }

  // numeric index if siblings >1 and no attr predicate
  let numeric = '';
  if (!attrPredicate && Array.isArray(siblingsArray) && siblingsArray.length > 1) {
    numeric = `[${positionIndex + 1}]`;
  }

  return `${prefixed}${attrPredicate || ''}${numeric}`;
}

// --- traverse and collect
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
      const thisAncestor = { tag, node: el, siblings: elements, pos: idx };
      const newAncestors = ancestors.concat(thisAncestor);

      const leafInfo = isLeafNode(el);
      if (leafInfo.leaf) totalLeaves++;

      const includedAncestors = newAncestors
        .map((a, indexInNew) => ({ ...a, idxInNew: indexInNew }))
        .filter(a => cfg.includeElements.includes(bareTag(a.tag).toUpperCase()));

      if (leafInfo.leaf && leafInfo.text.length > 0 && includedAncestors.length > 0) {
        leavesWithIncludedAncestors++;

        const stepsParts = [];
        for (let i = 0; i < includedAncestors.length; i++) {
          const anc = includedAncestors[i];
          const step = buildStep(anc.tag, anc.node, anc.siblings, anc.pos);
          if (i === 0) stepsParts.push(step);
          else {
            const prev = includedAncestors[i - 1];
            if (anc.idxInNew === prev.idxInNew + 1) stepsParts.push('/' + step);
            else stepsParts.push('//' + step);
          }
        }

        const lastIncluded = includedAncestors[includedAncestors.length - 1];
        const leafIsSameAsLastIncluded = (bareTag(lastIncluded.tag).toUpperCase() === bareTag(thisAncestor.tag).toUpperCase());
        if (!leafIsSameAsLastIncluded) {
          const leafStep = buildStep(thisAncestor.tag, thisAncestor.node, thisAncestor.siblings, thisAncestor.pos);
          stepsParts.push('//' + leafStep);
        }

        const xpath = '//' + stepsParts.join('');
        results.push(`${leafInfo.text} : ${xpath}`);
      }

      if (!leafInfo.leaf) traverseNode(el, newAncestors);
    });
  }
}

traverseNode(obj, []);

// --- write output
try {
  fs.writeFileSync(outputPath, results.join('\n'), 'utf8');
  console.log(`✅ Generated ${results.length} XPath entries → ${outputPath}`);
} catch (err) {
  console.error(`Failed to write output: ${err.message}`);
  process.exit(4);
}

// diagnostics if zero results
if (results.length === 0) {
  console.warn('⚠️  No XPath entries were produced.');
  console.warn(` - total leaf nodes found: ${totalLeaves}`);
  console.warn(` - leaf nodes that have at least one ancestor in includeElements (${cfg.includeElements.join(', ')}): ${leavesWithIncludedAncestors}`);
  console.warn('Possible reasons:');
  console.warn('  • includeElements may not match your XML element names (check namespaces/prefixes).');
  console.warn('  • leaf nodes may contain no text (empty or whitespace-only).');
  console.warn(`  • attribute-based indexing uses only a single attribute: '${cfg.attrName}'. If you expect a different attribute name, pass --attr.`);
  if (!debug) console.warn('Run again with --debug to print config and help troubleshoot.');
} else if (debug) {
  console.log(`Debug: totalLeaves=${totalLeaves}, leavesWithIncludedAncestors=${leavesWithIncludedAncestors}`);
}
