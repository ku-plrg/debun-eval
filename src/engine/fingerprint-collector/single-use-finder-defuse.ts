// Def-Use based Single-Use (SC) analysis — paper §3.1.
//
//   * Each Identifier occurrence is a "labeled variable" x_l ∈ lvarset.
//   * Scope resolution maps each label to a Binding (resolved name+scope).
//   * Def(u) : Label ⇀ 𝒫(Label) — defs that reach use-site u (path-sensitive).
//   * Use(d) : Label ⇀ 𝒫(Label) — uses reached by def d.
//   * Unique flow: |Def(u)| = 1 ∧ |Use(d)| = 1 ∧ ¬isExposed(d).
//   * Inlinable: x_i is a function-valued def, x_i ⇝ z_k (possibly via
//     declarator-init alias chain), z_k is a call-site, z_k ∉ Body(x_i).
//
// Project-specific deviations:
//   * IIFE goes into `scCallToBody` (inline map) instead of paper §3.2's
//     source rewrite — the downstream pog-generator handles inline walking.
//   * isExposed = (scope.kind === 'program' ∧ moduleKind === 'script').
//     Browser <script>-style files expose top-level bindings as globals; CJS
//     and ESM modules encapsulate them, so module-scope bindings remain
//     inline-eligible. (Matches what bundlers like swc actually do.)

const SKIP_KEYS = new Set(['type', 'loc', 'start', 'end', 'range']);

type Label = any;
type ScopeKind = 'program' | 'function' | 'block';

interface Binding {
  id: number;
  declSite: any;
  fnNode: any | null;
  scope: Scope;
  isExposed: boolean;
  isFnSelf: boolean;
}

type ModuleKind = 'esm' | 'cjs' | 'script';

/** Detect whether the AST is an ES module, CommonJS module, or plain script.
 *  ESM is unambiguous (parser's sourceType === 'module'). For script-parsed
 *  files, we walk top-level for CJS signals (require call / module.exports /
 *  exports.X). True scripts expose top-level bindings as window globals. */
function detectModuleKind(ast: any): ModuleKind {
  if (ast?.sourceType === 'module') return 'esm';
  // Top-level only scan — CJS markers live in the program body, not nested
  // deeply inside functions. Avoids a full-AST walk on huge bundles.
  const body = ast?.body;
  if (!Array.isArray(body)) return 'script';
  const stmtHasCJS = (s: any): boolean => {
    if (!s || typeof s !== 'object') return false;
    if (s.type === 'VariableDeclaration') {
      for (const d of s.declarations ?? []) {
        if (exprHasCJS(d.init)) return true;
      }
      return false;
    }
    if (s.type === 'ExpressionStatement') return exprHasCJS(s.expression);
    if (s.type === 'IfStatement') {
      return stmtHasCJS(s.consequent) || stmtHasCJS(s.alternate);
    }
    if (s.type === 'BlockStatement') {
      for (const c of s.body ?? []) if (stmtHasCJS(c)) return true;
    }
    return false;
  };
  const exprHasCJS = (e: any): boolean => {
    if (!e || typeof e !== 'object') return false;
    if (e.type === 'CallExpression') {
      if (e.callee?.type === 'Identifier' && e.callee.name === 'require') return true;
      if (exprHasCJS(e.callee)) return true;
      for (const a of e.arguments ?? []) if (exprHasCJS(a)) return true;
      return false;
    }
    if (e.type === 'AssignmentExpression') {
      return exprHasCJS(e.left) || exprHasCJS(e.right);
    }
    if (e.type === 'MemberExpression' && !e.computed) {
      const o = e.object, p = e.property;
      if (
        o?.type === 'Identifier' &&
        p?.type === 'Identifier' &&
        ((o.name === 'module' && p.name === 'exports') || o.name === 'exports')
      ) return true;
      return exprHasCJS(o);
    }
    if (e.type === 'SequenceExpression') {
      for (const x of e.expressions ?? []) if (exprHasCJS(x)) return true;
    }
    return false;
  };
  for (const stmt of body) {
    if (stmtHasCJS(stmt)) return 'cjs';
  }
  return 'script';
}

interface Scope {
  parent: Scope | null;
  kind: ScopeKind;
  bindings: Map<string, Binding>;
}

interface DUTables {
  defs: Map<Binding, Label[]>;             // fn-valued def-site labels per binding
  callOf: Map<Label, any>;                  // call-site label → enclosing CE
  reachingDefs: Map<Label, Set<Label>>;     // paper's Def map
  labelToBinding: Map<Label, Binding>;
  parentOf: Map<Label, any>;
  selfCalls: Map<Binding, number>;
  killed: Set<Binding>;
  closureReassigned: Set<Binding>;
  fnNodeToScope: Map<any, Scope>;
  bindings: Binding[];
  programScope: Scope;
  moduleKind: ModuleKind;
  // Enclosing-fn chain: lets classify avoid AST `isAncestor` walks. Set at
  // function queue and at every callOf insert.
  enclosingFn: Map<Label, any>;         // call-site label → its enclosing fn (or null)
  parentFnOf: Map<any, any>;            // fn node → its enclosing fn (or null)
}

// === Paper's Def / Use queries ==============================================

/** Def(u) — set of def-site labels that may reach use-site `u`. */
function Def(T: DUTables, u: Label): Set<Label> {
  return T.reachingDefs.get(u) ?? new Set();
}
/** Use(d) — set of use-site labels reached by def `d`. */
function Use(T: DUTables, d: Label): Set<Label> {
  const out = new Set<Label>();
  for (const [u, defs] of T.reachingDefs)
    if (defs.has(d)) out.add(u);
  return out;
}

// === Helpers ================================================================

const EMPTY_LABEL_SET: Set<Label> = new Set();

// RD invariant: Sets stored as overlay values are never mutated in place.
// Branches use a copy-on-write overlay keyed by Binding.id. Storage is split:
//   - `own`     : sparse Array indexed by id, for O(1) lookup without hashing
//   - `ownKeys` : list of ids set in this layer, for O(entries) iteration
// Fields are package-visible so mergeRD/equalRD can walk the chain inline
// (single-pass, dedup + merge fused — no intermediate materialize Map).
class RDState {
  readonly own: Array<Set<Label> | undefined> = [];
  readonly ownKeys: number[] = [];
  readonly base: RDState | null;

  constructor(base: RDState | null = null) {
    this.base = base;
  }

  fork(): RDState {
    return new RDState(this);
  }

  getById(id: number): Set<Label> | undefined {
    const own = this.own[id];
    if (own !== undefined) return own;
    return this.base?.getById(id);
  }

  get(b: Binding): Set<Label> | undefined {
    return this.getById(b.id);
  }

  has(b: Binding): boolean {
    return this.getById(b.id) !== undefined;
  }

  set(b: Binding, v: Set<Label>): void {
    if (this.own[b.id] === undefined) this.ownKeys.push(b.id);
    this.own[b.id] = v;
  }

  setById(id: number, v: Set<Label>): void {
    if (this.own[id] === undefined) this.ownKeys.push(id);
    this.own[id] = v;
  }
}

const cloneRD = (rd: RDState): RDState => rd.fork();

// Branch-merge core. Combines two control-flow paths into `out` (mutating).
// Caller invariants:
//   (a) `ancestor` is in both `out`'s and `b`'s chains — the common fork
//       ancestor — OR `ancestor === out` (loop case: b descends from out
//       and out has no overrides above itself).
//   (b) `out` is safe to mutate (a fork the caller owns).
//
// Two phases against the common ancestor:
//   Phase 1 — walk b's chain up to ancestor, unioning each b-override into
//             out. Truncating at ancestor is safe because entries at/beyond
//             ancestor are shared via inheritance (the va === vb shortcut
//             would skip them anyway).
//   Phase 2 — walk out's own chain up to ancestor, unioning ancestor.getById
//             into each out-override not already merged in Phase 1. This is
//             the asymmetric-merge case that the original `mergeRD` got
//             implicitly by iterating b.materialize() — we cover it here so
//             classify still sees the ancestor's contribution.
const mergeBranchesInto = (out: RDState, b: RDState, ancestor: RDState): void => {
  const seen = new Set<number>();
  // Phase 1: b's overrides into out.
  for (let cur: RDState | null = b; cur && cur !== ancestor; cur = cur.base) {
    const own = cur.own;
    const keys = cur.ownKeys;
    for (let i = 0; i < keys.length; i++) {
      const id = keys[i];
      if (seen.has(id)) continue;
      seen.add(id);
      const vb = own[id]!;
      const va = out.getById(id);
      if (!va) { out.setById(id, vb); continue; }
      if (va === vb) continue;
      let allIn = true;
      for (const x of vb) if (!va.has(x)) { allIn = false; break; }
      if (allIn) continue;
      const merged = new Set(va);
      for (const x of vb) merged.add(x);
      out.setById(id, merged);
    }
  }
  // Phase 2: out's overrides ∪= ancestor's value (skip when ancestor === out).
  if (ancestor !== out) {
    for (let cur: RDState | null = out; cur && cur !== ancestor; cur = cur.base) {
      const own = cur.own;
      const keys = cur.ownKeys;
      for (let i = 0; i < keys.length; i++) {
        const id = keys[i];
        if (seen.has(id)) continue;
        seen.add(id);
        const v_out = out.getById(id)!;
        const v_anc = ancestor.getById(id);
        if (!v_anc || v_anc === v_out) continue;
        let allIn = true;
        for (const x of v_anc) if (!v_out.has(x)) { allIn = false; break; }
        if (allIn) continue;
        const merged = new Set(v_out);
        for (const x of v_anc) merged.add(x);
        out.setById(id, merged);
      }
    }
  }
};

