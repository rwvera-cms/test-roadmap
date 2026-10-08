/* Reads roadmap workbooks (.xlsx) and turns them into roadmap data. No dependencies.
   Shared by the browser preview (site/preview.js) and the build script (scripts/build-roadmap.mjs).

   Workbook kinds:
   - Enterprise setup: sheets "Settings", "Themes", "Product Areas"   (owned by the Director)
   - Product roadmap:  sheets "Product Area", "Initiatives", "Milestones", "Reference"   (one per product area, owned by its DM)
*/

/* ---------- minimal .xlsx reader (zip + sheet XML) ---------- */

// inflateRaw: (Uint8Array) => Promise<Uint8Array> | Uint8Array   — supplied by the caller (browser or Node)
export async function readWorkbook(buffer, inflateRaw) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const files = await unzip(u8, inflateRaw);
  const text = (p) => (files[p] ? new TextDecoder().decode(files[p]) : '');
  if (!files['xl/workbook.xml']) throw new Error('Not an Excel workbook (.xlsx).');

  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlDecode(t[1])).join(''));

  // Which number formats are dates, so serial numbers can be turned into dates.
  const styles = text('xl/styles.xml');
  const customFmt = {};
  for (const m of styles.matchAll(/<numFmt [^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) customFmt[m[1]] = m[2];
  const xfs = (styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || [, ''])[1];
  const dateStyle = [...xfs.matchAll(/<xf [^>]*?numFmtId="(\d+)"/g)].map((m) => {
    const id = Number(m[1]);
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    const code = (customFmt[m[1]] || '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
    return /[dy]/i.test(code) && !/h/i.test(code.replace(/mm/g, ''));
  });

  const rels = {};
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship [^>]*>/g)) {
    const id = (m[0].match(/Id="([^"]+)"/) || [])[1];
    const target = (m[0].match(/Target="([^"]+)"/) || [])[1];
    if (id && target) rels[id] = target.replace(/^\/?(xl\/)?/, 'xl/');
  }
  const sheets = {};
  for (const m of text('xl/workbook.xml').matchAll(/<sheet [^>]*>/g)) {
    const name = xmlDecode((m[0].match(/name="([^"]+)"/) || [])[1] || '');
    const rid = (m[0].match(/r:id="([^"]+)"/) || [])[1];
    sheets[name] = parseSheet(text(rels[rid]), shared, dateStyle);
  }
  return sheets;
}

function parseSheet(xml, shared, dateStyle) {
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNum = Number((rm[0].match(/ r="(\d+)"/) || [])[1]) || rows.length + 1;
    const row = [];
    for (const cm of (rm[1] || '').matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || '';
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      const t = (attrs.match(/ t="([^"]+)"/) || attrs.match(/^t="([^"]+)"/) || [])[1];
      const s = Number((attrs.match(/ s="(\d+)"/) || attrs.match(/^s="(\d+)"/) || [])[1] || 0);
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xmlDecode(x[1])).join('');
      else if (t === 'b') val = v === '1';
      else if (t === 'str' || t === 'e') val = xmlDecode(v ?? '');
      else if (v !== undefined) val = dateStyle[s] ? serialToDate(Number(v)) : Number(v);
      row[colIndex(ref)] = val;
    }
    rows[rowNum - 1] = row;
  }
  return Array.from(rows, (r) => Array.from(r || [], (c) => (c === undefined ? '' : c)));
}

const colIndex = (ref) => [...(ref || 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const xmlDecode = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
function serialToDate(n) { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000)); return d.toISOString().slice(0, 10); }

async function unzip(u8, inflateRaw) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not an Excel workbook (.xlsx). If it is an older .xls file, save it as .xlsx.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (!/^xl\/(workbook\.xml|sharedStrings\.xml|styles\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = u8.subarray(start, start + csize);
    out[name] = method === 0 ? data : await inflateRaw(data);
  }
  return out;
}

/* ---------- workbook → roadmap ---------- */

const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const str = (v) => (v === true ? 'Yes' : v === false ? 'No' : String(v ?? '').trim());

// Header row → objects, matching headers loosely. Skips blank and EXAMPLE rows.
function table(rows, fields) {
  const hi = rows.findIndex((r) => r && r.filter((c) => str(c)).length >= 2);
  if (hi < 0) return [];
  const header = rows[hi].map(norm);
  const idx = {};
  for (const [k, names] of Object.entries(fields)) { const i = header.findIndex((h) => names.includes(h)); if (i >= 0) idx[k] = i; }
  return rows.slice(hi + 1).filter((r) => r && r.some((c) => str(c)))
    .filter((r) => !r.some((c) => /^example\b/i.test(str(c))))
    .map((r) => Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, r[i] ?? ''])));
}
// Two-column label/value sheets (About, Settings).
function keyValues(rows) {
  const o = {}; (rows || []).forEach((r) => { if (r && str(r[0])) o[norm(r[0])] = r[1] ?? ''; }); return o;
}
function day(v) {
  if (!v) return '';
  if (typeof v === 'number') return serialToDate(v);
  const s = str(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return '';
}
const num = (v) => (str(v) === '' ? null : (isNaN(Number(str(v).replace(/[,%$]/g, ''))) ? null : Number(str(v).replace(/[,%$]/g, ''))));
const yes = (v) => v === true || ['yes', 'true', 'y', '1', 'done'].includes(norm(v));

const F = {
  theme: { code: ['code'], name: ['theme', 'name', 'title'], description: ['description'], kpi: ['kpi', 'kpiname'], unit: ['kpiunit', 'unit'],
    baseline: ['baseline', 'kpibaseline'], current: ['current', 'kpicurrent'], target: ['target', 'kpitarget'] },
  area: { code: ['code'], name: ['productarea', 'name', 'title'], owner: ['productowner', 'owner'], dm: ['deliverymanager'], description: ['description'], active: ['active'], category: ['category', 'type', 'worktype', 'portfolio'] },
  init: { id: ['id', 'initiativeid'], area: ['productarea', 'productareacode', 'area'], title: ['initiative', 'title', 'name'], theme: ['strategictheme', 'theme'], horizon: ['horizon'], status: ['status'],
    start: ['startdate', 'start'], end: ['enddate', 'end'], owner: ['owner'], summary: ['summary'], jira: ['jiraepic', 'epic'],
    deps: ['dependson', 'dependsonids', 'dependencies'], risk: ['risknote', 'risk'], reviewed: ['lastreviewed'] },
  ms: { initiative: ['initiativeid', 'initiative'], title: ['milestone', 'title', 'name'], date: ['date', 'duedate'], type: ['type'], done: ['done'], jira: ['jiraepic', 'epic'] },
};

/**
 * workbooks: [{ fileName, sheets }]   base: existing roadmap data to merge into (optional)
 * Returns { data, warnings, areasLoaded }
 * Product workbooks replace their own area's initiatives and milestones in `base`;
 * an enterprise workbook replaces themes, product areas and settings.
 */
export function buildRoadmap(workbooks, base = null) {
  const warnings = [];
  const data = base ? structuredClone(base) : { settings: {}, themes: [], productAreas: [], initiatives: [], milestones: [] };
  data.initiatives ||= []; data.milestones ||= []; data.themes ||= []; data.productAreas ||= [];

  const enterprise = workbooks.filter((w) => w.sheets['Themes'] && w.sheets['Product Areas']);
  const products = workbooks.filter((w) => w.sheets['Initiatives']);
  workbooks.filter((w) => !enterprise.includes(w) && !products.includes(w))
    .forEach((w) => warnings.push(`${w.fileName}: not a roadmap workbook (no "Initiatives" or "Themes" sheet). Skipped.`));

  for (const w of enterprise) {
    const s = keyValues(w.sheets['Settings']);
    data.settings = {
      ...data.settings,
      orgName: str(s.organization || s.orgname) || data.settings.orgName || '',
      fiscalYearStartMonth: num(s.fiscalyearstartmonth) || data.settings.fiscalYearStartMonth || 1,
      jiraBaseUrl: str(s.jirabaseurl) || data.settings.jiraBaseUrl || '',
    };
    data.themes = table(w.sheets['Themes'], F.theme).filter((t) => str(t.name)).map((t) => ({
      id: str(t.code) || str(t.name), name: str(t.name), description: str(t.description),
      kpi: { name: str(t.kpi), unit: str(t.unit), baseline: num(t.baseline), current: num(t.current), target: num(t.target) },
    }));
    data.productAreas = table(w.sheets['Product Areas'], F.area).filter((a) => str(a.name) && !/^no$/i.test(str(a.active))).map((a) => ({
      id: str(a.code) || str(a.name), name: str(a.name), owner: str(a.owner), deliveryManager: str(a.dm), description: str(a.description),
      category: str(a.category),
    }));
  }

  const areasLoaded = [];
  for (const w of products) {
    const about = keyValues(w.sheets['Product Area'] || w.sheets['About']);
    // Themes from the product workbook's Reference tab are a fallback when no enterprise workbook is loaded.
    const refThemes = table(w.sheets['Reference'] || [], { code: ['themecode', 'code'], name: ['theme', 'strategictheme'] }).filter((t) => str(t.code) && str(t.name));
    refThemes.forEach((t) => { if (!data.themes.some((x) => x.id === str(t.code))) data.themes.push({ id: str(t.code), name: str(t.name), description: '', kpi: {} }); });
    const themeId = (v) => { const n = norm(v); const t = data.themes.find((x) => norm(x.id) === n || norm(x.name) === n); return t ? t.id : str(v); };

    // Product area per row: the row's "Product area" column (combined workbooks), else the Product Area tab B1,
    // else the file name ("Roadmap - CLD.xlsx"), else the initiative ID prefix (CLD-01).
    const areaOf = (v) => { const n = norm(v); if (!n) return ''; const a = data.productAreas.find((x) => norm(x.id) === n || norm(x.name) === n); return a ? a.id : str(v).toUpperCase(); };
    const fromName = (w.fileName.match(/([A-Za-z0-9]{2,10})\.xlsx$/i) || [])[1]?.toUpperCase();
    const b1 = areaOf(about.productareacode || about.productarea);
    const fallback = b1 || (fromName && data.productAreas.some((a) => a.id === fromName) ? fromName : '');
    const rows = table(w.sheets['Initiatives'], F.init);
    rows.filter((i) => !str(i.id) && str(i.title)).forEach((i) => warnings.push(`${w.fileName}: "${str(i.title)}" has no ID and was skipped.`));

    const inits = [];
    let guessed = false;
    for (const i of rows.filter((r) => str(r.id) && str(r.title))) {
      let area = areaOf(i.area) || fallback;
      if (!area) { area = (str(i.id).match(/^([A-Za-z0-9]+)-/) || [])[1]?.toUpperCase() || ''; guessed = !!area; }
      if (!area) { warnings.push(`${w.fileName}: ${str(i.id)} has no product area. Set the Product area column (or the Product Area tab, cell B1).`); continue; }
      inits.push({
        id: str(i.id).toUpperCase(), title: str(i.title), productArea: area, theme: themeId(i.theme),
        horizon: str(i.horizon) || 'Plan', status: str(i.status) || 'Not started', start: day(i.start), end: day(i.end),
        owner: str(i.owner), summary: str(i.summary), jiraEpic: str(i.jira),
        dependsOn: str(i.deps).split(/[;,\s]+/).map((x) => x.toUpperCase()).filter(Boolean),
        riskNote: str(i.risk), lastReviewed: day(i.reviewed) || day(about.lastupdated),
      });
    }
    if (!inits.length) {
      warnings.push(`${w.fileName}: no initiatives to show yet. Pick your product area (Product Area tab, cell B1, or the Product area column), add at least one initiative with an ID, save, and preview again.`);
      continue;
    }
    if (guessed) warnings.push(`${w.fileName}: some rows have no product area, so it was taken from the initiative ID. Set the Product area column to be sure.`);

    const fileAreas = [...new Set(inits.map((i) => i.productArea))];
    for (const area of fileAreas) {
      if (!data.productAreas.some((a) => a.id === area)) {
        data.productAreas.push({ id: area, name: fileAreas.length === 1 ? (str(about.productareaname) || area) : area, owner: '', deliveryManager: str(about.deliverymanager || about.updatedby), description: '' });
        if (enterprise.length || base) warnings.push(`${w.fileName}: product area "${area}" is not in the enterprise setup workbook. It was added, but check the code.`);
      }
      if (!areasLoaded.includes(area)) areasLoaded.push(area);
    }

    const ids = new Set(inits.map((i) => i.id));
    const counter = {};
    const ms = table(w.sheets['Milestones'] || [], F.ms).filter((m) => str(m.title)).map((m) => {
      const ini = str(m.initiative).toUpperCase(); counter[ini] = (counter[ini] || 0) + 1;
      return { id: `${ini}-m${counter[ini]}`, initiative: ini, title: str(m.title), date: day(m.date), type: str(m.type) || 'Release', done: yes(m.done), jiraEpic: str(m.jira) };
    });
    ms.filter((m) => !ids.has(m.initiative)).forEach((m) => warnings.push(`${w.fileName}: milestone "${m.title}" points to initiative "${m.initiative}", which isn't on the Initiatives tab.`));

    // Replace the rows of every area in this file; keep everyone else's.
    const oldIds = new Set(data.initiatives.filter((i) => fileAreas.includes(i.productArea)).map((i) => i.id));
    data.initiatives = data.initiatives.filter((i) => !fileAreas.includes(i.productArea)).concat(inits);
    data.milestones = data.milestones.filter((m) => !oldIds.has(m.initiative) && !ids.has(m.initiative)).concat(ms.filter((m) => ids.has(m.initiative)));
  }

  // Cross-workbook checks
  const seen = {};
  data.initiatives.forEach((i) => { if (seen[i.id] && seen[i.id] !== i.productArea) warnings.push(`Initiative ID ${i.id} is used by both ${seen[i.id]} and ${i.productArea}. IDs must be unique.`); seen[i.id] = i.productArea; });
  data.initiatives.filter((i) => i.theme && !data.themes.some((t) => t.id === i.theme))
    .forEach((i) => warnings.push(`${i.id}: theme "${i.theme}" doesn't match any strategic theme.`));

  data.generatedAt = new Date().toISOString();
  data.source = 'excel';
  return { data, warnings, areasLoaded };
}
