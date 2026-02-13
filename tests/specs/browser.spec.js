import { test, expect } from '@playwright/test';

/**
 * Browser tests for rex-spider-perplexity.
 */

test.describe('REX - Perplexity Spider - Browser', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/browser.html');
    await page.waitForFunction(() => window.testUtilitiesReady === true);
  });

  test('Validate page loaded.', async ({ page }) => {
    await expect(page).toHaveTitle(/Perplexity Spider Browser Test Page/);
  });

  test('extractCitationSource does not crash when meta_data is missing', async ({ page }) => {
    const source = await page.evaluate(() => {
      return window.rexPerplexityTestUtils.extractCitationSource({
        name: 'Example source title',
        url: 'https://www.nature.com/articles/test'
      });
    });

    expect(source).toBe('nature.com');
  });

  test('extractCitationSource prefers citation_domain_name when present', async ({ page }) => {
    const source = await page.evaluate(() => {
      return window.rexPerplexityTestUtils.extractCitationSource({
        name: 'Example source title',
        url: 'https://www.nature.com/articles/test',
        meta_data: {
          citation_domain_name: 'nature.com'
        }
      });
    });

    expect(source).toBe('nature.com');
  });
});
