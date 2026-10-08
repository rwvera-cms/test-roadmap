#!/usr/bin/env node
/**
 * Pull the roadmap from MS Lists (SharePoint) via Microsoft Graph and write site/data/roadmap.json.
 * Node 24+, no dependencies.
 *
 * Required env (GitHub Actions secrets/vars):
 *   GRAPH_TOKEN (local testing only)     A delegated token copied from Graph Explorer. Skips the app registration.
 *                                         Expires in about an hour. Never store it in GitHub.
 *   TENANT_ID, CLIENT_ID, CLIENT_SECRET   Entra app with Graph application permission Sites.Selected,
 *                                         granted Read on the roadmap site (see README step 2)
 *   SP_SITE                               e.g.  samtek.sharepoint.com:/sites/EnterpriseRoadmap
 * Optional:
 *   JIRA_BASE_URL                         e.g.  https://samtek.atlassian.net  (used for epic links)
 *   LIST_SUFFIX                           Appended to every list name, e.g. " POC" (note the leading space)
 *   ORG_NAME                              shown in the page header (default "Samtek")
 *   FISCAL_YEAR_START_MONTH               1-12 (default 1 = calendar year; 10 = US federal FY)
 *
 * If TENANT_ID is not set, the script copies the sample data so the site still deploys.
 */
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'site', 'data', 'roadmap.json');
const SAMPLE = path.join(root, 'site', 'data', 'roadmap.sample.json');

const env = process.env;
// Display names of the four lists. LIST_SUFFIX lets test copies coexist, e.g. LIST_SUFFIX=" POC" reads "Initiatives POC".
const sfx = env.LIST_SUFFIX || '';
const LISTS = { themes: 'Strategic Themes' + sfx, areas: 'Product Areas' + sfx, initiatives: 'Initiatives' + sfx, milestones: 'Milestones' + sfx };
const GRAPH = 'https://graph.microsoft.com/v1.0';

