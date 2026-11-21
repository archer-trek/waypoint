use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static NEXT_MEDIA_TEMP_ID: AtomicU64 = AtomicU64::new(1);
#[cfg(any(not(target_os = "android"), test))]
pub const MEDIA_CACHE_SUBDIR: &str = "waypoint-media";
pub const MEDIA_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

pub fn sanitize_media_filename(raw: &str) -> String {
    let tail = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = tail
        .chars()
        .map(|ch| {
            if ch == '\0' || ch == ':' || ch.is_control() {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let without_traversal = cleaned.replace("..", "_");
    let trimmed = without_traversal.trim_matches(|ch: char| ch == '.' || ch.is_whitespace());
    if trimmed.is_empty() {
        "attachment".to_string()
    } else {
        trimmed.to_string()
    }
}

fn infer_mime_type_from_filename(filename: &str) -> Option<&'static str> {
    let ext = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())?;
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "heic" | "heif" => Some("image/heic"),
        "bmp" => Some("image/bmp"),
        "avif" => Some("image/avif"),
        "pdf" => Some("application/pdf"),
        "txt" | "log" => Some("text/plain"),
        "md" | "markdown" => Some("text/markdown"),
        "csv" => Some("text/csv"),
        "json" => Some("application/json"),
        "html" | "htm" => Some("text/html"),
        "xml" => Some("application/xml"),
        "doc" => Some("application/msword"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xls" => Some("application/vnd.ms-excel"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "ppt" => Some("application/vnd.ms-powerpoint"),
        "pptx" => Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        "mp3" => Some("audio/mpeg"),
        "m4a" => Some("audio/mp4"),
        "ogg" => Some("audio/ogg"),
        "wav" => Some("audio/wav"),
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mov" => Some("video/quicktime"),
        "zip" => Some("application/zip"),
        "tar" => Some("application/x-tar"),
        "gz" => Some("application/gzip"),
        "apk" => Some("application/vnd.android.package-archive"),
        _ => None,
    }
}

fn is_valid_mime_essence(essence: &str) -> bool {
    let Some((major, minor)) = essence.split_once('/') else {
        return false;
    };
    if minor.contains('/') || major.is_empty() || minor.is_empty() {
        return false;
    }
    let valid_token = |part: &str| {
        part.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'!' | b'#' | b'$' | b'&' | b'-' | b'^' | b'_' | b'.' | b'+')
        })
    };
    valid_token(major) && valid_token(minor)
}

pub fn normalize_media_mime_type(mime_type: Option<&str>, filename: &str) -> String {
    if let Some(raw) = mime_type {
        let essence = raw
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !essence.is_empty()
            && essence != "*/*"
            && essence != "application/octet-stream"
            && is_valid_mime_essence(&essence)
        {
            return essence;
        }
    }
    infer_mime_type_from_filename(filename)
        .unwrap_or("application/octet-stream")
        .to_string()
}

#[cfg(any(not(target_os = "android"), test))]
pub fn media_cache_dir(base_cache_dir: &Path) -> PathBuf {
    base_cache_dir.join(MEDIA_CACHE_SUBDIR)
}

pub fn cleanup_expired_media_cache(
    cache_dir: &Path,
    now: SystemTime,
    max_age: Duration,
) -> std::io::Result<usize> {
    if !cache_dir.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in std::fs::read_dir(cache_dir)? {
        let entry = match entry {
            Ok(item) => item,
            Err(_) => continue,
        };
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let timestamp = metadata.modified().or_else(|_| metadata.created());
        let Ok(modified) = timestamp else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age >= max_age {
            let delete_result = if metadata.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            if delete_result.is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

pub fn prepare_media_cache_file(
    cache_dir: &Path,
    filename: &str,
    bytes: &[u8],
    now: SystemTime,
    max_age: Duration,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(cache_dir).map_err(|err| err.to_string())?;
    let _ = cleanup_expired_media_cache(cache_dir, now, max_age);

    let safe_name = sanitize_media_filename(filename);
    let ts = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = NEXT_MEDIA_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let batch_dir = cache_dir.join(format!("{ts}-{seq}"));
    std::fs::create_dir_all(&batch_dir).map_err(|err| err.to_string())?;
    let file_path = batch_dir.join(&safe_name);
    std::fs::write(&file_path, bytes).map_err(|err| err.to_string())?;
    Ok(file_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = NEXT_MEDIA_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("waypoint-rust-test-{label}-{nanos}-{seq}"))
    }

    #[test]
    fn sanitize_media_filename_strips_paths_and_traversal() {
        assert_eq!(sanitize_media_filename("../secret/report.pdf"), "report.pdf");
        assert_eq!(
            sanitize_media_filename("C:\\Users\\a\\..pic:1.png"),
            "_pic_1.png"
        );
        assert_eq!(sanitize_media_filename("   "), "attachment");
        assert_eq!(sanitize_media_filename("."), "attachment");
        assert_eq!(sanitize_media_filename("\0:\n"), "___");
        assert_eq!(sanitize_media_filename("demo.txt"), "demo.txt");
    }

    #[test]
    fn normalize_media_mime_type_preserves_valid_and_falls_back_by_extension() {
        assert_eq!(
            normalize_media_mime_type(Some("Application/PDF; charset=utf-8"), "file.bin"),
            "application/pdf"
        );
        assert_eq!(
            normalize_media_mime_type(Some("application/octet-stream"), "notes.md"),
            "text/markdown"
        );
        assert_eq!(
            normalize_media_mime_type(Some("*/*"), "photo.JPEG"),
            "image/jpeg"
        );
        assert_eq!(
            normalize_media_mime_type(Some("invalid mime"), "clip.mp4"),
            "video/mp4"
        );
        assert_eq!(
            normalize_media_mime_type(None, "archive.unknownext"),
            "application/octet-stream"
        );
    }

    #[test]
    fn media_cache_dir_joins_waypoint_media_subdir() {
        let base = Path::new("/data/user/0/app.waypoint.client/cache");
        assert_eq!(
            media_cache_dir(base),
            PathBuf::from("/data/user/0/app.waypoint.client/cache/waypoint-media")
        );
    }

    #[test]
    fn prepare_and_cleanup_expired_media_cache_removes_only_stale_entries() {
        let root = unique_test_dir("cache-cleanup");
        let cache_dir = media_cache_dir(&root);
        let now = SystemTime::now();
        let ttl = Duration::from_secs(3600);

        let fresh_file = prepare_media_cache_file(&cache_dir, "fresh.png", b"png-bytes", now, ttl)
            .expect("fresh file should be created");
        assert!(fresh_file.exists());
        assert_eq!(std::fs::read(&fresh_file).unwrap(), b"png-bytes");

        let removed_none =
            cleanup_expired_media_cache(&cache_dir, now, Duration::from_secs(60)).unwrap();
        assert_eq!(removed_none, 0);
        assert!(fresh_file.exists());

        let future = now + Duration::from_secs(7200);
        let removed_stale = cleanup_expired_media_cache(&cache_dir, future, ttl).unwrap();
        assert_eq!(removed_stale, 1);
        assert!(!fresh_file.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cleanup_expired_media_cache_handles_missing_directory() {
        let missing = unique_test_dir("missing").join("waypoint-media");
        assert_eq!(
            cleanup_expired_media_cache(&missing, SystemTime::now(), MEDIA_CACHE_TTL).unwrap(),
            0
        );
    }
}
