import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * 候选规则预检的端到端流程。核心断言是「隔离」：
 * - 预检本身不改动规则、锁定、快门表、认证结论或导出状态；
 * - 确认新增只在预检未过期时可用；导入或编辑使预检过期后立即拒绝确认；
 * - 冲突结论不提供确认入口，且旧冲突的见证不归咎于候选规则。
 * 所有期望值均由 2-SAT 求解逻辑决定（与 Vitest 穷举 oracle 一致），无固定假结论。
 */

test('有效收紧：预检隔离工作区，确认后并入规则并重新认证', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sample-btn').click();
  await page.getByTestId('import-btn').click();
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(4);

  // 锁定 S1=CLOSED 并先运行一次认证（产生认证结论，供隔离断言）
  await page.getByTestId('lock-S1').click();
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-sat')).toBeVisible();
  await expect(page.getByTestId('changes-summary')).toContainText('共 1 处改动');

  // 候选：S1 OPEN OR S2 OPEN（禁止 S1、S2 同时 CLOSED）→ 有效收紧
  await page.getByTestId('candidate-text').fill('S1 OPEN OR S2 OPEN');
  await page.getByTestId('precheck-btn').click();
  await expect(page.getByTestId('precheck-tightens')).toBeVisible();

  // 满足候选的规范方案（遵守锁定 S1=CLOSED）：S2=OPEN、S3=OPEN
  await expect(page.getByTestId('precheck-plan-row-S1')).toContainText('CLOSED');
  await expect(page.getByTestId('precheck-plan-row-S2')).toContainText('OPEN');
  await expect(page.getByTestId('precheck-plan-row-S3')).toContainText('OPEN');
  await expect(page.getByTestId('precheck-plan-row-S4')).toContainText('CLOSED');
  // 违反候选的可复核见证（当前合法、遵守同一锁定）：S1=CLOSED、S2=CLOSED
  await expect(page.getByTestId('precheck-counterexample-row-S1')).toContainText('CLOSED');
  await expect(page.getByTestId('precheck-counterexample-row-S2')).toContainText('CLOSED');
  await expect(page.getByTestId('precheck-counterexample-row-S3')).toContainText('OPEN');

  // 隔离：预检不改动规则、锁定、快门表、认证结论
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(4);
  await expect(page.locator('.lock-summary')).toContainText('已锁定 1 个快门');
  await expect(page.getByTestId('result-sat')).toBeVisible();
  await expect(page.getByTestId('stale-warning')).toHaveCount(0);
  await expect(page.getByTestId('state-S2-CLOSED')).toBeChecked();
  await expect(page.getByTestId('adopt-plan')).toBeEnabled();

  // 确认新增：候选并入为规则 #4，旧认证结论立即失效，锁定与快门表不动
  await page.getByTestId('confirm-add-rule').click();
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(5);
  await expect(page.getByTestId('rule-4')).toContainText('S1 OPEN OR S2 OPEN');
  await expect(page.getByTestId('stale-warning')).toBeVisible();
  await expect(page.locator('.lock-summary')).toContainText('已锁定 1 个快门');
  await expect(page.getByTestId('lock-state-S1')).toContainText('CLOSED');
  await expect(page.getByTestId('state-S2-CLOSED')).toBeChecked();
  await expect(page.getByTestId('adopt-plan')).toBeDisabled();

  // 重新认证：方案与预检的规范方案一致
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-sat')).toBeVisible();
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

test('预检过期：锁定变化后立即拒绝确认，重新预检后方可确认', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sample-btn').click();
  await page.getByTestId('import-btn').click();

  await page.getByTestId('candidate-text').fill('S1 OPEN OR S2 OPEN');
  await page.getByTestId('precheck-btn').click();
  await expect(page.getByTestId('precheck-tightens')).toBeVisible();
  await expect(page.getByTestId('confirm-add-rule')).toBeEnabled();

  // 期间改动锁定 → 预检立即过期，确认入口消失，规则不得被并入
  await page.getByTestId('lock-S2').click();
  await expect(page.getByTestId('precheck-stale')).toBeVisible();
  await expect(page.getByTestId('confirm-add-rule')).toHaveCount(0);
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(4);

  // 基于当前锁定重新预检 → 仍然有效收紧，确认可用
  await page.getByTestId('precheck-btn').click();
  await expect(page.getByTestId('precheck-tightens')).toBeVisible();
  await expect(page.getByTestId('precheck-stale')).toHaveCount(0);
  await page.getByTestId('confirm-add-rule').click();
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(5);
  // 确认只追加规则：锁定 S2=CLOSED 保留不动
  await expect(page.locator('.lock-summary')).toContainText('已锁定 1 个快门');
  await expect(page.getByTestId('lock-state-S2')).toContainText('CLOSED');

  // 重新认证：S2=CLOSED 被锁定，候选迫使 S1=OPEN；字典序最小方案 S3=CLOSED、S4=OPEN
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-sat')).toBeVisible();
  const expectPlan: Record<string, string> = {
    S1: 'OPEN',
    S2: 'CLOSED',
    S3: 'CLOSED',
    S4: 'OPEN',
  };
  for (const [id, state] of Object.entries(expectPlan)) {
    await expect(page.getByTestId(`plan-row-${id}`)).toContainText(state);
  }
});

