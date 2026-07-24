import { ESTree } from 'meriyah';

export interface FunctionSignature {
  type: 'FunctionDeclaration' | 'FunctionExpression' | 'ArrowFunctionExpression';
  id: ESTree.Identifier | null;
  params: ESTree.Parameter[];
  async: boolean;
  generator: boolean;
  expression: boolean;
}
export interface Function {
  id?: string;
  name?: string;
  body: ESTree.Node;
  // Original signature (id/params/async/generator/funcType) of the function
  // node, captured at extraction time so callers that need to re-emit the
  // function shell (e.g. line counting) can reproduce the original output.
  sig?: FunctionSignature;
  // CallExpression AST node → SC function body to inline at that call.
  // Transitively includes CEs reachable through inlined SC bodies so the
  // POG walker can keep resolving nested SC calls without an extra lookup
  // layer. Absent/empty ⇒ no inlining for this function.
  singleCallBody: Map<ESTree.Node, ESTree.Node>;
}
export type POGHash = {
  id?: string;
  nodes: number;
  hash: string;
  body: ESTree.Node;
};
export interface POG {
  id?: string;
  body: ESTree.Node;
  graph: Map<number, POGNode>;
}

export type POGOptionTuple = [boolean, boolean, boolean];

export interface POGAnalysisOptions {
  branchFlipping?: boolean;
  branchBypassing?: boolean;
  pathCloning?: boolean;
  literalProperty?: boolean;
  skipArguments?: boolean;
  assignmentPropagation?: boolean;
  inlining?: boolean;
}

export type POGOptionInput = POGOptionTuple | POGAnalysisOptions;

export type POGNodeBase = {
  id: number;
  type: 'start' | 'exit' | 'exception-exit' | 'block' | 'branch';
};

export interface POGNodeStart extends POGNodeBase {
  type: 'start';
  next?: number;
}

export interface POGNodeBranch extends POGNodeBase {
  type: 'branch';
  then?: number;
  else?: number;
}
export interface POGNodeBlock extends POGNodeBase {
  type: 'block';
  next?: number;
  op?: Op[];
  loop: boolean;
}
export interface Getter {
  type: 'property';
  value: string;
}
export interface Setter {
  type: 'property-update';
  value: string;
}

export interface POGNodeEnd extends POGNodeBase {
  type: 'exit' | 'exception-exit';
}
export type Op = Getter | Setter;
export type POGNode = POGNodeStart | POGNodeEnd | POGNodeBranch | POGNodeBlock;
export type Value = 'top' | 'truthy' | 'falsy' | 'pos' | 'neg' | 'bottom';
export type Env = Record<string, Value>;
export type PrevId = [POGNode, Env, boolean?];
export interface POGState {
  currentId: number;
  nodes: Map<number, POGNode>;
  prevIds: PrevId[];
  loopStack: { break: PrevId[]; continue: PrevId[] }[];
  endId: number;
  exceptionId: number;
}
