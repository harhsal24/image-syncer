// generateXPaths.js
// Usage:
//   node generateXPaths.js input.xml output.txt [--ns d] [--include PROPERTY,IMAGE]
//        [--attr ValuationType] [--filterParent IMAGE --filterChild ImageCategoryType]
//
// Generates XPaths that INCLUDE ONLY elements present in the includeElements list
// (insert '//' if included elements are separated by non-included elements).
//
// Example:
//   node generateXPaths.js sample.xml out.txt --include IMAGE,PROPERTY --filterParent IMAGE --filterChild ImageCategoryType

const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error(`Usage:
  node generateXPaths.js <input.xml> <output.txt>
    [--ns d]
    [--include PROPERTY,IMAGE]
    [--attr ValuationType]
    [--filterParent IMAGE --filterChild ImageCategoryType]`);
  process.exit(1);
}

const inputPath = argv[0];
const outputPath = argv[1];

let nsShort = 'd';
let includeElements = ['PROPERTY', 'IMAGE'];
let attrName = 'ValuationType';
let filterParent = null;
let filterChild = null;

for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--ns' && argv[i+1]) nsShort = argv[++i];
  else if (a === '--include' && argv[i+1]) includeElements = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  else if (a === '--attr' && argv[i+1]) attrName = argv[++i];
  else if (a === '--filterParent' && argv[i+1]) filterParent = argv[++i].toUpperCase();
  else if (a === '--filterChild' && argv[i+1]) filterChild = argv[++i];
}

function formatXPathLiteral(value) {
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

const xmlText = fs.readFileSync(inputPath, 'utf8');
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  textNodeName: '#text'
});
const obj = parser.parse(xmlText);

function bareTag(tag) {
  if (!tag) return tag;
  const idx = tag.indexOf(':');
  return idx === -1 ? tag : tag.substring(idx + 1);
}

function isLeafNode(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return { leaf: true, text: String(value).trim() };
  if (value == null || typeof value !== 'object') return { leaf: true, text: String(value ?? '').trim() };
  const childKeys = Object.keys(value).filter(k => !k.startsWith('@_') && k !== '#text');
  if (childKeys.length === 0) {
    const t = (typeof value['#text'] === 'string') ? value['#text'].trim() : '';
    return { leaf: true, text: t };
  }
  return { leaf: false, text: null };
}

function getChildText(node, childTag) {
  if (!node || typeof node !== 'object') return null;
  const key = Object.keys(node).find(k => bareTag(k).toUpperCase() === childTag.toUpperCase());
  if (!key) return null;
  const v = node[key];
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object' && typeof v['#text'] === 'string') return v['#text'].trim();
  return null;
}

function buildStep(tag, nodeObj, siblingsArray, positionIndex) {
  const b = bareTag(tag);
  const prefixed = `${nsShort}:${b}`;

  // filterParent handling: if this tag is the filterParent, add child-value predicate
  if (filterParent && filterChild && b.toUpperCase() === filterParent) {
    const childValue = getChildText(nodeObj, filterChild);
    if (childValue) {
      return `${prefixed}[@${filterChild}=${formatXPathLiteral(childValue)}]`;
    }
  }

  // attribute predicate (ValuationType / ValutationType tolerant)
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

  // numeric index only when siblings >1 and no attr predicate
  let numeric = '';
  if (!attrPredicate && Array.isArray(siblingsArray) && siblingsArray.length > 1) {
    numeric = `[${positionIndex + 1}]`;
  }

  return `${prefixed}${attrPredicate || ''}${numeric}`;
}

const results = [];

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

      // find included ancestors among the full ancestor chain (including this element)
      const includedAncestors = newAncestors
        .map((a, indexInNew) => ({ ...a, idxInNew: indexInNew }))
        .filter(a => includeElements.includes(bareTag(a.tag).toUpperCase()));

      if (leafInfo.leaf && leafInfo.text.length > 0 && includedAncestors.length > 0) {
        // Build path using only includedAncestors (preserve document order).
        // If included ancestors are not adjacent, use '//' between them.
        const steps = [];
        for (let i = 0; i < includedAncestors.length; i++) {
          const anc = includedAncestors[i];
          const step = buildStep(anc.tag, anc.node, anc.siblings, anc.pos);
          if (i === 0) {
            steps.push(step);
          } else {
            const prev = includedAncestors[i - 1];
            // if directly adjacent in ancestor chain, join with '/'
            if (anc.idxInNew === prev.idxInNew + 1) {
              steps.push('/' + step);
            } else {
              // not adjacent -> use descendant-or-self
              steps.push('//' + step);
            }
          }
        }

        // If the last included ancestor is not the actual leaf element, append the leaf element
        const lastIncluded = includedAncestors[includedAncestors.length - 1];
        const leafIsSameAsLastIncluded = (bareTag(lastIncluded.tag).toUpperCase() === bareTag(thisAncestor.tag).toUpperCase());
        if (!leafIsSameAsLastIncluded) {
          // append leaf selector as descendant (use //)
          const leafStep = buildStep(thisAncestor.tag, thisAncestor.node, thisAncestor.siblings, thisAncestor.pos);
          steps.push('//' + leafStep);
        }

        // assemble xpath (prefix with '//' so it is relative anywhere in doc)
        const xpath = '//' + steps.join('');
        results.push(`${leafInfo.text} : ${xpath}`);
      }

      if (!leafInfo.leaf) traverseNode(el, newAncestors);
    });
  }
}

traverseNode(obj, []);
fs.writeFileSync(outputPath, results.join('\n'), 'utf8');
console.log(`✅ Generated ${results.length} XPath entries → ${outputPath}`);
