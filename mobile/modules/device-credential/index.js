// device-credential — "Use phone PIN / pattern instead" (native, Android only).
// See android/src/main/java/expo/modules/devicecredential/DeviceCredentialModule.kt.
//
// Safe everywhere: if the native module is not in the installed binary (web, iOS,
// an older APK), every call resolves { success: false, error: 'not_available' }
// instead of throwing, and the app simply hides the button.
import { requireOptionalNativeModule } from 'expo-modules-core';

const Native = requireOptionalNativeModule('DeviceCredential');

export const isDeviceCredentialAvailable = !!Native;

export async function confirmDeviceCredential(title, description = '') {
  if (!Native) return { success: false, error: 'not_available' };
  try {
    const r = await Native.confirmAsync(String(title), String(description));
    return r && typeof r === 'object' ? r : { success: false, error: 'unknown' };
  } catch {
    return { success: false, error: 'unknown' };
  }
}
