#!/usr/bin/env node
// generateXPaths.js (leaf steps have no numeric index)
// Usage and behavior same as before.

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('Usage: node generateXPaths.js <input.xml> <output.txt> [--ns d] [--include PROPERTY,IMAGE] [--attr ValuationUseType] [--filterParent IMAGE --filterChild ImageCategoryType] [--defaults <json>] [--debug]');
  process.exit(1);
}

const inputPath = argv[0];
const outputPath = argv[1];

const builtInDefaults = {
  nsShort: 'd',
  includeElements: ['PROPERTY', 'IMAGE'],
  attrName: 'ValuationUseType',
  filterParent: 'IMAGE',
  filterChild: 'ImageCategoryType'
};

let defaultsFileFromCLI = null;
let cliOptions = {};
let debug = false;
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--ns' && argv[i+1]) cliOptions.nsShort = argv[++i];
  else if (a === '--include' && argv[i+1]) cliOptions.includeElements = argv[++i];
  else if (a === '--attr' && argv[i+1]) cliOptions.attrName = argv[++i];
  else if (a === '--filterParent' && argv[i+1]) cliOptions.filterParent = argv[++i];
  else if (a === '--filterChild' && argv[i+1]) cliOptions.filterChild = argv[++i];
  else if (a === '--defaults' && argv[i+1]) defaultsFileFromCLI = argv[++i];
  else if (a === '--debug') debug = true;
}

function tryLoadDefaults(fp) {
  try {
    if (!fp) return null;
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    console.warn(`Warning: could not load defaults ${fp}: ${e.message}`);
    return null;
  }
}

const defaultsJsonPath = defaultsFileFromCLI || path.join(process.cwd(), 'generateXPaths.defaults.json');
const fileDefaults = tryLoadDefaults(defaultsJsonPath) || {};

const cfg = { ...builtInDefaults, ...fileDefaults, ...cliOptions };
if (typeof cfg.includeElements === 'string') cfg.includeElements = cfg.includeElements.split(',').map(s => s.trim());
cfg.includeElements = (Array.isArray(cfg.includeElements) ? cfg.includeElements : []).map(s => String(s).toUpperCase());
cfg.nsShort = String(cfg.nsShort || builtInDefaults.nsShort);
cfg.attrName = String(cfg.attrName || builtInDefaults.attrName);
cfg.filterParent = cfg.filterParent ? String(cfg.filterParent).toUpperCase() : null;
cfg.filterChild = cfg.filterChild ? String(cfg.filterChild) : null;

if (debug) console.log('Config:', JSON.stringify(cfg, null, 2));

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
try { xmlText = fs.readFileSync(inputPath, 'utf8'); }
catch (e) { console.error(`Failed to read ${inputPath}: ${e.message}`); process.exit(2); }

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  textNodeName: '#text'
});

let obj;
try { obj = parser.parse(xmlText); }
catch (e) { console.error(`Failed to parse XML: ${e.message}`); process.exit(3); }

function bareTag(tag) {
  if (!tag) return tag;
  const idx = tag.indexOf(':');
  return idx === -1 ? tag : tag.substring(idx + 1);
}

function isLeafNode(value) {
  if (value == null) return { leaf: true, text: '' };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return { leaf: true, text: String(value).trim() };
  if (typeof value !== 'object') return { leaf: true, text: String(value).trim() };
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
  if (v == null) return null;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && typeof v['#text'] === 'string') return v['#text'].trim();
  return null;
}

const signatureCounts = new Map();
const compositeKeyCounters = new Map();
const compositeInstanceToNumber = new Map();

