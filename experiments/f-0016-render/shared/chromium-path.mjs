// 使用本机已缓存的 Chrome for Testing（Playwright 1.6x 下载的 chromium-1234），不另行下载浏览器。
import { homedir } from 'node:os';
export const CHROMIUM = process.env.F0016_CHROMIUM ?? `${homedir()}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
