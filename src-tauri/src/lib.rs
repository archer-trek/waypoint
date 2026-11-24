mod media;

#[cfg(not(target_os = "android"))]
use media::media_cache_dir;
use media::{normalize_media_mime_type, prepare_media_cache_file, MEDIA_CACHE_TTL};
use std::time::SystemTime;
#[cfg(target_os = "macos")]
use tauri::Manager;
#[cfg(not(target_os = "android"))]
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "android")]
mod android_bridge {
    use jni::objects::{JObject, JString, JValue};
    use jni::JNIEnv;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    const BRIDGE_TIMEOUT: Duration = Duration::from_secs(10);

    fn take_jni_error(env: &mut JNIEnv<'_>, fallback: &str) -> String {
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        fallback.to_string()
    }

    fn read_nullable_jstring(
        env: &mut JNIEnv<'_>,
        obj: JObject<'_>,
    ) -> Result<Option<String>, String> {
        if obj.is_null() {
            return Ok(None);
        }
        let jstr = JString::from(obj);
        let value: String = env
            .get_string(&jstr)
            .map_err(|err| take_jni_error(env, &err.to_string()))?
            .into();
        Ok(Some(value))
    }

    fn exec_on_activity<T, F>(
        window: &tauri::WebviewWindow,
        timeout_msg: &str,
        action: F,
    ) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut JNIEnv<'_>, &JObject<'_>) -> Result<T, String> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        window
            .with_webview(move |webview| {
                webview.jni_handle().exec(move |env, activity, _webview| {
                    let result = action(env, activity);
                    let _ = tx.send(result);
                });
            })
            .map_err(|err| err.to_string())?;
        rx.recv_timeout(BRIDGE_TIMEOUT)
            .map_err(|_| timeout_msg.to_string())?
    }

    pub fn query_media_cache_dir(window: &tauri::WebviewWindow) -> Result<PathBuf, String> {
        exec_on_activity(
            window,
            "Timed out resolving Android cache directory",
            |env, activity| {
                let value = env
                    .call_method(
                        activity,
                        "getMediaCacheDirPath",
                        "()Ljava/lang/String;",
                        &[],
                    )
                    .map_err(|err| take_jni_error(env, &err.to_string()))?;
                let obj = value
                    .l()
                    .map_err(|err| take_jni_error(env, &err.to_string()))?;
                match read_nullable_jstring(env, obj)? {
                    Some(raw) if !raw.is_empty() => Ok(PathBuf::from(raw)),
                    _ => Err("Android cache directory is unavailable".to_string()),
                }
            },
        )
    }

    pub fn open_media_file(
        window: &tauri::WebviewWindow,
        file_path: &str,
        mime_type: &str,
    ) -> Result<(), String> {
        let path_owned = file_path.to_string();
        let mime_owned = mime_type.to_string();
        exec_on_activity(
            window,
            "Timed out opening media file on Android",
            move |env, activity| {
                let jpath = env
                    .new_string(&path_owned)
                    .map_err(|err| take_jni_error(env, &err.to_string()))?;
                let jmime = env
                    .new_string(&mime_owned)
                    .map_err(|err| take_jni_error(env, &err.to_string()))?;
                let value = env
                    .call_method(
                        activity,
                        "openMediaFile",
                        "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                        &[JValue::Object(&jpath), JValue::Object(&jmime)],
                    )
                    .map_err(|err| take_jni_error(env, &err.to_string()))?;
                let obj = value
                    .l()
                    .map_err(|err| take_jni_error(env, &err.to_string()))?;
                match read_nullable_jstring(env, obj)? {
                    Some(err_msg) if !err_msg.is_empty() => Err(err_msg),
                    _ => Ok(()),
                }
            },
        )
    }

    pub fn set_system_appearance(
        window: &tauri::WebviewWindow,
        appearance: &str,
    ) -> Result<(), String> {
        let appearance_owned = appearance.to_string();
        window
            .with_webview(move |webview| {
                webview.jni_handle().exec(move |env, activity, _webview| {
                    if let Ok(jappearance) = env.new_string(&appearance_owned) {
                        let _ = env.call_method(
                            activity,
                            "setSystemAppearance",
                            "(Ljava/lang/String;)V",
                            &[JValue::Object(&jappearance)],
                        );
                    }
                    let _ = take_jni_error(env, "");
                });
            })
            .map_err(|err| err.to_string())
    }
}

#[tauri::command]
fn open_media_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    bytes: Vec<u8>,
    filename: String,
    mime_type: Option<String>,
) -> Result<(), String> {
    let normalized_mime = normalize_media_mime_type(mime_type.as_deref(), &filename);

    #[cfg(target_os = "android")]
    {
        let _ = app;
        let cache_dir = android_bridge::query_media_cache_dir(&window)?;
        let path = prepare_media_cache_file(
            &cache_dir,
            &filename,
            &bytes,
            SystemTime::now(),
            MEDIA_CACHE_TTL,
        )?;
        let path_str = path.to_string_lossy().to_string();
        android_bridge::open_media_file(&window, &path_str, &normalized_mime)
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (window, normalized_mime);
        let cache_dir = media_cache_dir(&std::env::temp_dir());
        let path = prepare_media_cache_file(
            &cache_dir,
            &filename,
            &bytes,
            SystemTime::now(),
            MEDIA_CACHE_TTL,
        )?;
        app.opener()
            .open_path(path.to_string_lossy().to_string(), None::<&str>)
            .map_err(|err| err.to_string())
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn parse_desktop_window_theme(appearance: &str) -> Option<tauri::Theme> {
    match appearance.trim().to_ascii_lowercase().as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    }
}

#[tauri::command]
fn sync_system_appearance(window: tauri::WebviewWindow, appearance: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android_bridge::set_system_appearance(&window, &appearance)
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        window
            .set_theme(parse_desktop_window_theme(&appearance))
            .map_err(|err| err.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "windows", target_os = "macos")))]
    {
        let _ = (window, appearance);
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_media_file,
            sync_system_appearance
        ])
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app_handle, event);
    });
}

#[cfg(test)]
mod tests {
    use super::parse_desktop_window_theme;

    #[test]
    fn parse_desktop_window_theme_maps_known_modes_and_falls_back_to_system() {
        assert_eq!(
            parse_desktop_window_theme("light"),
            Some(tauri::Theme::Light)
        );
        assert_eq!(parse_desktop_window_theme("dark"), Some(tauri::Theme::Dark));
        assert_eq!(
            parse_desktop_window_theme(" Light "),
            Some(tauri::Theme::Light)
        );
        assert_eq!(
            parse_desktop_window_theme("DARK\n"),
            Some(tauri::Theme::Dark)
        );
        assert_eq!(parse_desktop_window_theme("system"), None);
        assert_eq!(parse_desktop_window_theme("unknown"), None);
    }
}
