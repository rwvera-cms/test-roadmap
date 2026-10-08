#!/usr/bin/env node
/**
 * Build site/data/roadmap.json from CSV exports of the four MS Lists. No Graph, no app registration.
 *
 * 1. In each list: Export → Export to CSV.
 * 2. Put the four files in data/lists/ (any names that contain "theme", "area", "initiative", "milestone").
 * 3. node scripts/csv-to-roadmap.mjs
 *
 * Headers are matched loosely (case, spaces and punctuation ignored), so either display names
 * ("Start date") or internal names ("StartDate") work. Lookup columns can hold the code (CLD) or the name
 * (Cloud Platform). Dates can be 10/1/2026, 10/1/2026 12:00 AM or 2026-10-01.
 *
 * Optional env: ORG_NAME, FISCAL_YEAR_START_MONTH, JIRA_BASE_URL (same as sync-lists.mjs)
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(root, 'data', 'lists');
const OUT = path.join(root, 'site', 'data', 'roadmap.json');
const env = process.env;

// Accepted header spellings for each field (compared after lowercasing and removing non-letters/digits).
const COLS = {
  title: ['title', 'name', 'initiativename', 'themename', 'productareaname', 'milestonename', 'milestone'],
  code: ['code', 'themecode', 'areacode', 'productareacode'],
  description: ['description'],
  kpiName: ['kpi', 'kpiname'],
  kpiUnit: ['kpiunit', 'unit'],
  kpiBaseline: ['kpibaseline', 'baseline'],
  kpiCurrent: ['kpicurrent', 'current'],
  kpiTarget: ['kpitarget', 'target'],
  sortOrder: ['sortorder', 'order'],
  owner: ['owner', 'productowner'],
  deliveryManager: ['deliverymanager', 'dm'],
  active: ['active'],
  key: ['initiativeid', 'initiativekey', 'key'],
  productArea: ['productarea', 'area'],
  theme: ['strategictheme', 'theme'],
  horizon: ['horizon'],
  status: ['status'],
  start: ['startdate', 'start'],
  end: ['enddate', 'end', 'duedate'],
  summary: ['summary'],
  jiraEpic: ['jiraepic', 'epic', 'jira'],
  dependsOn: ['dependsonids', 'dependson', 'dependencies'],
  riskNote: ['risknote', 'risk', 'risks'],
  lastReviewed: ['lastreviewed', 'reviewed'],
  initiative: ['initiative', 'initiativeid', 'initiativekey'],
  date: ['date', 'milestonedate'],
  type: ['type', 'milestonetype'],
  done: ['done', 'complete', 'completed'],
};

const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function main() {
  let files;
  try { files = (await readdir(DIR)).filter((f) => f.toLowerCase().endsWith('.csv')); }
  catch { throw new Error(`Folder not found: ${DIR}\nCreate data/lists/ and put the four CSV exports in it.`); }
  const pick = (word) => {
    const f = files.find((x) => norm(x).includes(word));
    if (!f) throw new Error(`No CSV with "${word}" in its name in data/lists/. Found: ${files.join(', ') || '(none)'}`);
    return f;
  };
  const load = async (word) => {
    const f = pick(word);
    const rows = parseCsv((await readFile(path.join(DIR, f), 'utf8')).replace(/^﻿/, ''));
    const header = rows.shift() || [];
    const idx = {};
    for (const [field, names] of Object.entries(COLS)) {
      const i = header.findIndex((h) => names.includes(norm(h)));
      if (i >= 0) idx[field] = i;
    }
    const data = rows.filter((r) => r.some((c) => c.trim())).map((r) => {
      const o = {}; for (const [k, i] of Object.entries(idx)) o[k] = (r[i] ?? '').trim(); return o;
    });
    console.log(`${f}: ${data.length} rows, columns matched: ${Object.keys(idx).join(', ')}`);
    return data;
  };

  const [T, A, I, M] = [await load('theme'), await load('area'), await load('initiative'), await load('milestone')];
  const bySort = (a, b) => (num(a.sortOrder) ?? 999) - (num(b.sortOrder) ?? 999);

  const themes = T.sort(bySort).map((t) => ({
    id: t.code || t.title, name: t.title, description: t.description || '',
    kpi: { name: t.kpiName || '', unit: t.kpiUnit || '', baseline: num(t.kpiBaseline), current: num(t.kpiCurrent), target: num(t.kpiTarget) },
  }));
  const areas = A.sort(bySort).filter((a) => !isNo(a.active)).map((a) => ({
    id: a.code || a.title, name: a.title, owner: a.owner || '', deliveryManager: a.deliveryManager || '', description: a.description || '',
  }));
  // Lookup columns export as the looked-up item's title; accept either the code or the name.
  const resolver = (list) => { const m = new Map(); list.forEach((x) => { m.set(norm(x.id), x.id); m.set(norm(x.name), x.id); }); return (v) => m.get(norm(v)) || v; };
  const themeOf = resolver(themes), areaOf = resolver(areas);

  const initiatives = I.filter((i) => i.key).map((i) => ({
    id: i.key, title: i.title, productArea: areaOf(i.productArea), theme: themeOf(i.theme),
    horizon: i.horizon || 'Plan', status: i.status || 'Not started',
    start: day(i.start), end: day(i.end), owner: i.owner || '', summary: i.summary || '',
    jiraEpic: i.jiraEpic || '', dependsOn: (i.dependsOn || '').split(/[;,\s]+/).filter(Boolean),
    riskNote: i.riskNote || '', lastReviewed: day(i.lastReviewed),
  }));
  const initOf = resolver(initiatives.map((i) => ({ id: i.id, name: i.title })));
  const milestones = M.map((m, n) => ({
    id: `m${n + 1}`, initiative: initOf(m.initiative), title: m.title, date: day(m.date),
    type: m.type || 'Release', done: isYes(m.done), jiraEpic: m.jiraEpic || '',
  })).filter((m) => m.initiative);

  const data = {
    source: 'lists-csv',
    generatedAt: new Date().toISOString(),
    settings: { orgName: env.ORG_NAME || 'Samtek', fiscalYearStartMonth: Number(env.FISCAL_YEAR_START_MONTH || 1), jiraBaseUrl: env.JIRA_BASE_URL || '' },
    themes, productAreas: areas, initiatives, milestones,
  };

  // Point out the most common export problems instead of failing silently on the page.
  const unknownArea = initiatives.filter((i) => !areas.some((a) => a.id === i.productArea));
  const unknownTheme = initiatives.filter((i) => !themes.some((t) => t.id === i.theme));
  const noDates = initiatives.filter((i) => !i.start || !i.end);
  if (unknownArea.length) console.warn(`! ${unknownArea.length} initiative(s) have a product area that isn't in Product Areas: ${unknownArea.map((i) => `${i.id}="${i.productArea}"`).join(', ')}`);
  if (unknownTheme.length) console.warn(`! ${unknownTheme.length} initiative(s) have a theme that isn't in Strategic Themes: ${unknownTheme.map((i) => `${i.id}="${i.theme}"`).join(', ')}`);
  if (noDates.length) console.warn(`! ${noDates.length} initiative(s) are missing a start or end date and won't show on the timeline: ${noDates.map((i) => i.id).join(', ')}`);

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data, null, 2));
  console.log(`Wrote ${OUT}: ${initiatives.length} initiatives, ${milestones.length} milestones, ${areas.length} product areas, ${themes.length} themes.`);
}

// RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes.
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Accepts 2026-10-01, 10/1/2026, 10/1/2026 12:00 AM (US month/day order, as Lists exports it).
function day(v) {
  if (!v) return '';
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  return '';
}
function num(v) { if (v === undefined || v === null || String(v).trim() === '') return null; const n = Number(String(v).replace(/[,%$]/g, '')); return isNaN(n) ? null : n; }
function isYes(v) { return ['yes', 'true', '1', 'y'].includes(norm(v)); }
function isNo(v) { return ['no', 'false', '0', 'n'].includes(norm(v)); }

main().catch((e) => { console.error(e.message || e); process.exit(1); });
