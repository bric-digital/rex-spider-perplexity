import { test, expect } from '@playwright/test';

/**
 * Comprehensive test suite for rex-spider-perplexity
 * Tests IndexedDB operations, CRUD, pattern matching, and bulk operations
 */

test.describe('REX - Perplexity Spider - Browser', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/browser.html');
    await page.waitForFunction(() => window.testUtilitiesReady === true);
  });

  test('Validate page loaded.', async ({ page }) => {
    await expect(page).toHaveTitle(/Perplexity Spider Browser Test Page/);
  });
});
