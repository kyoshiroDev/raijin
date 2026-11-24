// Préchargé dans l'API du banc pendant l'e2e (`node -r`) : aucun appel réseau réel (Helius, DexScreener,
// GeckoTerminal, Jupiter, RugCheck, Resend…). `fetch` et les sockets TCP ne joignent que la boucle locale
// (Postgres, Redis, front de test) ; toute autre destination échoue immédiatement et est comptée sur stderr.
'use strict';
const net = require('node:net');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const isLoopback = (host) => host === undefined || host === null || host === '' || LOOPBACK.has(String(host).toLowerCase());
const refuse = (where) => {
  process.stderr.write(`[e2e banc] appel réseau sortant refusé : ${where}\n`);
  return new Error(`Réseau bloqué pendant l'e2e du banc (${where})`);
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (!isLoopback(url.hostname)) throw refuse(url.host);
  return realFetch(input, init);
};

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  if (options && typeof options === 'object' && !options.path && !isLoopback(options.host)) {
    const error = refuse(`${options.host}:${options.port}`);
    process.nextTick(() => this.destroy(error));
    return this;
  }
  if (typeof first === 'number' && typeof args[1] === 'string' && !isLoopback(args[1])) {
    const error = refuse(`${args[1]}:${first}`);
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return realConnect.apply(this, args);
};
