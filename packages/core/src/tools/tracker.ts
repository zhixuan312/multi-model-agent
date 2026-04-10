export class FileTracker {
  private files = new Set<string>();

  trackWrite(filePath: string): void {
    this.files.add(filePath);
  }

  getFiles(): string[] {
    return [...this.files].sort();
  }

  reset(): void {
    this.files.clear();
  }
}
