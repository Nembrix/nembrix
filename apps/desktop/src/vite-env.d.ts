/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

// File System Access API — used by the export flow to open a native save
// dialog in Chromium-based browsers (the desktop app uses Tauri's dialog
// instead). Not yet in TS's default DOM lib, so we declare the slice we use.
interface FileSystemWritableFileStream {
  write(data: string | BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
}
interface FileSystemFileHandle {
  readonly name: string;
  createWritable(): Promise<FileSystemWritableFileStream>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}
interface Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
}
