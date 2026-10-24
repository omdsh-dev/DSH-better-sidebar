#!/usr/bin/env node
/**
 * Collect the triage snapshot: every open issue and open PR, plus the cheapest
 * "is this already fixed?" evidence (issue-number references in commits and in
 * the working tree).
 *
 * Usage: node snapshot.mjs [--out <dir>] [--limit <n>]
 * Writes <dir>/snapshot.json (structured) and <dir>/digest.md (human digest).
 * Nothing is written back to GitHub: this script is read-only.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'issue-triage')));
const LIMIT = opt('--limit', '400');
fs.mkdirSync(OUT, { recursive: true });

const gh = (cmdArgs, { json = true } = {}) => {
  const out = execFileSync('gh', cmdArgs, { encoding: 'utf8', maxBuffer: 1 << 28 });
  return json ? JSON.parse(out) : out;
};
const git = (cmdArgs) => execFileSync('git', cmdArgs, { encoding: 'utf8', maxBuffer: 1 << 28 });

const clean = (s) => String(s ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s ?? '');

// ---- 1. open issues & PRs -------------------------------------------------
const issues = gh(['issue', 'list', '--state', 'open', '--limit', LIMIT, '--json', 'number,title,labels,author,createdAt,updatedAt,body,comments']);
const prs = gh(['pr', 'list', '--state', 'open', '--limit', LIMIT, '--json', 'number,title,author,createdAt,body']);
const issueNumbers = new Set(issues.map((i) => i.number));

const refs = (text) => [...new Set((String(text ?? '').match(/#(\d{2,5})(?![\dA-Za-z])/g) ?? []).map((m) => +m.slice(1)))];
const prRefs = {}; // issue number -> [pr numbers]
for (const p of prs) {
  for (const n of refs(`${p.title}\n${p.body}`)) if (issueNumbers.has(n)) (prRefs[n] ??= []).push(p.number);
}

// ---- 2. fix evidence from git + tree --------------------------------------
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
const defaultBranch = (() => {
  try { return git(['symbolic-ref', 'refs/remotes/origin/HEAD']).trim().replace('refs/remotes/origin/', ''); }
  catch { return 'main'; }
})();
const fixRefs = {}; // issue number -> { commits: [...], files: [...] }
const record = (n, kind, value) => {
  if (!issueNumbers.has(n)) return;
  const slot = (fixRefs[n] ??= { commits: [], files: [] });
  const list = kind === 'commit' ? slot.commits : slot.files;
  if (!list.includes(value) && list.length < 3) list.push(value);
};
const commitLines = git(['log', '--format=%h%x1f%s', '-n', '4000', '--all']).split('\n').filter(Boolean);
for (const line of commitLines) {
  const [hash, subject] = line.split('\x1f');
  for (const n of refs(subject)) record(n, 'commit', `${hash} ${subject.slice(0, 110)}`);
}
const tracked = git(['ls-files']).split('\n').filter((f) => /\.(md|ts|tsx|mjs|js|json|yml)$/.test(f) && !/^(pnpm-lock|CHANGELOG_EN)/.test(f));
for (const file of tracked) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (!/#\d{2,5}/.test(text)) continue;
  for (const [i, line] of text.split('\n').entries()) {
    // Color literals (`color: #333`) look exactly like issue refs; skip those lines.
    if (/\b(color|background|fill|stroke)\s*:/i.test(line)) continue;
    for (const n of refs(line)) record(n, 'file', `${file}:${i + 1} ${line.trim().slice(0, 120)}`);
  }
}

// ---- 3. digest ------------------------------------------------------------
const ageDays = (iso) => Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
const ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const prioOf = (labels) => labels.map((l) => l.name).find((n) => /^P[0-3]$/.test(n));
const rows = issues
  .map((i) => {
    const labels = i.labels.map((l) => l.name);
    return { ...i, labels, prio: prioOf(labels) };
  })
  .sort((a, b) => (ORDER[a.prio] ?? 9) - (ORDER[b.prio] ?? 9) || a.number - b.number);

const out = [];
out.push(`# Triage snapshot · ${new Date().toISOString().slice(0, 10)}`);
out.push('');
out.push(`- open issues: **${issues.length}** · open PRs: **${prs.length}**`);
const dist = {};
for (const r of rows) dist[r.prio ?? 'no-priority'] = (dist[r.prio ?? 'no-priority'] ?? 0) + 1;
out.push(`- 优先级分布：${Object.entries(dist).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
out.push(`- 基准分支：\`${defaultBranch}\`（当前 \`${branch}\`，引用扫描含 \`--all\`）`);
out.push('');
for (const r of rows) {
  out.push(`### #${r.number} [${r.labels.join(',') || '-'}] ${ageDays(r.createdAt)}d c${r.comments.length} @${r.author.login}`);
  out.push(`T: ${clean(r.title)}`);
  const body = clean(r.body).slice(0, 220);
  if (body) out.push(`B: ${body}`);
  const strangers = r.comments.filter((c) => c.author.login !== r.author.login).slice(0, 2)
    .map((c) => `@${c.author.login}: ${clean(c.body).slice(0, 170)}`);
  if (strangers.length) out.push(`C: ${strangers.join(' || ')}`);
  const fix = fixRefs[r.number];
  if (fix?.commits.length) out.push(`FIX(commit): ${fix.commits.join(' ;; ')}`);
  if (fix?.files.length) out.push(`FIX(file): ${fix.files.join(' ;; ')}`);
  const pr = prRefs[r.number];
  if (pr?.length) out.push(`PR(open): ${pr.slice(0, 6).map((n) => `#${n}`).join(' ')}`);
  out.push('');
}
out.push(`## 没有关联合并 PR 的 open PR (${prs.filter((p) => !refs(`${p.title}\n${p.body}`).some((n) => issueNumbers.has(n))).length})`);
out.push('');
for (const p of prs) {
  if (refs(`${p.title}\n${p.body}`).some((n) => issueNumbers.has(n))) continue;
  out.push(`- #${p.number} ${clean(p.title).slice(0, 110)} (@${p.author.login}, ${ageDays(p.createdAt)}d)`);
}

fs.writeFileSync(path.join(OUT, 'snapshot.json'), JSON.stringify({ generatedAt: new Date().toISOString(), defaultBranch, branch, issues: rows, prs, prRefs, fixRefs }, null, 1));
fs.writeFileSync(path.join(OUT, 'digest.md'), out.join('\n') + '\n');
console.log(`snapshot: ${OUT}`);
console.log(`  issues=${issues.length} prs=${prs.length} withOpenPR=${Object.keys(prRefs).length} fixRefs=${Object.keys(fixRefs).length}`);
console.log(`  likely-CJK-bodied issues: ${issues.filter((i) => hasCJK(i.body)).length}`);
