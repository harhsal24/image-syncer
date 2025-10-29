// parser.js
// Usage:
//   node parser.js                    -> uses defaults (./input/sample.xml -> ./output/sample.txt)
//   node parser.js input.xml out.txt  -> uses provided paths

const fs = require('fs');
const path = require('path');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

// ----------------- Helper utilities -----------------

/**
 * Format an XPath literal safely (handles values containing both single and double quotes).
 * Returns a string suitable to put after = in an XPath predicate, e.g. "'abc'" or "concat('a', '\"', 'b')"
 */
function formatXPathLiteral(value) {
  if (value.indexOf("'") === -1) {
    return `'${value}'`;
  }
  if (value.indexOf('"') === -1) {
    return `"${value}"`;
  }
  // contains both single and double quotes -> use concat()
  const parts = value.split("'");
  const concatParts = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length > 0) concatParts.push(`'${parts[i]}'`);
    if (i < parts.length - 1) concatParts.push(`"'"`);
  }
  return `concat(${concatParts.join(',')})`;
}

/** strip namespace prefix if present, e.g. d:PROPERTY -> PROPERTY */
function stripPrefix(tagName) {
  const idx = tagName.indexOf(':');
  return idx === -1 ? tagName : tagName.substring(idx + 1);
}

/**
 * Build the xpath step for a node using configured attributes and parent-scope indexing rules.
 * - node: DOM element
 * - parent: DOM element (may be null for root)
 * - options: config object
 */
function makeXPathStep(node, parent, options) {
  const tag = node.tagName;
  const attrsToUse = Array.isArray(options.attributesToIncludeInPath) ? options.attributesToIncludeInPath : [];

  // detect leaf status
  const isLeaf = !Array.from(node.childNodes).some(n => n.nodeType === 1);

  // build attribute predicates
  const attrPredicates = [];
  for (const attrName of attrsToUse) {
    if (node.hasAttribute && node.hasAttribute(attrName)) {
      const raw = String(node.getAttribute(attrName) ?? '');
      if (raw.length > 0) {
        attrPredicates.push(`@${attrName}=${formatXPathLiteral(raw)}`);
      }
    }
  }

  // compute numeric index in parent scope (if needed)
  let numericIndex = null;
  let siblingsSameTag = [];
  if (parent) {
    const parentChildren = Array.from(parent.childNodes).filter(n => n.nodeType === 1);
    siblingsSameTag = parentChildren.filter(c => c.tagName === tag);

    if (siblingsSameTag.length > 1) {
      if (attrPredicates.length === 0) {
        numericIndex = siblingsSameTag.indexOf(node) + 1;
      } else {
        const sameAttrSiblings = siblingsSameTag.filter(s => {
          return attrsToUse.every(a => {
            const sa = (s.getAttribute && s.getAttribute(a) !== null) ? String(s.getAttribute(a)) : undefined;
            const na = (node.getAttribute && node.getAttribute(a) !== null) ? String(node.getAttribute(a)) : undefined;
            return sa === na;
          });
        });

        if (sameAttrSiblings.length > 1) {
          numericIndex = sameAttrSiblings.indexOf(node) + 1;
        } else {
          numericIndex = null;
        }
      }
    } else {
      numericIndex = null;
    }
  }

  // leaf-node policy: 'auto'|'always'|'never'
  const leafPolicy = options.leafNodeIndexing || 'auto';
  if (isLeaf) {
    if (leafPolicy === 'never') {
      numericIndex = null;
    } else if (leafPolicy === 'always') {
      if (parent) {
        const idx = (siblingsSameTag && siblingsSameTag.length) ? (siblingsSameTag.indexOf(node) + 1) : 1;
        numericIndex = idx;
        const isException = Array.isArray(options.exceptionsToIndexOneForcing) &&
          (options.exceptionsToIndexOneForcing.includes(tag) || options.exceptionsToIndexOneForcing.includes(stripPrefix(tag)));
        if (numericIndex === 1 && isException) numericIndex = null;
      } else {
        numericIndex = null;
      }
    }
    // 'auto' => leave numericIndex as originally calculated
  }

  // build predicate string
  let predicateStr = '';
  if (attrPredicates.length > 0) {
    predicateStr += `[${attrPredicates.join(' and ')}]`;
  }

  if (numericIndex !== null) {
    predicateStr += `[${numericIndex}]`;
  } else {
    // Apply global force-index rule for non-leaf nodes OR when leafPolicy === 'always'
    const forceArr = Array.isArray(options.forceIndexOneFor) ? options.forceIndexOneFor : null;
    if (forceArr) {
      const forceForAll = forceArr.length === 0;
      const forceForSpecific = forceForAll ? false : (forceArr.includes(tag) || forceArr.includes(stripPrefix(tag)));
      const shouldForceThisTag = forceForAll || forceForSpecific;

      const isException = Array.isArray(options.exceptionsToIndexOneForcing) &&
                          (options.exceptionsToIndexOneForcing.includes(tag) || options.exceptionsToIndexOneForcing.includes(stripPrefix(tag)));

      // New rule: if this is a leaf, only allow global force when leafPolicy === 'always'
      const leafAllowsForce = !isLeaf || (isLeaf && leafPolicy === 'always');

      if (shouldForceThisTag && !isException && leafAllowsForce) {
        predicateStr += `[1]`;
      }
    }
  }

  return `${tag}${predicateStr}`;
}



/**
 * Build absolute XPath for current node using ancestor chain.
 * ancestors: array of nodes from root ... to current (inclusive)
 */
function buildAbsoluteXPathFromAncestors(ancestors, options) {
  const steps = [];
  for (let i = 0; i < ancestors.length; i++) {
    const node = ancestors[i];
    const parent = i > 0 ? ancestors[i - 1] : null;
    steps.push(makeXPathStep(node, parent, options));
  }
  return '/' + steps.join('/');
}

// ----------------- Core traversal / generator -----------------

/**
 * Generate lines "value : /ABSOLUTE/XPATH" for leaf nodes.
 * xmlString: full XML content
 * options: configuration object
 */
function generateXpathList(xmlString, options) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  const errorNode = doc.getElementsByTagName('parsererror');
  if (errorNode && errorNode.length > 0) {
    // serialize parsererror details
    throw new Error('XML Parsing Error: ' + new XMLSerializer().serializeToString(errorNode[0]));
  }

  const results = [];
  if (!doc.documentElement) return '';

  // recursively walk and maintain ancestor stack
  function walk(node, ancestors) {
    if (!node || node.nodeType !== 1) return; // element nodes only

    // Skip configured ignored leaf nodes (by tag name WITHOUT assuming namespace)
    const bareTag = stripPrefix(node.tagName);
    if (Array.isArray(options.ignoreLeafNodes) && options.ignoreLeafNodes.includes(node.tagName)) return;
    if (Array.isArray(options.ignoreLeafNodes) && options.ignoreLeafNodes.includes(bareTag)) return;

    // find element children
    const childElements = Array.from(node.childNodes).filter(n => n.nodeType === 1);

    // leaf = no element children, and some non-empty text content
    if (childElements.length === 0) {
      const txt = node.textContent ? node.textContent.trim() : '';
      if (txt.length > 0) {
        const abs = buildAbsoluteXPathFromAncestors(ancestors.concat(node), options);
        results.push(`${txt} : ${abs}`);
      }
      return;
    }

    // for each child, we must pass ancestor context; numeric indexing logic is computed in makeXPathStep
    for (const child of childElements) {
      walk(child, ancestors.concat(node));
    }
  }

  walk(doc.documentElement, []); // start with root element (ancestors empty)
  return results.join('\n');
}

// ----------------- Default configuration -----------------

