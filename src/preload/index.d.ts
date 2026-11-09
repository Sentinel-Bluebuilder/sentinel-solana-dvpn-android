import type { IPC, EVENTS, IpcChannel } from '../shared/ipc';

declare global {
  interface Window {
    api: {
      IPC: typeof IPC;
      EVENTS: typeof EVENTS;
      /** Set by the Android WebView preload only; absent on the desktop. */
      platform?: 'android';
      android?: { openVpnSettings(): void; notificationsAllowed(): boolean; openNotificationSettings(): void; vpnSystemState(): { alwaysOn?: boolean; lockdown?: boolean }; welcomed(): boolean; markWelcomed(): void; setSecure(on: boolean): void };
      invoke<T = unknown>(channel: IpcChannel, payload?: unknown): Promise<T>;
      on<T = unknown>(channel: string, cb: (payload: T) => void): () => void;
    };
  }
}

export {};
