// ─── Which shell the renderer runs in ───
// The Android WebView preload sets window.api.platform = 'android'; the Electron preload does not.
// Screens use this only for wording and for controls that exist on one platform.

export const onAndroid = (): boolean => typeof window !== 'undefined' && window.api?.platform === 'android';

/** Picks the desktop or the Android text. */
export const byPlatform = <T,>(desktop: T, android: T): T => (onAndroid() ? android : desktop);

/** "this computer" on the desktop, "this phone" on Android. */
export const thisDevice = (): string => byPlatform('this computer', 'this phone');
