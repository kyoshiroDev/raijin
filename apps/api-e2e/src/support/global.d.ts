import type { ChildProcess } from 'node:child_process';

/* Variables partagées entre global-setup et global-teardown de Jest (même processus). */
declare global {
  var __TEARDOWN_MESSAGE__: string;
  var __API_PROCESS__: ChildProcess | undefined;
}

export {};
