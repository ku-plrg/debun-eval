import fs from 'fs';
import path from 'path';
import { CORPUS_DIR, DB_DIR } from './config';
import { fingerprintSource } from './detect';

/**
 * build-db.ts — construct a flat fingerprint DB (all-hash.json / all-libs.json)
 * from the collected corpus, so the score_u scorer can be pointed at it.
 *
 * This is a faithful adaptation of
 * debun-tosem26/src/debun/phase1/lib-database.ts: same per-(lib,version) unique
 * hashing, same {nodes:{hash:{libIdx:[[vStart,vEnd]]}}} output structure, same
 * `all-libs` metadata ({id, versions[], hashCnt[]}). Two simplifications, valid
 * because the corpus only ever holds clean release versions collected from npm:
 *   - version validity/sort is done with a plain SemVer regex + numeric tuple
 *     sort instead of the `semver` package (prerelease dirs never occur here);
 *   - fingerprinting goes through the shared detect.ts wrapper.
 *
 * The blacklist and birth-date dup filters are intentionally NOT built here —
 * the scorer treats them as optional (absent => no removal). Add them later if
 * precision needs tightening.
 */

type HashData = Record<
  string,
  Record<string, Record<number, Array<[number, number]>>>
>;
type LibData = Record<
  string,
  { id: number; versions: string[]; hashCnt: number[] }
>;

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function versionKey(v: string): number[] {
  return v.split('.').map((n) => parseInt(n, 10));
}

function getAllFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...getAllFiles(full));
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function main() {
  if (!fs.existsSync(CORPUS_DIR)) {
    console.error(`[build-db] corpus not found: ${CORPUS_DIR}`);
    console.error(`[build-db] run "npm run collect" first.`);
    process.exit(1);
  }

  const allLibs: LibData = {};
  const allHashes: HashData = {};
  let libIdx = 0;

  const libNames = fs
    .readdirSync(CORPUS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const libName of libNames) {
    const libDir = path.join(CORPUS_DIR, libName);
    const versions = fs
      .readdirSync(libDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SEMVER_RE.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => {
        const ka = versionKey(a),
          kb = versionKey(b);
        for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
        return 0;
      });
    if (versions.length === 0) continue;

    allLibs[libName] = { id: libIdx, versions: [], hashCnt: [] };
    let versionIdx = 0;

    for (const version of versions) {
      const files = getAllFiles(path.join(libDir, version));
      const hashSet = new Map<string, { hash: string; nodes: number }>();
      for (const file of files) {
        let code: string;
        try {
          code = fs.readFileSync(file, 'utf-8');
        } catch {
          continue;
        }
        try {
          const grouped = fingerprintSource(code);
          for (const [nodes, hashes] of Object.entries(grouped)) {
            for (const hash of hashes) {
              if (!hashSet.has(hash))
                hashSet.set(hash, { hash, nodes: parseInt(nodes, 10) });
            }
          }
        } catch (e) {
          // Skip files DEBUN's parser can't handle (matches lib-database.ts).
        }
      }

      const uniqueHashes = Array.from(hashSet.values());
      if (uniqueHashes.length === 0) continue;

      allLibs[libName].versions.push(version);
      allLibs[libName].hashCnt.push(uniqueHashes.length);

      for (const { hash, nodes } of uniqueHashes) {
        const n = String(nodes);
        allHashes[n] ||= {};
        if (allHashes[n][hash]) {
          if (allHashes[n][hash][libIdx]) {
            const prev = allHashes[n][hash][libIdx];
            if (prev[prev.length - 1][1] === versionIdx - 1)
              prev[prev.length - 1][1] = versionIdx;
            else prev.push([versionIdx, versionIdx]);
          } else {
            allHashes[n][hash][libIdx] = [[versionIdx, versionIdx]];
          }
        } else {
          allHashes[n][hash] = { [libIdx]: [[versionIdx, versionIdx]] };
        }
      }
      versionIdx++;
    }

    console.log(
      `[build-db] ${libName}: ${allLibs[libName].versions.length} versions`
    );
    libIdx++;
  }

  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DB_DIR, 'all-hash.json'),
    JSON.stringify(allHashes)
  );
  fs.writeFileSync(
    path.join(DB_DIR, 'all-libs.json'),
    JSON.stringify(allLibs, null, 2)
  );
  console.log(
    `\n[build-db] done. ${Object.keys(allLibs).length} libraries -> ${DB_DIR}`
  );
}

main();
