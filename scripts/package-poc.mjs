// Package the dashboard for the POC Static Web App: sample data only, no Entra sign-in.
// Usage: node scripts/package-poc.mjs [outDir]   (default: poc-dist)
// Copies site/ without the real data/roadmap.json, so the page falls back to data/roadmap.sample.json.
import { cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] || 'poc-dist';
rmSync(out, { recursive: true, force: true });
cpSync('site', out, { recursive: true, filter: (p) => !p.endsWith(join('data', 'roadmap.json')) && !p.endsWith('.DS_Store') });

const cfgPath = join(out, 'staticwebapp.config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
delete cfg.auth;
delete cfg.responseOverrides;
cfg.routes = [{ route: '/data/*', headers: { 'Cache-Control': 'no-store' } }];
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

console.log(`Wrote ${out}/ (sample data, no sign-in).`);
