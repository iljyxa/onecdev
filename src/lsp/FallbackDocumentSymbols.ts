interface Registration {
  dispose(): void;
}

export class FallbackDocumentSymbols {
  private registration: Registration | undefined;
  private disposed = false;

  constructor(private readonly register: () => Registration) {}

  setAnalyzerRunning(running: boolean): void {
    if (this.disposed) {
      return;
    }
    if (running) {
      this.registration?.dispose();
      this.registration = undefined;
    } else {
      this.registration ??= this.register();
    }
  }

  dispose(): void {
    this.setAnalyzerRunning(true);
    this.disposed = true;
  }
}
