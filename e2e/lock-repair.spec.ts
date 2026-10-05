import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * 锁定修复建议的端到端流程：
 * 无解 → 最少撤销建议（含候选方案）→ 期间改动锁定使建议过期
 * （过期建议不得改写工作区：锁定、快门表、采纳状态一律不动）
 * → 重新认证得到基于当前锁定的新建议 → 确认修复（一次性撤销所列锁定
 * 并重新认证）→ 采纳 → 下载稿与屏幕一致。
 */
test('锁定修复建议：过期不改写工作区，确认后一次性撤销并重新认证', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sample-btn').click();
  await page.getByTestId('import-btn').click();
  await expect(page.getByTestId('shutter-table')).toBeVisible();

  // 锁定 S3=CLOSED、S4=CLOSED → 违反规则 #2（S3 OPEN OR S4 OPEN），认证无解
  await page.getByTestId('lock-S3').click();
  await page.getByTestId('lock-S4').click();
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-unsat')).toBeVisible();

  // 原冲突闭环保留：两条蕴含路径仍在
  await expect(page.getByTestId('path-open-to-closed')).toBeVisible();
  await expect(page.getByTestId('path-closed-to-open')).toBeVisible();

  // 修复建议：撤 S3 或 S4 均可（最少 1 个），并列按 UTF-8 字节序取 S3
  const suggestion = page.getByTestId('repair-suggestion');
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText('最少撤销 1 个');
  await expect(page.getByTestId('repair-remove-S3')).toContainText('S3');
  await expect(page.getByTestId('repair-remove-S3')).toContainText('CLOSED');
  await expect(page.getByTestId('repair-remove-S4')).toHaveCount(0);
  // 候选方案（撤销 S3 后）：S3=OPEN，其余 CLOSED；确认前不生效
  await expect(page.getByTestId('repair-plan-row-S3')).toContainText('OPEN');
  await expect(page.getByTestId('repair-plan-row-S1')).toContainText('CLOSED');
  await expect(page.getByTestId('state-S3-CLOSED')).toBeChecked(); // 快门表未动

  // 期间改动锁定（S1、S2 锁为 OPEN）→ 建议立即过期，且不得改写工作区
  await page.getByTestId('lock-S1').click();
  await page.getByTestId('lock-state-S1').click(); // CLOSED → OPEN
  await page.getByTestId('lock-S2').click();
  await page.getByTestId('lock-state-S2').click(); // CLOSED → OPEN
  await expect(page.getByTestId('stale-warning')).toBeVisible();
  await expect(page.getByTestId('repair-suggestion')).toHaveCount(0);
  await expect(page.getByTestId('confirm-repair')).toHaveCount(0);
  // 锁定集合未被旧建议改写：四把锁都在，S3、S4 并未被“撤销”
  await expect(page.locator('.lock-summary')).toContainText('已锁定 4 个快门');
  await expect(page.getByTestId('lock-state-S1')).toContainText('OPEN');
  await expect(page.getByTestId('lock-state-S2')).toContainText('OPEN');
  await expect(page.getByTestId('lock-state-S3')).toContainText('CLOSED');
  await expect(page.getByTestId('lock-state-S4')).toContainText('CLOSED');
  // 快门表未被旧候选方案改写：仍全部 CLOSED，未采纳、不可下载
  for (const id of ['S1', 'S2', 'S3', 'S4']) {
    await expect(page.getByTestId(`state-${id}-CLOSED`)).toBeChecked();
  }
  await expect(page.getByTestId('adopt-plan')).toBeDisabled();
  await expect(page.getByTestId('download-plan')).toBeDisabled();

  // 重新认证：建议必须基于当前锁定集合重新计算。
  // 当前锁定 {S1=OPEN, S2=OPEN, S3=CLOSED, S4=CLOSED} 含两对独立冲突
  // （规则 #0 与规则 #2），最少撤 2 个，并列中取 [S1, S3]——
  // 与过期建议（仅 S3）不同，证明旧建议未被采纳。
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-unsat')).toBeVisible();
  const fresh = page.getByTestId('repair-suggestion');
  await expect(fresh).toBeVisible();
  await expect(fresh).toContainText('最少撤销 2 个');
  await expect(page.getByTestId('repair-remove-S1')).toContainText('OPEN');
  await expect(page.getByTestId('repair-remove-S3')).toContainText('CLOSED');
  await expect(page.getByTestId('repair-remove-S2')).toHaveCount(0);
  await expect(page.getByTestId('repair-remove-S4')).toHaveCount(0);

  // 确认修复：一次性撤销 S1、S3 并重新认证 → 可行
  await page.getByTestId('confirm-repair').click();
  await expect(page.getByTestId('result-sat')).toBeVisible();
  // 只撤销了所列锁定：S1、S3 解锁，S2=OPEN、S4=CLOSED 保留不动
  await expect(page.getByTestId('lock-S1')).toHaveText('锁定');
  await expect(page.getByTestId('lock-S3')).toHaveText('锁定');
  await expect(page.getByTestId('lock-state-S2')).toContainText('OPEN');
  await expect(page.getByTestId('lock-state-S4')).toContainText('CLOSED');
  await expect(page.locator('.lock-summary')).toContainText('已锁定 2 个快门');
  // 重新认证的方案与候选一致：S1=CLOSED、S2=OPEN、S3=OPEN、S4=CLOSED
  const expectPlan: Record<string, string> = {
    S1: 'CLOSED',
    S2: 'OPEN',
    S3: 'OPEN',
    S4: 'CLOSED',
  };
  for (const [id, state] of Object.entries(expectPlan)) {
    await expect(page.getByTestId(`plan-row-${id}`)).toContainText(state);
  }
  await expect(page.getByTestId('changes-summary')).toContainText('共 2 处改动');

  // 采纳并下载：采纳稿与屏幕表逐行一致
  await page.getByTestId('adopt-plan').click();
  await expect(page.getByTestId('adopted-banner')).toBeVisible();
  for (const [id, state] of Object.entries(expectPlan)) {
    await expect(page.getByTestId(`state-${id}-${state}`)).toBeChecked();
  }
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('download-plan').click();
  const download = await downloadPromise;
  const filePath = await download.path();
  expect(readFileSync(filePath!, 'utf-8')).toBe(
    'S1 CLOSED\nS2 OPEN\nS3 OPEN\nS4 CLOSED\n',
  );
});

