# Preserve annotations & generic metadata needed by JNI, WebView JS bridges, and Tauri reflection
-keepattributes JavascriptInterface,*Annotation*,Signature,InnerClasses,EnclosingMethod

# WebView @JavascriptInterface methods across app & generated classes
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# MainActivity native/JNI & JS bridge entrypoints
-keep class app.waypoint.client.MainActivity {
    public <init>(...);
    public java.lang.String getMediaCacheDirPath();
    public java.lang.String openMediaFile(java.lang.String, java.lang.String);
    public void setSystemAppearance(java.lang.String);
}

-keep class app.waypoint.client.MainActivity$WaypointAndroidBridge {
    public <init>(...);
    @android.webkit.JavascriptInterface <methods>;
}

# Tauri & Wry generated native bindings & activity classes
-keep class app.waypoint.client.Rust {
    *;
}

-keep class app.waypoint.client.TauriActivity {
    *;
}

-keep class app.waypoint.client.WryActivity {
    *;
}

-keep class app.waypoint.client.Logger {
    *;
}

-keep class app.waypoint.client.PermissionHelper {
    *;
}

# Tauri runtime & plugins (including tauri-plugin-opener)
-keep class app.tauri.** {
    *;
}

-keep class app.tauri.opener.** {
    *;
}

# Preserve line numbers for release crash diagnostics
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
