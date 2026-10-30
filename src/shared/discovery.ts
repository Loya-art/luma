export interface ComputerLocation {
  path: string;
  name: string;
  kind: 'disk' | 'folder';
  freeBytes?: number;
  totalBytes?: number;
}
export interface DiscoveredFolder {
  path: string;
  name: string;
  count: number;
  photos: number;
  videos: number;
  bytes: number;
  recommended: boolean;
  recommendation: string;
  previewUrl?: string;
}
export interface DiscoveryIssue { path: string; message: string }
export interface FilteredPhotoDirectory { path: string; reason: string }
export interface ComputerDiscoveryState {
  id: string | null;
  status: 'idle' | 'running' | 'complete' | 'cancelled' | 'error';
  roots: string[];
  currentDirectory?: string;
  visitedDirectories: number;
  skippedDirectories: number;
  filteredDirectories: number;
  filtered: FilteredPhotoDirectory[];
  count: number;
  bytes: number;
  folders: DiscoveredFolder[];
  issues: DiscoveryIssue[];
  issueCount: number;
  startedAt?: number;
  finishedAt?: number;
}
