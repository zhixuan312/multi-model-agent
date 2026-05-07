export class ShutdownCoordinator {
  private inProgress = false;

  signal(): void {
    this.inProgress = true;
  }

  isShutdownInProgress(): boolean {
    return this.inProgress;
  }

  async drain(action: () => Promise<void>): Promise<void> {
    await action();
  }
}
