export interface PhoneReceiveOptions { destination: string; albumName: string }
export interface ReceiveAddress { name: string; url: string; qrCode: string }
export interface ReceivedFile { name: string; bytes: number; status: 'received' | 'duplicate' | 'failed'; message?: string }
export interface PhoneReceiveState {
  active: boolean; destination?: string; albumName?: string; expiresAt?: number;
  addresses: ReceiveAddress[]; received: number; skipped: number; failed: number;
  bytes: number; uploading: number; files: ReceivedFile[]; lastError?: string;
}
