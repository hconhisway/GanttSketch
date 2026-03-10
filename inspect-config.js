const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  
  try {
    console.log('Navigating to http://localhost:3000...');
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle', timeout: 10000 });
    
    console.log('Page loaded successfully!');
    
    // Take initial screenshot
    await page.screenshot({ path: 'screenshot-initial.png' });
    console.log('Screenshot saved: screenshot-initial.png');
    
    // Check for any console errors
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    // Look for config panel elements
    const configButton = await page.$('[data-testid*="config"], button:has-text("Config"), button:has-text("Settings")');
    
    if (configButton) {
      console.log('Found config button, clicking...');
      await configButton.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'screenshot-config-open.png' });
      console.log('Screenshot saved: screenshot-config-open.png');
    } else {
      console.log('No config button found, checking if config panel is already visible...');
    }
    
    // Search for hierarchy aggregation related text
    const pageContent = await page.content();
    const hierarchyMatches = pageContent.match(/hierarchy[^<]*aggregation/gi) || [];
    
    console.log('\n--- Hierarchy Aggregation Config Items Found ---');
    if (hierarchyMatches.length > 0) {
      hierarchyMatches.forEach((match, idx) => {
        console.log(`${idx + 1}. ${match}`);
      });
    } else {
      console.log('No hierarchy aggregation config items visible in page content');
    }
    
    // Check for specific text patterns
    const text = await page.textContent('body');
    const patterns = [
      'Hierarchy 1 Aggregation',
      'Hierarchy 2 Aggregation', 
      'Hierarchy 3 Aggregation',
      'Aggregation Rule',
      'hierarchy aggregation'
    ];
    
    console.log('\n--- Searching for specific patterns ---');
    patterns.forEach(pattern => {
      if (text.includes(pattern)) {
        console.log(`✓ Found: "${pattern}"`);
      }
    });
    
    // Report console errors
    if (errors.length > 0) {
      console.log('\n--- Console Errors ---');
      errors.forEach(err => console.log(err));
    } else {
      console.log('\n✓ No console errors detected');
    }
    
    // Keep browser open for manual inspection
    console.log('\nBrowser will remain open for manual inspection. Press Ctrl+C to close.');
    await page.waitForTimeout(300000); // Wait 5 minutes
    
  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: 'screenshot-error.png' });
  } finally {
    await browser.close();
  }
})();
