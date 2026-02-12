import { test, expect } from '@playwright/test';

test('interaction performance baseline', async ({ page }) => {
  await page.goto('/');
  const viewport = page.locator('.gantt-viewport');
  await expect(viewport).toBeVisible({ timeout: 60_000 });

  const box = await viewport.boundingBox();
  if (!box) throw new Error('Viewport box not found');

  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -500);
  await page.keyboard.up('Control');

  await page.waitForTimeout(200);

  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.mouse.up();

  await page.waitForTimeout(500);

  const metrics = await page.evaluate(() => {
    const perf = (window as any).__ganttPerfMetrics;
    const samples = perf?.getSamples?.() || [];
    const memory = (performance as any).memory;
    return {
      samples,
      memory: memory
        ? {
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize
          }
        : null
    };
  });

  const fetchSamples = metrics.samples
    .map((s: any) => s.fetchMs)
    .filter((v: any) => typeof v === 'number')
    .sort((a: number, b: number) => a - b);
  const renderSamples = metrics.samples
    .map((s: any) => s.renderMs)
    .filter((v: any) => typeof v === 'number')
    .sort((a: number, b: number) => a - b);

  const p95 = (arr: number[]) =>
    arr.length === 0 ? null : arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))];

  console.log('p95 fetch (ms):', p95(fetchSamples));
  console.log('p95 render (ms):', p95(renderSamples));
  console.log('memory:', metrics.memory);

  expect(metrics.samples.length).toBeGreaterThan(0);
});
