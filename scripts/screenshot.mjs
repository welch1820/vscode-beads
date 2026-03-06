#!/usr/bin/env node

// Agent screenshot verification tool.
// Takes a screenshot of code-server running in headless Chrome.
//
// Usage:
//   node screenshot.mjs                  # screenshot to screenshots/latest.png
//   node screenshot.mjs --reload         # reload window first, then screenshot
//   node screenshot.mjs --output foo.png # custom output path
//   node screenshot.mjs --sidebar beads  # click Beads sidebar before capture
//   node screenshot.mjs --wait 3000      # wait N ms after load (default: 2000)
//   node screenshot.mjs --url http://... # custom code-server URL (default: 127.0.0.1:8080)

import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    reload:  { type: 'boolean', default: false },
    output:  { type: 'string',  default: 'screenshots/latest.png' },
    sidebar: { type: 'string',  default: '' },
    click:   { type: 'string',  multiple: true, default: [] },
    wait:    { type: 'string',  default: '2000' },
    url:     { type: 'string',  default: 'http://127.0.0.1:8080' },
    help:    { type: 'boolean', default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`Usage: node screenshot.mjs [options]
  --reload         Reload the code-server window before capture
  --output PATH    Output file (default: screenshots/latest.png)
  --sidebar NAME   Click a sidebar icon by title before capture (e.g., "Beads")
  --click TEXT     Click element containing TEXT (repeatable, executed in order with 1s delay)
  --wait MS        Wait after load/reload (default: 2000)
  --url URL        code-server URL (default: http://127.0.0.1:8080)`);
  process.exit(0);
}

const waitMs = parseInt(args.wait, 10);
const outputPath = resolve(args.output);

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    console.log(`Navigating to ${args.url} ...`);
    await page.goto(args.url, { waitUntil: 'networkidle2', timeout: 30000 });

    if (args.reload) {
      console.log('Reloading window...');
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    }

    // Wait for VS Code workbench to be ready
    await page.waitForSelector('.monaco-workbench', { timeout: 15000 }).catch(() => {
      console.warn('Warning: .monaco-workbench not found, continuing anyway');
    });

    // Dismiss workspace trust dialog if present
    const trustDismissed = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button.monaco-button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('trust the authors')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (trustDismissed) {
      console.log('Dismissed workspace trust dialog');
      await new Promise(r => setTimeout(r, 3000));
    }

    // Dismiss "Open Workspace" notification if present
    await page.evaluate(() => {
      const notifications = document.querySelectorAll('.notification-list-item .action-label');
      for (const btn of notifications) {
        if (btn.textContent?.includes('Close') || btn.getAttribute('aria-label') === 'Close') {
          btn.click();
        }
      }
    });

    if (args.sidebar) {
      console.log(`Clicking sidebar: ${args.sidebar}`);
      // Activity bar icons have aria-label matching the view title
      const clicked = await page.evaluate((name) => {
        const items = document.querySelectorAll('.action-item a.action-label');
        for (const item of items) {
          if (item.getAttribute('aria-label')?.toLowerCase().includes(name.toLowerCase())) {
            item.click();
            return true;
          }
        }
        return false;
      }, args.sidebar);

      if (!clicked) {
        console.warn(`Warning: sidebar "${args.sidebar}" not found`);
      }
      // Wait for webview iframe content to load after sidebar activation
      await new Promise(r => setTimeout(r, 3000));
    }

    // Click elements by text content (in order), searching all frames
    // VS Code webviews use nested iframes — must search recursively
    async function clickByText(page, searchText) {
      // Collect all frames containing the text
      async function collectFrames(frame, depth = 0) {
        const matches = [];
        try {
          const hasText = await frame.evaluate(
            (s) => document.body?.textContent?.includes(s) || false, searchText
          );
          if (hasText) matches.push({ frame, depth });
        } catch {}
        for (const child of frame.childFrames()) {
          matches.push(...await collectFrames(child, depth + 1));
        }
        return matches;
      }

      const frames = await collectFrames(page.mainFrame());
      // Deepest frame first — that's where the actual webview content lives
      frames.sort((a, b) => b.depth - a.depth);

      for (const { frame } of frames) {
        try {
          const result = await frame.evaluate((s) => {
            let best = null, bestLen = Infinity;
            for (const el of document.querySelectorAll('*')) {
              const t = el.textContent?.trim() || '';
              if (t.includes(s) && t.length < bestLen) {
                best = el;
                bestLen = t.length;
              }
            }
            if (best) {
              best.click();
              return { found: true, tag: best.tagName, text: best.textContent?.trim().slice(0, 60) };
            }
            return { found: false };
          }, searchText);
          if (result.found) return result;
        } catch {}
      }
      return { found: false };
    }

    for (const text of args.click) {
      console.log(`Clicking element containing: "${text}"`);
      const result = await clickByText(page, text);
      if (result.found) {
        console.log(`  Clicked: <${result.tag}> "${result.text}"`);
      } else {
        console.warn(`  Warning: no element found containing "${text}"`);
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`Waiting ${waitMs}ms for UI to settle...`);
    await new Promise(r => setTimeout(r, waitMs));

    await mkdir(dirname(outputPath), { recursive: true });
    await page.screenshot({ path: outputPath, fullPage: false });
    console.log(`Screenshot saved: ${outputPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Screenshot failed:', err.message);
  process.exit(1);
});