const defaultOptions = {
  // Default I/O paths (relative to this script folder)
  inputFile: path.join(__dirname, 'input', 'sample-input.xml'),
  outputFile: path.join(__dirname, 'output', 'sample.txt'),

  // INDEXING: set [] to force index [1] for ALL tags
  forceIndexOneFor: [],

  // exceptions to the force rule above (never show [1] even if forcing)
  // can include names with or without namespace prefix (e.g. 'd:PROPERTY' or 'PROPERTY')
  exceptionsToIndexOneForcing: [
    'MESSAGE',
    'DOCUMENT_SETS', 'DOCUMENT_SET',
    'DOCUMENTS', 'DOCUMENT',
    'DEAL_SETS', 'DEAL_SET',
    'DEALS', 'DEAL',
    'SERVICES', 'SERVICE',
    'VALUATION', 'VALUATION_RESPONSE',
    'VALUATION_ANALYSES', 'VALUATION_ANALYSIS',
    'PROPERTIES'
  ],

  // ATTRIBUTES to prefer for predicates (kept to ValuationUseType as requested)
  attributesToIncludeInPath: ['ValuationUseType'],

  // IGNORE leaf node tags (no output lines created for these tags)
  ignoreLeafNodes: [
    // 'ImageFileLocationIdentifier'
  ],

  // NEW: control leaf-node indexing behavior:
  // 'auto'   -> default behavior (index only when needed to disambiguate)
  // 'always' -> always include numeric index for leaf nodes (respects exceptionsToIndexOneForcing)
  // 'never'  -> never include numeric index for leaf nodes (even if needed)
  leafNodeIndexing: 'never'
};

// ----------------- Main CLI flow -----------------

function resolveOptionValue(cliValue, defaultValue) {
  if (!cliValue) return defaultValue;
  return path.resolve(cliValue);
}

function main() {
  try {
    // CLI args: [node, parser.js, inputPath?, outputPath?]
    const argv = process.argv.slice(2);
    let inputPath = argv[0] ? path.resolve(argv[0]) : defaultOptions.inputFile;
    let outputPath = argv[1] ? path.resolve(argv[1]) : defaultOptions.outputFile;

    // If inputPath points to a bare filename inside input folder, allow that UX:
    if (!path.isAbsolute(inputPath) && fs.existsSync(path.join(__dirname, 'input', inputPath))) {
      inputPath = path.join(__dirname, 'input', inputPath);
    }

    // Build options object to pass into generator
    const options = {
      forceIndexOneFor: Array.isArray(defaultOptions.forceIndexOneFor) ? defaultOptions.forceIndexOneFor.slice() : [],
      exceptionsToIndexOneForcing: Array.isArray(defaultOptions.exceptionsToIndexOneForcing) ? defaultOptions.exceptionsToIndexOneForcing.slice() : [],
      attributesToIncludeInPath: Array.isArray(defaultOptions.attributesToIncludeInPath) ? defaultOptions.attributesToIncludeInPath.slice() : [],
      ignoreLeafNodes: Array.isArray(defaultOptions.ignoreLeafNodes) ? defaultOptions.ignoreLeafNodes.slice() : [],
      leafNodeIndexing: defaultOptions.leafNodeIndexing || 'auto'
    };

    if (!fs.existsSync(inputPath)) {
      console.error(`✖ Input file not found: ${inputPath}`);
      console.error('Usage: node parser.js [input.xml] [output.txt]');
      process.exit(1);
    }

    // ensure output directory exists
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    console.log(`Reading XML: ${inputPath}`);
    console.log(`Writing output: ${outputPath}`);
    console.log(`Attributes used for predicates: ${options.attributesToIncludeInPath.join(', ')}`);
    console.log(`Force index [1] for: ${options.forceIndexOneFor.length === 0 ? 'ALL tags' : options.forceIndexOneFor.join(', ')}`);
    console.log(`Exceptions to force rule: ${options.exceptionsToIndexOneForcing.join(', ')}`);
    console.log(`Leaf node indexing policy: ${options.leafNodeIndexing}`);
    if (options.ignoreLeafNodes.length) {
      console.log(`Ignored leaf nodes: ${options.ignoreLeafNodes.join(', ')}`);
    }

    const xmlData = fs.readFileSync(inputPath, 'utf8');
    const outputContent = generateXpathList(xmlData, options);
    fs.writeFileSync(outputPath, outputContent, 'utf8');

    const count = outputContent.split('\n').filter(l => l.trim().length > 0).length;
    console.log(`\n✔ Done — generated ${count} lines.`);
  } catch (err) {
    console.error('✖ Error:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

// run
if (require.main === module) {
  main();
}

module.exports = {
  generateXpathList,
  defaultOptions
};