// Loop fixpoint check: returns true iff merging `b` into `a` would leave `a`
// unchanged (every entry in b's chain is already covered by a). Walks b's
// chain up to `stopAt` (default `a`) since entries at/beyond stopAt are
// shared by reference and would skip on the `va === vb` shortcut anyway.
const rdSubsumes = (a: RDState, b: RDState, stopAt: RDState | null = a): boolean => {
  const seen = new Set<number>();
  for (let cur: RDState | null = b; cur && cur !== stopAt; cur = cur.base) {
    const own = cur.own;
    const keys = cur.ownKeys;
    for (let i = 0; i < keys.length; i++) {
      const id = keys[i];
      if (seen.has(id)) continue;
      seen.add(id);
      const vb = own[id]!;
      const va = a.getById(id);
      if (!va) return false;
      if (va === vb) continue;
      for (const x of vb) if (!va.has(x)) return false;
    }
  }
  return true;
};

const newScope = (parent: Scope | null, kind: ScopeKind): Scope => ({
  parent,
  kind,
  bindings: new Map(),
});

// resolveScope walks the scope chain looking up a name. Repeated lookups in
// the same scope (common in minified single-letter aliasing) hit a per-scope
// `name → binding` cache. The cache is correct because scope.bindings is
// fully populated by the hoist pre-pass and frozen before walk queries it.
const _resolveCache: WeakMap<Scope, Map<string, Binding | null>> = new WeakMap();
const resolveScope = (scope: Scope, name: string): Binding | null => {
  let bucket = _resolveCache.get(scope);
  if (bucket) {
    const cached = bucket.get(name);
    if (cached !== undefined) return cached;
  }
  let result: Binding | null = null;
  for (let s: Scope | null = scope; s; s = s.parent) {
    const b = s.bindings.get(name);
    if (b) { result = b; break; }
  }
  if (!bucket) { bucket = new Map(); _resolveCache.set(scope, bucket); }
  bucket.set(name, result);
  return result;
};

const findVarScope = (scope: Scope): Scope => {
  for (let s: Scope | null = scope; s; s = s.parent)
    if (s.kind !== 'block') return s;
  return scope;
};

const enclosingFnScope = (s: Scope): Scope => {
  for (let cur: Scope | null = s; cur; cur = cur.parent)
    if (cur.kind === 'function' || cur.kind === 'program') return cur;
  return s;
};

const isInsideScope = (inner: Scope, outer: Scope): boolean => {
  for (let cur: Scope | null = inner; cur; cur = cur.parent)
    if (cur === outer) return true;
  return false;
};

const append = <K, V>(m: Map<K, V[]>, k: K, v: V): void => {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
};

function collectPatternIds(pattern: any, out: any[] = []): any[] {
  if (!pattern?.type) return out;
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern);
      break;
    case 'RestElement':
      collectPatternIds(pattern.argument, out);
      break;
    case 'AssignmentPattern':
      collectPatternIds(pattern.left, out);
      break;
    case 'ArrayPattern':
      for (const el of pattern.elements || []) collectPatternIds(el, out);
      break;
    case 'ObjectPattern':
      for (const p of pattern.properties || []) {
        if (p?.type === 'Property') collectPatternIds(p.value, out);
        else if (p?.type === 'RestElement')
          collectPatternIds(p.argument, out);
      }
      break;
  }
  return out;
}

// Cached subtree-write check. RD is mutated only by AssignmentExpression with
// operator `=` and Identifier left, or by VariableDeclarator. Nested function
// bodies are deferred (their writes don't reach the enclosing walk's rd), so
// they short-circuit to false here. Branch handlers can skip cloneRD/mergeRD
// when both sides return false — see callers in walk().
const rdWriteCache = new WeakMap<any, boolean>();
function nodeWritesRD(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  const cached = rdWriteCache.get(node);
  if (cached !== undefined) return cached;
  const t = node.type;
  if (
    (t === 'AssignmentExpression' &&
      node.operator === '=' &&
      node.left?.type === 'Identifier') ||
    t === 'VariableDeclaration' ||
    t === 'VariableDeclarator'
  ) {
    rdWriteCache.set(node, true);
    return true;
  }
  // Nested function bodies are walked separately via the deferred queue.
  if (
    t === 'FunctionDeclaration' ||
    t === 'FunctionExpression' ||
    t === 'ArrowFunctionExpression'
  ) {
    rdWriteCache.set(node, false);
    return false;
  }
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = (node as any)[k];
    if (Array.isArray(v)) {
      for (const c of v) {
        if (nodeWritesRD(c)) {
          rdWriteCache.set(node, true);
          return true;
        }
      }
    } else if (v && typeof v === 'object' && v.type) {
      if (nodeWritesRD(v)) {
        rdWriteCache.set(node, true);
        return true;
      }
    }
  }
  rdWriteCache.set(node, false);
  return false;
}

// === Single-pass build: hoist + integrated visit/RD ========================
//
// Two-pass overall: (1) hoist pre-pass for forward references, (2) integrated
// walk that classifies Identifiers, threads path-sensitive RD, and queues
// every function body for deferred processing. The deferred queue is drained
// after the enclosing scope's walk completes, so each inner function body is
// walked when `T.defs` for its outer-scope bindings is already complete —
// giving the closure-capture seed an accurate "all-defs" view.

