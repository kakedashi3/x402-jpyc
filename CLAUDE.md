## X402 Docs

Before working on a X402 feature, check the docs via `npx nia-docs https://x402.org`.

```bash
# Search for a topic
npx nia-docs https://x402.org -c "grep -rl 'auth' ."

# Read a specific page
npx nia-docs https://x402.org -c "cat getting-started.md"

# Find all guides
npx nia-docs https://x402.org -c "find . -name '*.md'"

# List top-level structure
npx nia-docs https://x402.org -c "tree -L 1"

# Browse interactively
npx nia-docs https://x402.org
```

The shell starts in the docs root. Use `.` for relative paths — all standard Unix tools work (grep, find, cat, tree, ls, head, tail, wc).
