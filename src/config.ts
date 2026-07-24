import path from 'path';

/**
 * Absolute paths this eval harness depends on. The DEBUN POG fingerprint engine
 * is vendored under src/engine (bit-identical to the paper); only the scorer is
 * re-ported here (see scorer.ts) to make the fingerprint DB directory swappable.
 */
export const DATASET_PATH =
  process.env.DEBUN_DATASET ||
  path.resolve(__dirname, '../dataset/pnpm-sep-25-annotated.json');

/** Where collect-corpus.ts writes the raw library sources ({lib}/{version}/*.js). */
export const CORPUS_DIR =
  process.env.DEBUN_CORPUS || path.resolve(__dirname, '../corpus');

/** Where build-db.ts writes the freshly-built fingerprint DB (all-hash/all-libs). */
export const DB_DIR = process.env.DEBUN_DB || path.resolve(__dirname, '../db');

export const OUT_DIR = path.resolve(__dirname, '../out');

/**
 * npm scoped names ("@scope/name") cannot be a single directory segment in the
 * flat {lib}/{version} corpus layout that DEBUN's DB builder expects, so we
 * encode the slash as "__". These two helpers are the single source of truth
 * for that mapping and must stay inverses of each other.
 */
export function npmNameToDir(name: string): string {
  return name.replace(/\//g, '__');
}
export function dirToNpmName(dir: string): string {
  return dir.replace(/__/g, '/');
}
