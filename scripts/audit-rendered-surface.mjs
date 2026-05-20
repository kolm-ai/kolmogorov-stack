#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(repo, 'public');

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] || fallback;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

function fileToRoute(file) {
  const rel = path.relative(publicDir, file).split(path.sep).join('/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'/index.html'.length);
  return '/' + rel.replace(/\.html$/, '');
}

const base = arg('base', 'http://localhost:8787');
const limit = Number(arg('limit', '0')) || 0;
const timeoutMs = Number(arg('timeout-ms', '5000')) || 5000;
const waitMs = Number(arg('wait-ms', '40')) || 40;
const progressEvery = Number(arg('progress-every', '0')) || 0;
const routeArg = arg('routes', null);
const routes = routeArg
  ? routeArg.split(',').map((s) => s.trim()).filter(Boolean)
  : walk(publicDir)
      .filter((file) => !file.includes(`${path.sep}_archive${path.sep}`))
      .map(fileToRoute)
      .sort();
const selected = limit > 0 ? routes.slice(0, limit) : routes;

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
];

const browser = await chromium.launch();
const failures = [];
let checked = 0;

for (const viewport of viewports) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: 'dark',
    userAgent: viewport.name === 'mobile'
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined
  });
  const page = await context.newPage();

  for (const route of selected) {
    checked += 1;
    const url = base + route;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const status = resp ? resp.status() : 0;
      if (status >= 400 || status === 0) {
        failures.push({ route, viewport: viewport.name, reason: `status_${status}` });
        continue;
      }
      await page.waitForTimeout(waitMs);
      const report = await page.evaluate(() => {
        const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest('pre, code, kbd, samp, script, style')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        let proseText = '';
        while (walker.nextNode()) proseText += ` ${walker.currentNode.nodeValue || ''}`;
        proseText = proseText.replace(/\s+/g, ' ').trim();
        const doc = document.documentElement;
        const overflow = Math.max(doc.scrollWidth, document.body?.scrollWidth || 0) - window.innerWidth;
        const polish = Boolean(document.querySelector('link[href="/surface-polish.css"]'));
        const visibleSkip = Array.from(document.querySelectorAll('.skip-link')).some((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none' &&
            rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
        });
        const badVisibleText = /\[object Object\]/i.test(proseText);
        const blank = bodyText.length < 24;
        const h1Text = Array.from(document.querySelectorAll('h1')).map((h) => h.innerText.trim()).join(' | ');
        return { bodyTextLength: bodyText.length, overflow, polish, visibleSkip, badVisibleText, blank, h1Text };
      });
      if (!report.polish) failures.push({ route, viewport: viewport.name, reason: 'surface_polish_missing' });
      if (report.blank) failures.push({ route, viewport: viewport.name, reason: `blank_or_near_blank:${report.bodyTextLength}` });
      if (report.visibleSkip) failures.push({ route, viewport: viewport.name, reason: 'skip_link_visible_unfocused' });
      if (report.badVisibleText) failures.push({ route, viewport: viewport.name, reason: 'visible_debug_text' });
      if (report.overflow > 2) failures.push({ route, viewport: viewport.name, reason: `horizontal_overflow:${Math.round(report.overflow)}px`, h1: report.h1Text });
    } catch (error) {
      failures.push({ route, viewport: viewport.name, reason: `error:${error.message.split('\n')[0]}` });
    }
    if (progressEvery > 0 && checked % progressEvery === 0) {
      console.log(`[rendered-surface] checked ${checked}/${selected.length * viewports.length}; latest ${viewport.name} ${route}; failures ${failures.length}`);
    }
  }

  await context.close();
}

await browser.close();

const byReason = new Map();
for (const failure of failures) {
  byReason.set(failure.reason, (byReason.get(failure.reason) || 0) + 1);
}

console.log(JSON.stringify({
  base,
  routes: selected.length,
  viewports: viewports.map((v) => v.name),
  checks: checked,
  failures: failures.length,
  by_reason: Object.fromEntries([...byReason.entries()].sort((a, b) => b[1] - a[1])),
  sample: failures.slice(0, 80)
}, null, 2));

if (failures.length > 0) process.exit(1);
