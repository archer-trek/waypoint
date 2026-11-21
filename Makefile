.PHONY: all build-android-apk apk test-android-jvm help

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
