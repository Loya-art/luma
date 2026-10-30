import net from 'node:net';
import { spawn } from 'node:child_process';

// Check before launching: an acceptance controller must never attach to and
// subsequently close an older user-owned app occupying the same CDP port.
export async function assertDebuggingPortAvailable(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(new Error(`调试端口 ${port} 已被占用；未启动或关闭任何现有软件。`, { cause: error })));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}

const exited = child => child.exitCode !== null || child.signalCode !== null;
async function waitForExit(child, milliseconds) {
  if (exited(child)) return true;
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(true); };
    const timer = setTimeout(() => { child.removeListener('exit', done); resolve(exited(child)); }, milliseconds);
    child.once('exit', done);
  });
}

export async function closeDesktopSession({ browser, child, leaveOpen = false, timeoutMs = 8000 }) {
  if (child && !leaveOpen && !exited(child)) {
    // This browser belongs to the child we just launched after the port check.
    // Closing its page requests Electron's normal window-all-closed shutdown.
    const pages = browser?.contexts().flatMap(context => context.pages()) ?? [];
    await Promise.race([
      Promise.allSettled(pages.map(page => page.close({ runBeforeUnload: false }))),
      new Promise(resolve => { const timer = setTimeout(resolve, timeoutMs); timer.unref(); }),
    ]);
  }
  // connectOverCDP.close disconnects its transport; it does not close the existing
  // remote application. See Playwright's BrowserType.connectOverCDP implementation.
  await browser?.close().catch(() => {});
  if (!child || leaveOpen || await waitForExit(child, timeoutMs)) return;
  // Only the exact ChildProcess captured by this controller may be terminated.
  // Never kill by executable name: the user's regular app/Edge/Codex may coexist.
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const command = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      command.once('error', reject);
      command.once('exit', code => code === 0 || exited(child) ? resolve() : reject(new Error(`测试进程 ${child.pid} 未能关闭`)));
    });
  } else child.kill('SIGKILL');
  if (!await waitForExit(child, 5000)) throw new Error(`测试进程 ${child.pid} 仍未退出`);
}
