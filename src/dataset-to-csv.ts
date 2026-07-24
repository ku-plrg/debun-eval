import fs from 'fs';
import path from 'path';
import { DATASET_PATH, OUT_DIR } from './config';

/**
 * dataset-to-csv.ts — dump the annotated dataset (pnpm-sep-25-annotated.json)
 * to a readable CSV: one row per website/bundle with its ground-truth library
 * list. Writes out/dataset.csv.
 *
 *   index, url, n_libraries, ground_truth   (ground_truth = "lib@ver;lib@ver;…")
 */

interface Entry {
  urls: string[];
  source: string;
  sourcemap?: string;
  groundTruth: string[];
}

const csvCell = (v: string) =>
  /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

function main() {
  const data: Entry[] = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));

  const header = ['index', 'url', 'n_libraries', 'ground_truth'];
  const lines = [header.join(',')];
  for (let i = 0; i < data.length; i++) {
    const e = data[i];
    lines.push(
      [
        i,
        csvCell((e.urls || []).join('|')),
        (e.groundTruth || []).length,
        csvCell((e.groundTruth || []).join(';')),
      ].join(',')
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'dataset.csv');
  fs.writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(`[dataset-to-csv] ${data.length} bundles -> ${outFile}`);
}

main();
