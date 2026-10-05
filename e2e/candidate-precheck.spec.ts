import { test, expect } from '@playwright/test';

/**
 * 新增规则预检的端到端隔离验证：
 * 预检只在临时视图上裁决（不改规则、锁定、认证结论、采纳/导出）；
 * 收紧类候选给出规范方案与违反见证（均遵守原锁定）；
 * 任何规则/锁定/导入/草稿改动使预检立即过期，过期不能确认；
 * 确认新增后规则真正追加、序号为末条、认证立即标记失效须重跑；
 * 冲突类（基线 / 候选）与冗余类各走一条支线。
 */

async function loadWorkspace(page: import('@playwright/test').Page, text: string) {
  await page.goto('/');
  await page.getByTestId('import-text').fill(text);
  await page.getByTestId('import-btn').click();
  await expect(page.getByTestId('import-ok')).toBeVisible();
}

const WS = [
  '[shutters]',
  'S1',
  'S2',
  'S3',
  '[rules]',
  'S1 OPEN OR S2 OPEN',
  'S2 CLOSED OR S3 OPEN',
].join('\n');

test('有效收紧：预检不改工作区，规范方案与违反见证均遵守原锁定，过期拒绝确认', async ({ page }) => {
  await loadWorkspace(page, WS);
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(2);

  // 先运行一次认证，稍后证明预检没有改动认证结论
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-sat')).toBeVisible();

  // 锁 S1=OPEN，使两份方案都必须遵守该原锁定
  await page.getByTestId('lock-S1').click();
  await page.getByTestId('lock-state-S1').click(); // CLOSED → OPEN
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-sat')).toBeVisible();
  // 无候选时最小方案：S1=OPEN（锁定），S2=CLOSED，S3=CLOSED（S2=CLOSED 已满足规则 #1）
  await expect(page.getByTestId('plan-row-S1')).toContainText('OPEN');
  await expect(page.getByTestId('plan-row-S2')).toContainText('CLOSED');
  await expect(page.getByTestId('plan-row-S3')).toContainText('CLOSED');

  // 候选 S2 CLOSED OR S3 CLOSED：当前方案空间中存在被排除的组合
  await page.getByTestId('candidate-text').fill('S2 CLOSED OR S3 CLOSED');
  await page.getByTestId('candidate-precheck').click();

  const tightening = page.getByTestId('candidate-tightening');
  await expect(tightening).toBeVisible();
  await expect(tightening).toContainText('有效收紧');
  // 被排除组合：S2=OPEN 且 S3=OPEN
  await expect(tightening).toContainText('S2=OPEN');
  await expect(tightening).toContainText('S3=OPEN');

  // 规范方案：加入候选后的 CLOSED 优先最小解（S1=OPEN 锁定；S2=CLOSED 可行则取 CLOSED，
  // S2=CLOSED 满足规则#0/#1 对 S3 无要求 → S3 须 CLOSED 以满足候选）
  const satisfying = page.getByTestId('candidate-satisfying-plan');
  await expect(satisfying).toContainText('S1');
  const expectSatisfying: Record<string, string> = {
    S1: 'OPEN',
    S2: 'CLOSED',
    S3: 'CLOSED',
  };
  for (const [id, state] of Object.entries(expectSatisfying)) {
    await expect(page.getByTestId(`candidate-satisfying-plan-row-${id}`)).toContainText(state);
  }

  // 违反见证：S2=OPEN 且 S3=OPEN（候选两文字同时不成立），S1 仍遵守原锁定
  const expectViolating: Record<string, string> = {
    S1: 'OPEN',
    S2: 'OPEN',
    S3: 'OPEN',
  };
  for (const [id, state] of Object.entries(expectViolating)) {
    await expect(page.getByTestId(`candidate-violating-plan-row-${id}`)).toContainText(state);
  }
  // 两份方案表的“原锁定”列都显示 S1=OPEN
  await expect(page.getByTestId('candidate-satisfying-plan-row-S1')).toContainText('OPEN');
  await expect(page.getByTestId('candidate-violating-plan-row-S1')).toContainText('OPEN');

  // 预检期间工作区未被修改：规则仍 2 条、快门表仍全部 CLOSED、认证面板仍在
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('state-S2-CLOSED')).toBeChecked();
  await expect(page.getByTestId('state-S3-CLOSED')).toBeChecked();
  await expect(page.getByTestId('result-sat')).toBeVisible();
  await expect(page.getByTestId('result-unsat')).toHaveCount(0);

  // 编辑草稿 → 预检立即过期，确认被拒绝（按钮禁用，规则数不变）
  await page.getByTestId('candidate-text').fill('S2 CLOSED OR S3 OPEN');
  await expect(page.getByTestId('candidate-stale')).toBeVisible();
  await expect(page.getByTestId('candidate-confirm')).toBeDisabled();
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(2);

  // 恢复草稿并重新预检；随后改动锁定（新增一把 S3=OPEN 锁）→ 立即过期、不能确认
  await page.getByTestId('candidate-text').fill('S2 CLOSED OR S3 CLOSED');
  await page.getByTestId('candidate-precheck').click();
  await expect(page.getByTestId('candidate-tightening')).toBeVisible();
  await expect(page.getByTestId('candidate-confirm')).toBeEnabled();
  await page.getByTestId('lock-state-S3').click(); // CLOSED → OPEN：锁定变化
  await expect(page.getByTestId('candidate-stale')).toBeVisible();
  await expect(page.getByTestId('candidate-confirm')).toBeDisabled();

  // 撤销这把锁使锁定集合恢复为预检时的 {S1=OPEN}，但 specRev 已前进，仍须重新预检
  await page.getByTestId('lock-S3').click();
  await expect(page.getByTestId('candidate-stale')).toBeVisible();

  // 重新预检（锁定回到 {S1=OPEN}，候选仍为收紧）→ 确认新增
  await page.getByTestId('candidate-precheck').click();
  await expect(page.getByTestId('candidate-tightening')).toBeVisible();
  await page.getByTestId('candidate-confirm').click();

  // 规则真正追加为末条（序号 #2），预检区清空
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(3);
  await expect(page.getByTestId('rule-2')).toContainText('S2 CLOSED OR S3 CLOSED');
  await expect(page.getByTestId('candidate-text')).toHaveValue('');
  await expect(page.getByTestId('candidate-stale')).toHaveCount(0);
  // 规则变化使认证结论立即失效，必须重新认证（原流程不变）
  await expect(page.getByTestId('stale-warning')).toBeVisible();
  await expect(page.getByTestId('adopt-plan')).toBeDisabled();

  // 重新认证：新规则生效，S2、S3 不能同时 OPEN
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-sat')).toBeVisible();
  await expect(page.getByTestId('plan-row-S3')).toContainText('CLOSED');
});

