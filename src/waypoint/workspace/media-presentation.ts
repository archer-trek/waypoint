export type MediaVisualKind =
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "spreadsheet"
  | "document"
  | "file";

const COMPOUND_ARCHIVE_SUFFIXES = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"] as const;

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "heic",
  "heif",
  "bmp",
  "ico",
]);

const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v", "3gp"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "flac", "ogg", "opus", "aac", "wma"]);
const ARCHIVE_EXTS = new Set([
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "zst",
  "tar.gz",
  "tar.bz2",
  "tar.xz",
  "tar.zst",
]);
const SPREADSHEET_EXTS = new Set(["csv", "tsv", "xls", "xlsx", "ods", "numbers"]);
const CODE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "kt",
  "kts",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "sh",
  "zsh",
  "bash",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "css",
  "scss",
  "sql",
  "md",
  "markdown",
]);
const DOCUMENT_EXTS = new Set(["pdf", "doc", "docx", "txt", "rtf", "odt", "pages", "epub", "ppt", "pptx"]);

const MIME_LABEL_MAP: Record<string, string> = {
  "application/pdf": "PDF",
  "application/zip": "ZIP",
  "application/x-zip-compressed": "ZIP",
  "application/gzip": "GZ",
  "application/x-tar": "TAR",
  "application/x-7z-compressed": "7Z",
  "application/json": "JSON",
  "text/plain": "TXT",
  "text/markdown": "MD",
  "text/csv": "CSV",
  "text/html": "HTML",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "application/octet-stream": "",
};

function extractLowerExtension(filename: string): string | undefined {
  const trimmed = filename.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  for (const suffix of COMPOUND_ARCHIVE_SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length) {
      return suffix.slice(1);
    }
  }
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === lower.length - 1) {
    return undefined;
  }
  const ext = lower.slice(dotIdx + 1);
  if (ext.length > 10 || !/^[a-z0-9]+$/.test(ext)) {
    return undefined;
  }
  return ext;
}

export function extractFileExtensionLabel(filename: string, mimeType?: string): string {
  const ext = extractLowerExtension(filename);
  if (ext) {
    return ext.toUpperCase();
  }
  const essence = mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (essence && essence in MIME_LABEL_MAP) {
    const mapped = MIME_LABEL_MAP[essence];
    if (mapped) {
      return mapped;
    }
  }
  if (essence.startsWith("image/")) {
    const sub = essence.slice("image/".length).split("+")[0]?.toUpperCase();
    if (sub && sub !== "*") return sub;
    return "图片";
  }
  if (essence.startsWith("video/")) return "视频";
  if (essence.startsWith("audio/")) return "音频";
  if (essence.startsWith("text/")) return "文本";
  return "文件";
}

export function formatFileSize(bytes?: number): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return undefined;
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const kb = bytes / 1024;
  if (kb < 10) {
    return `${kb.toFixed(1)} KB`;
  }
  if (kb < 1024) {
    return `${Math.round(kb)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 100) {
    return `${mb.toFixed(1)} MB`;
  }
  if (mb < 1024) {
    return `${Math.round(mb)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

export function classifyMediaFileKind(filename: string, mimeType?: string): MediaVisualKind {
  const ext = extractLowerExtension(filename);
  const essence = mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";

  if (essence.startsWith("image/") || (ext && IMAGE_EXTS.has(ext))) {
    return "image";
  }
  if (essence.startsWith("video/") || (ext && VIDEO_EXTS.has(ext))) {
    return "video";
  }
  if (essence.startsWith("audio/") || (ext && AUDIO_EXTS.has(ext))) {
    return "audio";
  }
  if (ext && ARCHIVE_EXTS.has(ext)) {
    return "archive";
  }
  if (essence === "application/zip" || essence === "application/gzip" || essence === "application/x-tar") {
    return "archive";
  }
  if (ext && SPREADSHEET_EXTS.has(ext)) {
    return "spreadsheet";
  }
  if (ext && CODE_EXTS.has(ext)) {
    return "code";
  }
  if (ext && DOCUMENT_EXTS.has(ext)) {
    return "document";
  }
  if (essence === "application/pdf" || essence.startsWith("text/")) {
    return "document";
  }
  return "file";
}
