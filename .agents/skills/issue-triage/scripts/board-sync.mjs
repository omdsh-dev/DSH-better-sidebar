#!/usr/bin/env node
/**
 * Sync the triage queue to the Projects v2 board.
 *
 * Idempotent: resolves the project/fields/options by NAME, adds only missing
 * items, and writes a field value only when it differs. Read-only with
 * --dry-run; --verify only reads and asserts invariants.
 *
 * Usage:
 *   node board-sync.mjs [--dry-run] [--verify] [--org omdsh-dev]
 *                       [--project "DSH-better-sidebar · 排期看板"]
 *
 * Requires the `project` scope (`gh auth refresh -s project`). Facts about the
 * API limits this script works around: ../references/gh-gotchas.md
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const ORG = opt('--org', 'omdsh-dev');
const PROJECT_TITLE = opt('--project', 'DSH-better-sidebar · 排期看板');
const DRY = flag('--dry-run');
const VERIFY_ONLY = flag('--verify');
const STATUS = { todo: 'Todo', review: '等待审核', dev: '等待开发', done: 'Done' };
const OPTIONS = {
  '优先级': ['P0', 'P1', 'P2', 'P3'],
  '批次': ['R1 · 立即', 'R2 · 下一窗口', 'R3 · 待排期', 'R0 · 等 PR review'],
};
const COLORS = ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE', 'GRAY'];
const promoted = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'references', 'promoted.json'), 'utf8')).R1 ?? [];

const gql = (query) => {
  const out = execFileSync('gh', ['api', 'graphql', '-f', 'query=' + query], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const parsed = JSON.parse(out);
  if (parsed.errors?.length) throw new Error(parsed.errors.map((e) => e.message).join('; '));
  return parsed.data;
};

// ---- 1. locate (or create) the project ------------------------------------
const findProject = () => {
  const list = gql(`{organization(login:"${ORG}"){projectsV2(first:50){nodes{id number title public}}}}`)
    .organization.projectsV2.nodes;
  return list.find((p) => p.title === PROJECT_TITLE);
};
let project = findProject();
if (!project && !DRY && !VERIFY_ONLY) {
  const orgId = gql(`{organization(login:"${ORG}"){id}}`).organization.id;
  const created = gql(`mutation{createProjectV2(input:{ownerId:"${orgId}",title:"${PROJECT_TITLE}"}){projectV2{id number title public}}}`).createProjectV2.projectV2;
  project = created;
  console.log(`created project #${created.number}`);
}
if (!project) throw new Error(`project "${PROJECT_TITLE}" not found under ${ORG} (create it, or drop --dry-run)`);
const PROJECT = project.id;
console.log(`project: #${project.number} ${project.title}${project.public ? ' (public)' : ' (private — 组织 owner 才能在 Settings → Visibility 改)'}`);

// ---- 2. fields: create missing, resolve ids by name ----------------------
const FIELDS = `{organization(login:"${ORG}"){projectV2(number:${project.number}){fields(first:50){nodes{... on ProjectV2FieldCommon{id name}
  ... on ProjectV2SingleSelectField{options{id name}}}}}}}`;
const readFields = () => gql(FIELDS.replace(/\n\s*/g, ' ')).organization.projectV2.fields.nodes;
let fields = readFields();
for (const [name, options] of Object.entries(OPTIONS)) {
  if (fields.some((f) => f.name === name)) continue;
  if (DRY) { console.log(`[dry] would create field ${name}`); continue; }
  gql(`mutation{createProjectV2Field(input:{projectId:"${PROJECT}",dataType:SINGLE_SELECT,name:"${name}",singleSelectOptions:[${options
    .map((o, i) => `{name:"${o}",color:${COLORS[i % COLORS.length]},description:""}`).join(',')}]}){projectV2Field{... on ProjectV2SingleSelectField{id name}}}}`);
  console.log(`created field ${name}`);
}
fields = readFields();
const fieldId = {}, optionId = {};
for (const f of fields) { fieldId[f.name] = f.id; for (const o of f.options ?? []) optionId[`${f.name}:${o.name}`] = o.id; }

