// Renders the app icons from SVG with Playwright's Chromium.
//   node scripts/generate-icons.mjs        (set PW_CHROMIUM to use a preinstalled browser)
// Produces build/icon.png (macOS style, 1024), build/icon.ico (Windows), resources/icon.png, resources/tray.png.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

// A shield split into four colour segments with a white check mark: "protected".
const SHIELD = 'M32 9.5 49.5 15.6V30.2c0 11.1-7.3 19.9-17.5 24.8C21.8 50.1 14.5 41.3 14.5 30.2V15.6Z';
const COLORS = { tl: '#4285F4', tr: '#EA4335', bl: '#34A853', br: '#FBBC05' };

const shield = `
  <clipPath id="shield"><path d="${SHIELD}"/></clipPath>
  <g clip-path="url(#shield)">
    <rect x="0" y="0" width="32" height="32" fill="${COLORS.tl}"/>
    <rect x="32" y="0" width="32" height="32" fill="${COLORS.tr}"/>
    <rect x="0" y="32" width="32" height="32" fill="${COLORS.bl}"/>
    <rect x="32" y="32" width="32" height="32" fill="${COLORS.br}"/>
    <path d="M32 0V64M0 32H64" stroke="#fff" stroke-width="1.6"/>
    <path d="${SHIELD}" fill="url(#gloss)"/>
  </g>
  <path d="M24.2 31.6 29.6 37 40.2 26.4" fill="none" stroke="#fff" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" filter="url(#soft)"/>`;

const defs = `<defs>
  <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef1f6"/>
  </linearGradient>
  <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
    <feDropShadow dx="0" dy="0.8" stdDeviation="0.8" flood-color="#1b2440" flood-opacity="0.3"/>
  </filter>
  <filter id="lift" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="1.4" stdDeviation="1.6" flood-color="#1b2440" flood-opacity="0.18"/>
  </filter>
</defs>`;

// Full-bleed white tile (Windows, Linux, tray). A hairline border keeps it visible on white desktops.
const square = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${defs}
  <rect x="0.5" y="0.5" width="63" height="63" rx="14.5" fill="url(#tile)" stroke="#d9dee8" stroke-width="1"/>
  <g filter="url(#lift)">${shield}</g></svg>`;

// macOS: the tile occupies 824/1024 of the canvas with a soft drop shadow.
const mac = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${defs}
  <filter id="drop" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#0b1020" flood-opacity="0.28"/></filter>
  <g transform="translate(100 100)">
    <rect width="824" height="824" rx="185" fill="url(#tile)" filter="url(#drop)"/>
    <rect x="1" y="1" width="822" height="822" rx="184" fill="none" stroke="#e2e6ee" stroke-width="2"/>
    <g transform="scale(12.875)" filter="url(#lift)">${shield}</g>
  </g></svg>`;

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage();
async function render(svg, size, path) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

mkdirSync('build', { recursive: true });
mkdirSync('resources', { recursive: true });
await render(mac, 1024, 'build/icon.png');
await render(square, 512, 'resources/icon.png');
await render(square, 32, 'resources/tray.png');
for (const size of [16, 24, 32, 48, 64, 128, 256]) await render(square, size, `build/ico-${size}.png`);
await browser.close();

try {
  const sizes = [16, 24, 32, 48, 64, 128, 256].map((s) => `build/ico-${s}.png`);
  execFileSync('convert', [...sizes, 'build/icon.ico']);
} catch {
  console.warn('ImageMagick not found: build/icon.ico not regenerated');
}
execFileSync('rm', ['-f', ...[16, 24, 32, 48, 64, 128, 256].map((s) => `build/ico-${s}.png`)]);
console.log('icons written');
