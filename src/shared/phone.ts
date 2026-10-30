export interface PhoneDevice {
  id: string;
  serial: string;
  name: string;
  state: 'device' | 'unauthorized' | 'offline';
  connection: 'usb' | 'wireless';
  androidVersion?: string;
}
export interface PhoneScanIssue { path: string; message: string }
export interface PhoneFolder { path: string; name: string; count: number; bytes: number; recommended?: boolean; exclusionReason?: string }
export interface PhoneScan {
  id: string;
  device: PhoneDevice;
  folders: PhoneFolder[];
  count: number;
  bytes: number;
  issues: PhoneScanIssue[];
  notes: string[];
  createdAt: number;
}
export type PhoneImportStatus = 'queued' | 'running' | 'paused' | 'complete' | 'error';
export interface PhoneImportJob {
  id: string;
  deviceId: string;
  deviceName: string;
  destination: string;
  status: PhoneImportStatus;
  total: number;
  done: number;
  imported: number;
  skipped: number;
  failed: number;
  totalBytes: number;
  transferredBytes: number;
  currentFile?: string;
  error?: string;
  issues: PhoneScanIssue[];
  createdAt: number;
  updatedAt: number;
}
export interface PhoneState {
  available: boolean;
  scanning: boolean;
  scanProgress?: { count: number; bytes: number; folder?: string };
  devices: PhoneDevice[];
  jobs: PhoneImportJob[];
}
export interface PhoneImportRequest { scanId: string; destination: string; folderPaths?: string[] }
