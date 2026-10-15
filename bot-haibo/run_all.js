#!/usr/bin/env node
'use strict';
/**
 * run_all.js — sequential runner for every project in projects.json.
 *
 * Usage:
 *   node run_all.js                      # all projects, all queries
 *   node run_all.js haibomotor gir-master # only listed projects
 *   node run_all.js --limit 2            # max 2 queries per project
 *   node run_all.js --delay 60           # 60s pause between projects
 *   node run_all.js --retries 1          # retry failed queries once
 *
 * Each project is executed sequentially by spawning
 * `node yandex_search_visit.js --project <name> [queries...]` as its own
 * child process, so one failing project never kills the whole batch.
 * Failures are retried up to --retries times (default 0).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'projects.json'), 'utf8')
);

function parseArgs(argv) {
  const names = [];
  let limit = 0; // 0 = no limit
  let delay = 30; // seconds between projects
  let retries = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') { limit = Number(argv[++i]) || 0; }
    else if (a === '--delay') { delay = Number(argv[++i]) || 0; }
    else if (a === '--retries' || a === '--retry') { retries = Number(argv[++i]) || 0; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node run_all.js [project ...] [--limit N] [--delay SECONDS] [--retries N]');
      console.log('Projects: ' + Object.keys(PROJECTS).join(', '));
      process.exit(0);
    } else if (a.startsWith('--')) { console.warn(`Unknown flag: ${a}`); }
    else names.push(a);
  }
  const unknown = names.filter((n) => !PROJECTS[n]);
  if (unknown.length) {
    console.error(`Unknown project(s): ${unknown.join(', ')}`);
    console.error(`Available: ${Object.keys(PROJECTS).join(', ')}`);
    process.exit(1);
  }
  return { names: names.length ? names : Object.keys(PROJECTS), limit, delay, retries };
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function runProject(name, queries) {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, 'yandex_search_visit.js'), '--project', name, ...queries];
    const child = spawn(process.execPath, args, { cwd: __dirname, stdio: 'inherit' });
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', (e) => { console.error(`  spawn error: ${e.message}`); resolve({ code: 1, signal: null }); });
  });
}

(async () => {
  const { names, limit, delay, retries } = parseArgs(process.argv.slice(2));
  console.log('==============================================');
  console.log('=== Batch runner: ' + names.length + ' project(s) ===');
  console.log('Projects: ' + names.join(', '));
  if (limit) console.log(`Limit: ${limit} queries per project`);
  if (retries) console.log(`Retries: ${retries} per failed query`);
  console.log('==============================================\n');

  const results = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const project = PROJECTS[name];
    let queries = (project.queries || []).slice();
    if (limit > 0) queries = queries.slice(0, limit);

    console.log('\n\n########################################');
    console.log(`### [${i + 1}/${names.length}] ${name} (${project.targetDomain}) — ${queries.length} queries`);
    console.log('########################################');

    let attempt = 0;
    let res;
    do {
      res = await runProject(name, queries);
      attempt++;
      if (res.code === 0) break;
      if (attempt <= retries) console.log(`  ↻ ${name} exit=${res.code}, retry ${attempt}/${retries}...`);
    } while (attempt <= retries);

    results.push({ name, ok: res.code === 0, code: res.code, signal: res.signal });
    console.log(`### ${name}: ${res.code === 0 ? '✓ OK' : '✗ FAILED (exit ' + res.code + (res.signal ? '/' + res.signal : '') + ')'}\n`);

    if (i < names.length - 1 && delay > 0) {
      console.log(`--- cooling down ${delay}s ---`);
      await sleep(delay);
    }
  }

  console.log('\n\n==============================================');
  console.log('=== BATCH SUMMARY ===');
  const ok = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' (exit ' + r.code + (r.signal ? '/' + r.signal : '') + ')'}`);
  console.log(`Total: ${results.length} | OK: ${ok} | Failed: ${results.length - ok}`);
  console.log('==============================================');
  process.exit(results.every((r) => r.ok) ? 0 : 2);
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });
