import type {
  Change,
  Edge,
  EdgeReason,
  ImplicationStep,
  ShutterState,
  SolveOutcome,
  Workspace,
} from './types';
import { minByUtf8, sortByUtf8 } from './utf8';

/**
 * 节点编码（i 为快门按 UTF-8 字节序排列后的变量下标）：
 *   node(i, OPEN)   = 2*i
 *   node(i, CLOSED) = 2*i + 1
 * 文字的否定 = node ^ 1（OPEN↔CLOSED 互换）。
 */
function nodeOf(i: number, state: ShutterState): number {
  return 2 * i + (state === 'CLOSED' ? 1 : 0);
}

function stateOfNode(node: number): ShutterState {
  return (node & 1) === 1 ? 'CLOSED' : 'OPEN';
}

interface BuiltGraph {
  n: number;
  sortedIds: string[];
  /** 每条边保留依据，便于见证路径逐步指回原规则 */
  edges: Edge[];
  adj: number[][];
}

/** 规则 a∨b 给出蕴含 ¬a→b 与 ¬b→a；锁定 l 给出单位蕴含 ¬l→l。 */
function buildGraph(
  workspace: Workspace,
  locks: Record<string, ShutterState>,
  extraUnit?: { i: number; state: ShutterState },
): BuiltGraph {
  const sortedIds = sortByUtf8(workspace.ids, (id) => id);
  const indexOf = new Map<string, number>();
  sortedIds.forEach((id, i) => indexOf.set(id, i));
  const n = sortedIds.length * 2;
  const edges: Edge[] = [];

  const addEdge = (from: number, to: number, reason: EdgeReason) =>
    edges.push({ from, to, reason });

  for (const rule of workspace.rules) {
    const ia = indexOf.get(rule.a.id)!;
    const ib = indexOf.get(rule.b.id)!;
    const na = nodeOf(ia, rule.a.state);
    const nb = nodeOf(ib, rule.b.state);
    addEdge(na ^ 1, nb, { kind: 'rule', ruleIndex: rule.index });
    addEdge(nb ^ 1, na, { kind: 'rule', ruleIndex: rule.index });
  }

  for (const [id, state] of Object.entries(locks)) {
    const i = indexOf.get(id)!;
    const v = nodeOf(i, state);
    addEdge(v ^ 1, v, { kind: 'lock', id, state });
  }

  if (extraUnit) {
    const v = nodeOf(extraUnit.i, extraUnit.state);
    addEdge(v ^ 1, v, { kind: 'assume', i: extraUnit.i, state: extraUnit.state });
  }

  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) adj[e.from].push(e.to);
  return { n, sortedIds, edges, adj };
}

/** 迭代版 Tarjan 强连通分量（comp 取值 0..k-1，逆拓扑序）。 */
function tarjan(n: number, adj: number[][]): Int32Array {
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const comp = new Int32Array(n).fill(-1);
  let timer = 0;
  let compCount = 0;

  for (let root = 0; root < n; root++) {
    if (disc[root] !== -1) continue;
    // 每个栈帧记录 [节点, 下一条待处理出边的位置]
    const frames: Array<[number, number]> = [[root, 0]];
    disc[root] = low[root] = timer++;
    stack.push(root);
    onStack[root] = 1;

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const v = frame[0];
      const neighbors = adj[v];
      if (frame[1] < neighbors.length) {
        const w = neighbors[frame[1]++];
        if (disc[w] === -1) {
          disc[w] = low[w] = timer++;
          stack.push(w);
          onStack[w] = 1;
          frames.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], disc[w]);
        }
      } else {
        if (low[v] === disc[v]) {
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            comp[w] = compCount;
          } while (w !== v);
          compCount++;
        }
        frames.pop();
        if (frames.length > 0) {
          const parent = frames[frames.length - 1][0];
          low[parent] = Math.min(low[parent], low[v]);
        }
      }
    }
  }
  return comp;
}

function findConflictIds(sortedIds: string[], comp: Int32Array): string[] {
  const conflicts: string[] = [];
  for (let i = 0; i < sortedIds.length; i++) {
    if (comp[2 * i] === comp[2 * i + 1]) conflicts.push(sortedIds[i]);
  }
  return conflicts;
}

/**
 * 在限定的 SCC 内做 BFS，返回 from→to 的蕴含路径（每步保留边依据）。
 * 同一 SCC 保证路径存在。
 */
function bfsPath(
  graph: BuiltGraph,
  comp: Int32Array,
  from: number,
  to: number,
): Edge[] {
  if (from === to) return [];
  const adjEdges: Edge[][] = Array.from({ length: graph.n }, () => []);
  for (const e of graph.edges) adjEdges[e.from].push(e);

  const prevEdge = new Map<number, Edge>();
  const visited = new Uint8Array(graph.n);
  const queue: number[] = [from];
  visited[from] = 1;
  let head = 0;
  while (head < queue.length) {
    const v = queue[head++];
    for (const e of adjEdges[v]) {
      if (visited[e.to] || comp[e.to] !== comp[from]) continue;
      visited[e.to] = 1;
      prevEdge.set(e.to, e);
      if (e.to === to) {
        const path: Edge[] = [];
        let cur = to;
        while (cur !== from) {
          const pe = prevEdge.get(cur)!;
          path.push(pe);
          cur = pe.from;
        }
        path.reverse();
        return path;
      }
      queue.push(e.to);
    }
  }
  throw new Error('蕴含路径搜索失败：节点虽在同一 SCC 却不可达');
}

