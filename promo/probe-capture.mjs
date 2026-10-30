import { _electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeDesktopSession } from '../scripts/desktop-session.mjs';

const root = path.resolve('promo/.work/probe'); await fs.mkdir(root, { recursive: true });
let app, child;
try {
  app = await _electron.launch({ executablePath: path.join(process.env.LOCALAPPDATA, 'Programs/Shiguang/Luma.exe'), env: { ...process.env, SHIGUANG_DATA_DIR: path.join(root, 'profile'), SHIGUANG_TEST_MODE: '1', SHIGUANG_HIDDEN_TEST: '1' } });
  child = app.process();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1920, 1080));
  const page = await app.firstWindow(); await page.getByTestId('home-albums').waitFor();
  const cdp = await page.context().newCDPSession(page); let frames = 0;
  cdp.on('Page.screencastFrame', event => { frames++; if (frames === 1) fs.writeFile(path.join(root, 'first.jpg'), Buffer.from(event.data, 'base64')); cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}); });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await page.getByTestId('import-folder').click(); await page.waitForTimeout(1000); await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
  await cdp.send('Page.stopScreencast'); console.log(JSON.stringify({ frames, invisible: await app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()) }));
} finally { await app?.close().catch(() => {}); await closeDesktopSession({ child }); }
