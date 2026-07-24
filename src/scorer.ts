import fs from 'fs';
import path from 'path';

/**
 * Faithful port of `evaluate` (score_u) from
 * debun-tosem26/src/debun/phase2/lib-scorer.ts, with two deliberate changes:
 *
 *   1. The fingerprint-DB directory is a parameter (not hard-coded), so we can
 *      point the scorer at either the paper's 79-lib DB or a freshly built DB.
 *   2. The website-corpus machinery (TARGET_URLS / allWebHashes) is dropped —
 *      here the bundle hashes are always supplied directly, never looked up by
 *      URL — and the blacklist / birth-date dup filters are made OPTIONAL:
 *      when their files are absent (as they are for a brand-new DB) the scorer
 *      simply applies no removal, which can only *raise* matches, never fake
 *      them. Everything else (thresholds, type2/type3 logic, percentage math,
 *      react-dom→react folding, ____ base-name split) is copied verbatim.
 */

const WEB_BLACKLIST_THRESHOLD = 0.6;
const DUP_THRESHOLD = 0.3;
const MIN_FUNCTION_COUNT = 5;

export interface Score {
  libName: string; // base library name (after ____ split, react-dom→react)
  topVersions: string[];
  topScore: number;
  topScoreStr: string;
  type3Versions: string[];
  type2Versions: string[];
}

type LibInfos = Record<
  string,
  { id: number; versions: string[]; hashCnt: number[] }
>;
type LibHashes = Record<
  string,
  Record<string, Record<string, [number, number][]>>
>;

export interface ScorerDB {
  libInfos: LibInfos;
  libHashes: LibHashes;
  blacklist: Record<string, string[]>;
  intraDupHashes: LibHashes;
  intraDupLibs: Record<string, Record<string, number>>;
  /** base library name -> true if any version has >= MIN_FUNCTION_COUNT unique fingerprints */
  detectable: Record<string, boolean>;
}

function readJSON<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

/** Load a fingerprint DB from a directory laid out like debun-hashes/. */
export function loadDB(dbDir: string): ScorerDB {
  const libInfos = readJSON<LibInfos>(
    path.join(dbDir, 'all-libs.json'),
    {}
  );
  const libHashes = readJSON<LibHashes>(
    path.join(dbDir, 'all-hash.json'),
    {}
  );
  const blacklist = readJSON<Record<string, string[]>>(
    path.join(dbDir, `blacklist-${WEB_BLACKLIST_THRESHOLD}.json`),
    {}
  );
  const intraDupHashes = readJSON<LibHashes>(
    path.join(dbDir, `dups-${DUP_THRESHOLD}-hash.json`),
    {}
  );
  const intraDupLibs = readJSON<Record<string, Record<string, number>>>(
    path.join(dbDir, `dups-${DUP_THRESHOLD}-libs.json`),
    {}
  );

  // Which libraries are even detectable in principle: DEBUN drops any
  // (lib,version) whose match count is < MIN_FUNCTION_COUNT, so a library
  // whose every version has fewer than 5 unique fingerprints can never be
  // reported. We fold to the same base name the scorer emits.
  const detectable: Record<string, boolean> = {};
  for (const [libName, info] of Object.entries(libInfos)) {
    const base = baseName(libName);
    const ok = (info.hashCnt || []).some((c) => c >= MIN_FUNCTION_COUNT);
    detectable[base] = detectable[base] || ok;
  }

  return { libInfos, libHashes, blacklist, intraDupHashes, intraDupLibs, detectable };
}

function baseName(libName: string): string {
  const base = libName.split('____')[0];
  return base === 'react-dom' ? 'react' : base;
}

const determineType = (matches: Record<string, [number, number][]>) => {
  if (Object.keys(matches).length === 1) {
    if (Object.values(matches)[0].length === 1) {
      const [[[vFrom, vTo]]] = Object.values(matches);
      if (vFrom === vTo) return 3; // type 3: only one version
    }
    return 2; // type 2: only one library
  }
  return 1;
};

const rangeIncludes = (ranges: [number, number][], value: number): boolean => {
  for (const [start, end] of ranges) {
    if (value >= start && value <= end) return true;
  }
  return false;
};

/**
 * Score one bundle's grouped hashes ({ nodes: [hash,…] }) against a DB.
 * Returns the raw per-library scores, ported line-for-line from `evaluate`.
 */