function buildTables(ast: any): DUTables {
  const moduleKind = detectModuleKind(ast);
  const T: DUTables = {
    defs: new Map(),
    callOf: new Map(),
    reachingDefs: new Map(),
    labelToBinding: new Map(),
    parentOf: new Map(),
    selfCalls: new Map(),
    killed: new Set(),
    closureReassigned: new Set(),
    fnNodeToScope: new Map(),
    bindings: [],
    programScope: newScope(null, 'program'),
    moduleKind,
    enclosingFn: new Map(),
    parentFnOf: new Map(),
  };
  // Populated lazily by walk()'s CallExpression handler when it sees
  // `recv.call(...)`/`recv.apply(...)` with an Identifier receiver — avoids
  // the upfront full-AST walk in collectApplyCallReceivers.
  const applyCallRecv = new Map<any, any>();
  const fnStack: any[] = [];
  const functionFlowLabels = new Set<Label>();

  const registerBinding = (b: Omit<Binding, 'id'>): Binding => {
    const registered: Binding = { id: T.bindings.length, ...b };
    T.bindings.push(registered);
    return registered;
  };

  // Bindings that have at least one function-valued def. The Identifier-use
  // path gates its bookkeeping on this — non-fn-valued bindings never feed
  // into classify, so we skip Map.set + setReached for them. (Common case in
  // minified JS: most bindings are data vars.)
  const isFnValuedBinding = new Set<Binding>();
  // Names ever bound to a fn-valued binding. The hoist marker pre-scan uses
  // this to detect bodies that reference a fn-valued name; bodies with none
  // can skip their walk entirely (see pending-body loop).
  const fnBindingNames = new Set<string>();
  const addFnDef = (b: Binding, label: Label): void => {
    functionFlowLabels.add(label);
    append(T.defs, b, label);
    isFnValuedBinding.add(b);
    // b.declSite is usually the FD/declarator/Identifier — derive a name.
    const declSite = b.declSite;
    const nm = declSite?.id?.name ?? declSite?.name;
    if (nm) fnBindingNames.add(nm);
  };

  const hasFunctionFlow = (defs: Set<Label> | undefined): boolean => {
    if (!defs) return false;
    for (const d of defs) if (functionFlowLabels.has(d)) return true;
    return false;
  };

  const setReached = (label: Label, b: Binding, rd: RDState): void => {
    const defs = rd.get(b);
    if (hasFunctionFlow(defs)) T.reachingDefs.set(label, defs!);
  };

  // ---- Declaration helpers ----
  const declare = (
    name: string,
    scope: Scope,
    declSite: any,
    fnNode: any | null,
    opts: { isFnSelf?: boolean } = {}
  ): Binding => {
    const existing = scope.bindings.get(name);
    if (existing) {
      T.labelToBinding.set(declSite, existing);
      if (fnNode) {
        if (!existing.fnNode) existing.fnNode = fnNode;
        addFnDef(existing, declSite);
      }
      return existing;
    }
    const b = registerBinding({
      declSite,
      fnNode,
      scope,
      isExposed: scope.kind === 'program' && moduleKind === 'script',
      isFnSelf: !!opts.isFnSelf,
    });
    scope.bindings.set(name, b);
    T.labelToBinding.set(declSite, b);
    if (fnNode) addFnDef(b, declSite);
    return b;
  };

  const declarePattern = (pat: any, scope: Scope): void => {
    for (const id of collectPatternIds(pat)) declare(id.name, scope, id, null);
  };

  // ---- Hoist pre-pass (binding registration only) ----
  // Descends through all non-function children so var/FD declarations at any
  // depth land in the right scope.
  // Fused pre-pass: registers FD/var/class bindings into scope AND seeds
  // function-flow defs into `rd` when an RDState is supplied. Combining the
  // two earlier passes (`hoist` + `hoistFnDeclsInto`) halves the traversal
  // count per pending function body.
  // Tracking flag for per-body fn-marker pre-scan. When `_trackFnMarker` is
  // on (only during pending-body hoist), `_foundFnMarker` is set the first
  // time hoist visits an Identifier matching `fnBindingNames` or a function
  // node (FE / Arrow / FD / MethodDefinition). The pending-body loop reads
  // it after hoist returns; a false value means the body's walk has no SC
  // work to do and can be skipped.
  let _trackFnMarker = false;
  let _foundFnMarker = false;
  const hoist = (node: any, scope: Scope, parent: any = null, rd: RDState | null = null): void => {
    if (!node?.type) return;
    if (_trackFnMarker && !_foundFnMarker) {
      const tt = node.type;
      if (tt === 'Identifier') {
        if (fnBindingNames.has(node.name)) _foundFnMarker = true;
      } else if (
        tt === 'FunctionDeclaration' || tt === 'FunctionExpression' ||
        tt === 'ArrowFunctionExpression' || tt === 'MethodDefinition'
      ) {
        _foundFnMarker = true;
      }
    }
    let current = scope;
    const isBlockCtx =
      (node.type === 'BlockStatement' &&
        parent?.type !== 'FunctionDeclaration' &&
        parent?.type !== 'FunctionExpression' &&
        parent?.type !== 'ArrowFunctionExpression') ||
      node.type === 'ForStatement' ||
      node.type === 'ForInStatement' ||
      node.type === 'ForOfStatement' ||
      node.type === 'SwitchStatement' ||
      node.type === 'CatchClause';
    if (isBlockCtx) current = newScope(scope, 'block');

    if (node.type === 'FunctionDeclaration' && node.id) {
      const b = declare(node.id.name, current, node, node);
      if (rd && !rd.has(b)) rd.set(b, new Set([node]));
      return;
    }
    if (node.type === 'ClassDeclaration' && node.id) {
      declare(node.id.name, current, node, null);
      return;
    }
    if (
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    )
      return;

    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        const target = node.kind === 'var' ? findVarScope(current) : current;
        if (d.id?.type !== 'Identifier') {
          declarePattern(d.id, target);
        } else if (!target.bindings.has(d.id.name)) {
          const fnInit =
            d.init?.type === 'FunctionExpression' ||
            d.init?.type === 'ArrowFunctionExpression'
              ? d.init
              : null;
          declare(d.id.name, target, d, fnInit);
        }
      }
    }

    // Type-driven descent (avoids Object.keys allocation per node).
    switch (node.type) {
      case 'Program':
      case 'BlockStatement':
      case 'ClassBody':
      case 'StaticBlock':
        for (const c of node.body) hoist(c, current, node, rd);
        return;
      case 'ExpressionStatement':
        if (node.expression) hoist(node.expression, current, node, rd);
        return;
      case 'ReturnStatement':
      case 'ThrowStatement':
      case 'UnaryExpression':
      case 'UpdateExpression':
      case 'SpreadElement':
      case 'RestElement':
      case 'AwaitExpression':
      case 'YieldExpression':
        if (node.argument) hoist(node.argument, current, node, rd);
        return;
      case 'CallExpression':
      case 'NewExpression':
        hoist(node.callee, current, node, rd);
        for (const a of node.arguments) hoist(a, current, node, rd);
        return;
      case 'MemberExpression':
        hoist(node.object, current, node, rd);
        if (node.computed) hoist(node.property, current, node, rd);
        return;
      case 'BinaryExpression':
      case 'LogicalExpression':
      case 'AssignmentExpression':
      case 'AssignmentPattern':
        hoist(node.left, current, node, rd);
        hoist(node.right, current, node, rd);
        return;
      case 'ConditionalExpression':
        hoist(node.test, current, node, rd);
        hoist(node.consequent, current, node, rd);
        hoist(node.alternate, current, node, rd);
        return;
      case 'SequenceExpression':
        for (const e of node.expressions) hoist(e, current, node, rd);
        return;
      case 'ArrayExpression':
      case 'ArrayPattern':
        for (const e of node.elements) if (e) hoist(e, current, node, rd);
        return;
      case 'ObjectExpression':
      case 'ObjectPattern':
        for (const p of node.properties) hoist(p, current, node, rd);
        return;
      case 'Property':
        if (node.computed) hoist(node.key, current, node, rd);
        hoist(node.value, current, node, rd);
        return;
      case 'TemplateLiteral':
        for (const e of node.expressions) hoist(e, current, node, rd);
        return;
      case 'TaggedTemplateExpression':
        hoist(node.tag, current, node, rd);
        hoist(node.quasi, current, node, rd);
        return;
      case 'VariableDeclaration':
        for (const d of node.declarations) hoist(d, current, node, rd);
        return;
      case 'VariableDeclarator':
        hoist(node.id, current, node, rd);
        if (node.init) hoist(node.init, current, node, rd);
        return;
      case 'LabeledStatement':
        hoist(node.body, current, node, rd);
        return;
      case 'CatchClause':
        if (node.param) hoist(node.param, current, node, rd);
        hoist(node.body, current, node, rd);
        return;
      case 'SwitchCase':
        if (node.test) hoist(node.test, current, node, rd);
        for (const c of node.consequent) hoist(c, current, node, rd);
        return;
      case 'SwitchStatement':
        hoist(node.discriminant, current, node, rd);
        for (const c of node.cases) hoist(c, current, node, rd);
        return;
      case 'IfStatement':
        hoist(node.test, current, node, rd);
        hoist(node.consequent, current, node, rd);
        if (node.alternate) hoist(node.alternate, current, node, rd);
        return;
      case 'ForStatement':
        if (node.init) hoist(node.init, current, node, rd);
        if (node.test) hoist(node.test, current, node, rd);
        if (node.update) hoist(node.update, current, node, rd);
        hoist(node.body, current, node, rd);
        return;
      case 'ForInStatement':
      case 'ForOfStatement':
        hoist(node.left, current, node, rd);
        hoist(node.right, current, node, rd);
        hoist(node.body, current, node, rd);
        return;
      case 'WhileStatement':
      case 'DoWhileStatement':
        hoist(node.test, current, node, rd);
        hoist(node.body, current, node, rd);
        return;
      case 'TryStatement':
        hoist(node.block, current, node, rd);
        if (node.handler) hoist(node.handler, current, node, rd);
        if (node.finalizer) hoist(node.finalizer, current, node, rd);
        return;
      case 'Identifier':
      case 'Literal':
      case 'TemplateElement':
      case 'PrivateIdentifier':
      case 'ThisExpression':
      case 'Super':
      case 'MetaProperty':
      case 'EmptyStatement':
      case 'DebuggerStatement':
      case 'BreakStatement':
      case 'ContinueStatement':
        return;
    }
    // Fallback for less-common types (class/import/export, etc.)
    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) for (const c of v) hoist(c, current, node, rd);
      else if (v && typeof v === 'object' && v.type) hoist(v, current, node, rd);
    }
  };

  // Re-hoists let/const/FD that belong to a block scope entered by walk.
  const hoistBlockBody = (stmts: any[], scope: Scope): void => {
    for (const s of stmts || []) {
      if (s?.type === 'FunctionDeclaration' && s.id) {
        declare(s.id.name, scope, s, s);
      } else if (s?.type === 'ClassDeclaration' && s.id) {
        declare(s.id.name, scope, s, null);
      } else if (
        s?.type === 'VariableDeclaration' &&
        (s.kind === 'let' || s.kind === 'const')
      ) {
        for (const d of s.declarations) {
          if (d.id?.type !== 'Identifier') {
            declarePattern(d.id, scope);
          } else if (!scope.bindings.has(d.id.name)) {
            const fnInit =
              d.init?.type === 'FunctionExpression' ||
              d.init?.type === 'ArrowFunctionExpression'
                ? d.init
                : null;
            declare(d.id.name, scope, d, fnInit);
          }
        }
      }
    }
  };

  // Queue of function bodies to walk after the enclosing scope completes.
  // `ancestry` captures the enclosing-fn chain at the queue point so the
  // walker can restore `fnStack` for self-recursion detection inside nested
  // function bodies (which are themselves deferred entries).
  type Deferred = { node: any; scope: Scope; ancestry: any[] };
  const pendingFns: Deferred[] = [];

  // Per-scope seed RDState cache, built lazily and never invalidated. Each
  // pending function body forks its parent scope's seed (`new RDState(seed)`)
  // and inherits all outer fn-flow defs through the base chain — replacing
  // the older per-body loop that called `rd.set(...)` for every outer-scope
  // binding (which on big bundles was ~10^8 ops per file).
  //
  // The cache never invalidates: the only way an entry can go stale is if a
  // sibling body's walk later does a closure write (`outerX = function(){}`)
  // and grows T.defs for an outer binding. In minified bundles closure
  // writes are rare, and a stale entry can at worst cause `|Def(u)|` to be
  // underestimated at a single use site (which makes a binding mis-classify
  // as SC). The regression suite and `sc-react-compare` smoke test cover
  // this; re-introduce versioning here if either drifts in the future.
  const scopeSeedCache = new Map<Scope, RDState>();
  const getScopeSeed = (scope: Scope): RDState => {
    const cached = scopeSeedCache.get(scope);
    if (cached) return cached;
    const parentSeed = scope.parent ? getScopeSeed(scope.parent) : null;
    const seed = parentSeed ? new RDState(parentSeed) : new RDState();
    for (const b of scope.bindings.values()) {
      const allDefs = T.defs.get(b);
      if (allDefs && allDefs.length) seed.set(b, new Set(allDefs));
    }
    scopeSeedCache.set(scope, seed);
    return seed;
  };

  // Body-trivial pre-scan. A pending body is "trivial" if walking it cannot
  // affect SC classification — no inner function nodes (nothing to queue),
  // no closure writes via `x = function(){}` (nothing to addFnDef on outer
  // bindings), and no Identifier reference to any currently-fn-valued
  // binding name (nothing to record into T.reachingDefs that classify reads).
  // Structural markers are cached per AST node; the Identifier check has to
  // run each time because fnBindingNames can grow.
  const _structureCache = new WeakMap<any, boolean>();  // true ⇒ structurally trivial
  const structureTrivial = (n: any): boolean => {
    if (!n || typeof n !== 'object') return true;
    if (!n.type) return true;
    const cached = _structureCache.get(n);
    if (cached !== undefined) return cached;
    const t = n.type;
    if (
      t === 'FunctionDeclaration' || t === 'FunctionExpression' ||
      t === 'ArrowFunctionExpression' || t === 'MethodDefinition'
    ) { _structureCache.set(n, false); return false; }
    if (t === 'AssignmentExpression') {
      const r = n.right;
      if (r?.type === 'FunctionExpression' || r?.type === 'ArrowFunctionExpression') {
        _structureCache.set(n, false); return false;
      }
    }
    if (t === 'VariableDeclarator') {
      const i = n.init;
      if (i?.type === 'FunctionExpression' || i?.type === 'ArrowFunctionExpression') {
        _structureCache.set(n, false); return false;
      }
    }
    // Type-driven descent. Anything not enumerated falls through to the
    // Object.keys fallback (rare types like Import/Export — conservatively
    // walked to catch any unhandled FE-bearing patterns).
    let ok = true;
    switch (t) {
      case 'Program': case 'BlockStatement': case 'ClassBody': case 'StaticBlock':
        for (const c of n.body) if (!structureTrivial(c)) { ok = false; break; } break;
      case 'ExpressionStatement': ok = structureTrivial(n.expression); break;
      case 'ReturnStatement': case 'ThrowStatement':
      case 'UnaryExpression': case 'UpdateExpression': case 'SpreadElement':
      case 'AwaitExpression': case 'YieldExpression': case 'RestElement':
        ok = !n.argument || structureTrivial(n.argument); break;
      case 'CallExpression': case 'NewExpression':
        ok = structureTrivial(n.callee);
        if (ok) for (const a of n.arguments) if (!structureTrivial(a)) { ok = false; break; }
        break;
      case 'MemberExpression':
        ok = structureTrivial(n.object) && (!n.computed || structureTrivial(n.property)); break;
      case 'BinaryExpression': case 'LogicalExpression':
      case 'AssignmentExpression': case 'AssignmentPattern':
        ok = structureTrivial(n.left) && structureTrivial(n.right); break;
      case 'ConditionalExpression':
        ok = structureTrivial(n.test) && structureTrivial(n.consequent) && structureTrivial(n.alternate); break;
      case 'SequenceExpression':
        for (const e of n.expressions) if (!structureTrivial(e)) { ok = false; break; } break;
      case 'ArrayExpression': case 'ArrayPattern':
        for (const e of n.elements) if (e && !structureTrivial(e)) { ok = false; break; } break;
      case 'ObjectExpression': case 'ObjectPattern':
        for (const p of n.properties) if (!structureTrivial(p)) { ok = false; break; } break;
      case 'Property':
        ok = (!n.computed || structureTrivial(n.key)) && structureTrivial(n.value); break;
      case 'TemplateLiteral':
        for (const e of n.expressions) if (!structureTrivial(e)) { ok = false; break; } break;
      case 'TaggedTemplateExpression':
        ok = structureTrivial(n.tag) && structureTrivial(n.quasi); break;
      case 'VariableDeclaration':
        for (const d of n.declarations) if (!structureTrivial(d)) { ok = false; break; } break;
      case 'VariableDeclarator':
        ok = structureTrivial(n.id) && (!n.init || structureTrivial(n.init)); break;
      case 'IfStatement':
        ok = structureTrivial(n.test) && structureTrivial(n.consequent)
          && (!n.alternate || structureTrivial(n.alternate)); break;
      case 'SwitchStatement':
        ok = structureTrivial(n.discriminant);
        if (ok) for (const c of n.cases) if (!structureTrivial(c)) { ok = false; break; }
        break;
      case 'SwitchCase':
        ok = (!n.test || structureTrivial(n.test));
        if (ok) for (const c of n.consequent) if (!structureTrivial(c)) { ok = false; break; }
        break;
      case 'ForStatement':
        ok = (!n.init || structureTrivial(n.init))
          && (!n.test || structureTrivial(n.test))
          && (!n.update || structureTrivial(n.update))
          && structureTrivial(n.body); break;
      case 'ForInStatement': case 'ForOfStatement':
        ok = structureTrivial(n.left) && structureTrivial(n.right) && structureTrivial(n.body); break;
      case 'WhileStatement': case 'DoWhileStatement':
        ok = structureTrivial(n.test) && structureTrivial(n.body); break;
      case 'TryStatement':
        ok = structureTrivial(n.block)
          && (!n.handler || structureTrivial(n.handler))
          && (!n.finalizer || structureTrivial(n.finalizer)); break;
      case 'CatchClause':
        ok = (!n.param || structureTrivial(n.param)) && structureTrivial(n.body); break;
      case 'LabeledStatement':
        ok = structureTrivial(n.body); break;
      // Leaf types — already trivial. Identifier itself is handled by the
      // fnRef check separately; structurally Identifier is benign.
      case 'Identifier': case 'Literal': case 'TemplateElement':
      case 'PrivateIdentifier': case 'ThisExpression': case 'Super':
      case 'MetaProperty': case 'EmptyStatement': case 'DebuggerStatement':
      case 'BreakStatement': case 'ContinueStatement':
        break;
      default:
        // Conservative: be non-trivial for unknown types.
        ok = false;
    }
    _structureCache.set(n, ok);
    return ok;
  };
  // Check Identifier references against current fnBindingNames. Returns true
  // iff `node` contains an Identifier whose name is in fnBindingNames.
  const containsFnRef = (n: any): boolean => {
    if (!n || typeof n !== 'object' || !n.type) return false;
    if (n.type === 'Identifier') return fnBindingNames.has(n.name);
    // Fast type-driven recurse (same shape as structureTrivial).
    const t = n.type;
    switch (t) {
      case 'Program': case 'BlockStatement': case 'ClassBody': case 'StaticBlock':
        for (const c of n.body) if (containsFnRef(c)) return true; return false;
      case 'ExpressionStatement': return containsFnRef(n.expression);
      case 'ReturnStatement': case 'ThrowStatement':
      case 'UnaryExpression': case 'UpdateExpression': case 'SpreadElement':
      case 'AwaitExpression': case 'YieldExpression': case 'RestElement':
        return !!n.argument && containsFnRef(n.argument);
      case 'CallExpression': case 'NewExpression':
        if (containsFnRef(n.callee)) return true;
        for (const a of n.arguments) if (containsFnRef(a)) return true; return false;
      case 'MemberExpression':
        return containsFnRef(n.object) || (n.computed && containsFnRef(n.property));
      case 'BinaryExpression': case 'LogicalExpression':
      case 'AssignmentExpression': case 'AssignmentPattern':
        return containsFnRef(n.left) || containsFnRef(n.right);
      case 'ConditionalExpression':
        return containsFnRef(n.test) || containsFnRef(n.consequent) || containsFnRef(n.alternate);
      case 'SequenceExpression':
        for (const e of n.expressions) if (containsFnRef(e)) return true; return false;
      case 'ArrayExpression': case 'ArrayPattern':
        for (const e of n.elements) if (e && containsFnRef(e)) return true; return false;
      case 'ObjectExpression': case 'ObjectPattern':
        for (const p of n.properties) if (containsFnRef(p)) return true; return false;
      case 'Property':
        return (n.computed && containsFnRef(n.key)) || containsFnRef(n.value);
      case 'TemplateLiteral':
        for (const e of n.expressions) if (containsFnRef(e)) return true; return false;
      case 'TaggedTemplateExpression':
        return containsFnRef(n.tag) || containsFnRef(n.quasi);
      case 'VariableDeclaration':
        for (const d of n.declarations) if (containsFnRef(d)) return true; return false;
      case 'VariableDeclarator':
        return containsFnRef(n.id) || (!!n.init && containsFnRef(n.init));
      case 'IfStatement':
        return containsFnRef(n.test) || containsFnRef(n.consequent)
          || (!!n.alternate && containsFnRef(n.alternate));
      case 'SwitchStatement':
        if (containsFnRef(n.discriminant)) return true;
        for (const c of n.cases) if (containsFnRef(c)) return true; return false;
      case 'SwitchCase':
        if (n.test && containsFnRef(n.test)) return true;
        for (const c of n.consequent) if (containsFnRef(c)) return true; return false;
      case 'ForStatement':
        return (!!n.init && containsFnRef(n.init))
          || (!!n.test && containsFnRef(n.test))
          || (!!n.update && containsFnRef(n.update))
          || containsFnRef(n.body);
      case 'ForInStatement': case 'ForOfStatement':
        return containsFnRef(n.left) || containsFnRef(n.right) || containsFnRef(n.body);
      case 'WhileStatement': case 'DoWhileStatement':
        return containsFnRef(n.test) || containsFnRef(n.body);
      case 'TryStatement':
        return containsFnRef(n.block)
          || (!!n.handler && containsFnRef(n.handler))
          || (!!n.finalizer && containsFnRef(n.finalizer));
      case 'CatchClause':
        return (!!n.param && containsFnRef(n.param)) || containsFnRef(n.body);
      case 'LabeledStatement':
        return containsFnRef(n.body);
      // Leaf types are clearly false (Identifier handled at top).
      case 'Literal': case 'TemplateElement': case 'PrivateIdentifier':
      case 'ThisExpression': case 'Super': case 'MetaProperty':
      case 'EmptyStatement': case 'DebuggerStatement':
      case 'BreakStatement': case 'ContinueStatement':
        return false;
      default:
        return true; // unknown — conservative
    }
  };

  // ---- Integrated walk: Identifier classification + RD threading ----
  const walk = (
    node: any,
    parent: any,
    scope: Scope,
    rd: RDState
  ): RDState => {
    if (!node?.type) return rd;

    // Leaf-node fast path: literals, this/super, leaf statements — no
    // recursion, no scope context. Quickly bails before any work below.
    switch (node.type) {
      case 'Literal':
      case 'TemplateElement':
      case 'PrivateIdentifier':
      case 'ThisExpression':
      case 'Super':
      case 'MetaProperty':
      case 'EmptyStatement':
      case 'DebuggerStatement':
      case 'BreakStatement':
      case 'ContinueStatement':
        return rd;
    }

    // Fast path: Identifier is by far the most-visited node type during walk.
    // Returning early here lets the common case skip the ~12 string-equality
    // checks for block context and statement-specific handlers below.
    // (Identifier never enters a new block scope, so `current = scope`.)
    if (node.type === 'Identifier') {
      if (!parent) return rd;
      const current = scope;
      const outerCE = applyCallRecv.get(node);
      if (outerCE) {
        const b = resolveScope(current, node.name);
        // Gate: classify only iterates fn-valued bindings. Non-fn bindings'
        // call-receiver use sites never feed into a useOf query, so skipping
        // the Map.set + setReached work is safe (modulo the minor staleness
        // window for closure writes that also affects the scope-seed cache —
        // verified against the regression + react bit-identical check).
        if (b && isFnValuedBinding.has(b)) {
          T.labelToBinding.set(node, b);
          const isSelf = b.fnNode && fnStack.includes(b.fnNode);
          if (isSelf) T.selfCalls.set(b, (T.selfCalls.get(b) ?? 0) + 1);
          else {
            T.callOf.set(node, outerCE);
            T.enclosingFn.set(node, fnStack.length ? fnStack[fnStack.length - 1] : null);
          }
          setReached(node, b, rd);
        }
        return rd;
      }
      // Dispatch on parent.type so the common cases (MemberExpression /
      // CallExpression / BinaryExpression etc.) fall through with one string
      // compare instead of scanning a 15-clause OR cascade.
      let skip = false;
      switch (parent.type) {
        case 'MemberExpression':
          skip = parent.property === node && !parent.computed;
          break;
        case 'Property':
        case 'MethodDefinition':
          skip = parent.key === node && !parent.computed;
          break;
        case 'AssignmentExpression':
          skip = parent.left === node && parent.operator === '=';
          break;
        case 'VariableDeclarator':
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ClassDeclaration':
        case 'ClassExpression':
          skip = parent.id === node;
          break;
        case 'LabeledStatement':
        case 'BreakStatement':
        case 'ContinueStatement':
          skip = parent.label === node;
          break;
        case 'ImportSpecifier':
          skip = parent.imported === node;
          break;
        case 'ExportSpecifier':
          skip = parent.exported === node;
          break;
      }
      if (!skip) {
        const b = resolveScope(current, node.name);
        // Gate on isFnValuedBinding — non-fn bindings never appear in
        // classify (their uses aren't queried), so all bookkeeping below is
        // skipped for them.
        if (b && isFnValuedBinding.has(b)) {
          T.labelToBinding.set(node, b);
          if (parent.type === 'VariableDeclarator' && parent.init === node) {
            T.parentOf.set(node, parent);
          }
          if (parent.type === 'CallExpression' && parent.callee === node) {
            const isSelf = b.fnNode && fnStack.includes(b.fnNode);
            if (isSelf) T.selfCalls.set(b, (T.selfCalls.get(b) ?? 0) + 1);
            else {
              T.callOf.set(node, parent);
              T.enclosingFn.set(node, fnStack.length ? fnStack[fnStack.length - 1] : null);
            }
          }
          setReached(node, b, rd);
        }
      }
      return rd;
    }

    let current = scope;

    // IIFE synthetic binding helper — used by the CallExpression case below
    // (declared up here so the early switch's TDZ doesn't trip on it).
    const makeIifeBinding = (fe: any, ce: any): void => {
      const b = registerBinding({
        declSite: fe,
        fnNode: fe,
        scope: current,
        isExposed: false,
        isFnSelf: false,
      });
      addFnDef(b, fe);
      T.callOf.set(ce, ce);
      T.enclosingFn.set(ce, fnStack.length ? fnStack[fnStack.length - 1] : null);
      T.reachingDefs.set(ce, new Set([fe]));
    };

    // ---- Early switch (V8 jump table) for the common types that don't
    // need scope setup or branching logic. Catches ~70% of node visits
    // (MemberExpression, BinaryExpression, etc.) and skips the whole
    // if-cascade below for them. ----
    switch (node.type) {
      case 'ExpressionStatement':
        return walk(node.expression, node, current, rd);
      case 'MemberExpression':
        rd = walk(node.object, node, current, rd);
        if (node.computed) rd = walk(node.property, node, current, rd);
        return rd;
      case 'BinaryExpression':
      case 'AssignmentPattern':
        rd = walk(node.left, node, current, rd);
        rd = walk(node.right, node, current, rd);
        return rd;
      case 'CallExpression':
      case 'NewExpression': {
        // IIFE / call-receiver classification (CallExpression only).
        if (node.type === 'CallExpression') {
          const callee = node.callee;
          if (callee?.type === 'FunctionExpression' || callee?.type === 'ArrowFunctionExpression') {
            makeIifeBinding(callee, node);
          } else if (
            callee?.type === 'MemberExpression' &&
            !callee.computed &&
            callee.property?.type === 'Identifier' &&
            (callee.property.name === 'call' || callee.property.name === 'apply')
          ) {
            const recv = callee.object;
            if (recv?.type === 'FunctionExpression' || recv?.type === 'ArrowFunctionExpression') {
              makeIifeBinding(recv, node);
            } else if (recv?.type === 'Identifier') {
              applyCallRecv.set(recv, node);
            }
          }
        }
        rd = walk(node.callee, node, current, rd);
        for (const a of node.arguments) rd = walk(a, node, current, rd);
        return rd;
      }
      case 'ReturnStatement':
      case 'ThrowStatement':
      case 'UnaryExpression':
      case 'UpdateExpression':
      case 'SpreadElement':
      case 'AwaitExpression':
      case 'YieldExpression':
      case 'RestElement':
        if (node.argument) rd = walk(node.argument, node, current, rd);
        return rd;
      case 'Property':
        if (node.computed) rd = walk(node.key, node, current, rd);
        rd = walk(node.value, node, current, rd);
        return rd;
      case 'SequenceExpression':
        for (const e of node.expressions) rd = walk(e, node, current, rd);
        return rd;
      case 'ArrayExpression':
      case 'ArrayPattern':
        for (const e of node.elements) if (e) rd = walk(e, node, current, rd);
        return rd;
      case 'ObjectExpression':
      case 'ObjectPattern':
        for (const p of node.properties) rd = walk(p, node, current, rd);
        return rd;
      case 'TemplateLiteral':
        for (const e of node.expressions) rd = walk(e, node, current, rd);
        return rd;
      case 'TaggedTemplateExpression':
        rd = walk(node.tag, node, current, rd);
        rd = walk(node.quasi, node, current, rd);
        return rd;
      case 'VariableDeclaration':
        for (const d of node.declarations) rd = walk(d, node, current, rd);
        return rd;
      case 'LabeledStatement':
        return walk(node.body, node, current, rd);
      case 'SwitchCase':
        if (node.test) rd = walk(node.test, node, current, rd);
        for (const c of node.consequent) rd = walk(c, node, current, rd);
        return rd;
      case 'Program':
      case 'ClassBody':
      case 'StaticBlock':
        for (const c of node.body) rd = walk(c, node, current, rd);
        return rd;
    }
    // Types not matched above fall through to the special-case if-cascade.

    // (CallExpression IIFE handling moved to the early switch above —
    // CallExpression returns from there, so no fall-through case needed.)

    // Assignment `x = ...`: classify, kill/gen RD, flag closure-write.
    if (
      node.type === 'AssignmentExpression' &&
      node.operator === '=' &&
      node.left?.type === 'Identifier'
    ) {
      rd = walk(node.right, node, current, rd);
      let b = resolveScope(current, node.left.name);
      if (!b) {
        b = registerBinding({
          declSite: node.left,
          fnNode: null,
          scope: T.programScope,
          // Undeclared write — true ambient global regardless of moduleKind.
          isExposed: true,
          isFnSelf: false,
        });
        T.programScope.bindings.set(node.left.name, b);
      } else if (
        b.scope.kind === 'function' &&
        enclosingFnScope(b.scope) !== enclosingFnScope(current)
      ) {
        T.closureReassigned.add(b);
      }
      const isFn =
        node.right?.type === 'FunctionExpression' ||
        node.right?.type === 'ArrowFunctionExpression';
      if (isFn) {
        addFnDef(b, node.left);
        T.labelToBinding.set(node.left, b);
        T.parentOf.set(node.left, node);
        if (!b.fnNode) b.fnNode = node.right;
      } else {
        T.killed.add(b);
      }
      // RD tracks only function-valued flows; non-function writes clear them.
      rd.set(b, isFn ? new Set([node.left]) : EMPTY_LABEL_SET);
      return rd;
    }

    // Function / arrow — register self-scope + queue body for deferred walk.
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const inner = newScope(scope, 'function');
      T.fnNodeToScope.set(node, inner);
      T.parentFnOf.set(node, fnStack.length ? fnStack[fnStack.length - 1] : null);
      for (const p of node.params || []) declarePattern(p, inner);
      if (node.type === 'FunctionExpression' && node.id)
        declare(node.id.name, inner, node, node, { isFnSelf: true });
      pendingFns.push({
        node,
        scope: inner,
        ancestry: [...fnStack, node],
      });
      return rd;
    }

    // Block / for / switch / catch: enter local scope with re-hoist.
    if (
      node.type === 'BlockStatement' &&
      parent?.type !== 'FunctionDeclaration' &&
      parent?.type !== 'FunctionExpression' &&
      parent?.type !== 'ArrowFunctionExpression'
    ) {
      current = newScope(scope, 'block');
      hoistBlockBody(node.body || [], current);
    }
    if (
      node.type === 'ForStatement' ||
      node.type === 'ForInStatement' ||
      node.type === 'ForOfStatement'
    ) {
      current = newScope(scope, 'block');
      const loop = node.type === 'ForStatement' ? node.init : node.left;
      if (
        loop?.type === 'VariableDeclaration' &&
        (loop.kind === 'let' || loop.kind === 'const')
      ) {
        for (const d of loop.declarations) {
          if (d.id?.type !== 'Identifier') {
            declarePattern(d.id, current);
          } else if (!current.bindings.has(d.id.name)) {
            const fnInit =
              d.init?.type === 'FunctionExpression' ||
              d.init?.type === 'ArrowFunctionExpression'
                ? d.init
                : null;
            declare(d.id.name, current, d, fnInit);
          }
        }
      }
    }
    if (node.type === 'SwitchStatement') {
      current = newScope(scope, 'block');
      for (const c of node.cases || [])
        hoistBlockBody(c.consequent || [], current);
    }
    if (node.type === 'CatchClause') {
      current = newScope(scope, 'block');
      if (node.param) declarePattern(node.param, current);
    }

    // Branching control flow — split, walk, merge.
    // Fast path: when a branch subtree contains no RD-mutating node (no
    // Assignment/VariableDecl), walking it leaves rd untouched, so
    // cloneRD+mergeRD is a no-op. We still walk for the side effects on T
    // (use-site reachingDefs, fn-self defs, etc.).
    if (node.type === 'IfStatement') {
      rd = walk(node.test, node, current, rd);
      const thenW = nodeWritesRD(node.consequent);
      const elseW = !!node.alternate && nodeWritesRD(node.alternate);
      if (!thenW && !elseW) {
        walk(node.consequent, node, current, rd);
        if (node.alternate) walk(node.alternate, node, current, rd);
        return rd;
      }
      const rdThen = thenW
        ? walk(node.consequent, node, current, cloneRD(rd))
        : (walk(node.consequent, node, current, rd), rd);
      const rdElse = !node.alternate
        ? rd
        : elseW
        ? walk(node.alternate, node, current, cloneRD(rd))
        : (walk(node.alternate, node, current, rd), rd);
      // Mutate the fork side; thenW guarantees rdThen is a fork, otherwise
      // elseW guarantees rdElse is a fork. Pass rd as the common ancestor so
      // the merge only walks override layers (cuts ~6.7k shared-binding iter
      // per merge on big bundles down to a handful).
      if (thenW) { mergeBranchesInto(rdThen, rdElse, rd); return rdThen; }
      mergeBranchesInto(rdElse, rdThen, rd);
      return rdElse;
    }
    if (node.type === 'ConditionalExpression') {
      rd = walk(node.test, node, current, rd);
      const aW = nodeWritesRD(node.consequent);
      const bW = nodeWritesRD(node.alternate);
      if (!aW && !bW) {
        walk(node.consequent, node, current, rd);
        walk(node.alternate, node, current, rd);
        return rd;
      }
      const rdA = aW
        ? walk(node.consequent, node, current, cloneRD(rd))
        : (walk(node.consequent, node, current, rd), rd);
      const rdB = bW
        ? walk(node.alternate, node, current, cloneRD(rd))
        : (walk(node.alternate, node, current, rd), rd);
      if (aW) { mergeBranchesInto(rdA, rdB, rd); return rdA; }
      mergeBranchesInto(rdB, rdA, rd);
      return rdB;
    }
    if (node.type === 'LogicalExpression') {
      rd = walk(node.left, node, current, rd);
      if (!nodeWritesRD(node.right)) {
        walk(node.right, node, current, rd);
        return rd;
      }
      const beforeRight = cloneRD(rd);
      const rdAfterRight = walk(node.right, node, current, beforeRight);
      // rdAfterRight is a descendant of beforeRight (a fork) — safe to mutate.
      mergeBranchesInto(rdAfterRight, rd, rd);
      return rdAfterRight;
    }
    if (node.type === 'SwitchStatement') {
      rd = walk(node.discriminant, node, current, rd);
      // Fast path: if no case writes rd, all walks leave rd unchanged.
      let anyWrites = false;
      for (const c of node.cases || []) {
        if (nodeWritesRD(c)) { anyWrites = true; break; }
      }
      if (!anyWrites) {
        for (const c of node.cases || []) walk(c, node, current, rd);
        return rd;
      }
      const merged = cloneRD(rd);
      for (const c of node.cases || []) {
        const after = nodeWritesRD(c)
          ? walk(c, node, current, cloneRD(rd))
          : (walk(c, node, current, rd), rd);
        mergeBranchesInto(merged, after, rd);
      }
      return merged;
    }

    // Loops: bounded fixpoint over body.
    if (
      node.type === 'WhileStatement' ||
      node.type === 'DoWhileStatement' ||
      node.type === 'ForStatement' ||
      node.type === 'ForInStatement' ||
      node.type === 'ForOfStatement'
    ) {
      if (node.type === 'ForStatement' && node.init)
        rd = walk(node.init, node, current, rd);
      if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
        if (node.right) rd = walk(node.right, node, current, rd);
        if (node.left) rd = walk(node.left, node, current, rd);
      }
      // Fast path: pure body + test/update don't change rd → no fixpoint
      // needed. Walk once with rd directly for side effects on T.
      const bodyW = nodeWritesRD(node.body);
      const testW = !!node.test && nodeWritesRD(node.test);
      const updW =
        node.type === 'ForStatement' && !!node.update && nodeWritesRD(node.update);
      if (!bodyW && !testW && !updW) {
        walk(node.body, node, current, rd);
        if (node.test) walk(node.test, node, current, rd);
        if (node.type === 'ForStatement' && node.update)
          walk(node.update, node, current, rd);
        return rd;
      }
      const state = cloneRD(rd);
      for (let i = 0; i < 3; i++) {
        const after = walk(node.body, node, current, cloneRD(state));
        if (rdSubsumes(state, after)) break;
        // after.chain ⊃ state — passing ancestor=state truncates merge to
        // after's overrides above state (skips the shared rd-chain bindings).
        mergeBranchesInto(state, after, state);
      }
      if (node.test) walk(node.test, node, current, state);
      if (node.type === 'ForStatement' && node.update)
        walk(node.update, node, current, state);
      return state;
    }

    if (node.type === 'TryStatement') {
      const blockW = nodeWritesRD(node.block);
      const handlerW = !!node.handler && nodeWritesRD(node.handler);
      const finW = !!node.finalizer && nodeWritesRD(node.finalizer);
      if (!blockW && !handlerW && !finW) {
        walk(node.block, node, current, rd);
        if (node.handler) walk(node.handler, node, current, rd);
        if (node.finalizer) walk(node.finalizer, node, current, rd);
        return rd;
      }
      const rdTry = walk(node.block, node, current, cloneRD(rd));
      let rdCatch: RDState | null = null;
      if (node.handler) {
        const handlerIn = cloneRD(rd);
        mergeBranchesInto(handlerIn, rdTry, rd);
        rdCatch = walk(node.handler, node, current, handlerIn);
      }
      // Result chain rooted in rdTry — mutate rdTry to absorb rdCatch.
      if (rdCatch) mergeBranchesInto(rdTry, rdCatch, rd);
      let rdAfter = rdTry;
      if (node.finalizer) rdAfter = walk(node.finalizer, node, current, rdAfter);
      return rdAfter;
    }

    // VariableDeclarator: walk init, then bind.
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      if (node.init) rd = walk(node.init, node, current, rd);
      const b = T.labelToBinding.get(node);
      if (b && node.init) {
        const directFn =
          node.init.type === 'FunctionExpression' ||
          node.init.type === 'ArrowFunctionExpression';
        const initFlow =
          node.init.type === 'Identifier'
            ? hasFunctionFlow(T.reachingDefs.get(node.init))
            : false;
        if (directFn || initFlow) {
          functionFlowLabels.add(node);
          // The binding inherits fn-flow status from the init. Mark it in
          // isFnValuedBinding so later uses of `b` actually run the
          // labelToBinding/setReached bookkeeping that classify needs.
          isFnValuedBinding.add(b);
          rd.set(b, new Set([node]));
        } else {
          rd.set(b, EMPTY_LABEL_SET);
        }
      } else if (b && !rd.has(b)) rd.set(b, EMPTY_LABEL_SET);
      return rd;
    }

    // (Identifier + leaf types + most expression types handled in fast paths
    // / early switch above.) Only the types that needed the cascade's scope
    // setup (BlockStatement with isBlockCtx; CatchClause with param decl)
    // and any unknown / less-common types reach the final dispatch below.
    switch (node.type) {
      case 'BlockStatement':
        for (const c of node.body) rd = walk(c, node, current, rd);
        return rd;
      case 'CatchClause':
        if (node.param) rd = walk(node.param, node, current, rd);
        return walk(node.body, node, current, rd);
    }
    // Generic Object.keys fallback for less-common types (class/import/export
    // declarations, etc.). Each fired here would be cheap to add a case for
    // above if it shows up in a profile.
    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (const c of v) rd = walk(c, node, current, rd);
      } else if (v && typeof v === 'object' && v.type) {
        rd = walk(v, node, current, rd);
      }
    }
    return rd;
  };

  // ---- Drive: hoist program-scope decls, then walk + drain queue ----
  const initialRD = new RDState();
  hoist(ast, T.programScope, null, initialRD);
  walk(ast, null, T.programScope, initialRD);

  // Deferred function-body processing. Each entry's body is walked with an
  // innerRD seeded by:
  //   1. Outer-scope bindings' full Phase-1 def-set (closure over-approx,
  //      via the scope-seed chain).
  //   2. The function's hoisted FDs.
  //   3. Each parameter as its own def-site.
  //   4. Named-FE self binding (declSite = the FE node).
  for (let pendingIdx = 0; pendingIdx < pendingFns.length; pendingIdx++) {
    const { node, scope: inner, ancestry } = pendingFns[pendingIdx];
    const parentSeed = inner.parent ? getScopeSeed(inner.parent) : null;
    const innerRD = parentSeed ? new RDState(parentSeed) : new RDState();
    // hoist also pre-scans for SC-relevant markers: an inner function (FE /
    // Arrow / FD / MethodDefinition) or an Identifier whose name maps to a
    // currently-fn-valued binding. If neither was seen AND all params are
    // plain Identifiers, the walk would write nothing that classify reads
    // — skip the entry entirely.
    _trackFnMarker = true;
    _foundFnMarker = false;
    if (node.body) hoist(node.body, inner, node, innerRD);
    _trackFnMarker = false;
    if (!_foundFnMarker) {
      let paramsTriv = true;
      const params = node.params;
      if (params && params.length) {
        for (let i = 0; i < params.length; i++) {
          if (params[i]?.type !== 'Identifier') { paramsTriv = false; break; }
        }
      }
      if (paramsTriv) continue;
    }
    for (const p of node.params || []) {
      if (p?.type === 'Identifier') {
        // Fast path: simple Identifier param (the common case in minified
        // code). Avoids the `collectPatternIds` allocation entirely.
        const b = T.labelToBinding.get(p);
        if (b) innerRD.set(b, EMPTY_LABEL_SET);
      } else {
        for (const id of collectPatternIds(p)) {
          const b = T.labelToBinding.get(id);
          if (b) innerRD.set(b, EMPTY_LABEL_SET);
        }
      }
    }
    if (node.type === 'FunctionExpression' && node.id) {
      const fnSelf = T.labelToBinding.get(node);
      if (fnSelf) innerRD.set(fnSelf, new Set([node]));
    }

    // Restore fnStack to the enclosing-fn chain captured at queue time so
    // self-recursion checks (`fnStack.includes(b.fnNode)`) see the correct
    // ancestor chain even when this body itself contains nested functions
    // that recursively call this body's parent.
    fnStack.length = 0;
    for (const f of ancestry) fnStack.push(f);
    for (const p of node.params || []) {
      // Walking a plain-Identifier param is a no-op (resolveScope finds the
      // param's own freshly-EMPTY_LABEL_SET binding, hasFunctionFlow=false).
      // Skip; non-trivial patterns (defaults, destructuring) still need walk.
      if (p?.type && p.type !== 'Identifier') walk(p, node, inner, innerRD);
    }
    if (node.body) walk(node.body, node, inner, innerRD);
  }

  return T;
}

