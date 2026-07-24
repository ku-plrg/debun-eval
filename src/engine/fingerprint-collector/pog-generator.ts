import { ESTree } from 'meriyah';
import {
  Env,
  Function,
  Op,
  POG,
  POGAnalysisOptions,
  POGNode,
  POGState,
  PrevId,
} from '../types/pog';
import { builtIns } from '../utils/builtins';

let pogState: POGState;
const RESULT = '@@RESULT';
const IGNORE_TYPEOF = true;
const SKIP_BUILTIN: string[] = builtIns;

let BRANCH_BYPASSING = true;
let PATH_CLONING = true;
let BRANCH_FLIPPING = true;
let SKIP_ARGUMENTS = true;
let INLINING = true;
let ASSIGNMENT_PROPAGATION = true;
let LITERAL_PROP = true;

let currentSingleCall: Map<ESTree.Node, ESTree.Node> | undefined;
// Depth of SC-inline body traversal — return inside an inlined body should
// not terminate the caller's flow, only halt the inlined path locally.
let inliningDepth = 0;
// One entry per active inlined frame; collects prevIds from explicit returns
// so they can be merged with fall-through at the CallExpression site, while
// letting sibling code after a return skip the return path (break-like).
let inlineReturnStack: PrevId[][] = [];

if (SKIP_ARGUMENTS) {
  SKIP_BUILTIN.push('arguments');
}

