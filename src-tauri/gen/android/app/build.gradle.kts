import java.io.File
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

fun resolveSigningProp(envName: String, propName: String): String? =
    System.getenv(envName)?.takeIf { it.isNotBlank() }
        ?: keystoreProperties.getProperty(propName)?.takeIf { it.isNotBlank() }

fun resolveStoreFile(rawPath: String): File {
    val expanded = if (rawPath.startsWith("~/")) {
        File(System.getProperty("user.home"), rawPath.removePrefix("~/"))
    } else {
        File(rawPath)
    }
    return if (expanded.isAbsolute) expanded else rootProject.file(rawPath)
}

val releaseStorePath = resolveSigningProp("WAYPOINT_ANDROID_KEYSTORE_PATH", "storeFile")
val releaseStorePassword = resolveSigningProp("WAYPOINT_ANDROID_KEYSTORE_PASSWORD", "storePassword")
val releaseKeyAlias = resolveSigningProp("WAYPOINT_ANDROID_KEY_ALIAS", "keyAlias")
val releaseKeyPassword = resolveSigningProp("WAYPOINT_ANDROID_KEY_PASSWORD", "keyPassword")
val hasReleaseSigning =
    releaseStorePath != null &&
    releaseStorePassword != null &&
    releaseKeyAlias != null &&
    releaseKeyPassword != null

val overrideVersionCode = (project.findProperty("waypointVersionCode") as String?)
    ?: System.getenv("WAYPOINT_ANDROID_VERSION_CODE")
val overrideVersionName = (project.findProperty("waypointVersionName") as String?)
    ?: System.getenv("WAYPOINT_ANDROID_VERSION_NAME")
val overrideAbiFilters = (project.findProperty("waypointAbiFilters") as String?)
    ?: System.getenv("WAYPOINT_ANDROID_ABI_FILTERS")

android {
    compileSdk = 37
    ndkVersion = "27.3.13750724"
    namespace = "app.waypoint.client"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.waypoint.client"
        minSdk = 24
        targetSdk = 37
        versionCode = overrideVersionCode?.toIntOrNull()
            ?: tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = overrideVersionName?.takeIf { it.isNotBlank() }
            ?: tauriProperties.getProperty("tauri.android.versionName", "1.0")
        if (!overrideAbiFilters.isNullOrBlank()) {
            ndk {
                abiFilters.clear()
                abiFilters.addAll(
                    overrideAbiFilters.split(",").map { it.trim() }.filter { it.isNotEmpty() }
                )
            }
        }
    }
    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = resolveStoreFile(releaseStorePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                // Stripped debug symbols to keep APK slim for testing
            }
        }
        getByName("release") {
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            isMinifyEnabled = true
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