test('规则自身冲突：全部解锁仍无解，明确报告且不提供修复建议', async ({ page }) => {
  await page.goto('/');
  // 四个子句覆盖 A、B 的全部组合：规则自身不可满足
  await page.getByTestId('import-text').fill(
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
  await page.getByTestId('import-btn').click();
  await expect(page.getByTestId('import-ok')).toBeVisible();

  // 即使有临时锁定，诊断也应指向规则本身而非锁定
  await page.getByTestId('lock-A').click();
  await page.getByTestId('lock-state-A').click(); // 锁 A=OPEN
  await page.getByTestId('run-certify').click();

  await expect(page.getByTestId('result-unsat')).toBeVisible();
  // 冲突闭环保留
  await expect(page.getByTestId('path-open-to-closed')).toBeVisible();
  // 明确报告规则自身冲突，不给任何撤销建议或确认按钮
  await expect(page.getByTestId('repair-rules-conflict')).toBeVisible();
  await expect(page.getByTestId('repair-rules-conflict')).toContainText('规则自身冲突');
  await expect(page.getByTestId('repair-suggestion')).toHaveCount(0);
  await expect(page.getByTestId('confirm-repair')).toHaveCount(0);
  await expect(page.getByTestId('adopt-plan')).toBeDisabled();
  await expect(page.getByTestId('download-plan')).toBeDisabled();
});

test('锁定超过 8 个：不做精确枚举，明确提示且不给出建议', async ({ page }) => {
  await page.goto('/');
  const ids = Array.from({ length: 9 }, (_, i) => `SH${i + 1}`);
  await page.getByTestId('import-text').fill(
    [
      '[shutters]',
      ...ids,
      '[rules]',
      'SH1 OPEN OR SH2 OPEN',
    ].join('\n'),
  );
  await page.getByTestId('import-btn').click();
  await expect(page.getByTestId('import-ok')).toBeVisible();

  // 9 把锁（SH1、SH2 的 CLOSED 锁定与规则冲突，其余无辜）
  for (const id of ids) {
    await page.getByTestId(`lock-${id}`).click();
  }
  await expect(page.locator('.lock-summary')).toContainText('已锁定 9 个快门');
  await page.getByTestId('run-certify').click();

  await expect(page.getByTestId('result-unsat')).toBeVisible();
  await expect(page.getByTestId('repair-too-many-locks')).toBeVisible();
  await expect(page.getByTestId('repair-too-many-locks')).toContainText('9');
  await expect(page.getByTestId('repair-suggestion')).toHaveCount(0);
  await expect(page.getByTestId('confirm-repair')).toHaveCount(0);
});
