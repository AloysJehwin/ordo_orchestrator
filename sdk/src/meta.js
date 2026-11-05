// Package identity. The npm name lives only in package.json; everything else reads it from here.
import { readFileSync } from "node:fs";

/** @type {{ name: string, version: string, bin: Record<string, string> }} */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;
export const BIN_NAME = Object.keys(pkg.bin)[0] ?? pkg.name;
export const USER_AGENT = `${PACKAGE_NAME}/${VERSION} (node ${process.versions.node}; ${process.platform})`;
