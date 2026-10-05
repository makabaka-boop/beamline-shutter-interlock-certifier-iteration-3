import type { ImportResult, Literal, Rule, ShutterState, Workspace } from './types';

export const MAX_SHUTTERS = 300;
export const MIN_SHUTTERS = 2;
export const MAX_RULES = 3000;

const STATES: ShutterState[] = ['OPEN', 'CLOSED'];
const SECTION_RE = /^\[([a-zA-Z]+)\]$/;

interface RawRule {
  lineNo: number;
  a: Literal;
  b: Literal;
  text: string;
}

type RuleLineOutcome = { a: Literal; b: Literal } | { errors: string[] };

/**
 * 按记号位置解析单行规则：首两个记号为第一个文字，末两个记号为第二个文字，
 * 中间记号（若有）须全部为连接词 OR（大小写不敏感；兼容旧版对重复 OR 的
 * 宽容）。如此「OR」自身也能作为快门 ID 被引用，如「S1 OPEN OR CLOSED」、
 * 「OR OPEN OR S1 CLOSED」。整份导入与候选规则预检共用本函数，语法一致。
 */
function parseRuleLine(
  line: string,
  isKnownId: (id: string) => boolean,
): RuleLineOutcome {
  const errors: string[] = [];
  const tokens = line.split(/\s+/);
  let wellFormed = tokens.length >= 4;
  for (let j = 2; j < tokens.length - 2; j++) {
    if (tokens[j].toUpperCase() !== 'OR') {
      wellFormed = false;
      break;
    }
  }
  if (!wellFormed) {
    errors.push(
      `规则必须恰好包含两个「快门ID 状态」文字，连接词 OR 只能出现在两个文字之间（得到 ${tokens.length} 个记号）`,
    );
    return { errors };
  }

  const seenOnLine = new Set<string>();
  const parseLiteral = (idTok: string, stateTok: string): Literal | null => {
    let bad = false;
    if (!isKnownId(idTok)) {
      errors.push(`未知快门 ID「${idTok}」，需先在 [shutters] 中声明`);
      bad = true;
    }
    if (!(STATES as string[]).includes(stateTok)) {
      errors.push(`非法状态「${stateTok}」（快门 ${idTok}），只允许 OPEN 或 CLOSED`);
      bad = true;
    }
    if (seenOnLine.has(idTok)) {
      errors.push(`同一条规则中快门「${idTok}」重复出现`);
      bad = true;
    }
    seenOnLine.add(idTok);
    if (bad) return null;
    return { id: idTok, state: stateTok as ShutterState };
  };

  const a = parseLiteral(tokens[0], tokens[1]);
  const b = parseLiteral(tokens[tokens.length - 2], tokens[tokens.length - 1]);
  if (!a || !b) return { errors };
  return { a, b };
}

/**
 * 解析整份导入文本。任何未知 ID、重复快门或非法状态都会拒绝整份导入
 * （返回全部已收集错误，workspace 为 null），调用方据此保留当前工作区。
 *
 * 语法（行首行尾空白忽略，# 起始为整行注释，空行忽略）：
 *   [shutters]
 *   <ID>
 *   ...
 *   [rules]
 *   <ID> <OPEN|CLOSED> [OR] <ID> <OPEN|CLOSED>
 *   ...
 *
 * 规则按记号位置解析：首两个记号为第一个文字，末两个记号为第二个文字，
 * 中间记号（若有）须全部为连接词 OR（大小写不敏感）。因此「OR」本身也
 * 可以作为快门 ID 登记并在规则中引用；ID 仅不允许为 OPEN/CLOSED（与状态
 * 记号冲突）。
 */
