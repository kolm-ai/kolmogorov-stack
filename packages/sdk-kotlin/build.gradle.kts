// Minimal AGP module shape for ai.kolm:kolm. Wire into your app's
// settings.gradle.kts via `include(":kolm")` and replace `kolm` with the
// module path you choose.

plugins {
    id("com.android.library") version "8.5.0"
    id("org.jetbrains.kotlin.android") version "2.0.0"
    id("maven-publish")
}

android {
    namespace = "ai.kolm"
    compileSdk = 34
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.annotation:annotation:1.8.0")
    // Optional runtime AARs — declare on the consumer side, not here.
    // implementation("com.facebook.executorch:executorch-android:0.3.0")
    // implementation("com.microsoft.onnxruntime:onnxruntime-android:1.18.0")
}

group = "ai.kolm"
version = "0.2.6"