test('确认隔离：导入替换工作区使预检过期，旧候选不被带入', async ({ page }) => {
  await loadWorkspace(page, WS);
  await page.getByTestId('candidate-text').fill('S1 CLOSED OR S2 CLOSED');
  await page.getByTestId('candidate-precheck').click();
  await expect(page.getByTestId('candidate-tightening')).toBeVisible();

  // 重新导入另一份工作区：旧预检必须消失，候选草稿清空，新工作区规则数独立
  await page.getByTestId('import-text').fill(
    ['[shutters]', 'A', 'B', '[rules]', 'A OPEN OR B OPEN'].join('\n'),
  );
  await page.getByTestId('import-btn').click();
  await expect(page.getByTestId('import-ok')).toBeVisible();
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('rule-0')).toContainText('A OPEN OR B OPEN');
  await expect(page.getByTestId('candidate-text')).toHaveValue('');
  await expect(page.getByTestId('candidate-stale')).toHaveCount(0);
  await expect(page.getByTestId('candidate-tightening')).toHaveCount(0);
  await expect(page.getByTestId('candidate-confirm')).toBeDisabled();
});

test('候选导致冲突：当前可行、加入后无解，见证含候选边，禁止确认', async ({ page }) => {
  await loadWorkspace(page, WS);
  // 锁 S2=CLOSED：规则 #0（S1 OPEN OR S2 OPEN）迫使 S1=OPEN，当前仍可行
  // （最小方案 S1=OPEN、S2=CLOSED、S3=CLOSED）。候选「S1 CLOSED OR S2 OPEN」
  // 的两个文字分别被规则+锁定（S1=OPEN）与锁定（S2=CLOSED）强制不成立 → 冲突。
  await page.getByTestId('lock-S2').click(); // 锁为当前表值 CLOSED
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-sat')).toBeVisible();
  await expect(page.getByTestId('plan-row-S1')).toContainText('OPEN');
  await expect(page.getByTestId('plan-row-S2')).toContainText('CLOSED');

  await page.getByTestId('candidate-text').fill('S1 CLOSED OR S2 OPEN');
  await page.getByTestId('candidate-precheck').click();
  const conflict = page.getByTestId('candidate-conflict');
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('候选导致冲突');
  // 含候选的闭环见证存在两条路径，且引用「规则 #2」（候选序号）
  await expect(page.getByTestId('candidate-conflict-path-open-to-closed')).toBeVisible();
  await expect(page.getByTestId('candidate-conflict-path-closed-to-open')).toBeVisible();
  await expect(conflict).toContainText('规则 #2');
  // 原锁定下本可执行的方案（证明冲突由候选引入）
  await expect(page.getByTestId('candidate-conflict-baseline-plan-row-S1')).toContainText('OPEN');
  await expect(page.getByTestId('candidate-conflict-baseline-plan-row-S2')).toContainText('CLOSED');
  // 冲突类不可确认；工作区未变
  await expect(page.getByTestId('candidate-confirm')).toBeDisabled();
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(2);
});

