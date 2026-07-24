import { ESTree, parse } from 'meriyah';
import escodegen from 'escodegen';
import { performance } from 'perf_hooks';
import { Function } from '../types/pog';
import walk from '../utils/walk';
import {
  createSCAnalysisByDefUse as createSCAnalysis,
  SCDefUseAnalysis as SCAnalysis,
} from './single-use-finder-defuse';

export interface ExtractFunctionOpts {
  /**
   * Drop functions whose escodegen-printed (rq3-style) line count is below
   * this threshold. 0 (default) = no filter — keep every function. Callers
   * that want the filter (e.g. npm/cdn populate) pass a positive value.
   * Site/web hashing intentionally leaves this at 0.
   */
  minFnLoc?: number;
  /**
   * If supplied, the function accumulates phase-level wall-clock timings
   * (in ms) into the provided fields. Untouched fields are left as-is so the
   * caller can sum across many files.
   */
  timings?: { parseMs?: number; scMs?: number; collectorMs?: number };
  /**
   * Whether to run the `JSCA_*` literal scan that fills `Function.id`. Default
   * true. rq1/rq2 detection paths don't read the id field, so they pass false
   * to skip the per-function getId walk.
   */
  extractFunctionId?: boolean;
}

let functions: Function[] = [];
let scAnalysis: SCAnalysis | null = null;
let currentMinFnLoc = 0;
let currentExtractId = true;

// Reproduce rq3/index.ts:countMainFunctionLines — wrap the (already-stripped)
// body with the captured signature, escodegen.generate it, and count newlines.
// Source-level line layout (minified vs pretty) doesn't matter; the line count
// is purely a function of the AST + escodegen's deterministic formatting.
function fnPrintedLinesBase(
  node:
    | ESTree.FunctionDeclaration
    | ESTree.FunctionExpression
    | ESTree.ArrowFunctionExpression,
  body: ESTree.Node,
): number {
  const isArrowExpression =
    node.type === 'ArrowFunctionExpression' && !!(node as any).expression;
  let wrapped: ESTree.Node;
  if (isArrowExpression) {
    wrapped = {
      type: 'ArrowFunctionExpression',
      id: (node as any).id ?? null,
      params: node.params ?? [],
      generator: false,
      async: !!(node as any).async,
      expression: true,
      body: body as ESTree.Expression,
    } as any;
  } else {
    const doubleWrapped: ESTree.BlockStatement = {
      type: 'BlockStatement',
      body: [body as ESTree.Statement],
    };
    wrapped = {
      type: node.type,
      id: (node as any).id ?? null,
      params: node.params ?? [],
      generator: !!(node as any).generator,
      async: !!(node as any).async,
      body: doubleWrapped,
    } as any;
  }
  try {
    return escodegen.generate(wrapped).split('\n').length;
  } catch {
    // If escodegen can't print this fragment, don't drop it on length grounds.
    return Number.POSITIVE_INFINITY;
  }
}

// Inline-aware LoC: base function lines + sum of escodegen-printed lines for
// every SC body that would be inlined into this caller. The inlineMap covers
// all call sites transitively (see single-use-finder.ts:buildInlineMap), so a
// single sweep over its values matches the post-inline footprint.
//
// The base body still contains the original CallExpressions (one line each),
// so this is a slight upper-bound vs. true substitution — fine as a noise
// floor since we just need to know whether the inlined fn is "real-sized".
function fnPrintedLinesInline(
  node:
    | ESTree.FunctionDeclaration
    | ESTree.FunctionExpression
    | ESTree.ArrowFunctionExpression,
  body: ESTree.Node,
  inlineMap: Map<ESTree.Node, ESTree.Node>,
): number {
  let total = fnPrintedLinesBase(node, body);
  if (!Number.isFinite(total)) return total;
  for (const scBody of inlineMap.values()) {
    try {
      total += escodegen.generate(scBody).split('\n').length;
    } catch {
      /* unprintable fragment — skip rather than rejecting fn outright */
    }
  }
  return total;
}