// Status options must exist; replacing options wipes values, so only rewrite
// when something is missing, and re-apply every Status afterwards.
const statusField = fields.find((f) => f.name === 'Status');
const wantStatus = ['Todo', STATUS.review, STATUS.dev, STATUS.done];
const missingStatus = wantStatus.filter((name) => !statusField.options.some((o) => o.name === name));
let statusRewritten = false;
if (missingStatus.length && !DRY && !VERIFY_ONLY) {
  gql(`mutation{updateProjectV2Field(input:{fieldId:"${statusField.id}",singleSelectOptions:[${wantStatus
    .map((name, i) => `{name:"${name}",color:${COLORS[i % COLORS.length]},description:""}`).join(',')}]}){projectV2Field{... on ProjectV2SingleSelectField{options{id name}}}}}`);
  statusRewritten = true;
  console.log(`rewrote Status options (missing: ${missingStatus.join(', ')}); all item values will be re-applied`);
}
if (statusRewritten) {
  fields = readFields();
  for (const f of fields) {
    fieldId[f.name] = f.id;
    for (const o of f.options ?? []) optionId[`${f.name}:${o.name}`] = o.id;
  }
} else if (missingStatus.length) {
  console.log(`[dry] would add Status options: ${missingStatus.join(', ')}`);
}

