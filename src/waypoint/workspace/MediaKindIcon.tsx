import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from "lucide-react";
import { classifyMediaFileKind } from "./media-presentation";

export function MediaKindIcon({
  filename,
  mimeType,
  className = "size-4",
}: {
  filename: string;
  mimeType?: string;
  className?: string;
}) {
  const kind = classifyMediaFileKind(filename, mimeType);
  switch (kind) {
    case "image":
      return <FileImage aria-hidden="true" strokeWidth={1.85} className={className} />;
    case "video":
      return <FileVideo aria-hidden="true" strokeWidth={1.85} className={className} />;
    case "audio":
      return <FileAudio aria-hidden="true" strokeWidth={1.85} className={className} />;
    case "archive":
      return <FileArchive aria-hidden="true" strokeWidth={1.85} className={className} />;
    case "spreadsheet":
      return <FileSpreadsheet aria-hidden="true" strokeWidth={1.85} className={className} />;
    case "code":
      return <FileCode aria-hidden="true" strokeWidth={1.85} className={className} />;
    case "document":
      return <FileText aria-hidden="true" strokeWidth={1.85} className={className} />;
    default:
      return <File aria-hidden="true" strokeWidth={1.85} className={className} />;
  }
}
