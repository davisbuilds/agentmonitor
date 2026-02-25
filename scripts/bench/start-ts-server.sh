#!/bin/sh
# Helper to start TS server from a clean shell context.
# Used by compare-ts-vs-rust.ts to avoid tsx-in-tsx spawn issues.
cd "$(dirname "$0")/../.."
exec node --import tsx src/server.ts