function normalizeLiteralProperty(
  value: ESTree.Literal['value']
): string | undefined {
  if (
    typeof value === 'string' ||
    (typeof value === 'number' && LITERAL_PROP)
  ) {
    return String(value);
  }
  return undefined;
}
function visit(node: ESTree.Node): void {
  switch (node.type) {
    case 'ExpressionStatement':
      visit(node.expression);
      break;
    case 'BlockStatement':
      node.body.forEach(visit);
      break;
    case 'ReturnStatement':
      node.argument && visit(node.argument);
      if (inliningDepth === 0) {
        connect_end();
      } else {
        const frame = inlineReturnStack[inlineReturnStack.length - 1];
        frame.push(...pogState.prevIds);
        pogState.prevIds = [];
      }
      break;
    case 'BreakStatement':
      const loop_break = pogState.loopStack.pop();
      if (!loop_break) return;
      loop_break.break.push(...pogState.prevIds);
      pogState.loopStack.push(loop_break);
      pogState.prevIds = [];
      break;
    case 'ContinueStatement':
      const loop_continue = pogState.loopStack.pop();
      if (!loop_continue) return;
      loop_continue.continue.push(...pogState.prevIds);
      pogState.loopStack.push(loop_continue);
      pogState.prevIds = [];
      break;
    case 'IfStatement': {
      const [thenPrevIds, elsePrevIds] = addBranch(node.test);
      pogState.prevIds = thenPrevIds;
      visit(node.consequent);
      const thenPrev = [...pogState.prevIds];
      pogState.prevIds = elsePrevIds;
      node.alternate && visit(node.alternate);
      pogState.prevIds = thenPrev.concat(pogState.prevIds);
      break;
    }
    case 'ThrowStatement':
      visit(node.argument);
      connect(pogState.exceptionId);
      pogState.prevIds = [];
      break;
    case 'TryStatement':
      visit(node.block);
      node.handler && visit(node.handler);
      node.finalizer && visit(node.finalizer);
      break;
    case 'WhileStatement': {
      const whileLoop = addLoop();
      const [thenPrevIds, elsePrevIds] = addBranch(node.test);
      pogState.prevIds = thenPrevIds;
      const whileLoopstack = loopVisitor(node.body);
      endLoop(whileLoopstack, whileLoop.id, elsePrevIds);
      break;
    }
    case 'DoWhileStatement': {
      const doWhileLoop = addLoop();
      const doWhileLoopstack = loopVisitor(node.body);
      const [thenPrevIds, elsePrevIds] = addBranch(node.test);
      pogState.prevIds = thenPrevIds;
      endLoop(doWhileLoopstack, doWhileLoop.id, elsePrevIds);
      break;
    }
    case 'ForStatement': {
      node.init && visit(node.init);
      const forLoop = addLoop();
      if (node.test) {
        const [thenPrevIds, elsePrevIds] = addBranch(node.test);
        pogState.prevIds = thenPrevIds;
        const forLoopstack = loopVisitor(node.body);
        node.update && visit(node.update);
        endLoop(forLoopstack, forLoop.id, elsePrevIds);
      } else {
        const forLoopstack = loopVisitor(node.body);
        endLoop(forLoopstack, forLoop.id, []);
      }
      break;
    }
    case 'ForInStatement':
    case 'ForOfStatement':
      visit(node.left);
      node.right && visit(node.right);
      const forInLoop = addLoop();
      const [thenPrevIds, elsePrevIds] = addemptyBranch();
      pogState.prevIds = thenPrevIds;
      const forInLoopstack = loopVisitor(node.body);
      endLoop(forInLoopstack, forInLoop.id, elsePrevIds);
      break;
    case 'SwitchStatement':
      pogState.loopStack.push({ break: [], continue: [] });
      visit(node.discriminant);
      node.cases.forEach((c) => {
        c.test && visit(c.test);
        const [thenPrevIds, elsePrevIds] = addemptyBranch();
        pogState.prevIds = thenPrevIds;
        c.consequent.forEach(visit);
        pogState.prevIds = elsePrevIds.concat(pogState.prevIds);
      });
      const switchcase = pogState.loopStack.pop();
      if (!switchcase) throw new Error('Loop stack is empty');
      pogState.prevIds = switchcase.break.concat(pogState.prevIds);
      break;
    case 'VariableDeclaration':
      node.declarations.forEach((decl) => {
        if (decl.init === null) return;
        visit(decl.init);
        if (decl.id.type === 'Identifier') {
          const name = decl.id.name;
          pogState.prevIds.forEach(([node, env, context]) => {
            env[name] = env[RESULT];
          });
        }
      });
      return;
    case 'Identifier':
      const name = (node as ESTree.Identifier).name;
      if (name === 'undefined' || name === 'NaN') {
        pogState.prevIds.forEach(([, env]) => {
          env[RESULT] = 'falsy';
        });
      } else {
        pogState.prevIds.forEach(([, env]) => {
          env[RESULT] = env[name] ?? 'pos';
        });
      }
      return;

    case 'Literal':
      if (
        node.value === null ||
        node.value === 0 ||
        node.value === false ||
        node.value === '' ||
        node.value === 0n
      ) {
        pogState.prevIds.forEach(([node, env, context]) => {
          env[RESULT] = 'falsy';
        });
      } else {
        pogState.prevIds.forEach(([node, env, context]) => {
          env[RESULT] = 'truthy';
        });
      }
      break;
    case 'ThisExpression':
      pogState.prevIds.forEach(([node, env, context]) => {
        env[RESULT] = 'truthy';
      });
      break;
    case 'ArrayExpression':
      node.elements.forEach((elem) => elem && visit(elem));
      pogState.prevIds.forEach(([node, env, context]) => {
        env[RESULT] = 'truthy';
      });
      break;
    case 'ObjectExpression':
      const properties = node.properties
        .filter((prop) => prop.type === 'Property')
        .filter(
          (prop) =>
            !['AssignmentPattern', 'ObjectPattern', 'ArrayPattern'].includes(
              prop.value.type
            )
        );
      properties.forEach((prop) => {
        visit(prop.key);
        visit(prop.value);
        const key =
          prop.key.type === 'Identifier'
            ? prop.key.name
            : prop.key.type === 'Literal'
              ? (normalizeLiteralProperty(prop.key.value) ?? '[]')
              : '[]';
        addOp({
          type: 'property-update',
          value: key,
        });
      });
      pogState.prevIds.forEach(([node, env, context]) => {
        env[RESULT] = 'truthy';
      });
      break;
    case 'UnaryExpression':
      if (node.operator === 'void') {
        visit(node.argument);
        pogState.prevIds.forEach(([node, env, context]) => {
          env[RESULT] = 'falsy';
        });
      } else if (node.operator === '!') {
        visit(node.argument);
        pogState.prevIds.forEach(([node, env, context]) => {
          switch (env[RESULT]) {
            case 'truthy':
              env[RESULT] = 'falsy';
              break;
            case 'falsy':
              env[RESULT] = 'truthy';
              break;
            case 'pos':
              env[RESULT] = 'neg';
              break;
            case 'neg':
              env[RESULT] = 'pos';
              break;
            case 'bottom':
              env[RESULT] = 'bottom';
              break;
          }
        });
      } else {
        visit(node.argument);
        pogState.prevIds.forEach(([node, env, context]) => {
          env[RESULT] = 'pos';
        });
      }
      break;
    case 'UpdateExpression':
      visit(node.argument);
      if (node.argument.type === 'MemberExpression') {
        visit(node.argument.object);
        visit(node.argument.property);
        const value =
          !node.argument.computed &&
          node.argument.property.type === 'Identifier'
            ? node.argument.property.name
            : node.argument.computed &&
                node.argument.property.type === 'Literal'
              ? (normalizeLiteralProperty(node.argument.property.value) ?? '[]')
              : '[]';
        addOp({
          type: 'property-update',
          value,
        });
        pogState.prevIds.forEach(([node, env, context]) => {
          env[RESULT] = 'pos';
        });
      } else {
        visit(node.argument);
        pogState.prevIds.forEach(([node, env, context]) => {
          env[RESULT] = 'pos';
        });
      }
      break;
    case 'BinaryExpression':
      visit(node.left);
      visit(node.right);
      if (
        node.operator === '!==' ||
        node.operator === '!=' ||
        node.operator === '>=' ||
        node.operator === '<='
      ) {
        pogState.prevIds.forEach(([node, env, context]) => {
          env[RESULT] = 'neg';
        });
      } else
        pogState.prevIds.forEach(([node, env, context]) => {
          env[RESULT] = 'pos';
        });
      break;
    case 'AssignmentExpression':
      if (node.left.type === 'MemberExpression') {
        visit(node.left.object);
        visit(node.left.property);
        visit(node.right);
        const value =
          !node.left.computed && node.left.property.type === 'Identifier'
            ? node.left.property.name
            : node.left.computed && node.left.property.type === 'Literal'
              ? (normalizeLiteralProperty(node.left.property.value) ?? '[]')
              : '[]';
        addOp({
          type: 'property-update',
          value,
        });
        pogState.prevIds.forEach(([node, env, context]) => {
          env[RESULT] = 'pos';
        });
      }
      if (node.left.type === 'Identifier') {
        visit(node.right);
        const name = node.left.name;
        pogState.prevIds.forEach(([node, env, context]) => {
          env[name] = env[RESULT];
          if (!ASSIGNMENT_PROPAGATION) {
            env[RESULT] = 'pos';
          }
        });
      }
      if (
        node.left.type === 'ArrayPattern' ||
        node.left.type === 'ObjectPattern'
      ) {
        visit(node.left);
        visit(node.right);
      }
      break;
    case 'LogicalExpression': {
      if (node.operator === '&&') {
        const [thenPrevIds, elsePrevIds] = addBranch(node.left);
        pogState.prevIds = thenPrevIds;
        visit(node.right);
        elsePrevIds.forEach(([node, env, context]) => (env[RESULT] = 'falsy'));
        pogState.prevIds = pogState.prevIds.concat(elsePrevIds);
      } else if (node.operator === '||') {
        const [thenPrevIds, elsePrevIds] = addBranch(node.left);
        pogState.prevIds = elsePrevIds;
        visit(node.right);
        thenPrevIds.forEach(([node, env, context]) => (env[RESULT] = 'truthy'));
        pogState.prevIds = pogState.prevIds.concat(thenPrevIds);
      } else {
        visit(node.left);
        const [thenPrevIds, elsePrevIds] = addemptyBranch();
        pogState.prevIds = thenPrevIds;
        visit(node.right);
        elsePrevIds.forEach(([node, env, context]) => (env[RESULT] = 'pos'));
        pogState.prevIds = pogState.prevIds.concat(elsePrevIds);
      }
      break;
    }
    case 'MemberExpression':
      if (
        node.object.type === 'Identifier' &&
        SKIP_BUILTIN.includes(node.object.name)
      ) {
        visit(node.property);
        pogState.prevIds.forEach(([node, env, context]) => {
          env[RESULT] = 'pos';
        });
        break;
      }
      visit(node.object);
      visit(node.property);
      const value =
        !node.computed && node.property.type === 'Identifier'
          ? node.property.name
          : node.computed && node.property.type === 'Literal'
            ? (normalizeLiteralProperty(node.property.value) ?? '[]')
            : '[]';
      addOp({
        type: 'property',
        value,
      });
      pogState.prevIds.forEach(([node, env, context]) => {
        env[RESULT] = 'pos';
      });
      break;
    case 'ConditionalExpression': {
      if (is_typeof(node)) {
        pogState.prevIds.forEach(([node, env, context]) => {
          env[RESULT] = 'pos';
        });
        break;
      }
      const [thenPrevIds, elsePrevIds] = addBranch(node.test);
      pogState.prevIds = thenPrevIds;
      visit(node.consequent);
      const thenPrev = [...pogState.prevIds];
      pogState.prevIds = elsePrevIds;
      visit(node.alternate);
      pogState.prevIds = thenPrev.concat(pogState.prevIds);
      break;
    }
    case 'CallExpression':
      visit(node.callee);
      node.arguments.forEach(visit);
      if (INLINING && currentSingleCall && currentSingleCall.has(node)) {
        inlineReturnStack.push([]);
        inliningDepth++;
        visit(currentSingleCall.get(node)!);
        inliningDepth--;
        const returns = inlineReturnStack.pop()!;
        pogState.prevIds = pogState.prevIds.concat(returns);
      }
      pogState.prevIds.forEach((prevId) => {
        prevId[1] = {};
        prevId[1][RESULT] = 'pos';
      });
      break;
    case 'NewExpression':
      visit(node.callee);
      node.arguments.forEach(visit);
      pogState.prevIds.forEach((prevId) => {
        prevId[1] = {};
        prevId[1][RESULT] = 'pos';
      });
      break;
    case 'SequenceExpression':
      node.expressions.forEach(visit);
      break;
    default: {
      Object.entries(node).forEach(([key, value]) => {
        if (value && typeof value === 'object') {
          if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
              if (value[i] && typeof value[i] === 'object') {
                visit(value[i]);
              }
            }
          } else {
            visit(value);
          }
        }
      });
      if (
        node.type === 'MetaProperty' ||
        node.type === 'Super' ||
        node.type === 'TemplateLiteral' ||
        node.type === 'TaggedTemplateExpression' ||
        node.type === 'AwaitExpression' ||
        node.type === 'YieldExpression' ||
        node.type === 'ImportExpression' ||
        node.type === 'ChainExpression' ||
        node.type === 'ClassExpression' ||
        node.type === 'Import'
      ) {
        pogState.prevIds.forEach(([node, env, context]) => {
          env[RESULT] = 'pos';
        });
      }
    }
  }
}

