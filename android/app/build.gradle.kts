plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "network.sentinel.devnetdvpn"
    compileSdk = 35

    defaultConfig {
        applicationId = "network.sentinel.devnetdvpn"
        minSdk = 29 // Android 10: isAlwaysOn / isLockdownEnabled, setHttpProxy, exec from nativeLibraryDir
        targetSdk = 35
        versionCode = 90
        versionName = "0.1.4"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // -PabiOnly=arm64-v8a: one-ABI APK (Firebase Test Lab phones; the protocol programs make
        // each ABI ~200 MB of native code).
        val abiOnly = providers.gradleProperty("abiOnly").orNull
        ndk { abiFilters += if (abiOnly != null) listOf(abiOnly) else listOf("x86_64", "arm64-v8a") }
    }

    buildTypes {
        debug {
            // Debug builds expose the dvpnd control socket and the CLI to adb (scripts/e2e/android).
            buildConfigField("boolean", "TEST_HOOKS", "true")
        }
        release {
            isMinifyEnabled = false
            buildConfigField("boolean", "TEST_HOOKS", "false")
            signingConfig = signingConfigs.getByName("debug") // owner picks the real key later
        }
    }

    buildFeatures { buildConfig = true }

    // Protocol executables are shipped as lib*.so so the installer extracts them where exec is allowed.
    packaging { jniLibs { useLegacyPackaging = true } }

    sourceSets["main"].jniLibs.srcDirs("src/main/jniLibs")
    sourceSets["main"].assets.srcDirs(layout.buildDirectory.dir("generated/nodeAssets"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isReturnDefaultValues = true }
}

// ─── Node assets: the Windows app's TS bundles + renderer (built in the repo root: `npm run build:cli`,
// `npm run build:android-main`, `npx electron-vite build`) ───
val repoRoot = rootProject.projectDir.parentFile
val nodeAssets = tasks.register<Copy>("nodeAssets") {
    val cli = File(repoRoot, "out/cli/devnet-dvpn.cjs")
    val main = File(repoRoot, "out/android/main.cjs")
    val preload = File(repoRoot, "out/android/web-preload.js")
    val renderer = File(repoRoot, "out/renderer")
    doFirst {
        check(cli.isFile) { "missing $cli: run `npm run build:cli` in $repoRoot first" }
        check(main.isFile && preload.isFile) { "missing $main: run `npm run build:android-main` in $repoRoot first" }
        check(File(renderer, "index.html").isFile) { "missing $renderer: run `npx electron-vite build` in $repoRoot first" }
    }
    from(cli) { rename { "cli.cjs" } }
    from(main)
    from(preload)
    from(renderer) { into("renderer") }
    from(File(repoRoot, "resources/daemon.proto")) { into("resources") }
    into(layout.buildDirectory.dir("generated/nodeAssets/node"))
}
tasks.named("preBuild") { dependsOn(nodeAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
