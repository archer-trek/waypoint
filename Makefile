.PHONY: all build-android-apk apk build-macos-dmg dmg build-windows-installer win release-prepare release-tag test-android-jvm clean help

ANDROID_NDK_VERSION := 27.3.13750724
HOST_OS := $(shell uname -s)

ifndef ANDROID_HOME
  ifneq ($(wildcard $(HOME)/Android/Sdk),)
    ANDROID_HOME := $(HOME)/Android/Sdk
  else ifeq ($(HOST_OS),Darwin)
    ifneq ($(wildcard $(HOME)/Library/Android/sdk),)
      ANDROID_HOME := $(HOME)/Library/Android/sdk
    endif
  endif
endif

ifndef NDK_HOME
  ifdef ANDROID_HOME
    ifneq ($(wildcard $(ANDROID_HOME)/ndk/$(ANDROID_NDK_VERSION)),)
      NDK_HOME := $(ANDROID_HOME)/ndk/$(ANDROID_NDK_VERSION)
    endif
  endif
endif

ifndef JAVA_HOME
  ifeq ($(HOST_OS),Darwin)
    JAVA_HOME := $(shell /usr/libexec/java_home -v 17 2>/dev/null)
  else
    ifneq ($(wildcard /usr/lib/jvm/java-17-openjdk-arm64),)
      JAVA_HOME := /usr/lib/jvm/java-17-openjdk-arm64
    else ifneq ($(wildcard /usr/lib/jvm/java-17-openjdk-amd64),)
      JAVA_HOME := /usr/lib/jvm/java-17-openjdk-amd64
    endif
  endif
endif

ANDROID_ENV := \
	$(if $(strip $(ANDROID_HOME)),ANDROID_HOME="$(ANDROID_HOME)" ANDROID_SDK_ROOT="$(ANDROID_HOME)",) \
	$(if $(strip $(NDK_HOME)),NDK_HOME="$(NDK_HOME)" ANDROID_NDK_HOME="$(NDK_HOME)",) \
	$(if $(strip $(JAVA_HOME)),JAVA_HOME="$(JAVA_HOME)",)

all: build-android-apk

build-android-apk:
	$(ANDROID_ENV) node scripts/build-android-apk.mjs \
		$(if $(OUT),--out "$(OUT)",) \
		$(if $(OUT_DIR),--out-dir "$(OUT_DIR)",) \
		$(if $(VERSION),--version "$(VERSION)",) \
		$(if $(BUILD_NUMBER),--build-number "$(BUILD_NUMBER)",) \
		$(if $(filter 1 true yes,$(RELEASE)),--release,) \
		$(if $(filter 1 true yes,$(UNSIGNED)),--unsigned,)

apk: build-android-apk

build-macos-dmg:
	node scripts/build-macos-dmg.mjs \
		$(if $(OUT),--out "$(OUT)",) \
		$(if $(OUT_DIR),--out-dir "$(OUT_DIR)",) \
		$(if $(TARGET),--target "$(TARGET)",) \
		$(if $(VERSION),--version "$(VERSION)",) \
		$(if $(BUILD_NUMBER),--build-number "$(BUILD_NUMBER)",) \
		$(if $(filter 1 true yes,$(RELEASE)),--release,)

dmg: build-macos-dmg

build-windows-installer:
	node scripts/build-windows-installer.mjs \
		$(if $(OUT),--out "$(OUT)",) \
		$(if $(OUT_DIR),--out-dir "$(OUT_DIR)",) \
		$(if $(TARGET),--target "$(TARGET)",) \
		$(if $(VERSION),--version "$(VERSION)",) \
		$(if $(filter 1 true yes,$(RELEASE)),--release,)

win: build-windows-installer

release-prepare:
	node scripts/prepare-release.mjs \
		$(if $(VERSION),--version "$(VERSION)",) \
		$(if $(filter 1 true yes,$(PR)),--pr,) \
		$(if $(filter 1 true yes,$(SKIP_CHECKS)),--skip-checks,) \
		$(if $(filter 1 true yes,$(DRY_RUN)),--dry-run,)

