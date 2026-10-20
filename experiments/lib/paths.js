// Where experiment outputs go. SFMCP_RESULTS redirects every script to a fresh
// folder (reproduce.sh uses this), so new runs never overwrite the shipped results.
import fs from "node:fs";
import path from "node:path";

const EXPERIMENTS = path.resolve(import.meta.dirname, "..");
export const RESULTS = process.env.SFMCP_RESULTS ? path.resolve(process.env.SFMCP_RESULTS) : path.join(EXPERIMENTS, "results");
export const RAW = path.join(RESULTS, "raw");
fs.mkdirSync(RAW, { recursive: true });