export function extractPOG(
  input: ESTree.Node | Function,
  options?: POGAnalysisOptions
): POGState {
  const isFunc =
    !!input && typeof input === 'object' && 'singleCallBody' in input;
  const node: ESTree.Node = isFunc
    ? (input as Function).body
    : (input as ESTree.Node);
  const func = isFunc ? (input as Function) : undefined;

  BRANCH_FLIPPING = options?.branchFlipping ?? true;
  BRANCH_BYPASSING = options?.branchBypassing ?? true;
  PATH_CLONING = options?.pathCloning ?? true;
  SKIP_ARGUMENTS = options?.skipArguments ?? true;
  INLINING = options?.inlining ?? true;
  ASSIGNMENT_PROPAGATION = options?.assignmentPropagation ?? true;
  LITERAL_PROP = options?.literalProperty ?? true;

  const start: POGNode = { id: 0, type: 'start' };
  pogState = {
    currentId: 1,
    prevIds: [[start, {}]],
    nodes: new Map<number, POGNode>([
      [0, start],
      [-1, { type: 'exit', id: -1 }],
      [-2, { type: 'exception-exit', id: -2 }],
    ]),
    loopStack: [],
    endId: -1,
    exceptionId: -2,
  };
  currentSingleCall =
    INLINING && func?.singleCallBody ? func.singleCallBody : undefined;
  inliningDepth = 0;
  inlineReturnStack = [];
  visit(node);
  connect_end();
  currentSingleCall = undefined;
  return pogState;
}


