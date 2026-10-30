import type { PhoneDevice, PhoneScan, PhoneState, PhoneImportRequest } from './phone';
import type { IntelligenceState, ModelSetupOptions, SearchRequest, SearchResponse, AnalysisDetail, CloudAnalysisRequest } from './intelligence';
import type { ComputerDiscoveryState, ComputerLocation } from './discovery';
import type { PhoneReceiveOptions, PhoneReceiveState } from './receive';
export type MediaKind = 'image' | 'video';
export interface MediaItem {
  id: string;
  sourceId: string;
  path: string;
  fileName: string;
  kind: MediaKind;
  width: number;
  height: number;
  duration: number | null;
  size: number;
  mtimeMs: number;
  addedAt: number;
  openCount: number;
  lastOpenedAt: number | null;
  takenAt: number | null;
  favorite: boolean;
  missing: boolean;
  tags: string[];
  aiTags?: string[];
  phoneFolders?: Array<{id:string;name:string;path:string}>;
  albumIds: string[];
  thumbnailUrl: string;
  previewUrl: string;
  originalUrl: string;
}
export interface Source {
  id: string;
  path: string;
  name: string;
  status: 'online' | 'offline' | 'scanning';
  count: number;
}
export interface Album { id: string; name: string }
export interface Camera { x: number; y: number; scale: number }
export interface Settings {
  view: 'wall' | 'grid';
  fit: 'contain' | 'cover';
  sizingMode: 'balanced' | 'views' | 'recent' | 'bytes';
  focusTint: boolean;
  lighting: 'light' | 'dim';
  seed: number;
  gap: number;
  thumbSize: number;
  sidebarOpen: boolean;
  camera: Camera;
  lastSelectedId: string | null;
}
export const DEFAULT_SETTINGS: Settings = {
  view: 'wall', fit: 'cover', sizingMode: 'balanced', focusTint: true, lighting: 'light', seed: 17, gap: 8, thumbSize: 240,
  sidebarOpen: true, camera: { x: 48, y: 48, scale: 0.85 }, lastSelectedId: null,
};
export interface JobState {
  id: string;
  type: 'scan' | 'thumbnail' | 'video';
  status: 'running' | 'complete' | 'cancelled' | 'error';
  label: string;
  done: number;
  total: number;
  error?: string;
}
export interface ImportError { path: string; message: string }
export interface LibrarySnapshot {
  media: MediaItem[];
  sources: Source[];
  albums: Album[];
  tags: string[];
  settings: Settings;
  jobs: JobState[];
  errors: ImportError[];
}
export interface MediaPatch {
  favorite?: boolean;
  addTags?: string[];
  removeTags?: string[];
  addAlbumIds?: string[];
  removeAlbumIds?: string[];
}
export interface LibraryChange { type: 'library' | 'progress' | 'settings' }
export interface TrashResult { removed:string[]; failed:Array<{id:string;fileName:string;message:string}> }
export interface AlbumAPI {
  getSnapshot(): Promise<LibrarySnapshot>;
  chooseFolders(): Promise<string[]>;
  addSources(paths: string[]): Promise<void>;
  computerLocations(): Promise<ComputerLocation[]>;
  computerDiscoveryState(): Promise<ComputerDiscoveryState>;
  discoverComputer(paths: string[]): Promise<ComputerDiscoveryState>;
  cancelComputerDiscovery(): Promise<void>;
  addDiscoveredFolders(scanId: string, paths: string[]): Promise<void>;
  rescan(sourceId?: string): Promise<void>;
  cancelScan(): Promise<void>;
  updateMedia(ids: string[], patch: MediaPatch): Promise<void>;
  createAlbum(name: string): Promise<Album>;
  renameAlbum(id: string, name: string): Promise<void>;
  deleteAlbum(id: string): Promise<void>;
  removeSource(id: string): Promise<void>;
  removeMedia(ids: string[]): Promise<void>;
  trashMedia(ids: string[]): Promise<TrashResult>;
  phoneState():Promise<PhoneState>;
  phoneReceiveState():Promise<PhoneReceiveState>;
  startPhoneReceive(options:PhoneReceiveOptions):Promise<PhoneReceiveState>;
  stopPhoneReceive():Promise<PhoneReceiveState>;
  phoneDevices():Promise<PhoneDevice[]>;
  pairPhone(address:string,code:string):Promise<void>;
  connectPhone(address:string):Promise<void>;
  scanPhone(deviceId:string):Promise<PhoneScan>;
  chooseImportDestination():Promise<string|null>;
  importPhone(request:PhoneImportRequest):Promise<string>;
  pausePhoneImport(jobId:string):Promise<void>;
  resumePhoneImport(jobId:string):Promise<void>;
  intelligenceState():Promise<IntelligenceState>;
  chooseModelDirectory():Promise<string|null>;
  setupModels(options?:ModelSetupOptions):Promise<IntelligenceState>;
  analyzeMedia(ids?:string[]):Promise<string|null>;
  pauseAnalysis(jobId:string):Promise<void>;
  resumeAnalysis(jobId:string):Promise<void>;
  searchMedia(request:SearchRequest):Promise<SearchResponse>;
  analysisDetail(id:string):Promise<AnalysisDetail>;
  setAITag(id:string,tag:string,present:boolean):Promise<void>;
  cloudKeyStatus():Promise<boolean>;
  setCloudKey(key:string):Promise<void>;
  startCloudAnalysis(request:CloudAnalysisRequest):Promise<string>;
  relinkSource(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
  openExternal(id: string): Promise<void>;
  recordOpen(id: string): Promise<void>;
  setSettings(partial: Partial<Settings>): Promise<void>;
  prepareVideo(id: string): Promise<string>;
  cancelVideo(id: string): Promise<void>;
  getDroppedPaths(files: File[]): string[];
  onChange(listener: (event: LibraryChange) => void): () => void;
}
declare global { interface Window { album: AlbumAPI } }
