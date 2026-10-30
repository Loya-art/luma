import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AlbumAPI, LibraryChange } from '../src/shared/types';

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke(`album:${method}`, ...args);
const api: AlbumAPI = {
  getSnapshot: () => invoke('getSnapshot'),
  chooseFolders: () => invoke('chooseFolders'),
  addSources: paths => invoke('addSources', paths),
  computerLocations: () => invoke('computerLocations'),
  computerDiscoveryState: () => invoke('computerDiscoveryState'),
  discoverComputer: paths => invoke('discoverComputer', paths),
  cancelComputerDiscovery: () => invoke('cancelComputerDiscovery'),
  addDiscoveredFolders: (scanId, paths) => invoke('addDiscoveredFolders', scanId, paths),
  rescan: id => invoke('rescan', id),
  cancelScan: () => invoke('cancelScan'),
  updateMedia: (ids, patch) => invoke('updateMedia', ids, patch),
  createAlbum: name => invoke('createAlbum', name),
  renameAlbum: (id, name) => invoke('renameAlbum', id, name),
  deleteAlbum: id => invoke('deleteAlbum', id),
  removeSource: id => invoke('removeSource', id),
  removeMedia: ids => invoke('removeMedia', ids),
  trashMedia: ids => invoke('trashMedia', ids),
  phoneState:()=>invoke('phoneState'), phoneDevices:()=>invoke('phoneDevices'),
  phoneReceiveState:()=>invoke('phoneReceiveState'),startPhoneReceive:options=>invoke('startPhoneReceive',options),stopPhoneReceive:()=>invoke('stopPhoneReceive'),
  pairPhone:(address,code)=>invoke('pairPhone',address,code),connectPhone:address=>invoke('connectPhone',address),scanPhone:id=>invoke('scanPhone',id),
  chooseImportDestination:()=>invoke('chooseImportDestination'),importPhone:request=>invoke('importPhone',request),pausePhoneImport:id=>invoke('pausePhoneImport',id),resumePhoneImport:id=>invoke('resumePhoneImport',id),
  intelligenceState:()=>invoke('intelligenceState'),chooseModelDirectory:()=>invoke('chooseModelDirectory'),setupModels:options=>invoke('setupModels',options),analyzeMedia:ids=>invoke('analyzeMedia',ids),
  pauseAnalysis:id=>invoke('pauseAnalysis',id),resumeAnalysis:id=>invoke('resumeAnalysis',id),searchMedia:request=>invoke('searchMedia',request),analysisDetail:id=>invoke('analysisDetail',id),setAITag:(id,tag,present)=>invoke('setAITag',id,tag,present),
  cloudKeyStatus:()=>invoke('cloudKeyStatus'),setCloudKey:key=>invoke('setCloudKey',key),startCloudAnalysis:request=>invoke('startCloudAnalysis',request),
  relinkSource: id => invoke('relinkSource', id),
  reveal: id => invoke('reveal', id),
  openExternal: id => invoke('openExternal', id),
  recordOpen: id => invoke('recordOpen', id),
  setSettings: partial => invoke('setSettings', partial),
  prepareVideo: id => invoke('prepareVideo', id),
  cancelVideo: id => invoke('cancelVideo', id),
  // Files must be interpreted in preload, not serialized through IPC.
  // https://www.electronjs.org/docs/latest/api/web-utils
  getDroppedPaths: files => files.map(file => webUtils.getPathForFile(file)).filter(Boolean),
  onChange(listener) {
    const receive = (_event: Electron.IpcRendererEvent, change: LibraryChange) => listener(change);
    ipcRenderer.on('album:change', receive);
    return () => ipcRenderer.removeListener('album:change', receive);
  },
};
contextBridge.exposeInMainWorld('album', api);
