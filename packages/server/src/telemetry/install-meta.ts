function bucketOs(): 'darwin' | 'linux' | 'win32' | 'other' {
  const p = process.platform;
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  return 'other';
}

export function buildInstallMeta(args: { installId: string; mmagentVersion: string }) {
  return {
    installId: args.installId,
    mmagentVersion: args.mmagentVersion,
    os: bucketOs(),
    nodeMajor: Number(process.versions.node.split('.')[0]),
  };
}