function recordFunction(
  node:
    | ESTree.FunctionDeclaration
    | ESTree.FunctionExpression
    | ESTree.ArrowFunctionExpression
): void {
  if (!node.body) return;
  const isSC = !!scAnalysis?.isSCFunction(node);
  // Always strip nested functions — even for SC bodies — so that
  //   (a) nested non-SC fns inside an SC body are recorded in functions[]
  //       and get their own fingerprint (otherwise they'd be orphaned from
  //       the inlined set), and
  //   (b) the inline walker, which reads this body via scCallToBody, sees
  //       placeholders in place of nested fn definitions instead of drifting
  //       into their bodies as if they were sequential flow.
  const body = stripFunctions(node.body);

  const inlineMap = scAnalysis
    ? scAnalysis.buildInlineMap(body)
    : new Map<ESTree.Node, ESTree.Node>();

  if (isSC) return;

  // LoC filter — escodegen-printed line count of the function with all SC
  // bodies inlined into it (matches the post-inline footprint that POG hashing
  // actually consumes). Active only when caller supplied minFnLoc > 0 (npm/cdn).
  // Site/web hashing leaves minFnLoc=0 so every function survives.
  if (
    currentMinFnLoc > 0 &&
    fnPrintedLinesInline(node, body, inlineMap) < currentMinFnLoc
  ) {
    return;
  }

  const name = (node as any).id?.name ?? '';

  const sig = {
    type: node.type,
    id: (node as any).id ?? null,
    params: node.params ?? [],
    async: !!(node as any).async,
    generator: !!(node as any).generator,
    expression:
      node.type === 'ArrowFunctionExpression' && !!(node as any).expression,
  } as Function['sig'];

  functions.push({
    id: currentExtractId ? getId(body) : '',
    name,
    body,
    sig,
    singleCallBody: inlineMap,
  });
}

// Source-position metadata never holds AST nodes — descending into these
// inflates the collector walk by 3-4x on minified bundles. Match the SKIP_KEYS
// set in single-use-finder.ts to keep the two walks in sync.
const STRIP_SKIP_KEYS = new Set(['type', 'loc', 'start', 'end', 'range']);

function stripFunctions(node: ESTree.Node): ESTree.Node {
  if (!node) return node;

  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    if (!node.body) return node;
    recordFunction(node);

    return node.type === 'FunctionDeclaration'
      ? ({ type: 'EmptyStatement' } as any)
      : ({
          type: node.type,
          id: null,
          params: [],
          generator: false,
          async: false,
          body: { type: 'BlockStatement', body: [] },
        } as any);
  }

  for (const key of Object.keys(node)) {
    if (STRIP_SKIP_KEYS.has(key)) continue;
    const value = (node as any)[key];
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] && typeof value[i] === 'object') {
          value[i] = stripFunctions(value[i]);
        }
      }
    } else {
      (node as any)[key] = stripFunctions(value);
    }
  }

  return node;
}

function getId(node: ESTree.Node): string {
  let value: string | undefined;
  walk(node, {
    CallExpression(node: ESTree.Node) {
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'Symbol' &&
        node.arguments.length > 0 &&
        node.arguments[0].type === 'Literal' &&
        typeof node.arguments[0].value === 'string'
      ) {
        const symbolValue = node.arguments[0].value;
        if (value === undefined && symbolValue.startsWith('JSCA_')) {
          value = symbolValue;
        }
      }
    },
    TemplateLiteral(node: ESTree.Node) {
      if (node.type !== 'TemplateLiteral') return;
      const templateValue = node.quasis[0]?.value.raw;
      if (value === undefined && templateValue.startsWith('JSCA_')) {
        value = templateValue;
      }
    },
    Literal(node: ESTree.Node) {
      if (
        node.type === 'Literal' &&
        value === undefined &&
        typeof node.value === 'string' &&
        node.value.startsWith('JSCA_')
      ) {
        value = node.value;
      }
    },
  });
  return value || '';
}

function extractFunctions(
  code: string,
  inline: boolean = true,
  opts?: ExtractFunctionOpts,
): Function[] {
  functions = [];
  currentMinFnLoc = opts?.minFnLoc && opts.minFnLoc > 0 ? opts.minFnLoc : 0;
  currentExtractId = opts?.extractFunctionId !== false;
  const timings = opts?.timings;

  // Use perf_hooks.performance.now() — identical underlying clock to
  // console.time / console.timeEnd (Node docs: console.time uses
  // performance.now internally). Returns float milliseconds directly.
  const t0 = performance.now();
  let ast: ESTree.Program;
  try {
    ast = parse(code, {
      next: true,
      module: false,
    });
  } catch (e) {
    ast = parse(code, {
      next: true,
      module: true,
    });
  }
  const t1 = performance.now();
  scAnalysis = inline ? createSCAnalysis(ast) : null;
  const t2 = performance.now();
  stripFunctions(ast);
  const t3 = performance.now();

  if (timings) {
    timings.parseMs = (timings.parseMs ?? 0) + (t1 - t0);
    timings.scMs = (timings.scMs ?? 0) + (t2 - t1);
    timings.collectorMs = (timings.collectorMs ?? 0) + (t3 - t2);
  }

  return functions;
}

export default extractFunctions;
