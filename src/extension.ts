import { VERSION } from "@code-yeongyu/senpi";
import { Type } from "@earendil-works/pi-ai";

// Scaffold factory: real wiring lands in todo 11. The two runtime imports
// below keep both extension-loader externals in the bundle (verified by
// test/smoke.test.ts) without touching any senpi or pi-ai internals.
export default function earlyCompaction(_pi: unknown): void {
  void VERSION;
  void Type;
}
