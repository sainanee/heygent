// check-pins.ts <repo root>: every servers/*/image is a digest pin of the Parley server image, and every production
// pin's digest is listed in passed-on-staging.txt (the digests that passed conformance on staging). A folder with no
// image file is not deployed yet and passes. Exits 1 on any problem.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain, readServers, runCheck } from './servers.ts';

const PIN = /^ghcr\.io\/sainanee\/parley-server@(sha256:[0-9a-f]{64})\n?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The digests in passed-on-staging.txt: one per line; blank lines and `#` comments are allowed, nothing else. */
function readPassed(root: string, problems: string[]): Set<string> {
  const file = join(root, 'passed-on-staging.txt');
  if (!existsSync(file)) return new Set();
  const passed = new Set<string>();
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (line === '' || line.startsWith('#')) return;
      if (DIGEST.test(line)) passed.add(line);
      else problems.push(`passed-on-staging.txt:${i + 1}: not a digest (sha256:<64 hex>)`);
    });
  return passed;
}

export function checkPins(root: string): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const passed = readPassed(root, problems);
  for (const s of readServers(root)) {
    if (s.image === null) {
      notes.push(`servers/${s.folder}: no image yet (not deployed)`);
      continue;
    }
    const m = PIN.exec(s.image);
    if (m === null) {
      problems.push(`servers/${s.folder}/image: must be one line, ghcr.io/sainanee/parley-server@sha256:<64 hex> (a digest, never a tag)`);
      continue;
    }
    const digest = m[1]!;
    if (s.production && !passed.has(digest)) {
      problems.push(`servers/${s.folder}/image: ${s.app} is production and ${digest} is not in passed-on-staging.txt`);
    } else {
      notes.push(`servers/${s.folder}: ${digest}${s.production ? ' (passed on staging)' : ''}`);
    }
  }
  return { problems, notes };
}

if (isMain(import.meta.url)) runCheck('check-pins', checkPins);