// ---- 3. desired state from GitHub ----------------------------------------
const json = (a) => JSON.parse(execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 28 }));
/** `gh` printing a bare string (e.g. --jq .node_id) — not JSON. */
const text = (a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const openIssues = json(['issue', 'list', '--limit', '400', '--state', 'open', '--json', 'number,title,labels']);
const openPRs = json(['pr', 'list', '--limit', '400', '--state', 'open', '--json', 'number,title,body,id']);
const refs = (text) => [...new Set((String(text ?? '').match(/#(\d{2,5})(?![\dA-Za-z])/g) ?? []).map((m) => +m.slice(1)))];
const issueByNumber = new Map(openIssues.map((i) => [i.number, i]));
const prioOfIssue = new Map();
for (const i of openIssues) {
  const p = i.labels.map((l) => l.name).find((n) => /^P[0-3]$/.test(n));
  if (p) prioOfIssue.set(i.number, p);
}
const hasOpenPR = new Set();
for (const p of openPRs) for (const n of refs(`${p.title}\n${p.body}`)) if (issueByNumber.has(n)) hasOpenPR.add(n);

const RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const desired = new Map(); // "issue:123" | "pr:123" -> { prio?, batch?, status }
for (const i of openIssues) {
  const prio = prioOfIssue.get(i.number);
  const batch = !prio
    ? undefined
    : hasOpenPR.has(i.number)
      ? 'R0 · 等 PR review'
      : (prio === 'P0' || prio === 'P1' || promoted.includes(i.number)) ? 'R1 · 立即' : prio === 'P2' ? 'R2 · 下一窗口' : 'R3 · 待排期';
  desired.set(`issue:${i.number}`, {
    prio,
    batch,
    status: !prio ? STATUS.todo : hasOpenPR.has(i.number) ? STATUS.review : STATUS.dev,
  });
}
for (const p of openPRs) {
  const refsFromOpen = refs(`${p.title}\n${p.body}`).filter((n) => prioOfIssue.has(n));
  const prio = refsFromOpen.length ? refsFromOpen.map((n) => prioOfIssue.get(n)).sort((a, b) => RANK[a] - RANK[b])[0] : undefined;
  desired.set(`pr:${p.number}`, { prio, batch: 'R0 · 等 PR review', status: STATUS.review, nodeId: p.id });
}

if (VERIFY_ONLY && !DRY) { verify(); process.exit(0); }
if (DRY) {
  const byStatus = {}, byBatch = {};
  for (const d of desired.values()) { byStatus[d.status] = (byStatus[d.status] ?? 0) + 1; byBatch[d.batch ?? '(none)'] = (byBatch[d.batch ?? '(none)'] ?? 0) + 1; }
  console.log(`[dry] desired items: issues=${openIssues.length} prs=${openPRs.length}`);
  console.log(`[dry] Status:`, byStatus);
  console.log(`[dry] 批次:`, byBatch);
  process.exit(0);
}

// ---- 4. items + values ----------------------------------------------------
const items = new Map(); // "issue:123" -> item id
let cursor = null;
do {
  const r = gql(`{organization(login:"${ORG}"){projectV2(number:${project.number}){items(first:100${cursor ? `,after:"${cursor}"` : ''}){pageInfo{hasNextPage endCursor} nodes{id content{__typename ... on Issue{number} ... on PullRequest{number}} fieldValues(first:20){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{name}}}}}}}}}}`);
  const conn = r.organization.projectV2.items;
  for (const it of conn.nodes) {
    const kind = it.content.__typename === 'PullRequest' ? 'pr' : 'issue';
    if (!it.content.number) continue;
    const current = {};
    for (const fv of it.fieldValues.nodes) if (fv.field?.name) current[fv.field.name] = fv.name;
    items.set(`${kind}:${it.content.number}`, { id: it.id, current });
  }
  cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
} while (cursor);

const mutations = [];
for (const [key, want] of desired) {
  let item = items.get(key);
  if (!item) {
    const nodeId = key.startsWith('pr:') ? want.nodeId : text(['api', `repos/${ORG}/DSH-better-sidebar/issues/${key.split(':')[1]}`, '--jq', '.node_id']);
    const added = gql(`mutation{addProjectV2ItemById(input:{projectId:"${PROJECT}",contentId:"${nodeId}"}){item{id}}}`).addProjectV2ItemById.item;
    item = { id: added.id, current: {} };
    items.set(key, item);
    console.log(`+ ${key}`);
  }
  const wantValues = { '优先级': want.prio, '批次': want.batch, 'Status': want.status };
  for (const [name, value] of Object.entries(wantValues)) {
    if (!value || item.current[name] === value) continue;
    const oid = optionId[`${name}:${value}`];
    if (!oid) { console.log(`! ${key} no option ${name}:${value}`); continue; }
    mutations.push({ itemId: item.id, fieldId: fieldId[name], optionId: oid });
  }
}
for (let i = 0; i < mutations.length; i += 16) {
  const chunk = mutations.slice(i, i + 16);
  gql('mutation{' + chunk.map((m, k) => `m${k}:updateProjectV2ItemFieldValue(input:{projectId:"${PROJECT}",itemId:"${m.itemId}",fieldId:"${m.fieldId}",value:{singleSelectOptionId:"${m.optionId}"}}){projectV2Item{id}}`).join(' ') + '}');
}
console.log(`items: ${items.size} on board | field writes: ${mutations.length}`);
verify();

// ---- 5. read-back verification -------------------------------------------
function verify() {
  const seen = new Map();
  let cursor = null, count = 0;
  do {
    const r = gql(`{organization(login:"${ORG}"){projectV2(number:${project.number}){items(first:100${cursor ? `,after:"${cursor}"` : ''}){pageInfo{hasNextPage endCursor} nodes{content{__typename ... on Issue{number} ... on PullRequest{number}} fieldValues(first:20){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{name}}}}}}}}}}`);
    const conn = r.organization.projectV2.items;
    for (const it of conn.nodes) {
      const kind = it.content.__typename === 'PullRequest' ? 'pr' : 'issue';
      const values = {};
      for (const fv of it.fieldValues.nodes) if (fv.field?.name) values[fv.field.name] = fv.name;
      seen.set(`${kind}:${it.content.number}`, values);
      count++;
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  const miss = [], wrong = [];
  for (const [key, want] of desired) {
    const got = seen.get(key);
    if (!got) { miss.push(key); continue; }
    if ((want.prio ?? undefined) !== got['优先级']) wrong.push(`${key} 优先级 ${got['优先级'] ?? '-'} ≠ ${want.prio ?? '-'}`);
    if (want.batch && want.batch !== got['批次']) wrong.push(`${key} 批次 ${got['批次'] ?? '-'} ≠ ${want.batch}`);
    if (want.status !== got['Status']) wrong.push(`${key} Status ${got['Status'] ?? '-'} ≠ ${want.status}`);
  }
  // one priority label per issue
  const multi = openIssues.filter((i) => i.labels.map((l) => l.name).filter((n) => /^P[0-3]$/.test(n)).length > 1).map((i) => `#${i.number}`);
  const ok = miss.length === 0 && wrong.length === 0 && multi.length === 0;
  console.log(`verify: board items=${count} expected=${desired.size} missing=${miss.length} mismatched=${wrong.length} multi-P-label=${multi.length} → ${ok ? 'OK' : 'FAIL'}`);
  for (const m of [...miss, ...wrong, ...multi].slice(0, 12)) console.log('  -', m);
  if (!ok) process.exitCode = 1;
}