async function main() {
  await mkdir(path.dirname(OUT), { recursive: true });
  if (!env.TENANT_ID && !env.GRAPH_TOKEN) {
    if (!env.GITHUB_ACTIONS) {
      throw new Error('No credentials found. Set GRAPH_TOKEN (local test) or TENANT_ID/CLIENT_ID/CLIENT_SECRET, in this same Terminal window, then run again.');
    }
    console.warn('No credentials in GitHub secrets: publishing sample data.');
    await writeFile(OUT, await readFile(SAMPLE));
    return;
  }
  console.log(`Reading lists from ${env.SP_SITE} using ${env.GRAPH_TOKEN ? 'your Graph Explorer token' : 'the app registration'}...`);

  const token = env.GRAPH_TOKEN || await getToken();
  if (!env.SP_SITE) throw new Error('Missing env SP_SITE');
  const get = async (url) => {
    const r = await fetch(url.startsWith('http') ? url : GRAPH + url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Graph ${r.status} on ${url}\n${await r.text()}`);
    return r.json();
  };
  const all = async (url) => { // follow @odata.nextLink paging
    const out = [];
    for (let next = url; next;) { const page = await get(next); out.push(...page.value); next = page['@odata.nextLink']; }
    return out;
  };

  const site = await get(`/sites/${env.SP_SITE}`);
  const lists = await all(`/sites/${site.id}/lists?$select=id,displayName,name`);
  // Forgiving match: ignores case and extra spaces, and also accepts the list's URL name (e.g. "StrategicThemesPOC").
  const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, '');
  const listId = (name) => {
    const l = lists.find((x) => norm(x.displayName) === norm(name) || norm(x.name) === norm(name));
    if (!l) {
      const found = lists.map((x) => `  - "${x.displayName}"  (url name: ${x.name})`).join('\n');
      throw new Error(`List "${name}" not found on ${env.SP_SITE}.\nLists on this site:\n${found || '  (none returned — check the token has Sites.Read.All)'}`);
    }
    return l.id;
  };
  const items = async (name) => (await all(`/sites/${site.id}/lists/${listId(name)}/items?$expand=fields&$top=500`)).map((i) => ({ itemId: i.id, ...i.fields }));

  const [T, A, I, M] = await Promise.all([items(LISTS.themes), items(LISTS.areas), items(LISTS.initiatives), items(LISTS.milestones)]);

  // Lookup columns arrive as <Name>LookupId (the SharePoint item id). Map those to our short codes.
  const themeCode = Object.fromEntries(T.map((t) => [String(t.itemId), t.Code]));
  const areaCode = Object.fromEntries(A.map((a) => [String(a.itemId), a.Code]));
  const initKey = Object.fromEntries(I.map((i) => [String(i.itemId), i.InitiativeKey]));
  const bySort = (a, b) => (a.SortOrder ?? 999) - (b.SortOrder ?? 999);

  const data = {
    source: 'lists',
    generatedAt: new Date().toISOString(),
    settings: {
      orgName: env.ORG_NAME || 'Samtek',
      fiscalYearStartMonth: Number(env.FISCAL_YEAR_START_MONTH || 1),
      jiraBaseUrl: env.JIRA_BASE_URL || '',
    },
    themes: T.sort(bySort).map((t) => ({
      id: t.Code, name: t.Title, description: t.Description || '',
      kpi: { name: t.KpiName || '', unit: t.KpiUnit || '', baseline: num(t.KpiBaseline), current: num(t.KpiCurrent), target: num(t.KpiTarget) },
    })),
    productAreas: A.sort(bySort).filter((a) => a.Active !== false).map((a) => ({
      id: a.Code, name: a.Title, owner: a.ProductOwner || '', deliveryManager: a.DeliveryManager || '', description: a.Description || '',
    })),
    initiatives: I.filter((i) => i.InitiativeKey).map((i) => ({
      id: i.InitiativeKey,
      title: i.Title,
      productArea: ref(i, 'ProductArea', areaCode),
      theme: ref(i, 'Theme', themeCode),
      horizon: i.Horizon || 'Plan',
      status: i.Status || 'Not started',
      start: day(i.StartDate),
      end: day(i.EndDate),
      owner: i.Owner || '',
      summary: i.Summary || '',
      jiraEpic: (i.JiraEpic || '').trim(),
      dependsOn: String(i.DependsOn || '').split(/[;,\s]+/).map((s) => s.trim()).filter(Boolean),
      riskNote: i.RiskNote || '',
      lastReviewed: day(i.LastReviewed),
    })),
    milestones: M.map((m) => ({
      id: String(m.itemId),
      initiative: ref(m, 'Initiative', initKey),
      title: m.Title,
      date: day(m.MilestoneDate),
      type: m.MilestoneType || 'Release',
      done: !!m.Done,
      jiraEpic: (m.JiraEpic || '').trim(),
    })).filter((m) => m.initiative),
  };

  await writeFile(OUT, JSON.stringify(data, null, 2));
  console.log(`Wrote ${OUT}: ${data.initiatives.length} initiatives, ${data.milestones.length} milestones, ${data.productAreas.length} product areas.`);
}

async function getToken() {
  for (const k of ['TENANT_ID', 'CLIENT_ID', 'CLIENT_SECRET', 'SP_SITE']) if (!env[k]) throw new Error(`Missing env ${k}`);
  const r = await fetch(`https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  if (!r.ok) throw new Error(`Token request failed ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

// SharePoint returns date-only columns as UTC midnight of the site's time zone (e.g. 2026-07-01T04:00:00Z
// for US Eastern). Taking the first 10 chars is correct for sites west of UTC (all US time zones).
// Works whether the column is a Lookup (Graph returns <Name>LookupId) or a Choice/text column holding the code.
function ref(row, name, byItemId) {
  if (row[name + 'LookupId'] !== undefined) return byItemId[String(row[name + 'LookupId'])] || '';
  return String(row[name] ?? '').trim();
}
function day(v) { return v ? String(v).slice(0, 10) : ''; }
function num(v) { return v === undefined || v === null || v === '' ? null : Number(v); }

main().catch((e) => { console.error(e.message || e); process.exit(1); });
