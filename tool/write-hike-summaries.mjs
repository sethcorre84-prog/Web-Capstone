// tool/write-hike-summaries.mjs
// Rebuilds the whole hikeSummaries collection by hand. The Cloud Functions
// updateHikeSummaryOnUser / OnSession / OnTrail keep it up to date on their
// own; this is for a first fill, or to check them. Both use the same
// builder (jsPages/hike-summary.js), so they write the same documents.
//
// Read-only on every other collection: users/{uid} profiles are never
// written. Summaries of accounts that no longer have a hike (or are no
// longer hikers) are deleted.
//
//   node tool/write-hike-summaries.mjs          dry run (prints, writes nothing)
//   node tool/write-hike-summaries.mjs --apply  writes the collection
//
// Uses the Firebase CLI's signed-in account (firebase login) for project
// peakpath-ccd4a, through the Firestore REST API.

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { execSync } from 'child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'projects/peakpath-ccd4a/databases/(default)';
const APPLY = process.argv.includes('--apply');

const { buildHikeSummary, summaryFingerprint } = await import(pathToFileURL(path.join(ROOT, 'jsPages/hike-summary.js')));

const FT = path.join(execSync('npm root -g').toString().trim(), 'firebase-tools', 'lib');
const { requireAuth } = require(path.join(FT, 'requireAuth'));
const { Client } = require(path.join(FT, 'apiv2'));
const account = require(path.join(FT, 'auth')).getGlobalDefaultAccount();
if (!account) throw new Error('Run "firebase login" first.');
await requireAuth({ user: account.user, tokens: account.tokens });
const api = new Client({ urlPrefix: 'https://firestore.googleapis.com', apiVersion: 'v1' });

const plain = (v) => v == null ? v : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue)
  : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null
  : 'timestampValue' in v ? new Date(v.timestampValue) : 'arrayValue' in v ? (v.arrayValue.values || []).map(plain)
  : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, plain(x)])) : null;
const encode = (v) => v === null || v === undefined ? { nullValue: null }
  : v instanceof Date ? { timestampValue: v.toISOString() }
  : Array.isArray(v) ? { arrayValue: { values: v.map(encode) } }
  : typeof v === 'string' ? { stringValue: v }
  : typeof v === 'boolean' ? { booleanValue: v }
  : Number.isInteger(v) ? { integerValue: String(v) }
  : typeof v === 'number' ? { doubleValue: v }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } };
const list = async (collection) => {
  let docs = [], token = '';
  do {
    const { body } = await api.get(`${DB}/documents/${collection}?pageSize=300${token ? `&pageToken=${token}` : ''}`);
    docs = docs.concat(body.documents || []); token = body.nextPageToken || '';
  } while (token);
  return docs.map((d) => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, plain(v)])) }));
};

const [users, trails, sessions, existing] = await Promise.all([list('users'), list('trails'), list('hikeSessions'), list('hikeSummaries')]);
const stored = new Map(existing.map((doc) => [doc.id, doc]));
const writes = [];
let unchanged = 0;
const built = [];
users.forEach((user) => {
  const summary = buildHikeSummary(user, { sessions, trails });
  if (!summary) return;
  built.push(summary);
  if (summaryFingerprint(stored.get(user.id)) === summaryFingerprint(summary)) { unchanged += 1; return; }
  writes.push({ update: { name: `${DB}/documents/hikeSummaries/${user.id}`, fields: Object.fromEntries(Object.entries({
    ...summary, generatedAt: new Date(), generatedBy: 'tool/write-hike-summaries.mjs (jsPages/hike-summary.js)'
  }).map(([k, v]) => [k, encode(v)])) } });
});
const keep = new Set(built.map((s) => s.uid));
const stale = existing.filter((doc) => !keep.has(doc.id));
stale.forEach((doc) => writes.push({ delete: `${DB}/documents/hikeSummaries/${doc.id}` }));

const app = built.filter((s) => s.accountType === 'App user').length;
console.log(`${built.length} hikers with hikes (${app} app users, ${built.length - app} imported dummy).`);
console.log(`to write: ${writes.length - stale.length} | already up to date: ${unchanged} | to delete (no longer a hiker with hikes): ${stale.length}`);
if (!APPLY) { console.log('Dry run: nothing written. Add --apply to write.'); process.exit(0); }
if (!writes.length) { console.log('Nothing to write.'); process.exit(0); }
const { body } = await api.post(`${DB}/documents:commit`, { writes });
console.log(`Committed ${body.writeResults.length} writes to hikeSummaries at ${body.commitTime}.`);
