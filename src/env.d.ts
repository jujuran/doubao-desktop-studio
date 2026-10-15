/// <reference types="vite/client" />

import type { DesktopApi } from "../electron/contracts";

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}

export {};
