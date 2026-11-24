.PHONY: all build-android-apk apk build-macos-dmg dmg build-windows-installer win test-android-jvm help

ANDROID_HOME ?= $(HOME)/Android/Sdk
NDK_HOME ?= $(ANDROID_HOME)/ndk/27.3.13750724
JAVA_HOME ?= /usr/lib/jvm/java-17-openjdk-arm64

export ANDROID_HOME
export NDK_HOME
export JAVA_HOME

all: build-android-apk

build-android-apk:
	node scripts/build-android-apk.mjs $(if $(OUT),--out $(OUT),)

apk: build-android-apk

build-macos-dmg:
	node scripts/build-macos-dmg.mjs $(if $(OUT),--out $(OUT),) $(if $(TARGET),--target $(TARGET),)

dmg: build-macos-dmg

build-windows-installer:
	node scripts/build-windows-installer.mjs $(if $(OUT),--out $(OUT),) $(if $(TARGET),--target $(TARGET),)

win: build-windows-installer

test-android-jvm:
	cd src-tauri/gen/android && ./gradlew :app:testUniversalDebugUnitTest

help:
	@echo "Waypoint build helpers:"
	@echo "  make [build-android-apk|apk] [OUT=path/to/app.apk]                  Build single-ABI (arm64-v8a) signed test APK"
	@echo "  make [build-macos-dmg|dmg] [OUT=path/to/app.dmg] [TARGET=arm64|universal|x64]  Build macOS DMG (run on macOS)"
	@echo "  make [build-windows-installer|win] [OUT=path/to/setup.exe] [TARGET=x64|arm64]  Build Windows NSIS installer (run on Windows)"
	@echo "  make test-android-jvm                                               Run Android JVM unit tests"
	@echo "  make help                                                           Show this message"
