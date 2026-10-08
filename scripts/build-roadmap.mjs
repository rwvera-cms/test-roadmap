#!/usr/bin/env node
/**
 * Combine the roadmap workbooks into site/data/roadmap.json.
 *
 *   node scripts/build-roadmap.mjs                      # reads data/roadmaps/*.xlsx
 *   node scripts/build-roadmap.mjs examples/roadmaps    # reads another folder
 *
 * The folder needs one "Enterprise Setup.xlsx" (themes, KPIs, product areas) and one roadmap workbook per product area.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook, buildRoadmap } from '../site/lib/xlsx-roadmap.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(root, process.argv[2] || 'data/roadmaps');
const OUT = path.join(root, 'site', 'data', 'roadmap.json');

const files = (await readdir(dir).catch(() => [])).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
if (!files.length) { console.error(`No .xlsx files in ${dir}`); process.exit(1); }

const workbooks = [];
for (const f of files) {
  try { workbooks.push({ fileName: f, sheets: await readWorkbook(await readFile(path.join(dir, f)), (b) => inflateRawSync(b)) }); }
  catch (e) { console.error(`! ${f}: ${e.message}`); }
}
const { data, warnings, areasLoaded } = buildRoadmap(workbooks);
if (!workbooks.some((w) => w.sheets['Themes'])) warnings.unshift('No Enterprise Setup workbook found: themes come from the product workbooks and KPIs will be empty.');
warnings.forEach((w) => console.warn('! ' + w));

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(data, null, 2));
console.log(`Wrote ${path.relative(root, OUT)}: ${areasLoaded.length} product areas (${areasLoaded.join(', ')}), ${data.initiatives.length} initiatives, ${data.milestones.length} milestones, ${data.themes.length} themes.`);
