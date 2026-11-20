// tool/copy-shared-to-functions.mjs
// Copies the portal's hike-counting modules into functions/shared, where the
// Cloud Functions can load them (only the functions folder is deployed).
// Runs before every functions deploy (firebase.json "predeploy"), so the
// functions always count exactly like the website. Edit the files in
// jsPages/, never the copies.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['hike-events.js', 'hike-history.js', 'hike-summary.js'];
const target = path.join(ROOT, 'functions', 'shared');
fs.mkdirSync(target, { recursive: true });

FILES.forEach((file) => {
  const source = fs.readFileSync(path.join(ROOT, 'jsPages', file), 'utf-8');
  // .mjs, so Node loads them as ES modules inside the CommonJS functions.
  const body = source.replace(/from '\.\/([a-z-]+)\.js'/g, "from './$1.mjs'");
  const header = `// GENERATED from jsPages/${file} by tool/copy-shared-to-functions.mjs\n// at every functions deploy. Do not edit: change jsPages/${file} instead.\n\n`;
  fs.writeFileSync(path.join(target, file.replace(/\.js$/, '.mjs')), header + body);
});
console.log(`Copied ${FILES.join(', ')} to functions/shared.`);