// === Inlinability filter ====================================================

export function analyzeSCByDefUse(ast: any): {
  scFnNodes: Set<any>;
  scCallToBody: Map<any, any>;
} {
  const T = buildTables(ast);
  // Precompute inverse of reachingDefs, bucketed by use-label's binding.
  // The `null` bucket holds labels with no resolved binding (IIFE CE seeds).
  const inverseUse = new Map<Label, Map<Binding | null, Set<Label>>>();
  for (const [u, defs] of T.reachingDefs) {
    const ub = T.labelToBinding.get(u) ?? null;
    for (const d of defs) {
      let buckets = inverseUse.get(d);
      if (!buckets) inverseUse.set(d, (buckets = new Map()));
      let set = buckets.get(ub);
      if (!set) buckets.set(ub, (set = new Set()));
      set.add(u);
    }
  }
  const useOf = (curBinding: Binding, d: Label): Set<Label> => {
    const buckets = inverseUse.get(d);
    if (!buckets) return EMPTY_LABEL_SET as Set<Label>;
    const own = buckets.get(curBinding);
    const synth = buckets.get(null);
    if (!own) return synth ?? (EMPTY_LABEL_SET as Set<Label>);
    if (!synth) return own;
    const merged = new Set(own);
    for (const x of synth) merged.add(x);
    return merged;
  };

  // Precompute Σ T.selfCalls[b] over bindings sharing a fnNode. Before this
  // the inner classify loop scanned all bindings on every iteration — O(N²)
  // over T.bindings. Now O(1) per lookup.
  const selfCallsByFnNode = new Map<any, number>();
  for (const b of T.bindings) {
    if (!b.fnNode) continue;
    const c = T.selfCalls.get(b);
    if (!c) continue;
    selfCallsByFnNode.set(b.fnNode, (selfCallsByFnNode.get(b.fnNode) ?? 0) + c);
  }
  const selfCallSum = (fnNode: any): number => selfCallsByFnNode.get(fnNode) ?? 0;

  const fnNodeOfDef = (d: any): any => {
    if (!d?.type) return null;
    if (
      d.type === 'FunctionDeclaration' ||
      d.type === 'FunctionExpression' ||
      d.type === 'ArrowFunctionExpression'
    )
      return d;
    if (d.type === 'VariableDeclarator') {
      const init = d.init;
      if (
        init?.type === 'FunctionExpression' ||
        init?.type === 'ArrowFunctionExpression'
      )
        return init;
    }
    if (d.type === 'Identifier') {
      const parent = T.parentOf.get(d);
      if (parent?.type === 'AssignmentExpression' && parent.left === d) {
        const r = parent.right;
        if (
          r?.type === 'FunctionExpression' ||
          r?.type === 'ArrowFunctionExpression'
        )
          return r;
      }
    }
    return null;
  };

  const scFnNodes = new Set<any>();
  const scCallToBody = new Map<any, any>();

  for (const b of T.bindings) {
    if (b.isFnSelf) continue;
    if (b.isExposed) continue;
    if (T.killed.has(b)) continue;
    if (T.closureReassigned.has(b)) continue;
    const defs = T.defs.get(b);
    if (!defs || defs.length === 0) continue;

    for (const initialDef of defs) {
      const rootFnNode = fnNodeOfDef(initialDef);
      if (!rootFnNode?.body) continue;

      let curDef: Label = initialDef;
      let curBinding: Binding = b;
      for (let steps = 0; steps < 64; steps++) {
        const useSet = useOf(curBinding, curDef);
        if (useSet.size !== 1) break;
        const u = [...useSet][0];
        const rdHere = T.reachingDefs.get(u);
        if (!rdHere || rdHere.size !== 1 || !rdHere.has(curDef)) break;

        const ce = T.callOf.get(u);
        if (ce) {
          // Recursive-call check (was: AST-walking isAncestor). Walk the
          // enclosing-fn chain of the call site up to the program root; if
          // any link equals rootFnNode, the call is inside it ⇒ recursive.
          let curFn = T.enclosingFn.get(u) ?? null;
          let isInside = false;
          while (curFn) {
            if (curFn === rootFnNode) { isInside = true; break; }
            curFn = T.parentFnOf.get(curFn) ?? null;
          }
          if (isInside) break;
          if (selfCallSum(rootFnNode) > 0) break;
          scFnNodes.add(rootFnNode);
          scCallToBody.set(ce, rootFnNode.body);
          break;
        }

        const parent = T.parentOf.get(u);
        if (
          !parent ||
          parent.type !== 'VariableDeclarator' ||
          parent.init !== u
        )
          break;
        const next = T.labelToBinding.get(parent);
        if (!next || next.isExposed) break;
        if (T.killed.has(next) || T.closureReassigned.has(next)) break;
        curDef = parent;
        curBinding = next;
      }
    }
  }

  return { scFnNodes, scCallToBody };
}

