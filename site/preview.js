// "Preview a roadmap file": read dropped/selected .xlsx files in the browser and show them on the dashboard.
// Nothing is uploaded or saved. Uses site/lib/xlsx-roadmap.js (shared with the build script).
import { readWorkbook, buildRoadmap } from './lib/xlsx-roadmap.js';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function preview(fileList) {
  const files = [...fileList].filter((f) => /\.xlsx$/i.test(f.name));
  const banner = $('#preview-banner');
  if (!files.length) { show(`<b>That isn't an Excel roadmap file.</b> Choose a .xlsx workbook made from the roadmap template.`, true); return; }
  const workbooks = [], errors = [];
  for (const f of files) {
    try { workbooks.push({ fileName: f.name, sheets: await readWorkbook(await f.arrayBuffer(), inflateRaw) }); }
    catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }
  const base = window.RoadmapApp.getData();
  const { data, warnings, areasLoaded } = buildRoadmap(workbooks, base);
  const all = [...errors, ...warnings];
  if (!areasLoaded.length && !workbooks.some((w) => w.sheets['Themes'])) {
    show(`<b>Couldn't preview.</b><ul>${all.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`, true); return;
  }
  const names = areasLoaded.map((a) => data.productAreas.find((x) => x.id === a)?.name || a);
  window.RoadmapApp.setData(data, { area: areasLoaded.length === 1 ? areasLoaded[0] : null });
  show(`<b>Preview:</b> showing ${names.length ? esc(names.join(', ')) : 'the enterprise setup'} from ${esc(files.map((f) => f.name).join(', '))}. Nothing is saved or shared.
    ${all.length ? `<details><summary>${all.length} thing${all.length > 1 ? 's' : ''} to fix in the file</summary><ul>${all.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}`);
  banner.scrollIntoView({ block: 'nearest' });
}

function show(html, isError = false) {
  const b = $('#preview-banner');
  b.innerHTML = `<div class="pv-text">${html}</div><button type="button" id="pv-exit">${isError ? 'Dismiss' : 'Exit preview'}</button>`;
  b.classList.toggle('error', isError);
  b.hidden = false;
  $('#pv-exit').onclick = () => {
    b.hidden = true;
    if (!isError) window.RoadmapApp.setData(window.RoadmapApp.getData(), null);
  };
}

function wire() {
  const input = $('#pv-file');
  $('#pv-open').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files.length) preview(input.files); input.value = ''; });

  const overlay = $('#drop-overlay');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; overlay.hidden = false; });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; overlay.hidden = true;
    preview(e.dataTransfer.files);
  });
}

if (typeof DecompressionStream === 'undefined') {
  document.addEventListener('DOMContentLoaded', () => { const b = $('#pv-open'); if (b) b.hidden = true; });
} else if (window.RoadmapApp) wire();
else document.addEventListener('roadmap:ready', wire, { once: true });
