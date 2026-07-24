import { performance } from 'perf_hooks';
import { POGHash, POGAnalysisOptions } from '../types/pog';
import extractFunctions, { ExtractFunctionOpts } from './function-collector';
import poghash from './hash-function';
import pog from './pog-generator';

export interface FingerprintTimings {
  /** parser (meriyah) wall time in ms */
  parseMs?: number;
  /** single-use-finder.createSCAnalysis wall time in ms */
  scMs?: number;
  /** stripFunctions / function-collector recordFunction wall time in ms */
  collectorMs?: number;
  /** pog-generator wall time in ms */
  pogMs?: number;
  /** hash-function wall time in ms */
  hashMs?: number;
}

export interface FingerprintCollectorOpts extends ExtractFunctionOpts {
  /** Same shape as ExtractFunctionOpts.timings, plus pogMs / hashMs from this layer. */
  timings?: FingerprintTimings;
}

function fingerprintCollector(
  raw: string,
  options?: POGAnalysisOptions,
  collectorOpts?: FingerprintCollectorOpts,
): POGHash[] {
  const timings = collectorOpts?.timings;
  // Pass the same timings object down to extractFunctions; it fills in
  // parseMs/scMs/collectorMs and we add pogMs/hashMs on top.
  const functions = extractFunctions(raw, true, {
    minFnLoc: collectorOpts?.minFnLoc,
    timings,
  });
  const t1 = performance.now();
  const pogs = pog(functions, options);
  const t2 = performance.now();
  const hash = poghash(pogs);
  const t3 = performance.now();
  if (timings) {
    timings.pogMs = (timings.pogMs ?? 0) + (t2 - t1);
    timings.hashMs = (timings.hashMs ?? 0) + (t3 - t2);
  }
  return hash;
}

export default fingerprintCollector;
