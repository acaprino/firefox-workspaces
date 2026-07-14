// web-ext configuration. Auto-loaded by web-ext for build / sign / lint.
// Keeps repo and dev-only files out of the packaged & signed extension so
// only real extension assets ship (manifest.json, backend/, popup/, icons/).
// web-ext still always ignores .git, node_modules and web-ext-artifacts.
module.exports = {
  ignoreFiles: [
    "**/*.md",            // CLAUDE.md, README.md, docs/plans/*.md
    "**/*.py",            // scripts/*.py dev tools
    "**/*.bat",           // claude_.bat, scripts/sign.bat
    "docs/**",
    "scripts/**",
    "screenshots/**",
    ".env",
    ".env.example",
    "amo-metadata.json",  // AMO listing metadata, not an extension asset
    "web-ext-config.cjs", // this config itself
  ],
};
