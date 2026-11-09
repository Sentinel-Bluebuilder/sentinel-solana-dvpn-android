# --- sysproxy.ps1 - read or set the current user's system proxy (unelevated) ---
# Browsers (Chromium/Edge) and WinHTTP read the proxy from the per-connection settings blob
# (Internet Settings\Connections\DefaultConnectionSettings), not from the ProxyEnable /
# ProxyServer values alone. Writing only those values left Edge going direct (VM matrix
# 2026-10-21). InternetSetOption with per-connection options writes both and tells running
# apps the settings changed.
#   -Mode query           prints {"flags":n,"server":s,"bypass":s,"pac":s}
#   -Mode set -Json <b64> sets exactly those four values (base64 of the same JSON)
# ASCII only.
param(
  [ValidateSet('query', 'set')][string]$Mode = 'query',
  [string]$Json = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DvpnProxy {
  [DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "InternetSetOptionW")]
  static extern bool InternetSetOption(IntPtr h, int option, IntPtr buffer, int length);
  [DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "InternetQueryOptionW")]
  static extern bool InternetQueryOption(IntPtr h, int option, IntPtr buffer, ref int length);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr p);

  const int PER_CONNECTION_OPTION = 75, SETTINGS_CHANGED = 39, REFRESH = 37;
  const int FLAGS = 1, SERVER = 2, BYPASS = 3, PAC = 4;
  static int OptSize { get { return IntPtr.Size == 8 ? 16 : 8; } }
  static int ListSize { get { return IntPtr.Size == 8 ? 32 : 20; } }

  // INTERNET_PER_CONN_OPTION_LIST: dwSize, pszConnection (NULL = LAN), dwOptionCount, dwOptionError, pOptions
  static IntPtr List(IntPtr opts, int count) {
    IntPtr list = Marshal.AllocHGlobal(ListSize);
    for (int i = 0; i < ListSize; i++) Marshal.WriteByte(list, i, 0);
    Marshal.WriteInt32(list, 0, ListSize);
    Marshal.WriteInt32(list, IntPtr.Size * 2, count);
    Marshal.WriteIntPtr(list, IntPtr.Size * 2 + 8, opts);
    return list;
  }

  public static string[] Query() {
    int[] ids = { FLAGS, SERVER, BYPASS, PAC };
    IntPtr opts = Marshal.AllocHGlobal(OptSize * ids.Length);
    for (int i = 0; i < OptSize * ids.Length; i++) Marshal.WriteByte(opts, i, 0);
    for (int i = 0; i < ids.Length; i++) Marshal.WriteInt32(opts, i * OptSize, ids[i]);
    IntPtr list = List(opts, ids.Length);
    int len = ListSize;
    try {
      if (!InternetQueryOption(IntPtr.Zero, PER_CONNECTION_OPTION, list, ref len)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      string[] r = new string[4];
      r[0] = Marshal.ReadInt32(opts, IntPtr.Size).ToString();
      for (int i = 1; i < 4; i++) {
        IntPtr s = Marshal.ReadIntPtr(opts, i * OptSize + IntPtr.Size);
        r[i] = s == IntPtr.Zero ? "" : Marshal.PtrToStringUni(s);
        if (s != IntPtr.Zero) GlobalFree(s);
      }
      return r;
    } finally { Marshal.FreeHGlobal(list); Marshal.FreeHGlobal(opts); }
  }

  public static void Set(int flags, string server, string bypass, string pac) {
    IntPtr opts = Marshal.AllocHGlobal(OptSize * 4);
    for (int i = 0; i < OptSize * 4; i++) Marshal.WriteByte(opts, i, 0);
    IntPtr[] strs = { IntPtr.Zero, Marshal.StringToHGlobalUni(server ?? ""), Marshal.StringToHGlobalUni(bypass ?? ""), Marshal.StringToHGlobalUni(pac ?? "") };
    int[] ids = { FLAGS, SERVER, BYPASS, PAC };
    for (int i = 0; i < 4; i++) {
      Marshal.WriteInt32(opts, i * OptSize, ids[i]);
      if (i == 0) Marshal.WriteInt32(opts, i * OptSize + IntPtr.Size, flags);
      else Marshal.WriteIntPtr(opts, i * OptSize + IntPtr.Size, strs[i]);
    }
    IntPtr list = List(opts, 4);
    try {
      if (!InternetSetOption(IntPtr.Zero, PER_CONNECTION_OPTION, list, ListSize)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      InternetSetOption(IntPtr.Zero, SETTINGS_CHANGED, IntPtr.Zero, 0);
      InternetSetOption(IntPtr.Zero, REFRESH, IntPtr.Zero, 0);
    } finally {
      for (int i = 1; i < 4; i++) Marshal.FreeHGlobal(strs[i]);
      Marshal.FreeHGlobal(list); Marshal.FreeHGlobal(opts);
    }
  }
}
'@

function Out-State {
  $q = [DvpnProxy]::Query()
  [ordered]@{ flags = [int]$q[0]; server = $q[1]; bypass = $q[2]; pac = $q[3] } | ConvertTo-Json -Compress
}

if ($Mode -eq 'set') {
  if (-not $Json) { throw 'set needs -Json' }
  $v = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json)) | ConvertFrom-Json
  [DvpnProxy]::Set([int]$v.flags, [string]$v.server, [string]$v.bypass, [string]$v.pac)
}
Out-State
