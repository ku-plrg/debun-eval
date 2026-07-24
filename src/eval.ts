import fs from "fs";
import path from "path";
import { DATASET_PATH, DB_DIR, OUT_DIR } from "./config";
import { fingerprintSource } from "./detect";
import { loadDB, detectLibraries, ScorerDB } from "./scorer";

interface DatasetEntry {
  urls: string[];
  source: string;
  sourcemap?: string;
  groundTruth: string[]; // "pkg@version"
}

/**
 * Fold both DB library names and npm ground-truth names to a common key so
 * library-level matching is fair across the two naming worlds:
 *   - classic-CDN DB names: "lodash.js", "moment.js", "angular.js" -> strip .js
 *   - npm-built DB names:   "@ant-design__icons-svg" -> "@ant-design/icons-svg"
 */
function canonical(name: string): string {
  return name.toLowerCase().replace(/__/g, "/").replace(/\.js$/, "");
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val =
        argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args[key] = val;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbDir = args.db ? path.resolve(args.db) : DB_DIR;
  // Default operating point: 0.35 maximises library-level F1 on the full
  // all-versions DB with strict (npm-name) matching.
  const threshold = args.threshold ? parseFloat(args.threshold) : 0.35;
  const limit = args.limit ? parseInt(args.limit, 10) : Infinity;

  console.log(`[eval] dataset : ${DATASET_PATH}`);
  console.log(`[eval] DB dir  : ${dbDir}`);

  const db: ScorerDB = loadDB(dbDir);
  const dbLibCount = Object.keys(db.libInfos).length;
  const hasBlacklist = Object.keys(db.blacklist).length > 0;
  const hasDups = Object.keys(db.intraDupHashes).length > 0;
  console.log(`[eval] DB: ${dbLibCount} libraries`);

  const data: DatasetEntry[] = JSON.parse(
    fs.readFileSync(DATASET_PATH, "utf-8"),
  );

  let tp = 0,
    fp = 0,
    fn = 0;
  const perBundle: any[] = [];

  const entries = data.slice(0, limit);
  entries.forEach((entry, idx) => {
    const gtLibs = Array.from(
      new Set(
        entry.groundTruth.map((g) => canonical(g.replace(/@[^@/]*$/, ""))),
      ),
    );

    let detected: string[] = [];
    let error: string | undefined;
    try {
      const hashes = fingerprintSource(entry.source);
      detected = Array.from(
        new Set(detectLibraries(hashes, db, { threshold }).map(canonical)),
      );
    } catch (e) {
      error = (e as Error).message;
    }

    const gtSet = new Set(gtLibs);
    const detSet = new Set(detected);
    const truePos = detected.filter((d) => gtSet.has(d));
    const falsePos = detected.filter((d) => !gtSet.has(d));
    const falseNeg = gtLibs.filter((g) => !detSet.has(g));

    tp += truePos.length;
    fp += falsePos.length;
    fn += falseNeg.length;

    perBundle.push({
      idx,
      url: entry.urls[0],
      gt: gtLibs,
      detected,
      truePos,
      falsePos,
      falseNeg,
      error,
    });
  });

  const prf = (tp: number, fp: number, fn: number) => {
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 =
      precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall);
    return { precision, recall, f1 };
  };

  const full = prf(tp, fp, fn);

  const pct = (x: number) => (100 * x).toFixed(1) + "%";
  console.log("\n================ SCORE ================");
  console.log(`bundles evaluated : ${entries.length}`);
  console.log(`  TP=${tp}  FP=${fp}  FN=${fn}`);
  console.log(
    `  Precision=${pct(full.precision)}  Recall=${pct(full.recall)}  F1=${pct(
      full.f1,
    )}`,
  );
  console.log("====================================================\n");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = dbDir
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-40);
  const outFile = path.join(OUT_DIR, `eval-${stamp}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        dataset: DATASET_PATH,
        dbDir,
        threshold,
        dbLibCount,
        hasBlacklist,
        hasDups,
        bundles: entries.length,
        fullUniverse: { tp, fp, fn, ...full },
        perBundle,
      },
      null,
      2,
    ),
  );
  console.log(`[eval] wrote ${outFile}`);

  // Per-bundle detection results as CSV (extracted libraries vs ground truth).
  const csvCell = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const csvHeader = [
    "index",
    "url",
    "n_ground_truth",
    "n_detected",
    "tp",
    "fp",
    "fn",
    "ground_truth",
    "detected",
    "false_positives",
    "false_negatives",
  ];
  const csvLines = [csvHeader.join(",")];
  for (const b of perBundle) {
    csvLines.push(
      [
        b.idx,
        csvCell(b.url || ""),
        b.gt.length,
        b.detected.length,
        b.truePos.length,
        b.falsePos.length,
        b.falseNeg.length,
        csvCell(b.gt.join(";")),
        csvCell(b.detected.join(";")),
        csvCell(b.falsePos.join(";")),
        csvCell(b.falseNeg.join(";")),
      ].join(","),
    );
  }
  const csvFile = path.join(OUT_DIR, `detected-${stamp}.csv`);
  fs.writeFileSync(csvFile, csvLines.join("\n") + "\n");
  console.log(`[eval] wrote ${csvFile}`);
}

main();
