export type PerfMetricSample = {
  timestamp: number;
  fetchMs?: number;
  decodeMs?: number;
  gpuUploadMs?: number;
  renderMs?: number;
  interactionMs?: number;
  rendererMode?: 'webgl' | 'canvas';
  webglInstanceCount?: number;
};

class PerfMetrics {
  private samples: PerfMetricSample[] = [];
  private maxSamples = 100;

  record(sample: PerfMetricSample) {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  getSamples() {
    return [...this.samples];
  }

  getP95(field: keyof PerfMetricSample): number | null {
    const values = this.samples
      .map((sample) => sample[field])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .sort((a, b) => a - b);
    if (values.length === 0) return null;
    const idx = Math.min(values.length - 1, Math.floor(values.length * 0.95));
    return values[idx];
  }
}

export const perfMetrics = new PerfMetrics();
