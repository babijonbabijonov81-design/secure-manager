// Renders the app icons from SVG with Playwright's Chromium.
//   node scripts/generate-icons.mjs        (set PW_CHROMIUM to use a preinstalled browser)
// Produces build/icon.png (1024), build/icon.ico (Windows), build/icons/*.png and veil.svg (Linux hicolor),
// build/installer*.bmp (NSIS), resources/icon.png, resources/tray*.png.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

// «Две вуали»: a V made of two curved sheets with the conversation (a dot) hidden between them.
// The warm sheet is you, the cool one is the person you talk to.
const mark = ({ a = '#FF7A45', b = '#3DDC97', bOpacity = 0.92, dot = '#F4EFE9' } = {}) => `
  <path d="M7 9 Q19 10 24 39 Q11 29 7 9 Z" fill="${a}"/>
  <path d="M41 9 Q29 10 24 39 Q37 29 41 9 Z" fill="${b}" opacity="${bOpacity}"/>
  <circle cx="24" cy="14" r="4.2" fill="${dot}"/>`;

// App icon: the mark on a #1A1411 plate rounded by 22 % of its side, the mark taking 70 % of it.
const plate = (fill = '#1A1411', colors = {}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="10.56" fill="${fill}"/>
  <g transform="translate(7.2 7.2) scale(0.7)">${mark(colors)}</g></svg>`;
const DARK = plate();
// The smallest sizes use the one-colour mark (spec: «Трей и 16 px»), still on the plate so it shows on any background.
const SMALL = plate('#1A1411', { a: '#F4EFE9', b: '#F4EFE9', bOpacity: 0.6, dot: '#F4EFE9' });
const LIGHT = plate('#FFF6EF', { a: '#E2582A', b: '#14A672', bOpacity: 1, dot: '#1A1411' });
// Tray and 16 px: a one-colour mark, the right sheet at 60 %.
const mono = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 6 40 36">${mark({ a: color, b: color, bOpacity: 0.6, dot: color })}</svg>`;

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage();
async function render(svg, width, path, height = width, background = 'transparent') {
  await page.setViewportSize({ width, height });
  await page.setContent(`<html><body style="margin:0;background:${background}">${svg}</body></html>`);
  await page.screenshot({ path, omitBackground: background === 'transparent', clip: { x: 0, y: 0, width, height } });
}
const sized = (svg, w, h = w) => svg.replace('<svg ', `<svg width="${w}" height="${h}" `);

mkdirSync('build/icons', { recursive: true });
mkdirSync('resources', { recursive: true });

await render(sized(DARK, 1024), 1024, 'build/icon.png');
await render(sized(DARK, 512), 512, 'resources/icon.png');
await render(sized(LIGHT, 512), 512, 'resources/icon-light.png');
// Linux hicolor sizes, plus the vector version.
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) await render(sized(size <= 16 ? SMALL : DARK, size), size, `build/icons/${size}x${size}.png`);
writeFileSync('build/icons/veil.svg', DARK + '\n');
// Tray: light mark for dark panels, dark mark for the light Windows taskbar.
for (const [name, color] of [['tray', '#F4EFE9'], ['tray-dark', '#1A1411']]) {
  await render(sized(mono(color), 16), 16, `resources/${name}.png`);
  await render(sized(mono(color), 32), 32, `resources/${name}@2x.png`);
}

// Windows .ico: 16, 20, 24, 32, 40, 48, 64, 256.
const ICO = [16, 20, 24, 32, 40, 48, 64, 256];
for (const size of ICO) await render(sized(size <= 20 ? SMALL : DARK, size), size, `build/ico-${size}.png`);

// NSIS images: header 150×57 and sidebar 164×314, set in Onest like the app.
const font = (file, range) =>
  `@font-face{font-family:Onest;font-weight:100 900;src:url(data:font/woff2;base64,${readFileSync(`node_modules/@fontsource-variable/onest/files/${file}`).toString('base64')}) format('woff2');unicode-range:${range}}`;
const fonts = `<style>${font('onest-latin-wght-normal.woff2', 'U+0000-00FF')}${font('onest-cyrillic-wght-normal.woff2', 'U+0400-045F')}</style>`;
const header = `${fonts}<div style="width:150px;height:57px;background:#0C0A09;display:flex;align-items:center;gap:10px;padding-left:14px;box-sizing:border-box;font:800 22px Onest,sans-serif;color:#F4EFE9">${sized(DARK, 34)}veil</div>`;
const sidebar = `${fonts}<div style="width:164px;height:314px;background:#0C0A09;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font:800 30px Onest,sans-serif;color:#F4EFE9">${sized(DARK, 88)}veil<span style="font:500 12px Onest,sans-serif;color:#A39A90;text-align:center;padding:0 14px">Сквозное шифрование для Windows и Linux</span></div>`;
await render(header, 150, 'build/installerHeader.png', 57, '#0C0A09');
await render(sidebar, 164, 'build/installerSidebar.png', 314, '#0C0A09');
await browser.close();

try {
  execFileSync('convert', [...ICO.map((s) => `build/ico-${s}.png`), 'build/icon.ico']);
  for (const name of ['installerHeader', 'installerSidebar']) execFileSync('convert', [`build/${name}.png`, `BMP3:build/${name}.bmp`]);
  execFileSync('cp', ['build/installerSidebar.bmp', 'build/uninstallerSidebar.bmp']);
} catch {
  console.warn('ImageMagick not found: build/icon.ico and installer images not regenerated');
}
for (const size of ICO) rmSync(`build/ico-${size}.png`, { force: true });
rmSync('build/installerHeader.png', { force: true });
rmSync('build/installerSidebar.png', { force: true });
console.log('icons written');
