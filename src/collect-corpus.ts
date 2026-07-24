import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { DATASET_PATH, CORPUS_DIR, npmNameToDir } from './config';

/**
 * collect-corpus.ts — build the raw library-source corpus that the new
 * fingerprint DB is constructed from.
 *
 * For every "pkg@version" in the dataset's groundTruth, this downloads that
 * exact npm package version's tarball and lays its JS out as
 *
 *     corpus/{dir}/{version}/<relative path>.js
 *
 * where {dir} encodes scoped names (@scope/name -> @scope__name) so the flat
 * {lib}/{version} layout DEBUN's DB builder expects still holds. A manifest.json
 * records the dir<->npm name mapping plus which versions were collected vs
 * unavailable (private / unpublished / 404). The run is resumable: a version
 * whose directory already contains files is skipped.
 *
 * Usage:
 *   npm run collect                       # ALL clean-release versions of every GT package (default)
 *   npm run collect -- --versions gt      # only the ground-truth versions (faster, but leaks labels)
 *   npm run collect -- --limit 20         # only the first 20 packages (smoke test)
 *   npm run collect -- --only uuid,tslib  # specific packages
 */

const REGISTRY = 'https://registry.npmjs.org';
// Kept low: a sustained high-concurrency burst gets the npm registry to
// rate-limit (429), which is what wrecked the first full run.
const CONCURRENCY = 4;
const RETRIES = 6;
/** Clean release versions only (no prerelease suffix) — matches DEBUN's DB filter. */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with retry + rate-limit-aware backoff. Returns the Response on success,
 * null on a genuine 404, and null after exhausting retries. On 429/5xx it backs
 * off exponentially (honoring Retry-After when the server sends it) so a long
 * unattended run rides through throttling instead of marking versions missing.
 */
async function fetchRetry(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null; // genuinely missing — don't retry
      if (res.ok) return res;
      // 429 / 5xx / other: back off and retry.
      if (attempt < RETRIES - 1) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
        const wait = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : Math.min(30000, 1000 * 2 ** attempt) + Math.floor(200 * attempt);
        await sleep(wait);
      }
    } catch {
      if (attempt < RETRIES - 1) await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  }
  return null;
}

interface DatasetEntry {
  groundTruth: string[];
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val =
        argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  return args;
}

/** Split "pkg@version" — careful with scoped "@scope/name@version". */
function splitNameVersion(spec: string): [string, string] {
  const at = spec.lastIndexOf('@');
  return [spec.slice(0, at), spec.slice(at + 1)];
}

function registryUrl(name: string): string {
  // Encode the scope slash; leave the leading @ literal.
  return `${REGISTRY}/${name.replace('/', '%2F')}`;
}