function toSteps(
  path: Edge[],
  idOf: Map<number, string>,
): ImplicationStep[] {
  return path.map((e) => ({
    from: { id: idOf.get(e.from >>> 1)!, state: stateOfNode(e.from) },
    to: { id: idOf.get(e.to >>> 1)!, state: stateOfNode(e.to) },
    reason: e.reason,
  }));
}

/**
 * 精确裁决：蕴含图 + 强连通分量。
 * 可行时逐变量按 UTF-8 字节序贪试 CLOSED，返回 CLOSED 优先的字典序最小完整方案；
 * 无解时选择 ID 最小、正反文字同 SCC 的快门，给出两个方向的蕴含见证路径。
 */
export function solveWorkspace(
  workspace: Workspace,
  locks: Record<string, ShutterState>,
): SolveOutcome {
  const base = buildGraph(workspace, locks);
  const baseComp = tarjan(base.n, base.adj);
  const conflictIds = findConflictIds(base.sortedIds, baseComp);

  if (conflictIds.length > 0) {
    const chosenId = minByUtf8(conflictIds, (id) => id);
    const i = base.sortedIds.indexOf(chosenId);
    const idOf = new Map<number, string>();
    base.sortedIds.forEach((id, k) => idOf.set(k, id));

    const openNode = nodeOf(i, 'OPEN');
    const closedNode = nodeOf(i, 'CLOSED');
    const openToClosed = toSteps(
      bfsPath(base, baseComp, openNode, closedNode),
      idOf,
    );
    const closedToOpen = toSteps(
      bfsPath(base, baseComp, closedNode, openNode),
      idOf,
    );
    return {
      kind: 'unsat',
      witness: { id: chosenId, openToClosed, closedToOpen },
    };
  }

  // 可行：按 ID 的 UTF-8 字节序逐变量贪试 CLOSED；
  // 已确定的前缀作为单位边并入 units，候选值单独以 extraUnit 试设，重算 SCC 检验。
  // 快门 ID 允许为 __proto__ 等名称：units 用无原型对象承载、assignment 由
  // Object.fromEntries 构造，保证每个 ID 都落为独立的自有数据属性，
  // 不会触发 Object.prototype 的 __proto__ 访问器而丢失条目。
  const assignmentEntries: Array<[string, ShutterState]> = [];
  const units: Record<string, ShutterState> = Object.assign(
    Object.create(null),
    locks,
  );
  for (let i = 0; i < base.sortedIds.length; i++) {
    const id = base.sortedIds[i];
    const tryState = (state: ShutterState): boolean => {
      const g = buildGraph(workspace, units, { i, state });
      const comp = tarjan(g.n, g.adj);
      for (let k = 0; k < g.sortedIds.length; k++) {
        if (comp[2 * k] === comp[2 * k + 1]) return false;
      }
      return true;
    };

    let chosen: ShutterState;
    if (tryState('CLOSED')) {
      chosen = 'CLOSED';
    } else if (tryState('OPEN')) {
      chosen = 'OPEN';
    } else {
      // 不应发生：基础图可满足且此前前缀均为可行扩展
      throw new Error(`贪心求解异常：快门 ${id} 两个状态均不可扩展`);
    }
    assignmentEntries.push([id, chosen]);
    units[id] = chosen;
  }

  return {
    kind: 'sat',
    assignment: Object.fromEntries(assignmentEntries),
    orderedIds: base.sortedIds,
  };
}

/**
 * 仅判定可行性的轻量入口（一次 SCC，不构造方案）。
 * 供锁定修复建议在枚举锁定子集时做存在性检查；最终方案仍由
 * solveWorkspace 给出，两者共用同一构图与 Tarjan 实现，结论一致。
 */
export function isSatisfiable(
  workspace: Workspace,
  locks: Record<string, ShutterState>,
): boolean {
  const g = buildGraph(workspace, locks);
  const comp = tarjan(g.n, g.adj);
  return findConflictIds(g.sortedIds, comp).length === 0;
}

/** 比对方案与当前快门表，按 UTF-8 字节序列出改动。 */
export function computeChanges(
  orderedIds: string[],
  assignment: Record<string, ShutterState>,
  current: Record<string, ShutterState>,
): Change[] {
  const changes: Change[] = [];
  for (const id of orderedIds) {
    const from = current[id];
    const to = assignment[id];
    if (from !== to) changes.push({ id, from, to });
  }
  return changes;
}