// === Transitive inline map ==================================================

export interface SCDefUseAnalysis {
  scFnNodes: Set<any>;
  scCallToBody: Map<any, any>;
  isSCFunction(node: any): boolean;
  buildInlineMap(body: any): Map<any, any>;
}

export function createSCAnalysisByDefUse(ast: any): SCDefUseAnalysis {
  const { scFnNodes, scCallToBody } = analyzeSCByDefUse(ast);

  const collect = (node: any, map: Map<any, any>, seen: Set<any>): void => {
    if (!node || typeof node !== 'object' || !node.type) return;
    if (
      node.type === 'CallExpression' &&
      scCallToBody.has(node) &&
      !map.has(node)
    ) {
      const body = scCallToBody.get(node);
      map.set(node, body);
      if (!seen.has(body)) {
        seen.add(body);
        collect(body, map, seen);
      }
    }
    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) continue;
      const v = (node as any)[k];
      if (Array.isArray(v)) for (const c of v) collect(c, map, seen);
      else if (v && typeof v === 'object') collect(v, map, seen);
    }
  };

  return {
    scFnNodes,
    scCallToBody,
    isSCFunction: (n) => scFnNodes.has(n),
    buildInlineMap: (body) => {
      const m = new Map<any, any>();
      collect(body, m, new Set());
      return m;
    },
  };
}

export { Def, Use, buildTables };
export type { Binding, DUTables, Label };