export function parseWorkspace(text: string): ImportResult {
  const errors: string[] = [];
  const lines = text.split(/\r\n|\r|\n/);

  const seenIds = new Map<string, number>();
  const ids: string[] = [];
  const rawRules: RawRule[] = [];

  let section: 'none' | 'shutters' | 'rules' = 'none';
  const seenSections: string[] = [];

  const pushError = (lineNo: number, msg: string) =>
    errors.push(`第 ${lineNo} 行：${msg}`);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1].toLowerCase();
      if (name !== 'shutters' && name !== 'rules') {
        pushError(lineNo, `未知小节「[${sectionMatch[1]}]」，只允许 [shutters] 与 [rules]`);
        continue;
      }
      if (seenSections.includes(name)) {
        pushError(lineNo, `小节 [${name}] 重复出现`);
      }
      seenSections.push(name);
      section = name;
      continue;
    }

    if (section === 'none') {
      pushError(lineNo, `内容「${line}」出现在任何小节之前，请先写 [shutters]`);
      continue;
    }

    if (section === 'shutters') {
      if (/\s/.test(line)) {
        pushError(lineNo, `快门 ID「${line}」不能包含空白字符`);
        continue;
      }
      if ((line === 'OPEN' || line === 'CLOSED')) {
        pushError(lineNo, `快门 ID「${line}」与状态关键字冲突，不允许使用`);
        continue;
      }
      const prev = seenIds.get(line);
      if (prev !== undefined) {
        pushError(lineNo, `快门 ID「${line}」重复声明（首次出现于第 ${prev} 行）`);
        continue;
      }
      seenIds.set(line, lineNo);
      ids.push(line);
      continue;
    }

    // rules：与候选规则预检共用同一套单行规则解析
    const parsed = parseRuleLine(line, (id) => seenIds.has(id));
    if ('errors' in parsed) {
      for (const msg of parsed.errors) pushError(lineNo, msg);
      continue;
    }
    rawRules.push({ lineNo, a: parsed.a, b: parsed.b, text: line });
  }

  if (!seenSections.includes('shutters')) {
    errors.push('缺少 [shutters] 小节');
  }
  if (!seenSections.includes('rules')) {
    errors.push('缺少 [rules] 小节');
  }

  if (ids.length < MIN_SHUTTERS) {
    errors.push(`快门数量为 ${ids.length}，至少需要 ${MIN_SHUTTERS} 个`);
  }
  if (ids.length > MAX_SHUTTERS) {
    errors.push(`快门数量为 ${ids.length}，最多允许 ${MAX_SHUTTERS} 个`);
  }
  if (rawRules.length > MAX_RULES) {
    errors.push(`规则数量为 ${rawRules.length}，最多允许 ${MAX_RULES} 条`);
  }

  if (errors.length > 0) {
    return { ok: false, errors, workspace: null };
  }

  const rules: Rule[] = rawRules.map((r, index) => ({
    index,
    a: r.a,
    b: r.b,
    text: r.text,
  }));

  const workspace: Workspace = { ids, rules };
  return { ok: true, errors: [], workspace };
}

export interface CandidateParseResult {
  ok: boolean;
  errors: string[];
  rule: { a: Literal; b: Literal; text: string } | null;
}

/**
 * 解析单行候选规则（供新增规则预检）。与整份导入共用 parseRuleLine，
 * 记号语法完全一致；ID 必须已在当前工作区声明。输入必须为非空的单行
 * 规则文本（不允许注释行或多行）。
 */
export function parseCandidateRule(
  text: string,
  ids: string[],
): CandidateParseResult {
  const line = text.trim();
  if (line === '' || line.startsWith('#')) {
    return {
      ok: false,
      errors: ['候选规则为空：请输入「快门ID 状态 [OR] 快门ID 状态」'],
      rule: null,
    };
  }
  if (/\r|\n/.test(line)) {
    return { ok: false, errors: ['候选规则必须为单行文本'], rule: null };
  }
  const known = new Set(ids);
  const parsed = parseRuleLine(line, (id) => known.has(id));
  if ('errors' in parsed) {
    return { ok: false, errors: parsed.errors, rule: null };
  }
  return { ok: true, errors: [], rule: { a: parsed.a, b: parsed.b, text: line } };
}