export function score(
  uniqueHashes: Record<string, string[]>,
  db: ScorerDB,
  options: { threshold: number } = { threshold: 0.2 }
): Score[] {
  const { libInfos, libHashes, blacklist, intraDupHashes, intraDupLibs } = db;

  const totalMatches: Record<string, Record<number, number>> = {};
  const type3Matches: Record<string, Record<number, number>> = {};
  const type2Matches: Record<string, Record<number, number>> = {};
  if (!uniqueHashes) return [];

  Object.entries(uniqueHashes).forEach(([nodes, hashes]) => {
    hashes.forEach((hash) => {
      if (!libHashes[nodes]?.[hash]) return;
      if (blacklist[nodes]?.includes(hash)) return;
      const matches = libHashes[nodes][hash];
      const matchType = determineType(matches);
      Object.entries(matches).forEach(([lIdx, vIdxes]) => {
        if (totalMatches[lIdx] === undefined) totalMatches[lIdx] = {};
        vIdxes.forEach(([start, end]) => {
          for (let vIdx = start; vIdx <= end; vIdx++) {
            if (intraDupHashes[nodes]?.[hash]?.[lIdx]) {
              const ranges = intraDupHashes[nodes][hash][lIdx];
              if (rangeIncludes(ranges, vIdx)) return;
            }
            if (!totalMatches[lIdx][vIdx]) totalMatches[lIdx][vIdx] = 0;
            totalMatches[lIdx][vIdx]++;
            if (matchType === 3) {
              if (!type3Matches[lIdx]) type3Matches[lIdx] = {};
              if (!type3Matches[lIdx][vIdx]) type3Matches[lIdx][vIdx] = 0;
              type3Matches[lIdx][vIdx]++;
            }
            if (matchType === 2) {
              if (!type2Matches[lIdx]) type2Matches[lIdx] = {};
              if (!type2Matches[lIdx][vIdx]) type2Matches[lIdx][vIdx] = 0;
              type2Matches[lIdx][vIdx]++;
            }
          }
        });
      });
    });
  });

  const libById: Record<
    string,
    [string, { id: number; versions: string[]; hashCnt: number[] }]
  > = {};
  for (const entry of Object.entries(libInfos)) {
    libById[entry[1].id.toString()] = entry;
  }

  const scores: Score[] = [];
  Object.entries(totalMatches).forEach(([lIdx, matches]) => {
    const lib = libById[lIdx];
    if (!lib) return;

    let type3Versions: string[] = [];
    let type2Versions: string[] = [];
    let topType2VersionCount = 0;
    let topScore = 0;
    let topScoreStr = '';
    let topVersions: string[] = [];

    Object.entries(matches).forEach(([vIdx, s]) => {
      if (s < MIN_FUNCTION_COUNT) return;
      const percentage =
        s / (lib[1].hashCnt[parseFloat(vIdx)] - (intraDupLibs[lIdx]?.[vIdx] ?? 0));
      const type3Count = type3Matches[lIdx]?.[parseFloat(vIdx)] || 0;
      const type2Count = type2Matches[lIdx]?.[parseFloat(vIdx)] || 0;

      if (!(percentage > options.threshold)) return;
      const currentVersionStr = lib[1].versions[parseFloat(vIdx)];
      if (type3Count > 0) type3Versions.push(currentVersionStr);
      if (type2Count > 3) {
        if (type2Count > topType2VersionCount) {
          topType2VersionCount = type2Count;
          type2Versions = [];
        }
        if (type2Count === topType2VersionCount)
          type2Versions.push(currentVersionStr);
      }
      if (percentage > topScore) {
        topScore = percentage;
        topScoreStr = `${s}/${lib[1].hashCnt[parseFloat(vIdx)]}`;
        topVersions = [currentVersionStr];
      } else if (percentage === topScore) {
        topVersions.push(currentVersionStr);
      }
    });

    if (topScore > 0 && topVersions.length > 0) {
      scores.push({
        libName: baseName(lib[0]),
        topVersions,
        topScore,
        topScoreStr,
        type2Versions,
        type3Versions,
      });
    }
  });

  return scores;
}

/** Library-level detection set for one bundle: just the base library names. */
export function detectLibraries(
  uniqueHashes: Record<string, string[]>,
  db: ScorerDB,
  options: { threshold: number } = { threshold: 0.2 }
): string[] {
  return Array.from(new Set(score(uniqueHashes, db, options).map((s) => s.libName)));
}
