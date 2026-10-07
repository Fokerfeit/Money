package expo.modules.devicecredential

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// MONEY — "Use phone PIN / pattern instead".
//
// Opens Android's OWN credential screen — the phone's PIN, pattern or password, never
// a fingerprint — so whatever unlocks the phone can always unlock the app, even on
// phones whose fingerprint prompt shows no PIN button (tester batch, Oct 2026).
//   Android 11+  : BiometricPrompt with DEVICE_CREDENTIAL as the ONLY allowed authenticator.
//   Android 10-  : KeyguardManager.createConfirmDeviceCredentialIntent (the system lock screen).
// Resolves { success: true } or { success: false, error } — it never rejects, and it
// never sees or stores the credential itself (Android checks it).

private const val REQUEST_CODE = 0x4D4E

class DeviceCredentialModule : Module() {
  private var pending: Promise? = null

  private val keyguard: KeyguardManager?
    get() = appContext.reactContext?.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager

  private fun result(success: Boolean, error: String? = null): Map<String, Any> =
    if (error == null) mapOf("success" to success) else mapOf("success" to success, "error" to error)

  override fun definition() = ModuleDefinition {
    Name("DeviceCredential")

    // true when the phone has ANY screen lock (PIN, pattern or password)
    AsyncFunction("isDeviceSecureAsync") {
      keyguard?.isDeviceSecure == true
    }

    AsyncFunction("confirmAsync") { title: String, description: String, promise: Promise ->
      val activity = appContext.currentActivity as? FragmentActivity
      val km = keyguard
      if (activity == null || km == null) {
        promise.resolve(result(false, "not_available"))
        return@AsyncFunction
      }
      if (!km.isDeviceSecure) {
        promise.resolve(result(false, "not_enrolled"))
        return@AsyncFunction
      }
      if (pending != null) {
        promise.resolve(result(false, "busy"))
        return@AsyncFunction
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val callback = object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(res: BiometricPrompt.AuthenticationResult) {
            promise.resolve(result(true))
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            val error = when (errorCode) {
              BiometricPrompt.ERROR_USER_CANCELED,
              BiometricPrompt.ERROR_NEGATIVE_BUTTON,
              BiometricPrompt.ERROR_CANCELED -> "user_cancel"
              BiometricPrompt.ERROR_LOCKOUT,
              BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "lockout"
              BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL -> "not_enrolled"
              else -> "error_$errorCode"
            }
            promise.resolve(result(false, error))
          }
        }
        val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
        val info = BiometricPrompt.PromptInfo.Builder()
          .setTitle(title)
          .setDescription(description)
          .setAllowedAuthenticators(BiometricManager.Authenticators.DEVICE_CREDENTIAL)
          .build()
        prompt.authenticate(info)
      } else {
        @Suppress("DEPRECATION")
        val intent = km.createConfirmDeviceCredentialIntent(title, description)
        if (intent == null) {
          promise.resolve(result(false, "not_enrolled"))
          return@AsyncFunction
        }
        pending = promise
        activity.startActivityForResult(intent, REQUEST_CODE)
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode == REQUEST_CODE) {
        val p = pending
        pending = null
        p?.resolve(if (payload.resultCode == Activity.RESULT_OK) result(true) else result(false, "user_cancel"))
      }
    }
  }
}
