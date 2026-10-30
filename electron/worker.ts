import { parentPort, workerData } from 'node:worker_threads';
import { Library, type LibraryOptions } from './library';

// Database and media work stay outside Electron's UI thread.
// https://nodejs.org/docs/latest-v24.x/api/worker_threads.html
const port = parentPort!;
const library = new Library({ ...(workerData as LibraryOptions), onChange: event => port.postMessage({ event }) });
const methods = new Set(['getSnapshot', 'addSources', 'computerLocations', 'computerDiscoveryState', 'resolveDiscoveryPreview', 'discoverComputer', 'cancelComputerDiscovery', 'addDiscoveredFolders', 'rescan', 'cancelScan', 'updateMedia', 'createAlbum', 'renameAlbum', 'deleteAlbum', 'removeSource', 'removeMedia', 'relinkSource', 'setSettings', 'prepareVideo', 'cancelVideo', 'getPath', 'resolveMedia', 'recordOpen', 'close', 'beginTrash','finishTrash','phoneState','phoneReceiveState','startPhoneReceive','stopPhoneReceive','phoneDevices','pairPhone','connectPhone','scanPhone','importPhone','pausePhoneImport','resumePhoneImport','intelligenceState','setupModels','analyzeMedia','pauseAnalysis','resumeAnalysis','searchMedia','analysisDetail','setAITag','startCloudAnalysis']);
port.on('message', async (message: { id: number; method: string; args: unknown[] }) => {
  const { id, method, args } = message;
  try {
    if (!methods.has(method)) throw new Error('未知操作');
    const value = await (library as any)[method](...args);
    port.postMessage({ id, value });
  } catch (error) { port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
});
port.postMessage({ ready: true });
library.initialize().catch(error => port.postMessage({ fatal: error instanceof Error ? error.message : String(error) }));
