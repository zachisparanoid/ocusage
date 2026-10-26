import pkg from '../../package.json';

/** Own tool identity for the User-Agent header — never impersonates Codex's CLI. */
export const VERSION: string = pkg.version;
