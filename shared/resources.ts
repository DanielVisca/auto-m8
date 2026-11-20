// The resource API's data contract is shared with the browser; keep Node APIs in the server.
export type Pressure = 'normal' | 'warning' | 'critical'
export type ResourceProcess = { pid: number; name: string; cpuPercent: number; memoryBytes: number; perch: boolean }
export type ResourceSnapshot = {
  sampledAt: number; cpuPercent: number | null; cores: number; load: number
  memory: { totalBytes: number; usedBytes: number; compressedBytes: number | null; pressure: Pressure | null; swapBytes: number | null; swapBytesPerSecond: number | null }
  disk: { availableBytes: number; totalBytes: number } | null
  perch: { pid: number; memoryBytes: number; eventLoopDelayMs: number }
  processes: ResourceProcess[]; unavailable: string[]
  severity: Pressure; reasons: { label: string; detail: string }[]
}
