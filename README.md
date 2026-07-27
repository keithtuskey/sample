# sample

## Superpowers plugin

This repo enables the [Superpowers](https://github.com/obra/superpowers) plugin
for Claude Code — a core skills library covering TDD, systematic debugging,
planning, code review, and other collaboration workflows.

It is wired up as a **project-level plugin** in [`.claude/settings.json`](.claude/settings.json):

- Registers `obra/superpowers` as a plugin marketplace (`superpowers-dev`).
- Enables the `superpowers` plugin for anyone who opens this repo in Claude Code.

When you open this repository in a Claude Code session that supports plugins,
Claude Code reads these settings, fetches the marketplace from GitHub, and
installs/enables the plugin automatically (you'll be prompted to trust the
project settings the first time).

### Alternative: install manually

If you'd rather install it yourself, or want Anthropic's official marketplace
build:

```bash
# Official marketplace
/plugin install superpowers@claude-plugins-official

# Or the Superpowers marketplace
/plugin marketplace add obra/superpowers-marketplace
/plugin install superpowers@superpowers-marketplace
```

See the [Superpowers README](https://github.com/obra/superpowers#installation)
for other harnesses (Codex, Cursor, Gemini CLI, and more).
