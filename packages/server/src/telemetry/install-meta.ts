function bucketOs(): 'darwin' | 'linux' | 'win32' | 'other' {
  const p = process.platform;
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  return 'other';
}

export function buildInstallMeta(args: { installId: string; mmaVersion: string }) {
  return {
    installId: args.installId,
    mmaVersion: args.mmaVersion,
    os: bucketOs(),
    nodeMajor: Number(process.versions.node.split('.')[0]),
  };
}
