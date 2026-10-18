import { defineConfig } from "vitest/config";

// Unit tests only: fast and fully offline. Integration tests run via `npm run test:int`.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["test/integration/**", "node_modules/**"] } });