function predicateStringForElement(tag, nodeObj) {
  const b = bareTag(tag);
  if (cfg.filterParent && cfg.filterChild && b.toUpperCase() === cfg.filterParent) {
    const cv = getChildText(nodeObj, cfg.filterChild);
    if (cv != null && cv !== '') return `[@${cfg.filterChild}=${formatXPathLiteral(cv)}]`;
  }
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

// build step, optionally include index; alwaysIncludeIndex true forces index even if 1
function buildStepWithIndex(tag, nodeObj, assignedIndex, alwaysIncludeIndex) {
  const b = bareTag(tag);
  const pref = `${cfg.nsShort}:${b}`;
  const pred = predicateStringForElement(tag, nodeObj) || '';
  const base = `${pref}${pred}`;
  if (typeof assignedIndex === 'number' && (alwaysIncludeIndex || assignedIndex > 1)) {
    return `${base}[${assignedIndex}]`;
  }
  return base;
}

function buildNormalStep(tag, nodeObj, assignedIndex) {
  return buildStepWithIndex(tag, nodeObj, assignedIndex, false);
}

const results = [];
let totalLeaves = 0;
let leavesWithIncludedAncestors = 0;

function traverseNode(node, ancestors) {
  if (!node || typeof node !== 'object') return;
  const elementNames = Object.keys(node).filter(k => !k.startsWith('@_') && k !== '#text');

  for (const tag of elementNames) {
    const val = node[tag];
    const elements = Array.isArray(val) ? val : [val];

    elements.forEach((el, idx) => {
      const predStr = predicateStringForElement(tag, el);
      const sig = `${cfg.nsShort}:${bareTag(tag)}${predStr}`;
      const prev = signatureCounts.get(sig) || 0;
      const newIdx = prev + 1;
      signatureCounts.set(sig, newIdx);

      const thisAncestor = { tag, node: el, siblings: elements, pos: idx, assignedIndex: newIdx };
      const newAncestors = ancestors.concat(thisAncestor);

      const leafInfo = isLeafNode(el);
      if (leafInfo.leaf) totalLeaves++;

      const includedAncestors = newAncestors
        .map((a, i) => ({ ...a, idxInNew: i }))
        .filter(a => cfg.includeElements.includes(bareTag(a.tag).toUpperCase()));

      if (leafInfo.leaf && leafInfo.text.length > 0 && includedAncestors.length > 0) {
        leavesWithIncludedAncestors++;

        // find start included index (first with attr predicate else 0)
        let startIncludedIdx = -1;
        for (let i = 0; i < includedAncestors.length; i++) {
          const anc = includedAncestors[i];
          const p = predicateStringForElement(anc.tag, anc.node);
          if (p && p.indexOf(`@${cfg.attrName}=`) !== -1) { startIncludedIdx = i; break; }
        }
        if (startIncludedIdx === -1) startIncludedIdx = 0;

        // find image included index (filterParent with predicate)
        let imageIncludedIdx = -1;
        for (let i = 0; i < includedAncestors.length; i++) {
          const anc = includedAncestors[i];
          const bname = bareTag(anc.tag).toUpperCase();
          const p = predicateStringForElement(anc.tag, anc.node);
          if (cfg.filterParent && bname === cfg.filterParent && p) { imageIncludedIdx = i; break; }
        }

        let xpath = null;
        if (imageIncludedIdx >= 0 && startIncludedIdx <= imageIncludedIdx) {
          const slice = includedAncestors.slice(startIncludedIdx, imageIncludedIdx + 1);

          // composite signature and instance key
          const compositeSignatureParts = slice.map(s => {
            const p = predicateStringForElement(s.tag, s.node) || '';
            return `${cfg.nsShort}:${bareTag(s.tag)}${p}`;
          });
          const compositeKey = compositeSignatureParts.join('||');

          const instanceIdParts = slice.map(s => `${cfg.nsShort}:${bareTag(s.tag)}#${s.assignedIndex}`);
          const compositeInstanceKey = compositeKey + '::' + instanceIdParts.join(',');

          let compositeNumber;
          if (compositeInstanceToNumber.has(compositeInstanceKey)) {
            compositeNumber = compositeInstanceToNumber.get(compositeInstanceKey);
          } else {
            const prevCount = compositeKeyCounters.get(compositeKey) || 0;
            const nextCount = prevCount + 1;
            compositeKeyCounters.set(compositeKey, nextCount);
            compositeInstanceToNumber.set(compositeInstanceKey, nextCount);
            compositeNumber = nextCount;
          }

          // build inside parts: OMIT numeric index for the filterParent (IMAGE) inside parentheses
          const insideParts = slice.map(s => {
            const isFilterParent = (bareTag(s.tag).toUpperCase() === cfg.filterParent);
            if (isFilterParent) {
              return buildStepWithIndex(s.tag, s.node, null, false); // no numeric index for IMAGE here
            } else {
              return buildStepWithIndex(s.tag, s.node, s.assignedIndex, true); // include PROPERTY index
            }
          });

          const insideJoined = insideParts.reduce((acc, part, i) => {
            if (i === 0) return part;
            const prev = slice[i - 1];
            const curr = slice[i];
            if (curr.idxInNew === prev.idxInNew + 1) return acc + '/' + part;
            return acc + '//' + part;
          }, '');

          const grouped = `(//${insideJoined})[${compositeNumber}]`;

          // append included ancestors after imageIncludedIdx (if any)
          const afterParts = [];
          for (let j = imageIncludedIdx + 1; j < includedAncestors.length; j++) {
            const anc = includedAncestors[j];
            const step = buildNormalStep(anc.tag, anc.node, anc.assignedIndex);
            const prev = includedAncestors[j - 1];
            if (anc.idxInNew === prev.idxInNew + 1) afterParts.push('/' + step);
            else afterParts.push('//' + step);
          }

          // append leaf (without index)
          const lastIncluded = includedAncestors[includedAncestors.length - 1];
          const leafIsSame = (bareTag(lastIncluded.tag).toUpperCase() === bareTag(thisAncestor.tag).toUpperCase());
          if (!leafIsSame) {
            // build leaf step WITHOUT numeric index
            const leafStepNoIndex = buildStepWithIndex(thisAncestor.tag, thisAncestor.node, null, false);
            // determine separator relative to previous included
            const prevInc = includedAncestors[includedAncestors.length - 1];
            const thisIdxInNew = newAncestors.length - 1;
            if (thisIdxInNew === prevInc.idxInNew + 1) afterParts.push('/' + leafStepNoIndex);
            else afterParts.push('//' + leafStepNoIndex);
          }

          xpath = grouped + afterParts.join('');
        } else {
          // fallback: grouped IMAGE or normal path
          let imageIdx = -1;
          for (let i = 0; i < includedAncestors.length; i++) {
            const anc = includedAncestors[i];
            const bname = bareTag(anc.tag).toUpperCase();
            const p = predicateStringForElement(anc.tag, anc.node);
            if (cfg.filterParent && bname === cfg.filterParent && p) { imageIdx = i; break; }
          }

          if (imageIdx >= 0) {
            const groupedAnc = includedAncestors[imageIdx];
            const sig = `${cfg.nsShort}:${bareTag(groupedAnc.tag)}${predicateStringForElement(groupedAnc.tag, groupedAnc.node)}`;
            const instanceKey = sig + '::' + `${cfg.nsShort}:${bareTag(groupedAnc.tag)}#${groupedAnc.assignedIndex}`;
            let compositeNumber;
            if (compositeInstanceToNumber.has(instanceKey)) {
              compositeNumber = compositeInstanceToNumber.get(instanceKey);
            } else {
              const prevCount = compositeKeyCounters.get(sig) || 0;
              const nextCount = prevCount + 1;
              compositeKeyCounters.set(sig, nextCount);
              compositeInstanceToNumber.set(instanceKey, nextCount);
              compositeNumber = nextCount;
            }

            const grouped = `(//${sig})[${compositeNumber}]`;

            const afterParts = [];
            for (let j = imageIdx + 1; j < includedAncestors.length; j++) {
              const anc = includedAncestors[j];
              const step = buildNormalStep(anc.tag, anc.node, anc.assignedIndex);
              const prev = includedAncestors[j - 1];
              if (anc.idxInNew === prev.idxInNew + 1) afterParts.push('/' + step);
              else afterParts.push('//' + step);
            }

            // append leaf (without index)
            const lastIncluded = includedAncestors[includedAncestors.length - 1];
            const leafIsSame = (bareTag(lastIncluded.tag).toUpperCase() === bareTag(thisAncestor.tag).toUpperCase());
            if (!leafIsSame) {
              const leafStepNoIndex = buildStepWithIndex(thisAncestor.tag, thisAncestor.node, null, false);
              const prevInc = includedAncestors[includedAncestors.length - 1];
              const thisIdxInNew = newAncestors.length - 1;
              if (thisIdxInNew === prevInc.idxInNew + 1) afterParts.push('/' + leafStepNoIndex);
              else afterParts.push('//' + leafStepNoIndex);
            }

            xpath = grouped + afterParts.join('');
          } else {
            // plain included-only path
            const parts = [];
            for (let i = 0; i < includedAncestors.length; i++) {
              const anc = includedAncestors[i];
              const step = buildNormalStep(anc.tag, anc.node, anc.assignedIndex);
              if (i === 0) parts.push(step);
              else {
                const prev = includedAncestors[i - 1];
                if (anc.idxInNew === prev.idxInNew + 1) parts.push('/' + step);
                else parts.push('//' + step);
              }
            }

            // append leaf without index
            const lastIncluded = includedAncestors[includedAncestors.length - 1];
            const leafIsSame = (bareTag(lastIncluded.tag).toUpperCase() === bareTag(thisAncestor.tag).toUpperCase());
            if (!leafIsSame) {
              const leafStepNoIndex = buildStepWithIndex(thisAncestor.tag, thisAncestor.node, null, false);
              parts.push('//' + leafStepNoIndex);
            }

            xpath = '//' + parts.join('');
          }
        }

        results.push(`${leafInfo.text} : ${xpath}`);
      }

      if (!leafInfo.leaf) traverseNode(el, newAncestors);
    });
  }
}

traverseNode(obj, []);

try { fs.writeFileSync(outputPath, results.join('\n'), 'utf8'); console.log(`✅ Generated ${results.length} XPath entries → ${outputPath}`); }
catch (e) { console.error(`Failed to write output: ${e.message}`); process.exit(4); }

if (results.length === 0) {
  console.warn('⚠️  No XPath entries were produced.');
  console.warn(` - total leaf nodes found: ${totalLeaves}`);
  console.warn(` - leaf nodes that have at least one ancestor in includeElements (${cfg.includeElements.join(', ')}): ${leavesWithIncludedAncestors}`);
  if (!debug) console.warn('Run with --debug to diagnose.');
} else if (debug) {
  console.log(`Debug: totalLeaves=${totalLeaves}, leavesWithIncludedAncestors=${leavesWithIncludedAncestors}`);
}
