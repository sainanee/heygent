// Reads servers/*: each folder is one Fly app. Its fly.toml names the app; its `image` file, when present, pins the
// image (no file = not deployed yet). An app is staging when its name ends in `-staging`, and production otherwise:
// the name decides, never the folder's own settings, so a production app that claims test mode is still production.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Server {
  /** The folder name under servers/. */
  folder: string;
  dir: string;
  /** The Fly app name, from fly.toml's `app`. */
  app: string;
  production: boolean;
  /** The `image` file's contents, or null when the folder has none yet. */
  image: string | null;
}

const APP_LINE = /^app\s*=\s*"([a-z0-9][a-z0-9-]*)"\s*(?:#.*)?$/m;

export function readServers(root: string): Server[] {
  const base = join(root, 'servers');
  if (!existsSync(base)) throw new Error(`${base} does not exist`);
  return readdirSync(base)
    .filter((folder) => statSync(join(base, folder)).isDirectory())
    .sort()
    .map((folder) => {
      const dir = join(base, folder);
      const toml = join(dir, 'fly.toml');
      if (!existsSync(toml)) throw new Error(`servers/${folder}: no fly.toml`);
      const m = APP_LINE.exec(readFileSync(toml, 'utf8'));
      if (m === null) throw new Error(`servers/${folder}/fly.toml: no app = "<name>" line`);
      const app = m[1]!;
      const imageFile = join(dir, 'image');
      return {
        folder,
        dir,
        app,
        production: !app.endsWith('-staging'),
        image: existsSync(imageFile) ? readFileSync(imageFile, 'utf8') : null,
      };
    });
}

/** True when the module at `url` is the script node was started with (not imported). */
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(url);
}

/** Runs a check over the repo at argv[2] (default .): prints its problems to stderr and exits 1 if there are any. */
export function runCheck(name: string, check: (root: string) => { problems: string[]; notes: string[] }): void {
  const root = process.argv[2] ?? '.';
  let result: { problems: string[]; notes: string[] };
  try {
    result = check(root);
  } catch (e) {
    result = { problems: [e instanceof Error ? e.message : String(e)], notes: [] };
  }
  for (const n of result.notes) console.log(n);
  for (const p of result.problems) console.error(p);
  if (result.problems.length > 0) {
    console.error(`${name}: ${result.problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`${name}: ok`);
}
