/* Variable partagée entre global-setup et global-teardown de Jest. */
declare global {
  var __TEARDOWN_MESSAGE__: string;
}

export {};
