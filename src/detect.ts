// The DEBUN POG fingerprint engine, vendored verbatim under src/engine (only
// the fingerprint-collector closure — see src/engine/). This is the same
// entrypoint the paper's `detect` / DB-builder use, so the hashes match.
import fingerprintCollector from './engine/fingerprint-collector';

/**
 * Fingerprint one JS bundle source string into the `{ nodes: [hash, …] }`
 * shape the scorer consumes — identical to the grouping done by the `detect`
 * command in debun-tosem26/src/dist/index.ts. Duplicate hashes are collapsed
 * (a fingerprint counts once per bundle). `extractFunctionId:false` skips the
 * id literal-scan (the POG hash does not depend on it) to match the DB build.
 */
export function fingerprintSource(source: string): Record<string, string[]> {
  const hashes = fingerprintCollector(source, undefined, {
    extractFunctionId: false,
  });
  const unique = Array.from(
    new Map(hashes.map((h) => [h.hash, h])).values()
  );
  const grouped: Record<string, string[]> = {};
  for (const { hash, nodes } of unique) {
    (grouped[nodes] ||= []).push(hash);
  }
  return grouped;
}