async function fetchJSON(url: string): Promise<any | null> {
  const res = await fetchRetry(url);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function downloadTarball(url: string, dest: string): Promise<boolean> {
  const res = await fetchRetry(url);
  if (!res) return false;
  try {
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

function collectJSFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJSFiles(full));
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

interface PkgResult {
  npmName: string;
  dir: string;
  collected: string[];
  unavailable: string[];
}

async function collectPackage(
  npmName: string,
  gtVersions: string[],
  mode: 'all' | 'gt'
): Promise<PkgResult> {
  const dir = npmNameToDir(npmName);
  const result: PkgResult = { npmName, dir, collected: [], unavailable: [] };

  const meta = await fetchJSON(registryUrl(npmName));
  if (!meta || !meta.versions) {
    result.unavailable.push(...gtVersions);
    return result;
  }

  // Target versions: ALL clean-release versions (DEBUN methodology, no label
  // leakage) or just the ground-truth versions, depending on mode.
  const target =
    mode === 'all'
      ? Object.keys(meta.versions).filter((v) => SEMVER_RE.test(v))
      : gtVersions.filter((v) => meta.versions[v]);

  // Which versions still need fetching (resume support).
  const needed = target.filter((v) => {
    const vdir = path.join(CORPUS_DIR, dir, v);
    if (fs.existsSync(vdir) && collectJSFiles(vdir).length > 0) {
      result.collected.push(v);
      return false;
    }
    return true;
  });
  if (needed.length === 0) return result;

  for (const v of needed) {
    const tarball: string | undefined = meta.versions[v]?.dist?.tarball;
    if (!tarball) {
      result.unavailable.push(v);
      continue;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'debun-corpus-'));
    const tgz = path.join(tmp, 'pkg.tgz');
    const ok = await downloadTarball(tarball, tgz);
    if (!ok) {
      result.unavailable.push(v);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      continue;
    }
    try {
      // stdio:'ignore' silences bsdtar's "Ignoring unknown extended header
      // keyword" pax warnings; a real failure still throws (non-zero exit).
      execFileSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'ignore' });
      // npm tarballs extract under "package/".
      const pkgRoot = fs.existsSync(path.join(tmp, 'package'))
        ? path.join(tmp, 'package')
        : tmp;
      const jsFiles = collectJSFiles(pkgRoot);
      if (jsFiles.length === 0) {
        result.unavailable.push(v);
      } else {
        const destBase = path.join(CORPUS_DIR, dir, v);
        for (const f of jsFiles) {
          const rel = path.relative(pkgRoot, f);
          const dest = path.join(destBase, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(f, dest);
        }
        result.collected.push(v);
      }
    } catch {
      result.unavailable.push(v);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
  return result;
}

async function pool<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  size: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data: DatasetEntry[] = JSON.parse(
    fs.readFileSync(DATASET_PATH, 'utf-8')
  );

  // Gather { npmName: Set<version> } from all groundTruth entries.
  const wanted = new Map<string, Set<string>>();
  for (const entry of data) {
    for (const spec of entry.groundTruth) {
      const [name, version] = splitNameVersion(spec);
      if (!version) continue;
      if (!wanted.has(name)) wanted.set(name, new Set());
      wanted.get(name)!.add(version);
    }
  }

  let packages = Array.from(wanted.entries()).map(
    ([name, vs]) => [name, Array.from(vs).sort()] as [string, string[]]
  );
  packages.sort((a, b) => a[0].localeCompare(b[0]));

  if (args.only) {
    const only = new Set(args.only.split(',').map((s) => s.trim()));
    packages = packages.filter(([n]) => only.has(n));
  }
  if (args.limit) packages = packages.slice(0, parseInt(args.limit, 10));

  const mode: 'all' | 'gt' = args.versions === 'gt' ? 'gt' : 'all';
  console.log(
    `[collect] ${packages.length} packages, mode=${mode} ` +
      `(${mode === 'all' ? 'ALL clean-release versions per lib' : 'ground-truth versions only'}) -> ${CORPUS_DIR}`
  );
  fs.mkdirSync(CORPUS_DIR, { recursive: true });

  let done = 0;
  const results = await pool(
    packages,
    async ([name, versions]) => {
      const r = await collectPackage(name, versions, mode);
      done++;
      const status =
        r.unavailable.length === 0
          ? 'ok'
          : r.collected.length === 0
          ? 'UNAVAILABLE'
          : 'partial';
      console.log(
        `[collect ${done}/${packages.length}] ${name} [${status}] ` +
          `collected=${r.collected.length} unavailable=${r.unavailable.length}`
      );
      return r;
    },
    CONCURRENCY
  );

  const manifest = {
    dataset: DATASET_PATH,
    corpusDir: CORPUS_DIR,
    dirToNpm: Object.fromEntries(results.map((r) => [r.dir, r.npmName])),
    packages: results.map((r) => ({
      npmName: r.npmName,
      dir: r.dir,
      collected: r.collected.sort(),
      unavailable: r.unavailable.sort(),
    })),
  };
  fs.writeFileSync(
    path.join(CORPUS_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  const okPkgs = results.filter((r) => r.collected.length > 0).length;
  const okVers = results.reduce((n, r) => n + r.collected.length, 0);
  const badVers = results.reduce((n, r) => n + r.unavailable.length, 0);
  console.log('\n[collect] done.');
  console.log(`  packages with >=1 version:  ${okPkgs}/${packages.length}`);
  console.log(`  versions collected:         ${okVers}`);
  console.log(`  versions unavailable:       ${badVers}`);
  console.log(`  manifest: ${path.join(CORPUS_DIR, 'manifest.json')}`);
}

main();
