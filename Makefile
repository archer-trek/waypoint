.PHONY: all build-android-apk apk test-android-jvm help

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

test-android-jvm:
	cd src-tauri/gen/android && ./gradlew :app:testUniversalDebugUnitTest

help:
	@echo "Waypoint build helpers:"
	@echo "  make [build-android-apk|apk] [OUT=path/to/app.apk]  Build single-ABI (arm64-v8a) signed test APK"
	@echo "  make test-android-jvm                               Run Android JVM unit tests"
	@echo "  make help                                           Show this message"
