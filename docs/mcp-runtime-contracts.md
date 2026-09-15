# MCP Runtime Contracts

## Deferred Configuration Reload

Saving MCP configuration requests a reload for each live session. A busy session
returns `skipped: true` for compatibility, but retains a pending request. The
queue checks for an idle boundary every 250 ms, coalesces repeated saves and
allows only one acquisition at a time. A new turn winning the acquisition race
defers installation again. Destroy cancels the timer; a late lease is released.

Installation uses the existing registry/prompt rollback. Background exceptions
are logged and are not retried indefinitely. Saving again requests another attempt.
External edits to mcp.json do not trigger this queue; use the configuration API/UI.

## Tool Results

- MCP `isError: true` is preserved at the top level for ToolExecutor and in
  lightweight diagnostics. Business errors retain their content and do not throw.
- Standard MCP `image` blocks remain typed images for image-capable models.
  Non-image models receive a text placeholder, never raw image Base64.
- Supported MIME types are PNG, JPEG, WebP and GIF. Invalid Base64 and images
  exceeding the cumulative 4 MiB decoded-image budget per result are omitted
  with a text explanation. The existing 16 MiB transport limit is unchanged.
- Image data is not copied into details. Images use the existing tool-result
  persistence/transport path; this change does not add file-backed image storage
  or a new UI preview. Provider request limits still apply.
- Ordinary text is unchanged, including legacy JSON text containing Base64.
  Such servers must return standard image blocks for visual tool results.

## Validation

`npm run test:mcp-runtime` runs queue/result contracts, a real stdio fixture
through Runtime and ToolExecutor, and wrapper admission/rollback tests. It does
not start a Next server or invoke an external model. Existing framing tests and
`test:mcp-stdio` remain available separately.

Source changes are picked up by the development server. Installed application
bundles require a separate build/install; updating the Nuphus binary alone does
not update DeerHux's MCP client.
