# Standalone Composite Plugins

Profile export has an additional **Export as standalone plugin** action. It
packages the currently enabled third-party Bundles in their Profile order into
one `.dsh-plugin.zip`. Disabled plugins, DSH core Bundles, Skills, presets and
application add-ons are not members of this artifact.

The Plugins page imports this artifact as a single normal-priority Bundle.
The default identity is `dsh-suite-<profile>` with the Profile's version. The
recipient Profile must explicitly select the artifact's installed DSH version.
Import does not install or switch runtimes, execute lifecycle scripts, invoke
pnpm, contact a registry, or reuse ordinary plugin-pool files. Native artifacts
probe the selected, already installed Node executable with a fixed metadata
script; they do not load plugin code during export or import.

## Layout and Ownership

The archive contains `package.json`, `standalone.json`, `patch-template.yaml`
and private package files. The manifest records the private dependency graph,
member order, host requirements and file SHA-256 digests. Different versions
of one dependency retain distinct private package identities.

Import materializes the artifact below:

```
DSH_HOME/.dsh-launcher-standalone-plugins/<package>/<archive-sha256>/
```

Private dependency links resolve only to other copied private packages or
explicit DSH/Cordis host packages. Ordinary plugin bodies and pnpm store files
are never referenced. The active Profile contains only a `link:` dependency
and one Bundle entry for the outer package. Installing the same artifact into
another Profile may reuse that standalone artifact, not its ordinary plugin
counterparts. Enablement and ordering remain Profile-local.

DSH Bundle patches are structurally composed in order; module paths are
relocated to installed private files. No plugin code or `!!js` expression is
evaluated during export/import. Validation errors leave the Profile unchanged.
Hashes check artifact integrity, not publisher authenticity; imported plugin
code must still be trusted before running it.

## Initial Compatibility Boundary

- Artifacts target the exporting operating system and architecture.
- Native `.node` binaries and their companion files are copied unchanged and
  hashed. They record the selected DSH Node runtime, not Electron's runtime.
  Import and each launch require the same OS, architecture, Node major version
  and module ABI, with at least the recorded N-API version. A compatible Node
  must already be installed; export/import never download or rebuild it.
  This conservative check does not certify arbitrary binaries or supply OS
  libraries. Plugins must already work with the selected Node before export;
  recipients still need the appropriate system libraries.
- DSH/Cordis remain host-provided. Automatic, mismatched or replacement runtimes
  cannot run an enabled standalone artifact without a verified compatible host.
- Dynamic module names, nested include configurations and location-dependent
  configuration expressions fail export with a plugin-specific error.
- No launch-time executables or package-manager builds are generated. Plugins
  requiring undeclared external tools still require those tools.
- Nested standalone exports and embedding a standalone artifact in an ordinary
  Profile archive are not supported. Share the original `.dsh-plugin.zip`.

## Verification

`tests/standalone-plugin.test.ts` removes original source/store directories,
imports offline and loads private ESM modules with conflicting dependency
versions. Additional tests cover patch composition, archive validation,
Profile isolation, link repair, uninstall, runtime checks, UI and preload.

To test patch composition against an installed DSH implementation, set
`DSH_STANDALONE_PATCH_RUNTIME` to its `dsh-app-boot/lib/index.js` and run
`tests/standalone-plugin-patch.test.ts`. This checks composition without booting
a real Profile or accessing credentials.
