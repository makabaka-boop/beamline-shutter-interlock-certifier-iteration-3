import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * 唯一的端到端用例：完整走一次主流程，不在浏览器中预置结论——
 * 所有期望值均由 2-SAT 求解产出（并与 src/core 的 Vitest 穷举 oracle 一致）。
 *
 * 空工作区 → 非法导入整份拒绝 → 示例导入 → 认证得到字典序最小方案
 * → 改动列表 → 双锁触发无解闭环（每步指回原规则/锁定）→ 解锁恢复
 * → 采纳 → 下载稿与屏幕逐行一致。
 */
test('快门联锁主流程：导入 → 认证 → 冲突闭环 → 采纳 → 下载一致', async ({ page }) => {
  await page.goto('/');

  // 1. 空工作区：尚无认证面板与快门表
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByTestId('certify-panel')).toHaveCount(0);

  // 2. 非法导入：未知 ID + 非法状态 + 重复 ID，整份拒绝且保留当前（空）工作区
  await page.getByTestId('import-text').fill(
    [
      '[shutters]',
      'S1',
      'S2',
      'S1',
      '[rules]',
      'S1 OPEN OR X CLOSED',
      'S1 FOO OR S2 OPEN',
    ].join('\n'),
  );
  await page.getByTestId('import-btn').click();
  const errorBox = page.getByTestId('import-errors');
  await expect(errorBox).toBeVisible();
  await expect(errorBox).toContainText('未知快门 ID');
  await expect(errorBox).toContainText('非法状态');
  await expect(errorBox).toContainText('重复声明');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByTestId('shutter-panel')).toHaveCount(0);

  // 3. 载入示例并导入
  await page.getByTestId('sample-btn').click();
  await page.getByTestId('import-btn').click();
  await expect(page.getByTestId('import-ok')).toBeVisible();
  await expect(page.getByTestId('shutter-table')).toBeVisible();
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(4);

  // 4. 运行认证：可行；CLOSED 优先、UTF-8 字节序下仅 S3 必须 OPEN
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-sat')).toBeVisible();
  const expectPlan: Record<string, string> = {
    S1: 'CLOSED',
    S2: 'CLOSED',
    S3: 'OPEN',
    S4: 'CLOSED',
  };
  for (const [id, state] of Object.entries(expectPlan)) {
    await expect(page.getByTestId(`plan-row-${id}`)).toContainText(state);
  }
  await expect(page.getByTestId('changes-summary')).toContainText('共 1 处改动');
  await expect(page.getByTestId('change-S3')).toHaveText('S3：CLOSED→OPEN');
  await expect(page.getByTestId('download-plan')).toBeDisabled();

  // 5. 同时锁定 S3=CLOSED、S4=CLOSED：直接违反规则 #2（S3 OPEN OR S4 OPEN），
  //    S3 与 S4 正反文字并入同一 SCC；字节序最小者为 S3。
  await page.getByTestId('lock-S3').click();
  await expect(page.getByTestId('stale-warning')).toBeVisible();
  await expect(page.getByTestId('lock-state-S3')).toContainText('CLOSED');
  await page.getByTestId('lock-S4').click();
  await expect(page.getByTestId('lock-state-S4')).toContainText('CLOSED');

  await page.getByTestId('run-certify').click();
  const unsat = page.getByTestId('result-unsat');
  await expect(unsat).toBeVisible();
  await expect(unsat).toContainText('快门「S3」');

  // 路径一 S3=OPEN → S3=CLOSED：单位锁定边，仅一步且指回锁定
  const pathOC = page.getByTestId('path-open-to-closed');
  await expect(pathOC.locator('.path-step')).toHaveCount(1);
  await expect(pathOC.locator('.path-step').first()).toContainText('S3=OPEN');
  await expect(pathOC.locator('.path-step').first()).toContainText('S3=CLOSED');
  await expect(pathOC.locator('.path-step').first()).toContainText('依据 [锁定]');

  // 路径二 S3=CLOSED → S3=OPEN：规则#2 → 锁定 → 规则#2，闭合到 S3=OPEN
  const pathCO = page.getByTestId('path-closed-to-open');
  const coSteps = pathCO.locator('.path-step');
  await expect(coSteps).toHaveCount(3);
  const stepTexts = await coSteps.allTextContents();
  expect(stepTexts[0]).toContain('S3=CLOSED');
  expect(stepTexts[0]).toContain('S4=OPEN');
  expect(stepTexts[0]).toContain('依据 [规则 #2]');
  expect(stepTexts[0]).toContain('S3 OPEN OR S4 OPEN');
  expect(stepTexts[1]).toContain('S4=OPEN');
  expect(stepTexts[1]).toContain('S4=CLOSED');
  expect(stepTexts[1]).toContain('依据 [锁定]');
  expect(stepTexts[2]).toContain('S4=CLOSED');
  expect(stepTexts[2]).toContain('S3=OPEN');
  expect(stepTexts[2]).toContain('依据 [规则 #2]');

  // 无解时不允许采纳与下载
  await expect(page.getByTestId('adopt-plan')).toBeDisabled();
  await expect(page.getByTestId('download-plan')).toBeDisabled();

  // 6. 解锁：预览再次立即失效；重新认证恢复可行
  await page.getByTestId('lock-S3').click();
  await page.getByTestId('lock-S4').click();
  await expect(page.getByTestId('stale-warning')).toBeVisible();
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-sat')).toBeVisible();

  // 7. 采纳方案：快门表与屏幕方案一致
  await page.getByTestId('adopt-plan').click();
  await expect(page.getByTestId('adopted-banner')).toBeVisible();
  await expect(page.getByTestId('state-S3-OPEN')).toBeChecked();
  await expect(page.getByTestId('state-S1-CLOSED')).toBeChecked();
  await expect(page.getByTestId('state-S2-CLOSED')).toBeChecked();
  await expect(page.getByTestId('state-S4-CLOSED')).toBeChecked();

  // 8. 下载采纳稿：文件内容必须与屏幕表逐行一致
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('download-plan').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('shutter-table.txt');
  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  const content = readFileSync(filePath!, 'utf-8');
  expect(content).toBe('S1 CLOSED\nS2 CLOSED\nS3 OPEN\nS4 CLOSED\n');
});