test('原工作区已冲突：沿用原见证不归咎候选，禁止确认', async ({ page }) => {
  // 四子句覆盖 A、B 全部组合：规则自身冲突
  await loadWorkspace(
    page,
    [
      '[shutters]',
      'A',
      'B',
      '[rules]',
      'A OPEN OR B OPEN',
      'A OPEN OR B CLOSED',
      'A CLOSED OR B OPEN',
      'A CLOSED OR B CLOSED',
    ].join('\n'),
  );
  await page.getByTestId('candidate-text').fill('A CLOSED OR B CLOSED');
  await page.getByTestId('candidate-precheck').click();
  const box = page.getByTestId('candidate-baseline-conflict');
  await expect(box).toBeVisible();
  await expect(box).toContainText('原工作区已冲突');
  await expect(box).toContainText('与候选无关');
  // 原见证路径只引用规则 #0–#3，不出现候选 #4
  await expect(page.getByTestId('candidate-baseline-path-open-to-closed')).toBeVisible();
  await expect(page.getByTestId('candidate-baseline-path-closed-to-open')).toBeVisible();
  const text = await box.innerText();
  expect(text).not.toContain('规则 #4');
  await expect(page.getByTestId('candidate-confirm')).toBeDisabled();
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(4);
});

test('候选冗余：明确提示且可确认（追加后认证须重跑）', async ({ page }) => {
  await loadWorkspace(page, WS);
  // 与规则 #0 完全相同的候选
  await page.getByTestId('candidate-text').fill('S1 OPEN OR S2 OPEN');
  await page.getByTestId('candidate-precheck').click();
  await expect(page.getByTestId('candidate-redundant')).toBeVisible();
  await expect(page.getByTestId('candidate-redundant')).toContainText('候选冗余');
  await expect(page.getByTestId('candidate-confirm')).toBeEnabled();
  // 确认前规则数不变
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(2);
  await page.getByTestId('candidate-confirm').click();
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(3);
  await expect(page.getByTestId('rule-2')).toContainText('S1 OPEN OR S2 OPEN');
});

test('候选解析失败：列出错误且不改工作区', async ({ page }) => {
  await loadWorkspace(page, WS);
  await page.getByTestId('candidate-text').fill('S1 FOO OR X CLOSED');
  await page.getByTestId('candidate-precheck').click();
  const errors = page.getByTestId('candidate-errors');
  await expect(errors).toBeVisible();
  await expect(errors).toContainText('非法状态');
  await expect(errors).toContainText('未知快门 ID');
  await expect(page.getByTestId('candidate-confirm')).toBeDisabled();
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(2);
});