release-tag:
	node scripts/tag-release.mjs \
		$(if $(VERSION),--version "$(VERSION)",) \
		$(if $(filter 1 true yes,$(SKIP_CI_CHECK)),--skip-ci-check,) \
		$(if $(filter 1 true yes,$(DRY_RUN)),--dry-run,)

test-android-jvm:
	@if [ ! -f src-tauri/gen/android/tauri.settings.gradle ] || [ ! -f src-tauri/gen/android/app/tauri.build.gradle.kts ]; then \
		echo "Missing generated Tauri Gradle files (src-tauri/gen/android/tauri.settings.gradle / app/tauri.build.gradle.kts)." >&2; \
		echo "Run 'make apk UNSIGNED=1' or 'npx tauri android build --apk --target aarch64' first to generate them." >&2; \
		exit 1; \
	fi
	cd src-tauri/gen/android && $(ANDROID_ENV) ./gradlew :app:testUniversalDebugUnitTest --no-daemon

clean:
	rm -rf \
		dist \
		.vite \
		artifacts \
		src-tauri/target \
		src-tauri/gen/android/build \
		src-tauri/gen/android/.gradle \
		src-tauri/gen/android/.cxx \
		src-tauri/gen/android/.externalNativeBuild \
		src-tauri/gen/android/.tauri \
		src-tauri/gen/android/tauri.settings.gradle \
		src-tauri/gen/android/buildSrc/build \
		src-tauri/gen/android/buildSrc/.gradle \
		src-tauri/gen/android/app/build \
		src-tauri/gen/android/app/tauri.build.gradle.kts \
		src-tauri/gen/android/app/proguard-tauri.pro \
		src-tauri/gen/android/app/tauri.properties \
		src-tauri/gen/android/app/src/main/jniLibs \
		src-tauri/gen/android/app/src/main/assets
	@if [ -d src-tauri/gen/android/app/src/main ]; then \
		find src-tauri/gen/android/app/src/main -type d -name generated -prune -exec rm -rf {} +; \
	fi

help:
	@echo "Waypoint build helpers:"
	@echo "  make [build-android-apk|apk] [OUT=path] [OUT_DIR=dir] [VERSION=X.Y.Z] [BUILD_NUMBER=int] [RELEASE=1] [UNSIGNED=1]"
	@echo "      Build single-ABI (arm64-v8a) APK"
	@echo "  make [build-macos-dmg|dmg] [OUT=path] [OUT_DIR=dir] [TARGET=arm64|universal|x64] [VERSION=X.Y.Z] [BUILD_NUMBER=int] [RELEASE=1]"
	@echo "      Build macOS DMG (run on macOS)"
	@echo "  make [build-windows-installer|win] [OUT=path] [OUT_DIR=dir] [TARGET=x64|arm64] [VERSION=X.Y.Z] [RELEASE=1]"
	@echo "      Build Windows NSIS installer (run on Windows)"
	@echo "  make release-prepare VERSION=<patch|minor|major|X.Y.Z> [PR=1] [SKIP_CHECKS=1] [DRY_RUN=1]"
	@echo "      Prepare release branch chore/release-vX.Y.Z with synchronized manifest and lockfile versions"
	@echo "  make release-tag [VERSION=X.Y.Z] [SKIP_CI_CHECK=1] [DRY_RUN=1]"
	@echo "      Verify main & CI, then create and push annotated tag vX.Y.Z"
	@echo "  make test-android-jvm"
	@echo "      Run Android JVM unit tests (requires prior Android Tauri build)"
	@echo "  make clean"
	@echo "      Remove frontend, Rust/Tauri, Android, and local artifacts build outputs (preserves node_modules and keystores)"
	@echo "  make help"
	@echo "      Show this message"