function connect_end() {
  connect(pogState.endId);
  pogState.prevIds = [];
}

function join(left: Env, right: Env): Env {
  const result: Env = {};
  for (const key in left) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue === rightValue) {
      result[key] = leftValue;
    } else if (leftValue === 'top' || rightValue === 'top') {
      result[key] = 'top';
    } else if (leftValue === 'pos' || leftValue === 'neg') {
      result[key] =
        rightValue === 'pos' || rightValue === 'neg' ? 'top' : leftValue;
    } else if (leftValue === 'truthy' || leftValue === 'falsy') {
      result[key] =
        rightValue === 'truthy' || rightValue === 'falsy' ? 'top' : rightValue;
    } else {
      result[key] = rightValue;
    }
  }
  return result;
}

function merge(prevIds: PrevId[]): Env {
  const envs = prevIds.map(([, env]) => env);
  if (envs.length === 0) return {};
  return envs.reduce(join);
}
function addemptyBranch(): [PrevId[], PrevId[]] {
  const thenPrevIds: PrevId[] = [];
  const elsePrevIds: PrevId[] = [];
  const condition = createNode('branch');
  thenPrevIds.push([condition, {}, true]);
  elsePrevIds.push([condition, {}, false]);
  connect(condition.id);
  return [thenPrevIds, elsePrevIds];
}

