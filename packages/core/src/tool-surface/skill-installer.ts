// packages/core/src/tool-surface/skill-installer.ts
// Skill-install framework (architecture.md:164).
//
// Public surface for skill-install operations. Bundles:
//   - client auto-detection (detectClients)
//   - canonical client list (ALL_CLIENTS) and skill list (SUPPORTED_SKILLS)
//   - skill content discovery (getSkillsRoot, readSkillContent)
//   - per-client writer/remover dispatch
//
// Per-CLI orchestration (argv parsing, prompt UX, exit codes) lives in
// packages/server/src/cli/install-skill.ts which consumes this surface.

export { detectClients, ALL_CLIENTS } from './manifest.js';
export type { Client, InstallManifest, ManifestEntry } from './manifest.js';
export {
  manifestPath,
  manifestDir,
  listEntries,
  getEntry,
  appendEntry,
  removeEntry,
  isInstalled,
  FutureManifestError,
  ManifestParseError,
  ManifestSchemaValidationError,
} from './manifest.js';

export {
  SUPPORTED_SKILLS,
  SkillNotFoundError,
  getSkillsRoot,
  readSkillContent,
  discoverPerClientInstallDirs,
} from './discover.js';

export { installClaudeCode, uninstallClaudeCode } from './skill-installers/claude-code.js';
export { installCodexCli, uninstallCodexCli } from './skill-installers/codex-cli.js';
export { installCursor, uninstallCursor } from './skill-installers/cursor.js';
export { installGeminiCli, uninstallGeminiCli } from './skill-installers/gemini-cli.js';
