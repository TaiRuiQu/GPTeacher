/** Energy VAD with adaptive background estimation, attack hysteresis and end-of-turn silence. */
export class EnergyVad {
  private floor = 0.002;
  private aboveSince = 0;
  private quietSince = 0;
  private active = false;
  reset() {
    this.floor = 0.002;
    this.aboveSince = 0;
    this.quietSince = 0;
    this.active = false;
  }
  process(samples: Float32Array, time: number) {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / Math.max(1, samples.length));
    const threshold = Math.max(0.012, this.floor * 3.2);
    let started = false,
      ended = false;
    if (rms > threshold) {
      this.quietSince = 0;
      if (!this.aboveSince) this.aboveSince = time;
      if (!this.active && time - this.aboveSince >= 100) {
        this.active = true;
        started = true;
      }
    } else {
      this.aboveSince = 0;
      if (!this.active) this.floor = this.floor * 0.97 + Math.min(rms, 0.02) * 0.03;
      if (this.active) {
        if (!this.quietSince) this.quietSince = time;
        if (time - this.quietSince >= 1000) {
          this.active = false;
          this.quietSince = 0;
          ended = true;
        }
      }
    }
    return { rms, speaking: this.active, started, ended };
  }
}