function addBranch(node: ESTree.Node): [PrevId[], PrevId[]] {
  visit(node);
  const truthy: PrevId[] = [];
  const falsy: PrevId[] = [];
  const top: PrevId[] = [];
  const neg: PrevId[] = [];
  const pos: PrevId[] = [];

  for (const prevId of pogState.prevIds) {
    const [node, env, context] = prevId;
    switch (env[RESULT]) {
      case 'top':
      case undefined:
        top.push(prevId);
        break;
      case 'pos':
        pos.push(prevId);
        break;
      case 'neg':
        neg.push(prevId);
        break;
      case 'truthy':
        truthy.push(prevId);
        break;
      case 'falsy':
        falsy.push(prevId);
        break;
      case 'bottom':
        break;
    }
  }
  const thenPrevIds: PrevId[] = [];
  const elsePrevIds: PrevId[] = [];
  const shouldCreateBranch = pos.length > 0 || neg.length > 0 || top.length > 0;
  const env = merge(pogState.prevIds);
  if (!BRANCH_BYPASSING) {
    const [thenprev, elseprev] = addemptyBranch();
    return neg.length > pos.length && BRANCH_FLIPPING
      ? [elseprev, thenprev]
      : [thenprev, elseprev];
  }

  if (shouldCreateBranch) {
    const condition = createNode('branch');
    thenPrevIds.push([condition, { ...env }, true]);
    elsePrevIds.push([condition, { ...env }, false]);
    pogState.prevIds = [...pos, ...neg, ...top];
    connect(condition.id);
  }

  return neg.length > pos.length && BRANCH_FLIPPING
    ? [elsePrevIds.concat(truthy), thenPrevIds.concat(falsy)]
    : [thenPrevIds.concat(truthy), elsePrevIds.concat(falsy)];
}