test('候选导致冲突：给出指回候选的闭环，不提供确认入口且认证结论不受影响', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sample-btn').click();
  await page.getByTestId('import-btn').click();

  // 锁 S1=CLOSED：规则 #3 迫使 S4=CLOSED，规则 #2 再迫使 S3=OPEN
  await page.getByTestId('lock-S1').click();
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-sat')).toBeVisible();

  // 候选 S3 CLOSED OR S4 OPEN 与被迫使的 S3=OPEN、S4=CLOSED 直接矛盾
  await page.getByTestId('candidate-text').fill('S3 CLOSED OR S4 OPEN');
  await page.getByTestId('precheck-btn').click();
  await expect(page.getByTestId('precheck-candidate-conflict')).toBeVisible();
  await expect(page.getByTestId('precheck-path-open-to-closed')).toBeVisible();
  await expect(page.getByTestId('precheck-path-closed-to-open')).toBeVisible();
  // 闭环中至少一步指回候选规则
  await expect(
    page
      .getByTestId('precheck-candidate-conflict')
      .locator('.path-step', { hasText: '依据 [候选规则]' })
      .first(),
  ).toBeVisible();

  // 冲突结论不提供确认入口；预检不改动既有认证结论与规则
  await expect(page.getByTestId('confirm-add-rule')).toHaveCount(0);
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(4);
  await expect(page.getByTestId('result-sat')).toBeVisible();
  await expect(page.getByTestId('stale-warning')).toHaveCount(0);
});

test('原工作区已冲突：见证不归咎于候选，不提供确认入口', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sample-btn').click();
  await page.getByTestId('import-btn').click();

  // 双锁 S3=CLOSED、S4=CLOSED 直接违反规则 #2 → 原工作区无解
  await page.getByTestId('lock-S3').click();
  await page.getByTestId('lock-S4').click();
  await page.getByTestId('run-certify').click();
  await expect(page.getByTestId('result-unsat')).toBeVisible();
  await expect(page.getByTestId('repair-suggestion')).toBeVisible();

  // 任意候选的预检都报「原工作区已冲突」
  await page.getByTestId('candidate-text').fill('S1 OPEN OR S2 OPEN');
  await page.getByTestId('precheck-btn').click();
  const baseConflict = page.getByTestId('precheck-base-conflict');
  await expect(baseConflict).toBeVisible();
  await expect(baseConflict).toContainText('与候选规则');
  await expect(baseConflict).toContainText('无关');
  // 冲突闭环逐步合法，且没有任何一步指回候选规则
  await expect(page.getByTestId('precheck-path-open-to-closed')).toBeVisible();
  await expect(page.getByTestId('precheck-path-closed-to-open')).toBeVisible();
  await expect(
    baseConflict.locator('.path-step', { hasText: '依据 [候选规则]' }),
  ).toHaveCount(0);

  // 不提供确认入口；原认证结论（含锁定修复建议）不受影响
  await expect(page.getByTestId('confirm-add-rule')).toHaveCount(0);
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(4);
  await expect(page.getByTestId('result-unsat')).toBeVisible();
  await expect(page.getByTestId('repair-suggestion')).toBeVisible();
});

test('候选冗余与非法输入：冗余可确认但不改变方案，非法候选整份拒绝', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sample-btn').click();
  await page.getByTestId('import-btn').click();

  // 非法候选：未知 ID → 拒绝，工作区不变
  await page.getByTestId('candidate-text').fill('S9 OPEN OR S1 CLOSED');
  await page.getByTestId('precheck-btn').click();
  await expect(page.getByTestId('candidate-errors')).toContainText('未知快门 ID');
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(4);
  await expect(page.getByTestId('confirm-add-rule')).toHaveCount(0);

  // 冗余候选：S1 OPEN OR S3 OPEN 被规则链蕴含
  // （规则 #3：S1=CLOSED→S4=CLOSED；规则 #2：S4=CLOSED→S3=OPEN）
  await page.getByTestId('candidate-text').fill('S1 OPEN OR S3 OPEN');
  await page.getByTestId('precheck-btn').click();
  await expect(page.getByTestId('precheck-redundant')).toBeVisible();
  await expect(page.getByTestId('candidate-errors')).toHaveCount(0);

  // 候选文本被修改 → 与预检结果不一致，确认被禁用
  await page.getByTestId('candidate-text').fill('S1 OPEN OR S3 CLOSED');
  await expect(page.getByTestId('precheck-text-changed')).toBeVisible();
  await expect(page.getByTestId('confirm-add-rule')).toBeDisabled();
  // 改回已预检的文本 → 确认恢复可用
  await page.getByTestId('candidate-text').fill('S1 OPEN OR S3 OPEN');
  await expect(page.getByTestId('precheck-text-changed')).toHaveCount(0);
  await expect(page.getByTestId('confirm-add-rule')).toBeEnabled();

  // 确认新增冗余规则：规则数 +1，方案与新增前完全一致
  await page.getByTestId('confirm-add-rule').click();
  await expect(page.getByTestId('rules-list').locator('li')).toHaveCount(5);
  await expect(page.getByTestId('rule-4')).toContainText('S1 OPEN OR S3 OPEN');
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
});
