plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android { namespace="com.mikromate.app"; compileSdk=36
 defaultConfig { applicationId="com.mikromate.app"; minSdk=26; targetSdk=36; versionCode=500; versionName="5.0.0" }
}
dependencies {
 implementation("androidx.core:core-ktx:1.17.0")
 implementation("androidx.activity:activity-compose:1.11.0")
 implementation("androidx.compose.ui:ui:1.9.0")
 implementation("androidx.compose.material3:material3:1.3.2")
 implementation("androidx.compose.ui:ui-tooling-preview:1.9.0")
 debugImplementation("androidx.compose.ui:ui-tooling:1.9.0")
}