function loopVisitor(node: ESTree.Node) {
  pogState.loopStack.push({ break: [], continue: [] });
  visit(node);
  const loop = pogState.loopStack.pop();
  if (!loop) throw new Error('Loop stack is empty');
  return loop;
}
function endLoop(
  loop: { break: PrevId[]; continue: PrevId[] },
  id: number,
  prevIds: PrevId[]
) {
  pogState.prevIds = loop.continue.concat(pogState.prevIds);
  connect(id);
  pogState.prevIds = loop.break.concat(prevIds);
}

function connect(to: number) {
  pogState.prevIds.forEach((from) => connectPair(from, to));
}
function connectPair(from: PrevId, to: number) {
  const [node, env, context] = from;
  switch (node.type) {
    case 'branch':
      if (node.then && node.else) throw new Error('Condition has 2 branches');
      if (context) {
        node.then = to;
      } else {
        node.else = to;
      }
      break;
    case 'block':
      if (node.next) throw new Error('Node has already been connected');
      node.next = to;
      break;
    case 'start':
      if (node.next) throw new Error('Start Node has already been connected');
      node.next = to;
      break;
  }
}

function is_typeof(node: ESTree.ConditionalExpression): boolean {
  return (
    node.consequent.type === 'Literal' &&
    node.consequent.value === 'undefined' &&
    node.test.type === 'BinaryExpression' &&
    node.test.operator === '===' &&
    node.test.left.type === 'UnaryExpression' &&
    node.test.left.operator === 'void' &&
    node.test.left.argument.type === 'Literal' &&
    node.test.left.argument.value === 0 &&
    IGNORE_TYPEOF
  );
}


function addLoop() {
  const node = createNode('block', true);
  connect(node.id);
  pogState.prevIds = [[node, {}]];
  return node;
}

function addOp(operator: Op) {
  if (PATH_CLONING) {
    pogState.prevIds.forEach((from) => {
      if (from[0].type === 'block') {
        if (from[0].op) from[0].op?.push(operator);
        else from[0].op = [operator];
        pogState.nodes.set(from[0].id, from[0]);
      } else {
        const node = createNode('block', false, operator);
        connectPair(from, node.id);
        from[0] = node;
        from[1] = {};
        from[2] = undefined;
      }
    });
  } else {
    if (pogState.prevIds.length === 1) {
      const node = pogState.prevIds[0][0];
      if (node.type === 'block') {
        if (node.op) node.op.push(operator);
        else node.op = [operator];
        pogState.nodes.set(node.id, node);
        return;
      }
    }
    const node = createNode('block', false, operator);
    connect(node.id);
    pogState.prevIds = [[node, {}]];
  }
}

function createNode(
  type: 'branch' | 'block',
  loop?: boolean,
  value?: Op
): POGNode {
  const id = pogState.currentId++;
  const node: POGNode =
    type === 'branch'
      ? { id, type, then: undefined, else: undefined }
      : {
          id,
          type,
          next: undefined,
          loop: loop ?? false,
          op: value ? [value] : undefined,
        };
  pogState.nodes.set(id, node);
  return node;
}

function pog(functions: Function[], options?: POGAnalysisOptions): POG[] {
  return functions.map((func) => {
    const graph = extractPOG(func, options);

    return {
      id: func.id,
      body: func.body,
      graph: graph.nodes,
    };
  });
}

export default pog;
