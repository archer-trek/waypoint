import { describe, expect, test } from "vitest";
import {
  classifyMediaFileKind,
  extractFileExtensionLabel,
  formatFileSize,
} from "./media-presentation";

describe("media-presentation", () => {
  test("extractFileExtensionLabel handles compound archive suffixes, normal extensions, and MIME fallbacks", () => {
    expect(extractFileExtensionLabel("backup.tar.gz")).toBe("TAR.GZ");
    expect(extractFileExtensionLabel("architecture-spec.pdf")).toBe("PDF");
    expect(extractFileExtensionLabel("README")).toBe("文件");
    expect(extractFileExtensionLabel("blob", "application/pdf")).toBe("PDF");
    expect(extractFileExtensionLabel("photo", "image/webp")).toBe("WEBP");
    expect(extractFileExtensionLabel("clip", "video/mp4")).toBe("视频");
  });

  test("formatFileSize formats bytes, KB, MB, and GB cleanly", () => {
    expect(formatFileSize(undefined)).toBeUndefined();
    expect(formatFileSize(-1)).toBeUndefined();
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(420 * 1024)).toBe("420 KB");
    expect(formatFileSize(2.4 * 1024 * 1024)).toBe("2.4 MB");
    expect(formatFileSize(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  test("classifyMediaFileKind distinguishes images, media, archives, spreadsheets, code, and documents", () => {
    expect(classifyMediaFileKind("shot.png")).toBe("image");
    expect(classifyMediaFileKind("clip.mp4")).toBe("video");
    expect(classifyMediaFileKind("voice.m4a")).toBe("audio");
    expect(classifyMediaFileKind("bundle.tar.gz")).toBe("archive");
    expect(classifyMediaFileKind("metrics.xlsx")).toBe("spreadsheet");
    expect(classifyMediaFileKind("App.tsx")).toBe("code");
    expect(classifyMediaFileKind("spec.pdf")).toBe("document");
    expect(classifyMediaFileKind("raw.bin", "application/octet-stream")).toBe("file");
  });
});
