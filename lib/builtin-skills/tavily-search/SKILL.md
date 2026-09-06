---
name: tavily-search
cli-dependencies:
  - command: tvly
    install-url: https://cli.tavily.com
description: |
  Search the web with LLM-optimized results via the Tavily CLI. Use this skill when the user wants to search the web, find articles, look up information, get recent news, discover sources, or says "search for", "find me", "look up", "what's the latest on", "find articles about", or needs current information from the internet. Returns relevant results with content snippets, relevance scores, and metadata — optimized for LLM consumption. Supports domain filtering, time ranges, and multiple search depths.
allowed-tools: Bash(tvly *), Bash(export *), Bash(command *), Bash(which *), Bash(ls *), Bash(curl *), Bash(cat *)
---

# tavily search

Web search returning LLM-optimized results with content snippets and relevance scores.

## Before running any command

Ensure `tvly` is available. Run this ONE-LINER first:

```bash
export PATH="$HOME/.local/bin:$PATH" && command -v tvly
```

- If it prints a path → `tvly` is ready, use it directly.
- If empty / not found → install:

```bash
curl -fsSL https://cli.tavily.com/install.sh | bash
```

⚠️ IMPORTANT: Always prefix tvly commands with `export PATH="$HOME/.local/bin:$PATH" &&` in this session, e.g.:
```bash
export PATH="$HOME/.local/bin:$PATH" && tvly search "query" --json
```

## When to use

- You need to find information on any topic
- You don't have a specific URL yet
- First step in the workflow: **search** → extract → map → crawl → research

## Quick start

```bash
# Basic search
export PATH="$HOME/.local/bin:$PATH" && tvly search "your query" --json

# Advanced search with more results
export PATH="$HOME/.local/bin:$PATH" && tvly search "quantum computing" --depth advanced --max-results 10 --json

# Recent news
export PATH="$HOME/.local/bin:$PATH" && tvly search "AI news" --time-range week --topic news --json

# Domain-filtered
export PATH="$HOME/.local/bin:$PATH" && tvly search "SEC filings" --include-domains sec.gov,reuters.com --json

# Include full page content in results
export PATH="$HOME/.local/bin:$PATH" && tvly search "react hooks tutorial" --include-raw-content --max-results 3 --json
```

## Options

| Option | Description |
|--------|-------------|
| `--depth` | `ultra-fast`, `fast`, `basic` (default), `advanced` |
| `--max-results` | Max results, 0-20 (default: 5) |
| `--topic` | `general` (default), `news`, `finance` |
| `--time-range` | `day`, `week`, `month`, `year` |
| `--start-date` | Results after date (YYYY-MM-DD) |
| `--end-date` | Results before date (YYYY-MM-DD) |
| `--include-domains` | Comma-separated domains to include |
| `--exclude-domains` | Comma-separated domains to exclude |
| `--country` | Boost results from country |
| `--include-answer` | Include AI answer (`basic` or `advanced`) |
| `--include-raw-content` | Include full page content (`markdown` or `text`) |
| `--include-images` | Include image results |
| `--include-image-descriptions` | Include AI image descriptions |
| `--chunks-per-source` | Chunks per source (advanced/fast depth only) |
| `-o, --output` | Save output to file |
| `--json` | Structured JSON output |

## Search depth

| Depth | Speed | Relevance | Best for |
|-------|-------|-----------|----------|
| `ultra-fast` | Fastest | Lower | Real-time chat, autocomplete |
| `fast` | Fast | Good | Need chunks, latency matters |
| `basic` | Medium | High | General-purpose (default) |
| `advanced` | Slower | Highest | Precision, specific facts |

## Tips

- **Keep queries under 400 characters** — think search query, not prompt.
- **Break complex queries into sub-queries** for better results.
- **Use `--include-raw-content`** when you need full page text (saves a separate extract call).
- **Use `--include-domains`** to focus on trusted sources.
- **Use `--time-range`** for recent information.
- Read from stdin: `echo "query" | tvly search - --json`
